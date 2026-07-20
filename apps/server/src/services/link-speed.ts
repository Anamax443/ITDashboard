import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { getPool } from '../db/pool.js';
import { getAllSettings } from './settings.js';
import { logActivity } from './activity-log.js';
import { tcpProbeTimed } from './port-status-collector.js';
import { withHostLock, hostKey } from './host-lock.js';

// Quick "is it alive at all" ICMP check — to tell an OFFLINE host (no ping) from a
// host that's up but has SMB/445 blocked (firewall), so offline doesn't read as a
// port error. Locale-independent TTL= match.
function pingAlive(host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ping', ['-n', '1', '-w', String(timeoutMs), host], { windowsHide: true, timeout: timeoutMs + 2000, maxBuffer: 1 << 16 },
      (_e, stdout) => resolve(/TTL=/i.test(stdout || '')));
  });
}

// Average ping RTT in ms (2 echoes), or null if unreachable — recorded per measurement.
function pingLatency(host: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ping', ['-n', '2', '-w', String(timeoutMs), host], { windowsHide: true, timeout: timeoutMs * 2 + 2000, maxBuffer: 1 << 16 },
      (_e, stdout) => {
        const t = [...(stdout || '').matchAll(/[<=]\s*(\d+)\s*ms/gi)].map((m) => Number(m[1]));
        resolve(t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null);
      });
  });
}

// Cycles + test filename come from settings (linkspeed.cycles / linkspeed.filename).
// pauseMs = idle gap left between consecutive PCs in a batch (linkspeed.pause_ms) —
// spaces out the load on .213's uplink and lets other collectors slip in between.
// Which measurement methods run — each independently toggleable in Settings.
// SMB (single-stream up/down) + NIC (negotiated port speed) default ON; robocopy
// (/MT multi-file, saturates fast links) default OFF (heavier).
export interface LinkMethods { smb: boolean; robocopy: boolean; nic: boolean }
const settingOn = (v: string | undefined, def: boolean) =>
  v == null || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

async function readOpts(): Promise<{ cycles: number; filename: string; okMbps: number; pauseMs: number; methods: LinkMethods }> {
  const s = await getAllSettings();
  const cycles = Math.max(1, Math.min(20, Number(s['linkspeed.cycles']) || 4));
  const filename = ((s['linkspeed.filename'] ?? '').trim() || 'itdash-speedtest.tmp').replace(/[\\/:*?"<>|]/g, '_');
  const okMbps = Number(s['linkspeed.ok_mbps']) || 200;
  const pauseMs = Math.max(0, Math.min(60000, Number(s['linkspeed.pause_ms']) || 0));
  const methods: LinkMethods = {
    smb: settingOn(s['linkspeed.method.smb'], true),
    robocopy: settingOn(s['linkspeed.method.robocopy'], false),
    nic: settingOn(s['linkspeed.method.nic'], true),
  };
  // Never end up with nothing to do — if the operator turned everything off, fall back to SMB.
  if (!methods.smb && !methods.robocopy && !methods.nic) methods.smb = true;
  return { cycles, filename, okMbps, pauseMs, methods };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Is the current local time inside the [start,end] "HH:MM" window (empty = always)?
function withinWindow(startStr: string | undefined, endStr: string | undefined): boolean {
  const a = /^(\d{1,2}):(\d{2})$/.exec((startStr ?? '').trim());
  const b = /^(\d{1,2}):(\d{2})$/.exec((endStr ?? '').trim());
  if (!a || !b) return true;
  const now = new Date(); const cur = now.getHours() * 60 + now.getMinutes();
  const s = +a[1]! * 60 + +a[2]!; const e = +b[1]! * 60 + +b[2]!;
  return s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e);
}

// Real link-speed test to a live PC/notebook: write an N-MB file from .213 to the
// client's C$ over SMB (= upload), read it back to .213 (= download), and compute
// Mb/s from the wall time. Both endpoints are real machines (not a weak router CPU),
// the transfer physically traverses the link, and it reuses the admin-share access
// the service account already has — so it measures the actual link/connection
// quality (and catches bad cables / 100-Mb ports / congested segments) with no
// vantage problem. Random payload so SMB3 compression can't skew it. The file is
// always deleted from the client afterwards; the target dir is created if missing.

const LOCAL_DIR = 'C:\\tmp\\itdash-speedtest';

export interface LinkSpeedResult {
  target: string;        // exactly what was entered (IP or hostname)
  ip: string | null;     // resolved current IP of the target
  hostname: string | null; // resolved computer name of the target
  sizeMB: number;
  upMbps: number | null;      // SMB single-stream
  downMbps: number | null;
  upMs: number | null;
  downMs: number | null;
  latencyMs: number | null;
  cycles: number;
  nicMbps: number | null;     // negotiated NIC link speed (port), via DCOM CIM
  nicName: string | null;     // the adapter that answered on the target IP
  roboUpMbps: number | null;  // robocopy /MT multi-file throughput
  roboDownMbps: number | null;
  error?: string;
  measuredAt: string;
}

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// Resolve a target string into BOTH its current IP and its hostname, so every result
// carries both regardless of what was entered. A hostname target is forward-resolved
// to its live IP (DNS/WINS) — that IP reveals which segment/interface answered (e.g.
// wifi vs docked cable). Best-effort: unresolved parts stay null.
//
// For an IP target the name is resolved from the LIVE DHCP lease (dhcp_leases, keyed by
// MAC and fed by the routers) first, and only then from the AD inventory — because
// `computers.ip_address` goes stale the moment a PC powers off: the reachability collector
// keeps its last IP (COALESCE, never nulled), the router then hands that IP to a different
// device, and a batch measuring the IP would inherit the powered-off PC's name. The lease
// tracks the actual current tenant of the IP. `inventoryName` is returned alongside so the
// caller can flag "inventory says X but we measured Y" (a stale-IP signal).
async function resolveEndpoint(target: string): Promise<{ ip: string | null; hostname: string | null; inventoryName: string | null }> {
  const t = (target || '').trim();
  const isIp = IP_RE.test(t);
  let ip: string | null = isIp ? t : null;
  let hostname: string | null = isIp ? null : t;
  let inventoryName: string | null = null;
  if (!ip && t) { try { ip = (await dnsLookup(t)).address; } catch { /* unresolved name */ } }
  if (!hostname && ip) {
    const pool = await getPool().catch(() => null);
    // AD inventory name for that IP (may be stale — see above). Fetched independently so a
    // failure of the lease lookup below can't also suppress this fallback.
    if (pool) {
      try {
        const inv = (await pool.request().input('ip', ip)
          .query<{ name: string }>(`SELECT TOP 1 name FROM computers WHERE ip_address=@ip AND name IS NOT NULL`)).recordset[0];
        inventoryName = inv?.name ?? null;
      } catch { /* inventory lookup failed */ }
      try {
        // Live tenant of this IP per the routers (freshest lease wins) — the authority.
        const lease = (await pool.request().input('ip', ip)
          .query<{ host_name: string | null }>(
            `SELECT TOP 1 host_name FROM dhcp_leases
             WHERE ip_address=@ip AND host_name IS NOT NULL AND host_name <> ''
             ORDER BY last_seen DESC`)).recordset[0];
        hostname = lease?.host_name ?? inventoryName;
      } catch { hostname = inventoryName; /* no lease table/row — use inventory */ }
    }
  }
  return { ip, hostname, inventoryName };
}

// Cache a random source file of the requested size on .213 (reused across runs).
async function ensureSource(sizeMB: number): Promise<string> {
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  const src = `${LOCAL_DIR}\\src-${sizeMB}.bin`;
  try { if ((await fs.stat(src)).size === sizeMB * 1024 * 1024) return src; } catch { /* create */ }
  const ws = createWriteStream(src);
  const CHUNK = 4 * 1024 * 1024;
  try {
    for (let written = 0; written < sizeMB * 1024 * 1024; written += CHUNK) {
      const buf = randomBytes(Math.min(CHUNK, sizeMB * 1024 * 1024 - written));
      if (!ws.write(buf)) await new Promise<void>((r) => ws.once('drain', () => r()));
    }
  } finally { ws.end(); }
  await new Promise<void>((res, rej) => { ws.once('finish', () => res()); ws.once('error', rej); });
  return src;
}

const mbps = (bytes: number, ms: number) => (ms > 0 ? Math.round((bytes * 8) / (ms / 1000) / 1e6 * 10) / 10 : null);

// Cache N random chunk files (for robocopy /MT, which parallelises across FILES — a
// single file wouldn't benefit). sizeMB split into ROBO_CHUNKS files under a per-size dir.
const ROBO_CHUNKS = 8;
async function ensureChunkSource(sizeMB: number): Promise<string> {
  const dir = `${LOCAL_DIR}\\chunks-${sizeMB}`;
  const per = Math.max(1, Math.floor(sizeMB / ROBO_CHUNKS));
  await fs.mkdir(dir, { recursive: true });
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.bin'));
    if (files.length === ROBO_CHUNKS) return dir;   // already built
  } catch { /* build */ }
  for (let i = 0; i < ROBO_CHUNKS; i++) {
    const bytes = i === ROBO_CHUNKS - 1 ? (sizeMB - per * (ROBO_CHUNKS - 1)) : per;   // last chunk carries the remainder
    await fs.writeFile(`${dir}\\chunk-${i}.bin`, randomBytes(Math.max(1, bytes) * 1024 * 1024));
  }
  return dir;
}

// Run robocopy and return wall-clock ms for the whole directory copy, or null on a hard
// error. Robocopy exit codes 0-7 mean success (1 = files copied); >=8 is a real failure —
// so we can't rely on the process exit code the way execFile does.
function runRobocopy(srcDir: string, dstDir: string): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('robocopy', [srcDir, dstDir, '/MT:16', '/NP', '/R:0', '/W:0', '/NJH', '/NJS', '/NDL', '/NFL'], { windowsHide: true });
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve((code ?? 16) < 8 ? Date.now() - t0 : null));
  });
}

// robocopy /MT up (→ client C$) + down (→ back to .213), Mb/s from wall time.
async function roboMeasure(target: string, sizeMB: number, remoteBase: string): Promise<{ up: number | null; down: number | null }> {
  const bytes = sizeMB * 1024 * 1024;
  const srcDir = await ensureChunkSource(sizeMB);
  const remoteDir = `${remoteBase}\\rc`;
  const backDir = `${LOCAL_DIR}\\rcback-${target.replace(/[^\w.-]/g, '_')}`;
  await fs.rm(remoteDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(backDir, { recursive: true, force: true }).catch(() => {});
  const upMs = await runRobocopy(srcDir, remoteDir);
  const downMs = upMs == null ? null : await runRobocopy(remoteDir, backDir);
  await fs.rm(backDir, { recursive: true, force: true }).catch(() => {});
  return { up: upMs == null ? null : mbps(bytes, upMs), down: downMs == null ? null : mbps(bytes, downMs) };
}

// Over ONE DCOM CIM session (same transport the disk/eventlog collectors use — plain
// Get-CimInstance would use WinRM, which most domain PCs don't have), read BOTH:
//   • the machine's own name (Win32_ComputerSystem.Name) — the ground truth for "who
//     actually answered on this IP", immune to a stale inventory IP after a DHCP
//     reassignment (a powered-off PC keeps its last IP in `computers`, which then gets
//     handed to a different device — that mismatch is exactly what we correct here);
//   • the negotiated link speed of the NIC that owns the target IP.
// Best-effort: any failure (DC denies DCOM, host offline, no matching adapter) resolves
// to null, never throws. Machine name is emitted first so a NIC name containing a '|'
// can't corrupt it. Returns an object (machine possibly null) whenever the session opened
// at all — a null result specifically means the host didn't answer DCOM.
function readHostInfo(host: string, ip: string | null): Promise<{ mbps: number | null; name: string | null; machine: string | null } | null> {
  const ps = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$opt = New-CimSessionOption -Protocol Dcom
$s = New-CimSession -ComputerName '${host}' -SessionOption $opt -ErrorAction Stop
try {
  $cs = Get-CimInstance -CimSession $s Win32_ComputerSystem -ErrorAction SilentlyContinue
  $machine = if ($cs) { $cs.Name } else { '' }
  $ip = '${ip ?? ''}'
  $na = $null
  if ($ip) {
    $cfg = Get-CimInstance -CimSession $s Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=true' -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -contains $ip } | Select-Object -First 1
    if ($cfg) { $na = Get-CimInstance -CimSession $s Win32_NetworkAdapter -Filter ("Index=" + $cfg.Index) -ErrorAction SilentlyContinue }
  }
  if (-not $na) {
    $na = Get-CimInstance -CimSession $s Win32_NetworkAdapter -Filter 'NetConnectionStatus=2' -ErrorAction SilentlyContinue |
      Where-Object { $_.Speed -gt 0 } | Sort-Object Speed -Descending | Select-Object -First 1
  }
  $spd = if ($na) { [int64]$na.Speed } else { 0 }
  $nic = if ($na) { $na.Name } else { '' }
  "$machine|$spd|$nic"
} finally { Remove-CimSession $s }
`;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 12000 });
    let out = '';
    p.stdout.on('data', (b) => (out += b.toString('utf8')));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const line = out.trim().split(/\r?\n/).find((l) => l.includes('|'));
      if (!line) return resolve(null);
      const parts = line.split('|');
      const machine = (parts[0] ?? '').trim() || null;
      const speed = Number(parts[1]);
      const nic = parts.slice(2).join('|').trim() || null;   // NIC name last — tolerant of a stray '|'
      resolve({ mbps: Number.isFinite(speed) && speed > 0 ? Math.round(speed / 1e6) : null, name: nic, machine });
    });
  });
}

async function archive(r: LinkSpeedResult, runId: string | null = null): Promise<void> {
  try {
    const pool = await getPool();
    await pool.request()
      .input('t', r.target).input('ip', r.ip).input('hn', r.hostname).input('up', r.upMbps).input('down', r.downMbps)
      .input('ums', r.upMs).input('dms', r.downMs).input('sz', r.sizeMB).input('err', r.error ?? null).input('lat', r.latencyMs).input('cyc', r.cycles)
      .input('nic', r.nicMbps).input('nicn', r.nicName).input('rup', r.roboUpMbps).input('rdown', r.roboDownMbps).input('run', runId)
      .query(`INSERT INTO link_speed_results (target, ip_address, host_name, up_mbps, down_mbps, up_ms, down_ms, size_mb, error, latency_ms, cycles, nic_mbps, nic_name, robo_up_mbps, robo_down_mbps, run_id)
              VALUES (@t,@ip,@hn,@up,@down,@ums,@dms,@sz,@err,@lat,@cyc,@nic,@nicn,@rup,@rdown,@run)`);
  } catch (e) { console.error('link-speed archive failed', e); }
}

// One measurement (no concurrency guard) — N cycles of write-to-C$ + read-back, keep
// the BEST up/down of the cycles (transient AV/CPU dips don't understate capacity),
// plus a ping RTT. The test file (linkspeed.filename) is deleted afterwards.
async function measure(target: string, sizeMB: number, cycles: number, filename: string, ep: { ip: string | null; hostname: string | null }, methods: LinkMethods, onCycle?: (done: number) => void): Promise<LinkSpeedResult> {
  const bytes = sizeMB * 1024 * 1024;
  const remoteDir = `\\\\${target}\\C$\\tmp\\itdash-speedtest`;
  const remoteFile = `${remoteDir}\\${filename}`;
  const localBack = `${LOCAL_DIR}\\back-${target.replace(/[^\w.-]/g, '_')}.bin`;
  // NIC negotiated speed is transport-independent (DCOM, not C$) — read it first and
  // keep it even if the SMB/robocopy part later fails (e.g. C$ denied). The same session
  // also returns the machine's OWN name: when present it overrides the (possibly stale)
  // inventory/lease name, so the result is always attributed to the box we actually
  // measured — not the previous tenant of a reassigned DHCP IP. Best-effort.
  let nicMbps: number | null = null, nicName: string | null = null;
  let hostname = ep.hostname;
  if (methods.nic) {
    const info = await readHostInfo(target, ep.ip).catch(() => null);
    if (info) { nicMbps = info.mbps; nicName = info.name; if (info.machine) hostname = info.machine; }
  }
  const base = { target, ip: ep.ip, hostname, sizeMB, cycles, measuredAt: new Date().toISOString() };

  const needsShare = methods.smb || methods.robocopy;
  try {
    let bU = 0, bUms: number | null = null, bD = 0, bDms: number | null = null;
    let roboUp: number | null = null, roboDown: number | null = null;
    if (needsShare) {
      await fs.mkdir(remoteDir, { recursive: true });
      if (methods.smb) {
        const src = await ensureSource(sizeMB);
        for (let i = 0; i < cycles; i++) {
          const t1 = Date.now();
          await pipeline(createReadStream(src), createWriteStream(remoteFile));
          const upMs = Date.now() - t1;
          const t2 = Date.now();
          await pipeline(createReadStream(remoteFile), createWriteStream(localBack));
          const downMs = Date.now() - t2;
          const u = mbps(bytes, upMs) ?? 0, d = mbps(bytes, downMs) ?? 0;
          if (u > bU) { bU = u; bUms = upMs; }
          if (d > bD) { bD = d; bDms = downMs; }
          onCycle?.(i + 1);   // report cycle progress for the live terminal
        }
      }
      if (methods.robocopy) { const rc = await roboMeasure(target, sizeMB, remoteDir); roboUp = rc.up; roboDown = rc.down; }
    }
    const latencyMs = await pingLatency(target, 1000);
    await fs.rm(remoteDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(localBack, { force: true }).catch(() => {});
    return { ...base, upMbps: bU || null, downMbps: bD || null, upMs: bUms, downMs: bDms, latencyMs, nicMbps, nicName, roboUpMbps: roboUp, roboDownMbps: roboDown };
  } catch (e) {
    await fs.rm(remoteDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(localBack, { force: true }).catch(() => {});
    return { ...base, upMbps: null, downMbps: null, upMs: null, downMs: null, latencyMs: null, nicMbps, nicName, roboUpMbps: null, roboDownMbps: null, error: String(e).split('\n')[0]!.slice(0, 200) };
  }
}

// Clamp a caller-supplied cycle count to 1..20, or fall back to the settings value
// when it's missing/invalid — the UI field takes precedence over linkspeed.cycles.
const effCycles = (override: number | undefined, fromSettings: number): number =>
  override != null && Number.isFinite(override) && override >= 1 ? Math.min(20, Math.floor(override)) : fromSettings;

let single = false;
// On-demand single PC test (used by the per-PC button). Archived to DB.
export async function runLinkSpeedTest(target: string, sizeMB: number, cyclesOverride?: number): Promise<LinkSpeedResult> {
  if (single) return { target, ip: null, hostname: null, sizeMB, upMbps: null, downMbps: null, upMs: null, downMs: null, latencyMs: null, cycles: 0, nicMbps: null, nicName: null, roboUpMbps: null, roboDownMbps: null, error: 'already_running', measuredAt: new Date().toISOString() };
  single = true;
  try {
    const { cycles, filename, methods } = await readOpts();
    const ep = await resolveEndpoint(target);
    const key = await hostKey(target);   // serialize per PC (identity, not IP) — no other heavy op runs on it meanwhile
    const r = await withHostLock(key, () => measure(target, sizeMB, effCycles(cyclesOverride, cycles), filename, ep, methods));
    await archive(r); return r;
  }
  finally { single = false; }
}

// --- batch (the measurement page) -----------------------------------------------
export interface BatchState {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  cycleDone: number;    // cycles finished on the CURRENT target (live)
  cycleTotal: number;   // cycles planned per target this run (0 = skipped host)
  sizeMB: number;
  startedAt: string | null;
  results: LinkSpeedResult[];
}
let batch: BatchState = { running: false, total: 0, done: 0, current: null, cycleDone: 0, cycleTotal: 0, sizeMB: 0, startedAt: null, results: [] };
let stopRequested = false;
export function getLinkSpeedStatus(): BatchState { return batch; }
// Abort a running batch after the current PC finishes (an in-flight transfer isn't
// cut mid-stream). Returns false if nothing is running.
export function stopLinkSpeed(): boolean { if (!batch.running) return false; stopRequested = true; return true; }

// "10.8.2.*", "10.8.2.180-182", bare IPs/hostnames, comma/space/newline separated.
// "all" must be pre-expanded by the caller (to active computer names) and passed in.
export function parseTargets(raw: string, allNames: string[]): string[] {
  const out = new Set<string>();
  for (const tok of String(raw).split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)) {
    if (tok.toLowerCase() === 'all') { allNames.forEach((n) => out.add(n)); continue; }
    let m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\*$/.exec(tok);
    if (m) { for (let i = 1; i <= 254; i++) out.add(`${m[1]}.${i}`); continue; }
    m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/.exec(tok);
    if (m) { const a = Math.min(+m[2]!, +m[3]!), b = Math.max(+m[2]!, +m[3]!); for (let i = a; i <= b; i++) out.add(`${m[1]}.${i}`); continue; }
    out.add(tok);
  }
  return [...out].slice(0, 512);
}

// Run a batch sequentially in the background (200 MB/PC — don't flood). Each target
// is SMB-prechecked (TCP 445) so dead/non-SMB IPs are skipped fast, then measured
// and archived. Progress is polled via getLinkSpeedStatus().
export async function runLinkSpeedBatch(targets: string[], sizeMB: number, cyclesOverride?: number): Promise<void> {
  if (batch.running) return;
  stopRequested = false;
  batch = { running: true, total: targets.length, done: 0, current: null, cycleDone: 0, cycleTotal: 0, sizeMB, startedAt: new Date().toISOString(), results: [] };
  const runId = batch.startedAt!;   // "otisk" — every target in this batch shares it
  const { cycles: cyclesSetting, filename, okMbps, pauseMs, methods } = await readOpts();
  const cycles = effCycles(cyclesOverride, cyclesSetting);
  const needsShare = methods.smb || methods.robocopy;
  const methodList = [methods.smb && 'SMB', methods.robocopy && 'Robocopy', methods.nic && 'NIC'].filter(Boolean).join('+');
  logActivity('info', 'linkspeed', `Měření spuštěno: ${targets.length} cílů · ${sizeMB} MB · ${cycles}× cyklů · ${methodList}${pauseMs ? ` · prodleva ${pauseMs} ms` : ''}`);
  let nOk = 0, nSlow = 0, nOff = 0, nErr = 0;
  try {
    for (let idx = 0; idx < targets.length; idx++) {
      const t = targets[idx]!;
      if (stopRequested) break;
      // Idle gap between PCs (not before the first) — eases sustained load on .213's
      // uplink and leaves room for other collectors. Interruptible via stopRequested.
      if (idx > 0 && pauseMs > 0) { await sleep(pauseMs); if (stopRequested) break; }
      batch.current = t;
      batch.cycleDone = 0; batch.cycleTotal = methods.smb ? cycles : 0;   // reset cycle progress for this target
      const ep = await resolveEndpoint(t);   // capture IP + hostname even for skipped hosts
      let r: LinkSpeedResult;
      // Reachability gate: SMB/robocopy need C$ (445); a NIC-only run needs just a ping.
      const share445 = needsShare ? (await tcpProbeTimed(t, 445, 2500)) != null : false;
      const alive = share445 ? true : await pingAlive(t, 1000);
      if (needsShare ? !share445 : !alive) {
        // Offline (no ping) vs up-but-445-blocked — labelled differently so offline
        // isn't mistaken for a port problem. Still grab the NIC speed if alive.
        batch.cycleTotal = 0;
        r = { target: t, ip: ep.ip, hostname: ep.hostname, sizeMB, upMbps: null, downMbps: null, upMs: null, downMs: null, latencyMs: null, cycles: 0, nicMbps: null, nicName: null, roboUpMbps: null, roboDownMbps: null, error: alive ? 'SMB/445 blokováno' : 'offline', measuredAt: new Date().toISOString() };
        if (methods.nic && alive) { const info = await withHostLock(await hostKey(t), () => readHostInfo(t, ep.ip)).catch(() => null); if (info) { r.nicMbps = info.mbps; r.nicName = info.name; if (info.machine) r.hostname = info.machine; } }
      } else {
        // Serialize per PC identity so no other heavy op skews the transfer.
        const key = await hostKey(t);
        r = await withHostLock(key, () => measure(t, sizeMB, cycles, filename, ep, methods, (d) => { batch.cycleDone = d; }));
      }
      await archive(r, runId);
      batch.results.push(r);
      batch.done++;
      // Log each result to the activity feed (warn = slow, error = hard error).
      const off = !!r.error && /offline/i.test(r.error);
      const isErr = !!r.error && !off;
      // Throughput verdict uses SMB if present, else robocopy (whichever method ran).
      const eUp = r.upMbps ?? r.roboUpMbps, eDown = r.downMbps ?? r.roboDownMbps;
      const slow = !r.error && eUp != null && eDown != null && Math.min(eUp, eDown) < okMbps;
      if (off) nOff++; else if (isErr) nErr++; else if (slow) nSlow++; else nOk++;
      const parts: string[] = [];
      if (r.upMbps != null) parts.push(`↑${r.upMbps} ↓${r.downMbps}`);
      if (r.roboUpMbps != null) parts.push(`RC↑${r.roboUpMbps} ↓${r.roboDownMbps}`);
      if (r.nicMbps != null) parts.push(`port ${r.nicMbps}`);
      // Stale-IP signal: the box that actually answered names itself differently than the
      // AD inventory has recorded for this IP → the inventory row still points at a PC that
      // has since powered off and given up its DHCP lease. Only flag when the device really
      // responded (name confirmed over SMB/DCOM), never on an offline guess.
      const responded = !off && (r.nicMbps != null || !r.error);
      const stale = responded && ep.inventoryName && r.hostname && ep.inventoryName.toLowerCase() !== r.hostname.toLowerCase();
      const name = r.hostname ? ` [${r.hostname}]` : '';
      const staleNote = stale ? ` · ⚠ inventář uvádí ${ep.inventoryName} (stará IP)` : '';
      const msg = r.error ? `${t}${name}: ${r.error}${staleNote}` : `${t}${name}: ${parts.join(' · ') || '—'} Mb/s${r.latencyMs != null ? ` · ${r.latencyMs} ms` : ''}${slow ? ' — POMALÉ' : ''}${staleNote}`;
      logActivity(isErr ? 'error' : slow || stale ? 'warn' : 'info', 'linkspeed', msg);
    }
    logActivity('info', 'linkspeed', `Měření dokončeno: ${nOk} OK · ${nSlow} pomalé · ${nOff} offline · ${nErr} chyba`);
  } finally {
    batch.running = false;
    batch.current = null;
  }
}

// Resolve a raw target string into a concrete IP/host list: expand "all" to the IPs
// of active PCs/servers, expand ranges, then drop any host on the exclusion list
// (linkspeed.exclude_hosts — matched by hostname or IP). Shared by the route + the
// scheduler so both behave the same. The scheduler ALWAYS honours exclusions; a manual
// run may pass { ignoreExclusions } to deliberately measure excluded hosts too.
export async function expandTargets(raw: string, opts?: { ignoreExclusions?: boolean }): Promise<string[]> {
  const s = await getAllSettings();
  let allTargets: string[] = [];
  if (/\ball\b/i.test(raw)) {
    const pool = await getPool();
    // Same leniency as the crash-dump collector: take reachable PCs AND not-yet-checked
    // ones that aren't persistently failing — branch PCs flap on slow links, so strict
    // reachable=1 dropped too many. The fast 445/ping probe skips the genuinely dead.
    allTargets = (await pool.request().query<{ ip_address: string }>(
      `SELECT ip_address FROM computers
       WHERE enabled=1 AND excluded=0 AND ip_address IS NOT NULL
         AND (reachable=1 OR (reachable IS NULL AND consecutive_failures < 10))`)).recordset.map((r) => r.ip_address);
  }
  let targets = parseTargets(raw, allTargets);
  // Exclusions accept the SAME syntax as targets — bare hostnames/IPs, ranges
  // "10.8.2.180-182" and wildcards "10.8.2.*" — so ranges/IPs are expanded to
  // concrete IPs (hostnames pass through). A target is dropped if its IP is
  // excluded, or if the hostname behind that IP is excluded.
  const exclRaw = (s['linkspeed.exclude_hosts'] ?? '').trim();
  const excl = new Set(opts?.ignoreExclusions ? [] : parseTargets(exclRaw, []).map((x) => x.toLowerCase()));
  if (excl.size && targets.length) {
    const pool = await getPool();
    const ipToName = new Map<string, string>();
    (await pool.request().query<{ ip_address: string; name: string }>(
      `SELECT ip_address, name FROM computers WHERE ip_address IS NOT NULL`)).recordset.forEach((r) => ipToName.set(r.ip_address, (r.name || '').toLowerCase()));
    targets = targets.filter((t) => !excl.has(t.toLowerCase()) && !excl.has(ipToName.get(t) || ''));
  }
  return targets;
}

// --- scheduled measurement -------------------------------------------------------
const boolS = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').toLowerCase());
let schedTimer: NodeJS.Timeout | null = null;
let schedStopped = false;

// Rolling "continuous" monitoring: pick the STALEST due targets, oldest attempt first, up
// to `n`. Freshness is judged on the last SUCCESSFUL measurement (freshMs = interval); a
// target with only an offline/error result is retried on a SHORT cadence (retryMs) so a PC
// that's off in the morning gets caught the moment it comes online during the day, instead
// of being written off as "offline" for the whole interval. Read from the DB (survives
// restarts). Returns [] when nothing is due.
async function pickDueTargets(candidates: string[], freshMs: number, retryMs: number, n: number): Promise<string[]> {
  if (!candidates.length) return [];
  const pool = await getPool();
  const rows = (await pool.request().query<{ k: string; t: Date; okt: Date | null }>(
    `SELECT COALESCE(ip_address, target) AS k, MAX(measured_at) AS t,
            MAX(CASE WHEN error IS NULL THEN measured_at END) AS okt
     FROM link_speed_results GROUP BY COALESCE(ip_address, target)`)).recordset;
  const lastAny = new Map<string, number>(), lastOk = new Map<string, number>();
  for (const r of rows) { if (!r.k) continue; const k = r.k.toLowerCase(); lastAny.set(k, new Date(r.t).getTime()); if (r.okt) lastOk.set(k, new Date(r.okt).getTime()); }
  const now = Date.now();
  return candidates
    .map((c) => ({ c, any: lastAny.get(c.toLowerCase()) ?? 0, ok: lastOk.get(c.toLowerCase()) ?? 0 }))
    .filter((x) => (now - x.ok >= freshMs) && (now - x.any >= retryMs))   // needs a fresh success AND not just attempted
    .sort((a, b) => a.any - b.any)   // oldest attempt first — fair rotation
    .slice(0, n)
    .map((x) => x.c);
}

export async function startLinkSpeedSchedule(): Promise<void> {
  schedStopped = false;
  if (schedTimer) { clearTimeout(schedTimer); schedTimer = null; }
  const loop = async () => {
    if (schedStopped) return;
    let tickMs = 20 * 60 * 1000;
    try {
      const s = await getAllSettings();
      tickMs = Math.max(2, Math.min(240, Number(s['linkspeed.tick_min']) || 20)) * 60 * 1000;
      if (boolS(s['linkspeed.enabled'])) {
        const raw = (s['linkspeed.targets'] ?? '').trim();
        const inWindow = withinWindow(s['linkspeed.window_start'], s['linkspeed.window_end']);
        if (raw && inWindow && !batch.running) {
          // Each PC is re-measured roughly every interval_hours; we do a small batch per
          // tick (batch_size) so the load is spread instead of one big hourly sweep.
          const freshMs = Math.max(0.1, Number(s['linkspeed.interval_hours']) || 24) * 3600 * 1000;
          const retryMs = Math.max(5, Math.min(1440, Number(s['linkspeed.retry_min']) || 45)) * 60 * 1000;
          const batchSize = Math.max(1, Math.min(200, Number(s['linkspeed.batch_size']) || 6));
          const due = await pickDueTargets(await expandTargets(raw), freshMs, retryMs, batchSize);
          if (due.length) {
            const sizeMB = Math.max(1, Math.min(1024, Number(s['linkspeed.size_mb']) || 100));
            void runLinkSpeedBatch(due, sizeMB);
          }
        }
      }
    } catch (e) {
      console.error('link-speed schedule error', e);
    }
    if (!schedStopped) schedTimer = setTimeout(loop, tickMs);
  };
  schedTimer = setTimeout(loop, 60 * 1000);   // first tick 1 min after boot
  console.log('Link-speed rolling schedule started (stalest-N per tick)');
}
