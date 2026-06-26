import { execFile } from 'node:child_process';
import { reverse as dnsReverseCb } from 'node:dns';
import { promisify } from 'node:util';
import { getPool } from '../db/pool.js';
import { getAllSettings, type SettingsMap } from './settings.js';
import { decryptSecret } from './secret-crypto.js';
import { boolSetting } from './alerts-util.js';
import { evaluateAndSendPrinterAlerts, evaluateAndSendDataFreshnessAlerts } from './alerts.js';
import { logActivity } from './activity-log.js';
import { icmpPing } from './reachability-collector.js';
import { pingWithOutput } from './port-status-collector.js';
import { parseNbtstat } from './netbios-util.js';
import { type ScanRange, maskOf, ipToInt, parseScanRanges, siteForIp, hostsOf } from './mikrotik-util.js';
import { fetchFtpSite, type FtpSiteResult, type FtpLease, type FtpArp } from './mikrotik-ftp.js';

// MikroTik DHCP lease collector. Pulls active leases from each configured
// RouterOS v7 router via the REST API and upserts them into dhcp_leases.
//
// Config is fully DB-driven from the Settings page (no secrets / IPs in env):
//   mikrotik.enabled       — master on/off for the in-app collector
//   mikrotik.routers        — "Brno=10.8.2.207,Zastavka=10.10.181.2"
//   mikrotik.user           — RouterOS read-only account (default "dhcp-reader")
//   mikrotik.password_enc   — AES-encrypted password (decryptSecret)
//   mikrotik.interval_sec   — standalone probe cadence, default 300s
// Only MIKROTIK_SECRET stays in env (the key that decrypts the password). With
// the master toggle off (or no routers configured) the collector is a no-op, so
// it never 401-spams a router that hasn't whitelisted the app server yet.

interface Router { site: string; ip: string; }

function parseRouters(raw: string | undefined): Router[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  const out: Router[] = [];
  for (const tok of s.split(/[,;]+/).map((x) => x.trim()).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const site = tok.slice(0, eq).trim();
    const ip = tok.slice(eq + 1).trim();
    if (site && ip) out.push({ site, ip });
  }
  return out;
}

// Resolve the live collector config from Settings. Returns null when the
// collector should NOT run (disabled or no routers configured). The password is
// decrypted here so callers never see the ciphertext.
interface MtConfig { routers: Router[]; user: string; pass: string; intervalSec: number; scanEnabled: boolean; scanRanges: ScanRange[]; ipscan: boolean; ipscanSec: number; ftpEnabled: boolean; ftpSites: Set<string>; }

// Sites (router names) whose router writes the export files we pull over FTP.
// Tolerant of the "Site=IP" form (same as mikrotik.routers): only the name before
// "=" is kept, so the operator can paste the routers list verbatim if they like.
function parseFtpSites(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(/[,;\r\n]+/).map((s) => s.split('=')[0]!.trim()).filter(Boolean));
}

function resolveConfig(settings: SettingsMap): MtConfig | null {
  if (!boolSetting(settings['mikrotik.enabled'])) return null;
  const routers = parseRouters(settings['mikrotik.routers']);
  const scanEnabled = boolSetting(settings['mikrotik.scan_enabled']);
  const scanRanges = scanEnabled ? parseScanRanges(settings['mikrotik.scan_ranges']) : [];
  // Run if we have at least one source of devices (routers OR an active scan).
  if (routers.length === 0 && scanRanges.length === 0) return null;
  const user = (settings['mikrotik.user'] ?? '').trim() || 'dhcp-reader';
  const enc = settings['mikrotik.password_enc'] ?? '';
  let pass = '';
  try { pass = enc ? decryptSecret(enc) : ''; } catch { pass = ''; }
  const n = Number(settings['mikrotik.interval_sec']);
  const intervalSec = Number.isFinite(n) && n >= 30 ? Math.floor(n) : 300;
  // Router-side ip-scan (NETBIOS/DNS names) — ON by default; per-router /24 scan.
  const ipscan = boolSetting(settings['mikrotik.ipscan'] ?? '1');
  const ds = Number(settings['mikrotik.ipscan_duration_sec']);
  const ipscanSec = Number.isFinite(ds) && ds >= 3 && ds <= 60 ? Math.floor(ds) : 10;
  // FTP file source (IP_scan.txt + ARP_scan.txt) — ON by default, but only for
  // the sites whose router actually produces the files (mikrotik.ftp_sites).
  const ftpEnabled = boolSetting(settings['mikrotik.ftp_enabled'] ?? '1');
  const ftpSites = parseFtpSites(settings['mikrotik.ftp_sites']);
  return { routers, user, pass, intervalSec, scanEnabled, scanRanges, ipscan, ipscanSec, ftpEnabled, ftpSites };
}

// RouterOS REST lease object (only the fields we use; keys are dash-cased).
interface RawLease {
  'address'?: string;
  'active-address'?: string;
  'mac-address'?: string;
  'active-mac-address'?: string;
  'host-name'?: string;
  'server'?: string;
  'comment'?: string;
  'status'?: string;
  'dynamic'?: string | boolean;
  'expires-after'?: string;
  'last-seen'?: string;
}

function normMac(mac: string | undefined): string {
  return (mac ?? '').trim().toUpperCase();
}

function toBool(v: string | boolean | undefined): boolean | null {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  return v.toLowerCase() === 'true';
}

// RouterOS REST ARP object (only the fields we use).
interface RawArp {
  'address'?: string;
  'mac-address'?: string;
  'interface'?: string;
  'dynamic'?: string | boolean;
  'complete'?: string | boolean;
  'disabled'?: string | boolean;
}

// RouterOS REST ip-scan result row (POST /rest/tool/ip-scan). Carries NETBIOS +
// reverse-DNS names that lease/arp don't — and crucially the ROUTER runs the scan
// from inside the subnet, so NetBIOS resolves (it's firewalled from the app
// server), naming static printers/servers the lease/arp tables can't.
interface RawIpScan {
  '.section'?: string;
  'address'?: string;
  'mac-address'?: string;
  'dns'?: string;
  'netbios'?: string;
  'snmp'?: string;
}

async function routerGet<T>(routerIp: string, path: string, user: string, pass: string, timeoutMs: number): Promise<T[]> {
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${routerIp}${path}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? (data as T[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

function fetchLeases(router: Router, user: string, pass: string, timeoutMs: number): Promise<RawLease[]> {
  return routerGet<RawLease>(router.ip, '/rest/ip/dhcp-server/lease', user, pass, timeoutMs);
}

function fetchArp(router: Router, user: string, pass: string, timeoutMs: number): Promise<RawArp[]> {
  return routerGet<RawArp>(router.ip, '/rest/ip/arp', user, pass, timeoutMs);
}

async function routerPost<T>(routerIp: string, path: string, body: unknown, user: string, pass: string, timeoutMs: number): Promise<T[]> {
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${routerIp}${path}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? (data as T[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

// Active ip-scan ON the router for `durationSec`, scanning the /24 of the router's
// own IP. The POST blocks for the duration, so its timeout is duration + a margin.
function fetchIpScan(router: Router, user: string, pass: string, durationSec: number): Promise<RawIpScan[]> {
  const oct = router.ip.split('.');
  if (oct.length !== 4) return Promise.resolve([]);
  const range = `${oct[0]}.${oct[1]}.${oct[2]}.0/24`;
  return routerPost<RawIpScan>(router.ip, '/rest/tool/ip-scan',
    { 'address-range': range, duration: String(durationSec) }, user, pass, durationSec * 1000 + 15000);
}

// Normalized device shape merged from all sources (DHCP lease / router ARP /
// active scan) before upsert. `source` records where we learned it.
type DeviceSource = 'dhcp' | 'arp' | 'scan';
interface NormDevice {
  site: string;
  mac: string;
  ip: string | null;
  host: string | null;
  server: string | null;
  comment: string | null;
  status: string | null;
  dynamic: boolean | null;   // false = static (DHCP reservation / ARP-only / scanned)
  exp: string | null;
  rls: string | null;
  source: DeviceSource;
}

function leaseToNorm(site: string, l: RawLease): NormDevice | null {
  const mac = normMac(l['mac-address'] ?? l['active-mac-address']);
  if (!mac) return null;
  return {
    site, mac,
    ip: (l['active-address'] ?? l['address'] ?? '').trim() || null,
    host: (l['host-name'] ?? '').trim() || null,
    server: (l['server'] ?? '').trim() || null,
    comment: (l['comment'] ?? '').trim() || null,
    status: (l['status'] ?? '').trim() || null,
    dynamic: toBool(l['dynamic']),
    exp: (l['expires-after'] ?? '').trim() || null,
    rls: (l['last-seen'] ?? '').trim() || null,
    source: 'dhcp',
  };
}

// ARP-only device = not a DHCP client, so it's statically addressed → dynamic=false.
function arpToNorm(site: string, a: RawArp): NormDevice | null {
  const mac = normMac(a['mac-address']);
  if (!mac) return null;
  const ip = (a['address'] ?? '').trim() || null;
  if (!ip) return null;
  return { site, mac, ip, host: null, server: null, comment: null, status: 'arp', dynamic: false, exp: null, rls: null, source: 'arp' };
}

// FTP file rows → NormDevice. The lease file is DHCP data (source 'dhcp'); ARP
// rows are statically-addressed devices not in DHCP (source 'arp', dynamic=false).
// The transport (FTP vs REST) isn't recorded in `source` — it's tracked per site
// in site_data_status; both transports dedupe into the same (site, mac) row.
function ftpLeaseToNorm(site: string, l: FtpLease): NormDevice {
  return {
    site, mac: normMac(l.mac), ip: l.ip, host: l.host, server: l.server, comment: null,
    status: l.status, dynamic: l.dynamic, exp: l.exp, rls: l.lastSeen, source: 'dhcp',
  };
}
function ftpArpToNorm(site: string, a: FtpArp): NormDevice {
  return { site, mac: normMac(a.mac), ip: a.ip, host: null, server: null, comment: null, status: 'arp', dynamic: false, exp: null, rls: null, source: 'arp' };
}

// Persist a site's FTP pull outcome (file header timestamps, parsed counts, last
// error) for the Phase-2 data-freshness / availability alert. Best-effort.
async function recordSiteStatus(site: string, r: FtpSiteResult): Promise<void> {
  try {
    // Signature of the newest file timestamp — used to detect (timezone-free)
    // whether the data is actually advancing. file_changed_at moves to real-UTC
    // now only when this signature changes, so the freshness alert never has to
    // compare the router's local file clock against UTC now.
    const times = [r.leaseTime, r.arpTime].filter((d): d is Date => d != null).map((d) => d.getTime());
    const sig = times.length ? String(Math.max(...times)) : null;
    const pool = await getPool();
    await pool.request()
      .input('site', site).input('lt', r.leaseTime).input('at', r.arpTime)
      .input('lc', r.leases.length).input('ac', r.arp.length)
      .input('got', r.leaseTime || r.arpTime ? 1 : 0).input('sig', sig).input('err', r.error)
      .query(`
        MERGE site_data_status AS t USING (SELECT @site AS site) AS s ON t.site = s.site
        WHEN MATCHED THEN UPDATE SET
          lease_file_time = COALESCE(@lt, t.lease_file_time),
          arp_file_time = COALESCE(@at, t.arp_file_time),
          lease_count = @lc, arp_count = @ac,
          fetched_at = CASE WHEN @got = 1 THEN SYSUTCDATETIME() ELSE t.fetched_at END,
          file_changed_at = CASE WHEN @sig IS NOT NULL AND (t.last_file_sig IS NULL OR t.last_file_sig <> @sig)
                                 THEN SYSUTCDATETIME() ELSE t.file_changed_at END,
          last_file_sig = COALESCE(@sig, t.last_file_sig),
          last_error = @err, updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (site, lease_file_time, arp_file_time, lease_count, arp_count, fetched_at, file_changed_at, last_file_sig, last_error)
          VALUES (@site, @lt, @at, @lc, @ac,
                  CASE WHEN @got = 1 THEN SYSUTCDATETIME() ELSE NULL END,
                  CASE WHEN @sig IS NOT NULL THEN SYSUTCDATETIME() ELSE NULL END, @sig, @err);
      `);
  } catch { /* best-effort status; never block a collect */ }
}

export interface FtpFetchLog { site: string; ip: string; ok: boolean; lines: string[]; }

// Force an FTP pull of the configured FTP sites NOW and return a per-site
// communication log — backs the Routers page "fetch now" button + its console.
// Records site_data_status so the freshness cards refresh immediately; the full
// device merge into dhcp_leases still happens on the next regular collect.
export async function runFtpFetchOnce(): Promise<FtpFetchLog[]> {
  const settings = await getAllSettings();
  const cfg = resolveConfig(settings);
  const out: FtpFetchLog[] = [];
  if (!cfg) { return out; }
  if (!cfg.ftpEnabled) { out.push({ site: '—', ip: '', ok: false, lines: ['FTP zdroj je vypnutý (Nastavení → MikroTik → „Číst i ze souborů přes FTP").'] }); return out; }
  const ftpRouters = cfg.routers.filter((r) => cfg.ftpSites.has(r.site));
  if (ftpRouters.length === 0) { out.push({ site: '—', ip: '', ok: false, lines: ['Žádná FTP lokalita není nastavená (Nastavení → MikroTik → „FTP lokality").'] }); return out; }
  for (const router of ftpRouters) {
    const lines: string[] = [`→ FTP ${router.ip}  (účet ${cfg.user})`];
    const t0 = Date.now();
    const ftp = await fetchFtpSite({ host: router.ip, user: cfg.user, pass: cfg.pass }, { lease: 'IP_scan.txt', arp: 'ARP_scan.txt' });
    if (ftp.leaseTime) lines.push(`  ✓ IP_scan.txt  — ${ftp.leases.length} leasů  (čas souboru ${ftp.leaseTime.toISOString().replace('T', ' ').slice(0, 19)})`);
    else lines.push('  ✗ IP_scan.txt  — nestaženo');
    if (ftp.arpTime) lines.push(`  ✓ ARP_scan.txt — ${ftp.arp.length} ARP záznamů  (čas souboru ${ftp.arpTime.toISOString().replace('T', ' ').slice(0, 19)})`);
    else lines.push('  ✗ ARP_scan.txt — nestaženo');
    if (ftp.error) lines.push(`  ⚠ ${ftp.error}`);
    // Round-trip into the DB: merge the parsed rows into dhcp_leases by MAC (leases
    // win, ARP adds statics) so the device inventory updates now — not only on the
    // next regular collect — and report the write count.
    let written = 0;
    if (ftp.leaseTime || ftp.arpTime) {
      const byMac = new Map<string, NormDevice>();
      for (const l of ftp.leases) byMac.set(normMac(l.mac), ftpLeaseToNorm(router.site, l));
      for (const a of ftp.arp) if (!byMac.has(normMac(a.mac))) byMac.set(normMac(a.mac), ftpArpToNorm(router.site, a));
      for (const d of byMac.values()) { if (await upsertDevice(d)) written++; }
      lines.push(`  → zapsáno do DB: ${written} zařízení (leasy+ARP sloučené přes MAC)`);
    }
    lines.push(`  hotovo za ${Date.now() - t0} ms`);
    await recordSiteStatus(router.site, ftp);
    out.push({ site: router.site, ip: router.ip, ok: !ftp.error && (!!ftp.leaseTime || !!ftp.arpTime), lines });
  }
  return out;
}

// Clean a usable host name from an ip-scan row: NETBIOS short name (before the
// "/WORKGROUP" domain part) first, else the reverse-DNS short host, else SNMP.
function ipScanName(s: RawIpScan): string | null {
  const nb = (s.netbios ?? '').trim();
  if (nb) { const n = nb.split('/')[0]!.trim(); if (n) return n; }
  const dns = (s.dns ?? '').trim().replace(/\.+$/, '');
  if (dns) { const short = dns.split('.')[0]!.trim(); if (short) return short; }
  const snmp = (s.snmp ?? '').trim();
  return snmp || null;
}

// --- Device category suggestion (operator can override) ----------------------
// MAC OUI prefixes (AA:BB:CC) for printer-centric vendors — these makes are
// almost always printers, so an OUI hit is a safe "printer" hint. (HP/others are
// left to hostname matching since their OUIs also cover PCs.) The category is
// generic `printer` — the vendor is just the reason we suspect it's a printer.
const PRINTER_OUI = new Set<string>([
  '00:07:4D', '48:A4:93', 'AC:3F:A4', '84:25:3F', '00:15:70', '2C:3A:E8', // Zebra
  '00:1E:8F', '2C:9E:FC', '88:87:17', 'F4:81:39', '00:00:85', '18:0C:AC', // Canon
  '00:C0:EE', '00:17:C8',                                                 // Kyocera
]);

// Heuristic only — never written to the operator-owned category, just shown as a
// greyed suggestion in the UI. Returns '' when nothing matches. All printer makes
// collapse to one generic `printer` category (operator wanted a single bucket).
export function suggestCategory(hostName: string | null | undefined, mac: string | undefined): string {
  const oui = normMac(mac).slice(0, 8);
  if (PRINTER_OUI.has(oui)) return 'printer';
  const h = (hostName ?? '').toLowerCase();
  if (!h) return '';
  // Common printer NetBIOS name prefixes: NPI = HP JetDirect, BRN/BRW = Brother,
  // RNP = Ricoh, KMBT = Kyocera/Konica-Minolta, EPSON = Epson.
  if (/^(npi|brn|brw|rnp|kmbt)/.test(h)) return 'printer';
  if (/canon|kyocera|zebra|laserjet|officejet|hewlett|(^|[^a-z])hp[^a-z]|epson|brother|lexmark|ricoh|konica|minolta|xerox|\boki\b|print|tisk|\bmfp\b/.test(h)) return 'printer';
  if (/iphone|ipad|galaxy|redmi|poco|honor|xiaomi|android|oneplus|huawei|pixel|realme/.test(h)) return 'phone';
  return '';
}

// --- Active subnet scan (from the app server) --------------------------------
// The application server pings each host in the configured ranges and reads its
// OWN ARP table to learn IP↔MAC for statically-addressed devices the router
// never sees (same-subnet hosts it doesn't route for). Ranges are "Site=CIDR".

// Read the host's ARP cache (Windows `arp -a`) → map of ip → normalized MAC.
// Lines look like:  "  10.8.2.100            64-c6-d2-73-08-70     dynamic".
function readLocalArp(): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const map = new Map<string, string>();
      if (err || !stdout) return resolve(map);
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})\s/);
        if (!m) continue;
        const mac = m[2]!.replace(/-/g, ':').toUpperCase();
        if (mac === 'FF:FF:FF:FF:FF:FF') continue;
        map.set(m[1]!, mac);
      }
      resolve(map);
    });
  });
}

// -----------------------------------------------------------------------------

const PING_CONCURRENCY = 10;
const SCAN_CONCURRENCY = 32;
let runInFlight = false;

interface Known { names: Set<string>; ips: Set<string>; }

async function loadKnownComputers(): Promise<Known> {
  const pool = await getPool();
  const r = await pool.request().query<{ name: string; ip_address: string | null }>(
    `SELECT name, ip_address FROM computers WHERE enabled = 1 AND excluded = 0`,
  );
  const names = new Set<string>();
  const ips = new Set<string>();
  for (const row of r.recordset) {
    if (row.name) names.add(row.name.toLowerCase());
    if (row.ip_address) ips.add(row.ip_address);
  }
  return { names, ips };
}

// Archive every (real-MAC, IP) pair a device is observed at — the connection
// history behind "MAC = the permanent ID, IP = temporary". Synthetic IP-<ip> ids
// carry no archive value (1:1 with their own IP), so they're skipped. Best-effort.
export async function recordIpHistory(mac: string, ip: string | null, site: string | null, source: string | null): Promise<void> {
  if (!mac || !ip || mac.startsWith('IP-')) return;
  try {
    const pool = await getPool();
    await pool.request().input('mac', mac).input('ip', ip).input('site', site).input('src', source).query(`
      MERGE device_ip_history AS t USING (SELECT @mac AS mac, @ip AS ip) AS s
        ON t.mac_address = s.mac AND t.ip_address = s.ip
      WHEN MATCHED THEN UPDATE SET last_seen = SYSUTCDATETIME(),
        site = COALESCE(@site, t.site), source = COALESCE(@src, t.source)
      WHEN NOT MATCHED THEN INSERT (mac_address, ip_address, site, source)
        VALUES (@mac, @ip, @site, @src);
    `);
  } catch { /* best-effort archive */ }
}

async function upsertDevice(d: NormDevice): Promise<{ mac: string; ip: string | null; host: string | null } | null> {
  if (!d.mac) return null;
  const pool = await getPool();
  // For a scan/arp row, don't blank out a richer host_name/server already stored
  // from a DHCP lease (COALESCE keeps the existing value when the new one is null).
  await pool.request()
    .input('site', d.site).input('mac', d.mac).input('ip', d.ip).input('host', d.host)
    .input('server', d.server).input('comment', d.comment).input('status', d.status)
    .input('dyn', d.dynamic).input('exp', d.exp).input('rls', d.rls).input('src', d.source)
    .query(`
      MERGE dhcp_leases AS t USING (SELECT @site AS site, @mac AS mac) AS s
        ON t.site = s.site AND t.mac_address = s.mac
      WHEN MATCHED THEN UPDATE SET
        ip_address = @ip, host_name = COALESCE(@host, t.host_name), server = COALESCE(@server, t.server),
        comment = COALESCE(@comment, t.comment), status = @status, dynamic = @dyn,
        expires_after = @exp, router_last_seen = @rls, source = @src, last_seen = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (site, mac_address, ip_address, host_name, server, comment, status, dynamic, expires_after, router_last_seen, source)
        VALUES (@site, @mac, @ip, @host, @server, @comment, @status, @dyn, @exp, @rls, @src);
    `);
  await recordIpHistory(d.mac, d.ip, d.site, d.source);
  return { mac: d.mac, ip: d.ip, host: d.host };
}

// Rolling window (hours) for the long-term loss/latency calc. Re-read from
// `devices.loss_window_hours` at the start of each collect run (default 24).
let lossWindowHours = 24;

// Persist a device's reachability AND its LONG-TERM loss/latency. Instead of
// storing the single 4-ping burst (which a momentary blip distorts), each ONLINE
// cycle appends a sample (sent/recv/latency) and we recompute the windowed ratio
// — dropped / sent over the last `lossWindowHours` — into dhcp_leases. A single
// bad cycle then weighs only 1/N. OFFLINE cycles record NO sample (a powered-off
// box must not accrue "100% loss") and clear loss/latency to NULL.
async function persistReachable(site: string, mac: string, reachable: boolean, host: string | null = null, sent = 0, recv = 0, latencyMs: number | null = null): Promise<void> {
  const pool = await getPool();
  if (reachable) {
    await pool.request()
      .input('site', site).input('mac', mac).input('host', host)
      .input('sent', sent).input('recv', recv).input('lat', latencyMs)
      .input('win', lossWindowHours)
      .query(`
        INSERT INTO device_ping_samples (mac_address, sent, recv, latency_ms)
        VALUES (@mac, @sent, @recv, @lat);

        UPDATE dl
        SET reachable = 1,
            host_name = COALESCE(@host, dl.host_name),
            reach_checked_at = SYSUTCDATETIME(),
            last_reachable_at = SYSUTCDATETIME(),
            packet_loss = w.loss,
            latency_ms  = w.lat
        FROM dhcp_leases dl
        CROSS APPLY (
          SELECT
            CAST(ROUND(CASE WHEN SUM(s.sent) > 0
                            THEN (SUM(s.sent) - SUM(s.recv)) * 100.0 / SUM(s.sent)
                            ELSE 0 END, 0) AS INT) AS loss,
            CASE WHEN COUNT(s.latency_ms) > 0
                 THEN CAST(ROUND(AVG(CAST(s.latency_ms AS FLOAT)), 0) AS INT)
                 ELSE NULL END AS lat
          FROM device_ping_samples s
          WHERE s.mac_address = @mac
            AND s.sample_at >= DATEADD(HOUR, -@win, SYSUTCDATETIME())
        ) w
        WHERE dl.site = @site AND dl.mac_address = @mac;
      `);
  } else {
    await pool.request().input('site', site).input('mac', mac).input('host', host).query(`
      UPDATE dhcp_leases
      SET reachable = 0,
          packet_loss = NULL,
          latency_ms = NULL,
          host_name = COALESCE(@host, host_name),
          reach_checked_at = SYSUTCDATETIME()
      WHERE site = @site AND mac_address = @mac;
    `);
  }
}

// Auto-confirm the category of AD-matched devices. AD already identifies the
// machine type (pc / server from os_version), so a device whose own hostname
// matches an AD computer needn't sit in "uncategorized" waiting for a manual
// click — we persist its type by MAC ("identify once, store, reuse"). Only fills
// an EMPTY category; an operator's explicit choice is never overwritten. Matches
// strictly on hostname (the unambiguous link); IP-only matches stay manual.
// Shared/USB printers are excluded (their host name isn't the device's type).
async function autoConfirmAdCategories(): Promise<number> {
  try {
    const pool = await getPool();
    const r = await pool.request().query<{ n: number }>(`
      MERGE device_categories AS t
      USING (
        SELECT l.mac_address AS mac,
               MIN(CASE WHEN c.os_version LIKE '%server%' THEN 'server' ELSE 'pc' END) AS cat
        FROM dhcp_leases l
        JOIN computers c ON LOWER(c.name) = LOWER(l.host_name)
        WHERE l.host_name IS NOT NULL AND l.host_name <> '' AND l.source <> 'share'
        GROUP BY l.mac_address
      ) AS s ON t.mac_address = s.mac
      WHEN MATCHED AND (t.category IS NULL OR t.category = '') THEN
        UPDATE SET category = s.cat, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (mac_address, category) VALUES (s.mac, s.cat)
      OUTPUT 1 AS n;
    `);
    return r.recordset.length;
  } catch {
    return 0;
  }
}

// Parse a Windows ping transcript: reply count (via "TTL=") and the average RTT
// from the per-reply "time<1ms"/"time=15ms" values. Locale-independent — the
// "[<=]NNms" token appears on every reply line in CS ("čas") and EN ("time").
interface PingStats { alive: boolean; lossPct: number; latencyMs: number | null; sent: number; received: number }

function parsePing(output: string, count: number): PingStats {
  let received = 0;
  const times: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/TTL=/i.test(line)) continue;
    received++;
    const m = line.match(/[<=]\s*(\d+)\s*ms/i);
    if (m) times.push(Number(m[1]));
  }
  const lossPct = Math.max(0, Math.min(100, Math.round(((count - received) / count) * 100)));
  const latencyMs = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  // `sent`/`received` feed the long-term (windowed) loss rate; `lossPct` is just
  // this single burst (kept for momentary logging, no longer stored directly).
  return { alive: received > 0, lossPct, latencyMs, sent: count, received };
}

// Multi-ping reachability with packet loss + average latency.
async function pingStats(ip: string, count: number, timeoutMs: number): Promise<PingStats> {
  const { output } = await pingWithOutput(ip, count, timeoutMs);
  return parsePing(output, count);
}

// Reverse-resolve a device's name. `ping -a` only works if the app host can do a
// DNS PTR / NetBIOS lookup (the app server often can't), so we query the device
// DIRECTLY over NetBIOS with `nbtstat -A <ip>` — peer-to-peer, no DNS needed.
// The node-status table lists the machine name under the "<00>" type. Returns
// null for devices that don't speak NetBIOS (many IoT) — name just stays unknown.
// Query a device's NetBIOS node status (`nbtstat -A <ip>`) — peer-to-peer over L3,
// no DNS or router needed. The node-status table yields the machine name (the
// "<00>" entry) AND, crucially, the device's real MAC ("MAC Address = …"). The MAC
// lets the active scan key remote-subnet hosts that ARP (L2, router-local) can't
// reach — works for Windows PCs and most network printers (Brother/HP speak
// NetBIOS). Returns nulls for devices that don't answer NetBIOS (many IoT).
export function resolveNode(ip: string, timeoutMs: number): Promise<{ name: string | null; mac: string | null }> {
  return new Promise((resolve) => {
    execFile('nbtstat', ['-A', ip], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 }, (_err, stdout) => {
      resolve(parseNbtstat(stdout || ''));
    });
  });
}

// Name-only convenience for the paths that already have the MAC (ARP / refresh).
function resolveName(ip: string, timeoutMs: number): Promise<string | null> {
  return resolveNode(ip, timeoutMs).then((r) => r.name);
}

const dnsReverse = promisify(dnsReverseCb);

// Reverse-DNS (PTR) name fallback for a scanned host that NetBIOS couldn't name.
// nbtstat (UDP 137) is firewalled from the app server, but DNS works here, so a
// domain host with a PTR record resolves to its name — which then pairs it to its
// AD computer by hostname (instead of a nameless `IP-<ip>` row). Returns the SHORT
// hostname uppercased (to match the AD / NetBIOS form). Best-effort; null on miss.
async function resolveNameViaDns(ip: string): Promise<string | null> {
  try {
    const names = await dnsReverse(ip);
    const fqdn = names?.[0];
    if (!fqdn) return null;
    const short = fqdn.split('.')[0]?.trim();
    return short ? short.toUpperCase() : null;
  } catch {
    return null;
  }
}

export interface MikrotikRunResult {
  routers: number;
  leases: number;
  unmatchedPinged: number;
  reachable: number;
  scanned: number;
  errors: string[];
  durationMs: number;
}

// Pull every router once, upsert leases, then ping only the UNMATCHED devices
// (those not paired with an AD computer by host_name/IP — matched ones reuse the
// reachability collector's verdict). Never throws.
export async function runMikrotikCollectOnce(): Promise<MikrotikRunResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  const errors: string[] = [];
  let leases = 0;
  let unmatchedPinged = 0;
  let reachable = 0;
  let scanned = 0;
  try {
    const settings = await getAllSettings();
    const cfg = resolveConfig(settings);
    if (!cfg) {
      return { routers: 0, leases: 0, unmatchedPinged: 0, reachable: 0, scanned: 0, errors: [], durationMs: Date.now() - t0 };
    }
    const { routers, user, pass, scanRanges } = cfg;
    const timeoutMs = 8000;
    const known = await loadKnownComputers();

    // Long-term loss/latency window (hours) — re-read each run so a Settings change
    // applies live. Prune ping samples older than the window (+1h margin) so the
    // history table stays bounded; only ONLINE cycles ever insert a sample.
    const winN = Number(settings['devices.loss_window_hours']);
    lossWindowHours = Number.isFinite(winN) && winN >= 1 ? Math.floor(winN) : 24;
    try {
      await (await getPool()).request().input('win', lossWindowHours)
        .query(`DELETE FROM device_ping_samples WHERE sample_at < DATEADD(HOUR, -(@win + 1), SYSUTCDATETIME())`);
    } catch { /* pruning is best-effort; never block a collect */ }

    // EXCLUDE ranges ("!"/"<>") opt a whole subnet OUT of the inventory entirely
    // — not just out of the active scan. Parsed straight from settings so it
    // applies even when scanning is disabled. Excluded IPs are never stored (any
    // source) and existing rows in those ranges are pruned below.
    const excludeRanges = parseScanRanges(settings['mikrotik.scan_ranges']).filter((r) => r.exclude);
    const inExcluded = (ip: string | null): boolean => {
      if (!ip) return false;
      const n = ipToInt(ip);
      return n != null && excludeRanges.some((r) => ((n & maskOf(r.prefix)) >>> 0) === r.base);
    };
    if (excludeRanges.length > 0) {
      const pool = await getPool();
      const all = (await pool.request().query<{ site: string; mac_address: string; ip_address: string | null }>(
        `SELECT site, mac_address, ip_address FROM dhcp_leases WHERE ip_address IS NOT NULL`)).recordset;
      for (const r of all) {
        if (inExcluded(r.ip_address)) {
          await pool.request().input('site', r.site).input('mac', r.mac_address)
            .query(`DELETE FROM dhcp_leases WHERE site = @site AND mac_address = @mac`);
        }
      }
    }

    // Unmatched (site, mac, ip) to ping after upserts.
    const toPing: Array<{ site: string; mac: string; ip: string }> = [];

    const handleDevice = async (d: NormDevice): Promise<void> => {
      if (inExcluded(d.ip)) return; // operator opted this subnet out entirely
      const up = await upsertDevice(d);
      if (!up) return;
      leases++;
      const matched = (up.host != null && known.names.has(up.host.toLowerCase()))
        || (up.ip != null && known.ips.has(up.ip));
      if (matched) {
        const pool = await getPool();
        await pool.request().input('site', d.site).input('mac', up.mac)
          .query(`UPDATE dhcp_leases SET reachable = NULL, reach_checked_at = NULL WHERE site = @site AND mac_address = @mac`);
      } else if (up.ip) {
        toPing.push({ site: d.site, mac: up.mac, ip: up.ip });
      }
    };

    // Phase 1 — routers: DHCP leases (dynamic AND static reservations, even when
    // not currently bound) merged with the ARP table, keyed by MAC (lease wins).
    // The ARP table is cached per router so the active scan (Phase 2) can REUSE it
    // instead of re-querying — halving the router REST round-trips per cycle (each
    // RouterOS REST request is a Basic-auth login/logout, so fewer = quieter).
    const arpByRouter = new Map<string, RawArp[]>();
    for (const router of routers) {
      try {
        const [rawLeases, rawArp, rawScan] = await Promise.all([
          fetchLeases(router, user, pass, timeoutMs),
          fetchArp(router, user, pass, timeoutMs).catch(() => [] as RawArp[]),
          cfg.ipscan ? fetchIpScan(router, user, pass, cfg.ipscanSec).catch(() => [] as RawIpScan[]) : Promise.resolve([] as RawIpScan[]),
        ]);
        arpByRouter.set(router.ip, rawArp);
        // Names the router-side ip-scan resolved (NETBIOS/DNS), keyed by MAC. The
        // scan does several passes, so keep the first non-empty name per MAC.
        const scanName = new Map<string, string>();
        for (const s of rawScan) {
          const mac = normMac(s['mac-address']);
          if (!mac || scanName.has(mac)) continue;
          const nm = ipScanName(s);
          if (nm) scanName.set(mac, nm);
        }
        const byMac = new Map<string, NormDevice>();
        for (const l of rawLeases) {
          const isBound = (l.status ?? '').toLowerCase() === 'bound';
          const isStatic = toBool(l.dynamic) === false;       // static reservation
          if (!isBound && !isStatic) continue;                // skip transient dynamic non-bound
          const d = leaseToNorm(router.site, l);
          if (d) byMac.set(d.mac, d);
        }
        for (const a of rawArp) {
          const d = arpToNorm(router.site, a);
          if (d && !byMac.has(d.mac)) byMac.set(d.mac, d);     // ARP-only = static, not in DHCP
        }
        // ip-scan: NAME any still-nameless device (static printers/servers the
        // router can't name from lease/arp), and add net-new devices the scan saw
        // but lease/arp missed. host_name COALESCE in upsert keeps a real DHCP name.
        for (const s of rawScan) {
          const mac = normMac(s['mac-address']);
          if (!mac) continue;
          const existing = byMac.get(mac);
          if (existing) {
            if (!existing.host) existing.host = scanName.get(mac) ?? null;
          } else {
            const ip = (s['address'] ?? '').trim() || null;
            if (ip) byMac.set(mac, { site: router.site, mac, ip, host: scanName.get(mac) ?? null, server: null, comment: null, status: 'scan', dynamic: false, exp: null, rls: null, source: 'scan' });
          }
        }
        // FTP file source — pull IP_scan.txt + ARP_scan.txt for sites that produce
        // them, merge by MAC (fill a still-missing name, add net-new statics the
        // REST pull didn't have) and record the per-site freshness status. Never
        // throws: a dead router / missing file becomes a recorded error.
        if (cfg.ftpEnabled && cfg.ftpSites.has(router.site)) {
          const ftp = await fetchFtpSite({ host: router.ip, user, pass }, { lease: 'IP_scan.txt', arp: 'ARP_scan.txt' });
          for (const l of ftp.leases) {
            const ex = byMac.get(normMac(l.mac));
            if (ex) { if (!ex.host && l.host) ex.host = l.host; }
            else byMac.set(normMac(l.mac), ftpLeaseToNorm(router.site, l));
          }
          for (const a of ftp.arp) {
            if (!byMac.has(normMac(a.mac))) byMac.set(normMac(a.mac), ftpArpToNorm(router.site, a));
          }
          await recordSiteStatus(router.site, ftp);
          if (ftp.error) errors.push(`${router.site} ftp: ${ftp.error}`);
        }
        for (const d of byMac.values()) await handleDevice(d);
      } catch (err) {
        errors.push(`${router.site}: ${String(err).split('\n')[0]}`);
      }
    }

    // Ping unmatched router devices with a small concurrency pool.
    let idx = 0;
    const worker = async () => {
      while (idx < toPing.length) {
        const d = toPing[idx++];
        if (!d) continue;
        try {
          const st = await pingStats(d.ip, 4, 1500);
          await persistReachable(d.site, d.mac, st.alive, null, st.sent, st.received, st.latencyMs);
          unmatchedPinged++;
          if (st.alive) reachable++;
        } catch { /* skip on error, keep last state */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PING_CONCURRENCY, toPing.length || 1) }, worker));

    // Phase 2 — active scan from the app server. DISCOVERY only pings UNKNOWN
    // IPs: once an IP↔MAC is in the DB it's cached and never re-discovered. MAC is
    // the cache key — if a static device later appears at a NEW IP, the upsert by
    // (site,mac) moves its row's ip_address there, so the OLD IP is no longer
    // stored and automatically falls back into the discovery pool. A separate
    // light up/down re-ping refreshes known static (scan/arp) devices so Status +
    // the printer-offline alert stay current, WITHOUT re-discovering them.
    if (cfg.scanEnabled && scanRanges.length > 0) {
      try {
        const pool = await getPool();
        // Everything currently stored with an IP (any source) is already known →
        // not re-discovered. (Runs after Phase 1, so this cycle's router rows are
        // included.)
        const stored = (await pool.request().query<{ site: string; mac_address: string; ip_address: string | null; source: string | null; host_name: string | null }>(
          `SELECT site, mac_address, ip_address, source, host_name FROM dhcp_leases WHERE ip_address IS NOT NULL`)).recordset;
        const knownIps = new Set<string>();
        for (const r of stored) if (r.ip_address) knownIps.add(r.ip_address);

        // Discovery: ping only the UNKNOWN host IPs in the INCLUDE ranges, minus
        // anything in an EXCLUDE ("!"/"<>") range (inExcluded is hoisted above).
        const includeRanges = scanRanges.filter((r) => !r.exclude);

        // Reconcile the Site= label of EXISTING scan rows. Discovery never re-pings
        // a known IP, so a range renamed after a row was created (bare "10.181.3.*"
        // → "Zastavka=10.181.3.*") would otherwise leave the old row stuck under the
        // netLabel "10.181.3" forever. If a stored scan row's IP now falls in an
        // include range whose label differs, adopt the configured label. PK is
        // (site,mac); the rename is a key move, so drop a colliding target row first
        // (same mac+ip = same device). Categories key by MAC, so they survive.
        for (const r of stored) {
          if (r.source !== 'scan' || !r.ip_address) continue;
          const want = siteForIp(r.ip_address, includeRanges);
          if (!want || want === r.site) continue;
          try {
            await pool.request().input('os', r.site).input('ns', want).input('mac', r.mac_address)
              .query(`
                DELETE FROM dhcp_leases WHERE site = @ns AND mac_address = @mac;
                UPDATE dhcp_leases SET site = @ns WHERE site = @os AND mac_address = @mac;`);
            r.site = want; // keep the in-memory copy consistent for the refresh pass below
          } catch { /* a single rename failure shouldn't abort the sweep */ }
        }

        const targets: Array<{ site: string; ip: string }> = [];
        const targetIps = new Set<string>();
        for (const range of includeRanges) {
          for (const ip of hostsOf(range)) {
            if (!knownIps.has(ip) && !targetIps.has(ip) && !inExcluded(ip)) { targets.push({ site: range.site, ip }); targetIps.add(ip); }
          }
        }
        const aliveIps = new Set<string>();
        const aliveList: Array<{ site: string; ip: string }> = [];
        let si = 0;
        const scanWorker = async () => {
          while (si < targets.length) {
            const tt = targets[si++];
            if (!tt) continue;
            try { if (await icmpPing(tt.ip, 1500)) { aliveIps.add(tt.ip); aliveList.push(tt); } } catch { /* skip */ }
          }
        };
        await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, targets.length || 1) }, scanWorker));

        // Resolve MACs: local ARP cache (.213's own subnet) merged with each
        // router's ARP (remote subnets — the last-hop router ARPs the target when
        // delivering our ping). Local takes precedence.
        const arpMap = await readLocalArp();
        for (const router of routers) {
          // Reuse the ARP already fetched in Phase 1 — no extra router REST call.
          for (const a of arpByRouter.get(router.ip) ?? []) {
            const aip = (a['address'] ?? '').trim();
            const amac = normMac(a['mac-address']);
            if (aip && amac && !arpMap.has(aip)) arpMap.set(aip, amac);
          }
        }
        // Resolve + store each alive host (parallelized — was sequential). ARP (L2)
        // only covers router-attached subnets; for the rest, fall back to nbtstat
        // node status, which returns the real MAC + name over L3 (cross-subnet) —
        // so remote-site PCs and printers that ping alive but have no ARP MAC still
        // get keyed and stored, instead of being silently dropped.
        let ai = 0;
        const storeWorker = async () => {
          while (ai < aliveList.length) {
            const a = aliveList[ai++];
            if (!a) continue;
            let mac = arpMap.get(a.ip) ?? null;
            let host: string | null = null;
            if (!mac) {
              const node = await resolveNode(a.ip, 2500);
              mac = node.mac;
              host = node.name;
            } else {
              host = await resolveName(a.ip, 2500);
            }
            // NetBIOS is firewalled from the app server, so most scan hosts come
            // back nameless; fall back to reverse DNS (works here), which names a
            // domain host and lets it pair to its AD computer by hostname.
            if (!host) host = await resolveNameViaDns(a.ip);
            // Option B: an alive host with no resolvable MAC (remote subnet — ARP is
            // router-local, and NetBIOS/nbtstat is often firewalled from the app
            // server) is still stored, keyed by a synthetic "IP-<ip>" id, so the
            // operator SEES the live host (IP + online/offline) instead of it being
            // silently dropped. A real MAC/name backfills later if ARP/NetBIOS/SNMP
            // resolves it. At read time a synthetic row whose IP matches an AD
            // computer still pairs by IP, so AD machines also show their name.
            if (!mac) mac = `IP-${a.ip}`;
            try {
              const st = await pingStats(a.ip, 4, 1500);
              await upsertDevice({ site: a.site, mac, ip: a.ip, host, server: null, comment: null, status: 'scan', dynamic: false, exp: null, rls: null, source: 'scan' });
              if (known.ips.has(a.ip)) {
                await pool.request().input('site', a.site).input('mac', mac)
                  .query(`UPDATE dhcp_leases SET reachable = NULL, reach_checked_at = NULL WHERE site = @site AND mac_address = @mac`);
              } else {
                await persistReachable(a.site, mac, st.alive, null, st.sent, st.received, st.latencyMs);
              }
              scanned++;
            } catch { /* one host's DB/probe error shouldn't abort the sweep */ }
          }
        };
        await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, aliveList.length || 1) }, storeWorker));

        // Reachability refresh for ALREADY-KNOWN static devices (scan/arp) not
        // matched to an AD computer — a targeted up/down re-ping by stored IP, NOT
        // re-discovery. Skips ones just pinged in discovery and AD-matched ones
        // (those use the computer's reachable).
        const refresh = stored.filter((r) =>
          (r.source === 'scan' || r.source === 'arp') && r.ip_address
          && !known.ips.has(r.ip_address) && !aliveIps.has(r.ip_address));
        let ri = 0;
        const refreshWorker = async () => {
          while (ri < refresh.length) {
            const r = refresh[ri++];
            if (!r || !r.ip_address) continue;
            try {
              // Loss-only ping always; a nameless device also gets a NetBIOS name
              // lookup (so suggestCategory can spot printers etc.) — once named, no
              // more lookups.
              const st = await pingStats(r.ip_address, 4, 1500);
              const host = r.host_name ? null : (await resolveName(r.ip_address, 2500) ?? await resolveNameViaDns(r.ip_address));
              await persistReachable(r.site, r.mac_address, st.alive, host, st.sent, st.received, st.latencyMs);
            } catch { /* keep last */ }
          }
        };
        await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, refresh.length || 1) }, refreshWorker));
      } catch (err) {
        errors.push(`scan: ${String(err).split('\n')[0]}`);
      }
    }

    // Prune stale "ghost" rows: an IP-reassigned lease whose old (site, mac) row
    // none of the collectors has touched for N days (last_seen AND reach_checked_at
    // AND last_reachable_at all older than the cutoff). Runs LAST, after this
    // cycle's observations bumped those timestamps. Non-destructive: a returning
    // device re-appears and its MAC-keyed category/note rejoins. 0 = disabled.
    let pruned = 0;
    const retDays = Number(settings['devices.lease_retention_days']);
    if (Number.isFinite(retDays) && retDays >= 1) {
      try {
        const pool = await getPool();
        const r = await pool.request().input('days', Math.floor(retDays)).query<{ n: number }>(`
          DELETE FROM dhcp_leases OUTPUT 1 AS n
          WHERE last_seen < DATEADD(DAY, -@days, SYSUTCDATETIME())
            AND (reach_checked_at IS NULL OR reach_checked_at < DATEADD(DAY, -@days, SYSUTCDATETIME()))
            AND (last_reachable_at IS NULL OR last_reachable_at < DATEADD(DAY, -@days, SYSUTCDATETIME()))
            -- Never prune a device the operator has IDENTIFIED as stable equipment
            -- (a confirmed category other than phone, or a name / note): it stays in
            -- the inventory, shown offline. Phones are exempt — Wi-Fi phones cycle
            -- through randomized MACs, so a stale phone MAC SHOULD prune as a ghost.
            AND NOT EXISTS (
              SELECT 1 FROM device_categories dc WHERE dc.mac_address = dhcp_leases.mac_address
                AND ((dc.category IS NOT NULL AND dc.category NOT IN ('', 'phone'))
                  OR (dc.name IS NOT NULL AND dc.name <> '')
                  OR (dc.note IS NOT NULL AND dc.note <> '')));
        `);
        pruned = r.recordset.length;
      } catch { /* pruning is best-effort; never block a collect */ }
    }

    // Auto-confirm the category of AD-matched devices (identify once via AD →
    // stored by MAC → reused), so domain machines don't sit in "uncategorized".
    const autoCat = await autoConfirmAdCategories();

    const durationMs = Date.now() - t0;
    logActivity(errors.length ? 'warn' : 'info', 'mikrotik',
      `Devices: ${leases} from ${routers.length} router(s)${scanned ? ` + ${scanned} scanned` : ''}; ${unmatchedPinged} unmatched pinged (${reachable} online)${pruned ? `; pruned ${pruned} stale` : ''}${autoCat ? `; auto-categorized ${autoCat} AD` : ''}${errors.length ? ` · errors: ${errors.join('; ')}` : ''} (${(durationMs / 1000).toFixed(1)}s)`);

    // Printer-offline alert eval runs on the collector's own cadence (fresh
    // reachability is in the DB now). Self-contained; never throws.
    try { await evaluateAndSendPrinterAlerts(); } catch (e) { logActivity('error', 'alerts', `Printer alert eval failed: ${String(e).split('\n')[0]}`); }

    // Per-site data-freshness / availability alert — the FTP file status was just
    // refreshed above. Self-contained; never throws.
    try { await evaluateAndSendDataFreshnessAlerts(); } catch (e) { logActivity('error', 'alerts', `Freshness alert eval failed: ${String(e).split('\n')[0]}`); }

    return { routers: routers.length, leases, unmatchedPinged, reachable, scanned, errors, durationMs };
  } catch (err) {
    logActivity('error', 'mikrotik', `DHCP collect failed: ${String(err).split('\n')[0]}`);
    return { routers: 0, leases, unmatchedPinged, reachable, scanned, errors: [String(err)], durationMs: Date.now() - t0 };
  } finally {
    runInFlight = false;
  }
}

// Lightweight per-router API connectivity test for the Settings panel. Hits the
// SAME REST endpoint the collector uses (so it exercises the real auth path) with
// a short timeout, but does NO scan — so it returns in seconds, not minutes.
// Per router: ok + lease count on success, or the HTTP/transport error.
export interface RouterTest { site: string; ip: string; ok: boolean; count: number | null; ms: number; error?: string }

export async function testRouters(): Promise<{ tested: number; results: RouterTest[] }> {
  const settings = await getAllSettings();
  const routers = parseRouters(settings['mikrotik.routers']);
  const user = (settings['mikrotik.user'] ?? '').trim() || 'dhcp-reader';
  const enc = settings['mikrotik.password_enc'] ?? '';
  let pass = '';
  try { pass = enc ? decryptSecret(enc) : ''; } catch { pass = ''; }

  const results: RouterTest[] = [];
  for (const r of routers) {
    const t0 = Date.now();
    try {
      const leases = await routerGet<RawLease>(r.ip, '/rest/ip/dhcp-server/lease', user, pass, 5000);
      results.push({ site: r.site, ip: r.ip, ok: true, count: leases.length, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ site: r.site, ip: r.ip, ok: false, count: null, ms: Date.now() - t0, error: String(e).split('\n')[0] });
    }
  }
  return { tested: results.length, results };
}

// On-demand ICMP ping of one device IP (per-row "Ping" in the Devices tab).
// Returns a cmd-like transcript and persists the verdict on the lease.
export async function probeDeviceNow(site: string, mac: string, ip: string): Promise<{ alive: boolean; console: string }> {
  const res = await pingWithOutput(ip, 10, 2000);
  const st = parsePing(res.output, 10);
  try { await persistReachable(site, mac, res.alive, null, st.sent, st.received, st.latencyMs); } catch { /* best effort */ }
  const lines = [`> ping -n 10 ${ip}`, '', res.output.replace(/\r\n/g, '\n').trimEnd()];
  return { alive: res.alive, console: lines.join('\n') };
}

let mtTimer: NodeJS.Timeout | null = null;
let mtStopped = false;

// How often to re-check Settings while the collector is disabled / unconfigured,
// so flipping mikrotik.enabled on in the UI takes effect without a restart.
const IDLE_RECHECK_SEC = 60;

// Standalone scheduler — mirrors reachability/port-status. Every cycle re-reads
// Settings (enable flag + interval), so changing them in the UI applies live
// without a service restart. While disabled or unconfigured it idles and
// re-checks every IDLE_RECHECK_SEC instead of collecting.
export async function startMikrotikSchedule(): Promise<void> {
  mtStopped = false;
  if (mtTimer) { clearTimeout(mtTimer); mtTimer = null; }
  const loop = async () => {
    if (mtStopped) return;
    let nextSec = IDLE_RECHECK_SEC;
    try {
      const settings = await getAllSettings();
      const cfg = resolveConfig(settings);
      if (cfg) {
        await runMikrotikCollectOnce();
        nextSec = cfg.intervalSec;
      }
    } catch (e) {
      console.error('MikroTik schedule error', e);
    }
    if (!mtStopped) mtTimer = setTimeout(loop, nextSec * 1000);
  };
  loop().catch((e) => console.error('MikroTik schedule error', e));
  console.log('MikroTik DHCP collector scheduled (DB-driven enable/interval)');
}
