import { execFile } from 'node:child_process';
import { getPool } from '../db/pool.js';
import { getAllSettings, type SettingsMap } from './settings.js';
import { decryptSecret } from './secret-crypto.js';
import { boolSetting } from './alerts-util.js';
import { evaluateAndSendPrinterAlerts } from './alerts.js';
import { logActivity } from './activity-log.js';
import { icmpPing } from './reachability-collector.js';
import { pingWithOutput } from './port-status-collector.js';
import { parseNbtstat } from './netbios-util.js';

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
interface MtConfig { routers: Router[]; user: string; pass: string; intervalSec: number; scanEnabled: boolean; scanRanges: ScanRange[]; }

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
  return { routers, user, pass, intervalSec, scanEnabled, scanRanges };
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

interface ScanRange { site: string; base: number; prefix: number; exclude: boolean; }

function maskOf(prefix: number): number { return prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0; }

function ipToInt(ip: string): number | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((x) => x > 255)) return null;
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}
function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// Accepts CIDR ("10.8.2.0/24") OR wildcard ("10.8.2.*" = /24, "10.8.*.*" = /16).
// Returns the masked network base, the prefix, and a short network label.
// Capped to /16../30 so a typo can't launch a /8 (16M-host) sweep.
function parseCidrOrWildcard(s: string): { base: number; prefix: number; netLabel: string } | null {
  const str = s.trim();
  if (str.includes('*')) {
    const parts = str.split('.');
    if (parts.length !== 4) return null;
    const octs: number[] = [];
    let fixed = 0;
    let seenStar = false;
    for (const p of parts) {
      if (p === '*') { seenStar = true; octs.push(0); continue; }
      if (seenStar) return null;            // a number after a '*' is invalid
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      octs.push(n); fixed++;
    }
    const prefix = fixed * 8;
    if (prefix < 16 || prefix > 24) return null;
    const base = (((octs[0]! << 24) >>> 0) + (octs[1]! << 16) + (octs[2]! << 8) + octs[3]!) >>> 0;
    return { base, prefix, netLabel: octs.slice(0, fixed).join('.') };
  }
  const m = str.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const ip = ipToInt(m[1]!);
  const prefix = Number(m[2]);
  if (ip == null || prefix < 16 || prefix > 30) return null;
  const base = (ip & ((~0 << (32 - prefix)) >>> 0)) >>> 0;
  return { base, prefix, netLabel: intToIp(base).replace(/(\.0)+$/, '') };
}

// "Site=range" per line/comma; the "Site=" is OPTIONAL (label derived from the
// network when omitted). range = CIDR or wildcard. A leading "!" or "<>" on the
// line marks an EXCLUDE range — IPs inside it are skipped even if another range
// covers them (same convention as the disk-scope syntax elsewhere in the app).
function parseScanRanges(raw: string | undefined): ScanRange[] {
  const out: ScanRange[] = [];
  for (const raw0 of (raw ?? '').split(/[,;\r\n]+/).map((s) => s.trim()).filter(Boolean)) {
    let tok = raw0;
    let exclude = false;
    if (tok.startsWith('!')) { exclude = true; tok = tok.slice(1).trim(); }
    else if (tok.startsWith('<>')) { exclude = true; tok = tok.slice(2).trim(); }
    const eq = tok.indexOf('=');
    const site = eq > 0 ? tok.slice(0, eq).trim() : '';
    const rangeStr = eq > 0 ? tok.slice(eq + 1).trim() : tok;
    const p = parseCidrOrWildcard(rangeStr);
    if (!p) continue;
    out.push({ site: site || p.netLabel, base: p.base, prefix: p.prefix, exclude });
  }
  return out;
}

// Usable host IPs of a range (skip network + broadcast).
function* hostsOf(r: ScanRange): Generator<string> {
  const size = 2 ** (32 - r.prefix);
  if (size <= 2) { yield intToIp(r.base); return; }
  for (let i = 1; i < size - 1; i++) yield intToIp((r.base + i) >>> 0);
}

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
  return { mac: d.mac, ip: d.ip, host: d.host };
}

async function persistReachable(site: string, mac: string, reachable: boolean, lossPct: number | null = null, host: string | null = null, latencyMs: number | null = null): Promise<void> {
  const pool = await getPool();
  await pool.request().input('site', site).input('mac', mac).input('r', reachable ? 1 : 0).input('loss', lossPct).input('host', host).input('lat', latencyMs).query(`
    UPDATE dhcp_leases
    SET reachable = @r,
        -- loss + latency only matter while ONLINE; offline = 100% / no RTT is just
        -- restating "offline", so store NULL there (nothing to show / count).
        packet_loss = CASE WHEN @r = 1 THEN @loss ELSE NULL END,
        latency_ms = CASE WHEN @r = 1 THEN @lat ELSE NULL END,
        host_name = COALESCE(@host, host_name),
        reach_checked_at = SYSUTCDATETIME(),
        last_reachable_at = CASE WHEN @r = 1 THEN SYSUTCDATETIME() ELSE last_reachable_at END
    WHERE site = @site AND mac_address = @mac;
  `);
}

// Parse a Windows ping transcript: reply count (via "TTL=") and the average RTT
// from the per-reply "time<1ms"/"time=15ms" values. Locale-independent — the
// "[<=]NNms" token appears on every reply line in CS ("čas") and EN ("time").
function parsePing(output: string, count: number): { alive: boolean; lossPct: number; latencyMs: number | null } {
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
  return { alive: received > 0, lossPct, latencyMs };
}

// Multi-ping reachability with packet loss + average latency.
async function pingStats(ip: string, count: number, timeoutMs: number): Promise<{ alive: boolean; lossPct: number; latencyMs: number | null }> {
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
    for (const router of routers) {
      try {
        const [rawLeases, rawArp] = await Promise.all([
          fetchLeases(router, user, pass, timeoutMs),
          fetchArp(router, user, pass, timeoutMs).catch(() => [] as RawArp[]),
        ]);
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
          await persistReachable(d.site, d.mac, st.alive, st.lossPct, null, st.latencyMs);
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
          try {
            for (const a of await fetchArp(router, user, pass, timeoutMs)) {
              const aip = (a['address'] ?? '').trim();
              const amac = normMac(a['mac-address']);
              if (aip && amac && !arpMap.has(aip)) arpMap.set(aip, amac);
            }
          } catch { /* skip a router that fails ARP */ }
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
                await persistReachable(a.site, mac, st.alive, st.lossPct, null, st.latencyMs);
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
              const host = r.host_name ? null : await resolveName(r.ip_address, 2500);
              await persistReachable(r.site, r.mac_address, st.alive, st.lossPct, host, st.latencyMs);
            } catch { /* keep last */ }
          }
        };
        await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, refresh.length || 1) }, refreshWorker));
      } catch (err) {
        errors.push(`scan: ${String(err).split('\n')[0]}`);
      }
    }

    const durationMs = Date.now() - t0;
    logActivity(errors.length ? 'warn' : 'info', 'mikrotik',
      `Devices: ${leases} from ${routers.length} router(s)${scanned ? ` + ${scanned} scanned` : ''}; ${unmatchedPinged} unmatched pinged (${reachable} online)${errors.length ? ` · errors: ${errors.join('; ')}` : ''} (${(durationMs / 1000).toFixed(1)}s)`);

    // Printer-offline alert eval runs on the collector's own cadence (fresh
    // reachability is in the DB now). Self-contained; never throws.
    try { await evaluateAndSendPrinterAlerts(); } catch (e) { logActivity('error', 'alerts', `Printer alert eval failed: ${String(e).split('\n')[0]}`); }

    return { routers: routers.length, leases, unmatchedPinged, reachable, scanned, errors, durationMs };
  } catch (err) {
    logActivity('error', 'mikrotik', `DHCP collect failed: ${String(err).split('\n')[0]}`);
    return { routers: 0, leases, unmatchedPinged, reachable, scanned, errors: [String(err)], durationMs: Date.now() - t0 };
  } finally {
    runInFlight = false;
  }
}

// On-demand ICMP ping of one device IP (per-row "Ping" in the Devices tab).
// Returns a cmd-like transcript and persists the verdict on the lease.
export async function probeDeviceNow(site: string, mac: string, ip: string): Promise<{ alive: boolean; console: string }> {
  const res = await pingWithOutput(ip, 10, 2000);
  const st = parsePing(res.output, 10);
  try { await persistReachable(site, mac, res.alive, st.lossPct, null, st.latencyMs); } catch { /* best effort */ }
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
