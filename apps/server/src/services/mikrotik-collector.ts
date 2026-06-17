import { getPool } from '../db/pool.js';
import { getAllSettings, type SettingsMap } from './settings.js';
import { decryptSecret } from './secret-crypto.js';
import { boolSetting } from './alerts-util.js';
import { evaluateAndSendPrinterAlerts } from './alerts.js';
import { logActivity } from './activity-log.js';
import { icmpPing } from './reachability-collector.js';
import { pingWithOutput } from './port-status-collector.js';

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
function resolveConfig(settings: SettingsMap): { routers: Router[]; user: string; pass: string; intervalSec: number } | null {
  if (!boolSetting(settings['mikrotik.enabled'])) return null;
  const routers = parseRouters(settings['mikrotik.routers']);
  if (routers.length === 0) return null;
  const user = (settings['mikrotik.user'] ?? '').trim() || 'dhcp-reader';
  const enc = settings['mikrotik.password_enc'] ?? '';
  let pass = '';
  try { pass = enc ? decryptSecret(enc) : ''; } catch { pass = ''; }
  const n = Number(settings['mikrotik.interval_sec']);
  const intervalSec = Number.isFinite(n) && n >= 30 ? Math.floor(n) : 300;
  return { routers, user, pass, intervalSec };
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

async function fetchLeases(router: Router, user: string, pass: string, timeoutMs: number): Promise<RawLease[]> {
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${router.ip}/rest/ip/dhcp-server/lease`, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? (data as RawLease[]) : [];
  } finally {
    clearTimeout(timer);
  }
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
  if (/canon|kyocera|zebra|laserjet|officejet|hewlett|(^|[^a-z])hp[^a-z]|epson|brother|lexmark|ricoh|konica|minolta|xerox|\boki\b|print|tisk|\bmfp\b/.test(h)) return 'printer';
  if (/iphone|ipad|galaxy|redmi|poco|honor|xiaomi|android|oneplus|huawei|pixel|realme/.test(h)) return 'phone';
  return '';
}

// -----------------------------------------------------------------------------

const PING_CONCURRENCY = 10;
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

async function upsertLease(site: string, l: RawLease): Promise<{ mac: string; ip: string | null; host: string | null } | null> {
  const mac = normMac(l['mac-address'] ?? l['active-mac-address']);
  if (!mac) return null;
  const ip = (l['active-address'] ?? l['address'] ?? '').trim() || null;
  const host = (l['host-name'] ?? '').trim() || null;
  const pool = await getPool();
  await pool.request()
    .input('site', site).input('mac', mac).input('ip', ip).input('host', host)
    .input('server', (l['server'] ?? '').trim() || null)
    .input('comment', (l['comment'] ?? '').trim() || null)
    .input('status', (l['status'] ?? '').trim() || null)
    .input('dyn', toBool(l['dynamic']))
    .input('exp', (l['expires-after'] ?? '').trim() || null)
    .input('rls', (l['last-seen'] ?? '').trim() || null)
    .query(`
      MERGE dhcp_leases AS t USING (SELECT @site AS site, @mac AS mac) AS s
        ON t.site = s.site AND t.mac_address = s.mac
      WHEN MATCHED THEN UPDATE SET
        ip_address = @ip, host_name = @host, server = @server, comment = @comment,
        status = @status, dynamic = @dyn, expires_after = @exp, router_last_seen = @rls,
        last_seen = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (site, mac_address, ip_address, host_name, server, comment, status, dynamic, expires_after, router_last_seen)
        VALUES (@site, @mac, @ip, @host, @server, @comment, @status, @dyn, @exp, @rls);
    `);
  return { mac, ip, host };
}

async function persistReachable(site: string, mac: string, reachable: boolean): Promise<void> {
  const pool = await getPool();
  await pool.request().input('site', site).input('mac', mac).input('r', reachable ? 1 : 0).query(`
    UPDATE dhcp_leases
    SET reachable = @r,
        reach_checked_at = SYSUTCDATETIME(),
        last_reachable_at = CASE WHEN @r = 1 THEN SYSUTCDATETIME() ELSE last_reachable_at END
    WHERE site = @site AND mac_address = @mac;
  `);
}

export interface MikrotikRunResult {
  routers: number;
  leases: number;
  unmatchedPinged: number;
  reachable: number;
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
  try {
    const settings = await getAllSettings();
    const cfg = resolveConfig(settings);
    if (!cfg) {
      return { routers: 0, leases: 0, unmatchedPinged: 0, reachable: 0, errors: [], durationMs: Date.now() - t0 };
    }
    const { routers, user, pass } = cfg;
    const timeoutMs = 8000;
    const known = await loadKnownComputers();

    // Collect the unmatched (site, mac, ip) to ping after all upserts.
    const toPing: Array<{ site: string; mac: string; ip: string }> = [];

    for (const router of routers) {
      try {
        const raw = await fetchLeases(router, user, pass, timeoutMs);
        const bound = raw.filter((l) => (l.status ?? '').toLowerCase() === 'bound');
        for (const l of bound) {
          const up = await upsertLease(router.site, l);
          if (!up) continue;
          leases++;
          const matched = (up.host != null && known.names.has(up.host.toLowerCase()))
            || (up.ip != null && known.ips.has(up.ip));
          // Matched devices: clear the lease's own ping verdict (UI uses the
          // computer's reachable). Unmatched: queue a ping.
          if (matched) {
            const pool = await getPool();
            await pool.request().input('site', router.site).input('mac', up.mac)
              .query(`UPDATE dhcp_leases SET reachable = NULL, reach_checked_at = NULL WHERE site = @site AND mac_address = @mac`);
          } else if (up.ip) {
            toPing.push({ site: router.site, mac: up.mac, ip: up.ip });
          }
        }
      } catch (err) {
        errors.push(`${router.site}: ${String(err).split('\n')[0]}`);
      }
    }

    // Ping unmatched devices with a small concurrency pool.
    let idx = 0;
    const worker = async () => {
      while (idx < toPing.length) {
        const d = toPing[idx++];
        if (!d) continue;
        try {
          const ok = await icmpPing(d.ip, 2000);
          await persistReachable(d.site, d.mac, ok);
          unmatchedPinged++;
          if (ok) reachable++;
        } catch { /* skip on error, keep last state */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PING_CONCURRENCY, toPing.length || 1) }, worker));

    const durationMs = Date.now() - t0;
    logActivity(errors.length ? 'warn' : 'info', 'mikrotik',
      `DHCP: ${leases} lease(s) from ${routers.length} router(s); ${unmatchedPinged} unmatched pinged (${reachable} online)${errors.length ? ` · errors: ${errors.join('; ')}` : ''} (${(durationMs / 1000).toFixed(1)}s)`);

    // Printer-offline alert eval runs on the collector's own cadence (fresh
    // reachability is in the DB now). Self-contained; never throws.
    try { await evaluateAndSendPrinterAlerts(); } catch (e) { logActivity('error', 'alerts', `Printer alert eval failed: ${String(e).split('\n')[0]}`); }

    return { routers: routers.length, leases, unmatchedPinged, reachable, errors, durationMs };
  } catch (err) {
    logActivity('error', 'mikrotik', `DHCP collect failed: ${String(err).split('\n')[0]}`);
    return { routers: 0, leases, unmatchedPinged, reachable, errors: [String(err)], durationMs: Date.now() - t0 };
  } finally {
    runInFlight = false;
  }
}

// On-demand ICMP ping of one device IP (per-row "Ping" in the Devices tab).
// Returns a cmd-like transcript and persists the verdict on the lease.
export async function probeDeviceNow(site: string, mac: string, ip: string): Promise<{ alive: boolean; console: string }> {
  const res = await pingWithOutput(ip, 4, 2000);
  try { await persistReachable(site, mac, res.alive); } catch { /* best effort */ }
  const lines = [`> ping -n 4 ${ip}`, '', res.output.replace(/\r\n/g, '\n').trimEnd()];
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
