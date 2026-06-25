import { Socket } from 'node:net';

// FTP file source for the MikroTik collector.
//
// A RouterOS scheduler writes two text files on each router — IP_scan.txt
// (`/ip dhcp-server lease print detail`) and ARP_scan.txt (`/ip arp print
// detail`). This module pulls those files over FTP (the read-only `dhcp-reader`
// account needs the `ftp` policy) and parses them into the same NormDevice-ish
// rows the REST collector produces, so they merge by MAC into dhcp_leases.
//
// Why files at all when REST already pulls leases+arp? The file is a snapshot the
// router writes itself on a fixed cadence — a robust, self-contained source whose
// header timestamp doubles as a per-site "data freshness" signal (a stale file =
// the router's scheduler/FTP/the box itself broke). REST stays as the supplement
// that adds ip-scan NETBIOS names (which can't be dumped to a file).
//
// No third-party FTP dependency: a minimal passive-mode RETR over node:net keeps
// the auto-deploy pipeline free of lockfile/install churn.

// ---- minimal FTP client (passive mode, binary RETR) -------------------------

interface FtpReply { code: number; text: string; }

// Read one complete FTP reply (handles RFC 959 multi-line "code-...\r\ncode ").
function readReply(sock: Socket, buf: { s: string }): Promise<FtpReply> {
  return new Promise((resolve, reject) => {
    const tryParse = (): boolean => {
      // A reply ends at a line "NNN <text>" (space after the 3-digit code). For a
      // multiline reply the first line is "NNN-...", we wait for the matching
      // "NNN " terminator.
      const lines = buf.s.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(/^(\d{3}) /);
        if (m) {
          const code = Number(m[1]);
          // consume up to and including this line
          const consumed = lines.slice(0, i + 1).join('\n');
          buf.s = buf.s.slice(consumed.length).replace(/^\r?\n/, '');
          resolve({ code, text: lines[i]! });
          return true;
        }
      }
      return false;
    };
    if (tryParse()) return;
    const onData = (d: Buffer) => { buf.s += d.toString('latin1'); if (tryParse()) cleanup(); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => { sock.off('data', onData); sock.off('error', onErr); };
    sock.on('data', onData);
    sock.on('error', onErr);
  });
}

function sendCmd(sock: Socket, buf: { s: string }, cmd: string): Promise<FtpReply> {
  sock.write(cmd + '\r\n');
  return readReply(sock, buf);
}

export interface FtpFetchOpts { host: string; user: string; pass: string; timeoutMs?: number; }

// Download a file's full contents as UTF-8 text. Throws on any protocol error or
// non-2xx/1xx where success is expected.
export async function ftpFetchText(filename: string, opts: FtpFetchOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const ctrl = new Socket();
  ctrl.setTimeout(timeoutMs);
  const cbuf = { s: '' };
  const fail = (msg: string) => { try { ctrl.destroy(); } catch { /* noop */ } throw new Error(msg); };

  await new Promise<void>((resolve, reject) => {
    ctrl.once('timeout', () => reject(new Error('control timeout')));
    ctrl.once('error', reject);
    ctrl.connect(21, opts.host, () => resolve());
  });

  try {
    let r = await readReply(ctrl, cbuf);                 // 220 greeting
    if (r.code !== 220) fail(`greeting ${r.text}`);
    r = await sendCmd(ctrl, cbuf, `USER ${opts.user}`);
    if (r.code !== 331 && r.code !== 230) fail(`USER ${r.text}`);
    if (r.code === 331) {
      r = await sendCmd(ctrl, cbuf, `PASS ${opts.pass}`);
      if (r.code !== 230) fail(`PASS ${r.text}`);
    }
    r = await sendCmd(ctrl, cbuf, 'TYPE I');
    if (r.code !== 200) fail(`TYPE ${r.text}`);
    r = await sendCmd(ctrl, cbuf, 'PASV');
    if (r.code !== 227) fail(`PASV ${r.text}`);
    const m = r.text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!m) fail(`PASV parse ${r.text}`);
    const dataHost = `${m![1]}.${m![2]}.${m![3]}.${m![4]}`;
    const dataPort = (Number(m![5]) << 8) + Number(m![6]);

    // Open data channel, then issue RETR; collect everything until data EOF.
    const data = new Socket();
    data.setTimeout(timeoutMs);
    const chunks: Buffer[] = [];
    const dataDone = new Promise<void>((resolve, reject) => {
      data.once('timeout', () => reject(new Error('data timeout')));
      data.once('error', reject);
      data.on('data', (d: Buffer) => chunks.push(d));
      data.once('end', () => resolve());
      data.connect(dataPort, dataHost);
    });

    r = await sendCmd(ctrl, cbuf, `RETR ${filename}`);
    if (r.code !== 150 && r.code !== 125) { try { data.destroy(); } catch { /* noop */ } fail(`RETR ${r.text}`); }

    await dataDone;
    r = await readReply(ctrl, cbuf);                     // 226 transfer complete
    if (r.code !== 226 && r.code !== 250) fail(`transfer ${r.text}`);

    try { await sendCmd(ctrl, cbuf, 'QUIT'); } catch { /* ignore */ }
    ctrl.destroy();
    return Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    try { ctrl.destroy(); } catch { /* noop */ }
    throw e;
  }
}

// ---- parsers ----------------------------------------------------------------

// The header line of every RouterOS `print file=` output:
//   "# 2026-06-25 16:07:30 by RouterOS 7.21.4"  → a Date (UTC-naive router local).
export function parseFileTime(text: string): Date | null {
  const m = text.match(/#\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  // Router prints local (Europe/Prague) time; store as that wall-clock in UTC
  // fields. Freshness only ever compares file-time deltas, so the offset cancels.
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
}

function kv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w-]+)=("([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]!] = m[3] !== undefined ? m[3] : m[4]!;
  return out;
}

export interface FtpLease {
  mac: string; ip: string | null; host: string | null; status: string | null;
  server: string | null; dynamic: boolean; exp: string | null; lastSeen: string | null;
}

// Parse `/ip dhcp-server lease print detail file=` output. Records start on a line
// "  N  FLAGS ;;; comment" (or "...address="); body fields can wrap to following
// indented lines, so accumulate until the next index line.
export function parseLeaseDetail(text: string): FtpLease[] {
  const lines = text.split(/\r?\n/);
  const recs: Array<{ flags: string; body: string }> = [];
  let cur: { flags: string; body: string } | null = null;
  const flush = () => { if (cur) recs.push(cur); cur = null; };
  for (const ln of lines) {
    if (/^#/.test(ln) || /^Flags:/.test(ln) || /^Columns:/.test(ln)) continue;
    const idx = ln.match(/^\s*(\d+)\s+([A-Z]*)\s*(.*)$/);
    if (idx) { flush(); cur = { flags: idx[2] || '', body: idx[3] || '' }; }
    else if (cur && ln.trim()) cur.body += ' ' + ln.trim();
  }
  flush();

  const out: FtpLease[] = [];
  for (const r of recs) {
    const p = kv(r.body);
    const mac = (p['mac-address'] || p['active-mac-address'] || '').toUpperCase();
    if (!mac) continue;
    const cm = r.body.match(/;;;\s*([^=]+?)(?:\s+[\w-]+=|$)/);
    out.push({
      mac,
      ip: p['address'] || p['active-address'] || null,
      host: p['host-name'] || (cm ? cm[1]!.trim() : null) || null,
      status: p['status'] || null,
      server: p['active-server'] || p['server'] || null,
      dynamic: r.flags.includes('D'),
      exp: p['expires-after'] || null,
      lastSeen: p['last-seen'] || null,
    });
  }
  return out;
}

// One site's full FTP pull: both files parsed, their header timestamps, and a
// non-null `error` if either file couldn't be fetched. Never throws — a dead
// router / missing file becomes an `error` string the caller records for the
// freshness alert. `leases`/`arp` hold whatever was successfully read.
export interface FtpSiteResult {
  leases: FtpLease[];
  arp: FtpArp[];
  leaseTime: Date | null;
  arpTime: Date | null;
  error: string | null;
}

export async function fetchFtpSite(
  opts: FtpFetchOpts,
  files: { lease: string; arp: string },
): Promise<FtpSiteResult> {
  const res: FtpSiteResult = { leases: [], arp: [], leaseTime: null, arpTime: null, error: null };
  const errs: string[] = [];
  try {
    const text = await ftpFetchText(files.lease, opts);
    res.leases = parseLeaseDetail(text);
    res.leaseTime = parseFileTime(text);
  } catch (e) { errs.push(`lease: ${String(e).split('\n')[0]}`); }
  try {
    const text = await ftpFetchText(files.arp, opts);
    res.arp = parseArpDetail(text);
    res.arpTime = parseFileTime(text);
  } catch (e) { errs.push(`arp: ${String(e).split('\n')[0]}`); }
  if (errs.length) res.error = errs.join('; ');
  return res;
}

export interface FtpArp { mac: string; ip: string | null; iface: string | null; status: string | null; }

// Parse `/ip arp print detail file=` output. Each record is "  N FLAGS k=v…" that
// may wrap; keep only COMPLETE entries (flag C) carrying a MAC — those are real
// devices. Drop incomplete/"failed" probes (no live answer).
export function parseArpDetail(text: string): FtpArp[] {
  const lines = text.split(/\r?\n/);
  const recs: Array<{ flags: string; body: string }> = [];
  let cur: { flags: string; body: string } | null = null;
  const flush = () => { if (cur) recs.push(cur); cur = null; };
  for (const ln of lines) {
    if (/^#/.test(ln) || /^Flags:/.test(ln)) continue;
    const idx = ln.match(/^\s*(\d+)\s+([A-Za-z]*)\s+(.*)$/);
    if (idx && /address=/.test(idx[3] || '')) { flush(); cur = { flags: idx[2] || '', body: idx[3] || '' }; }
    else if (cur && ln.trim()) cur.body += ' ' + ln.trim();
  }
  flush();

  const out: FtpArp[] = [];
  for (const r of recs) {
    if (!r.flags.includes('C')) continue;              // complete only
    const p = kv(r.body);
    const mac = (p['mac-address'] || '').toUpperCase();
    if (!mac) continue;
    out.push({ mac, ip: p['address'] || null, iface: p['interface'] || null, status: p['status'] || null });
  }
  return out;
}
