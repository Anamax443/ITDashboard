import { request as httpsRequest } from 'node:https';
import { getPool } from '../db/pool.js';
import { getAllSettings, type SettingsMap } from './settings.js';
import { decryptSecret } from './secret-crypto.js';
import { boolSetting } from './alerts-util.js';
import { logActivity } from './activity-log.js';
import { parseScanRanges, siteForIp } from './mikrotik-util.js';

// UniFi controller collector. Logs in to a (legacy, :8443) controller, reads the
// connected-client list (/api/s/<site>/stat/sta), and upserts each client into
// dhcp_leases as source='unifi' — keyed by MAC so it merges with DHCP/ARP/scan
// rows instead of duplicating. UniFi sees wired AND wireless clients across every
// network with a real MAC + hostname, so it fills the gap left by router ARP
// (L2, router-local) and the app-server scan (can't key MAC-less remote hosts).
//
// Config is fully DB-driven (Settings page); the password is decrypted here so
// callers never see the ciphertext. Self-signed controller cert is accepted (the
// controller is an internal VM with a self-signed cert, like the device proxies).

interface UnifiConfig { baseUrl: string; site: string; user: string; pass: string; intervalSec: number; }

function resolveConfig(settings: SettingsMap): UnifiConfig | null {
  if (!boolSetting(settings['unifi.enabled'])) return null;
  const baseUrl = (settings['unifi.url'] ?? '').trim().replace(/\/+$/, '');
  const user = (settings['unifi.user'] ?? '').trim();
  const enc = settings['unifi.password_enc'] ?? '';
  let pass = '';
  try { pass = enc ? decryptSecret(enc) : ''; } catch { pass = ''; }
  if (!baseUrl || !user || !pass) return null;          // not configured → idle
  const site = (settings['unifi.site'] ?? '').trim() || 'default';
  const n = Number(settings['unifi.interval_sec']);
  const intervalSec = Number.isFinite(n) && n >= 30 ? Math.floor(n) : 300;
  return { baseUrl, site, user, pass, intervalSec };
}

interface HttpResult { status: number; body: string; cookies: string[]; }

// Minimal HTTPS JSON call over node:https (the controller cert is self-signed, so
// rejectUnauthorized is off — same stance as the device web proxy). Never throws
// synchronously; rejects the promise on a transport/timeout error.
function httpsJson(url: string, opts: { method: string; cookie?: string; json?: unknown; timeoutMs?: number }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = opts.json != null ? Buffer.from(JSON.stringify(opts.json)) : null;
    const req = httpsRequest({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': String(payload.length) } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body,
        cookies: (res.headers['set-cookie'] as string[] | undefined) ?? [],
      }));
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 10000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Build a Cookie header from the controller's Set-Cookie list (session + csrf).
function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

// A UniFi connected-client object (only the fields we use).
interface UnifiClient {
  mac?: string;
  ip?: string;
  last_ip?: string;
  hostname?: string;
  name?: string;                          // operator-set alias (best name)
  is_wired?: boolean;
  network?: string;
  last_connection_network_name?: string;
  ap_mac?: string;
  last_uplink_name?: string;
}

// Upsert one UniFi client as a device row. Keyed by (site, mac) like every other
// source. Non-destructive: keeps a DHCP-provided name/comment, and does NOT
// relabel a 'dhcp' row (DHCP is the authoritative static/dynamic source) — UniFi
// only owns the live reachability + a better name when none exists. A UniFi client
// in stat/sta is CONNECTED, so reachable=1.
async function upsertUnifiClient(site: string, mac: string, ip: string | null, host: string | null, comment: string): Promise<void> {
  const pool = await getPool();
  await pool.request()
    .input('site', site).input('mac', mac).input('ip', ip).input('host', host).input('comment', comment)
    .query(`
      MERGE dhcp_leases AS t USING (SELECT @site AS site, @mac AS mac) AS s
        ON t.site = s.site AND t.mac_address = s.mac
      WHEN MATCHED THEN UPDATE SET
        ip_address = @ip,
        host_name = COALESCE(t.host_name, @host),
        comment = COALESCE(t.comment, @comment),
        status = 'unifi',
        source = CASE WHEN t.source = 'dhcp' THEN 'dhcp' ELSE 'unifi' END,
        -- UniFi (stat/sta) doesn't report static-vs-DHCP, so don't assert it: a
        -- DHCP-owned row keeps its real flag, anything UniFi takes over goes NULL
        -- (unknown) instead of falsely showing "Statická".
        dynamic = CASE WHEN t.source = 'dhcp' THEN t.dynamic ELSE NULL END,
        reachable = 1,
        last_reachable_at = SYSUTCDATETIME(),
        reach_checked_at = SYSUTCDATETIME(),
        last_seen = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (site, mac_address, ip_address, host_name, comment, status, dynamic, source,
         reachable, last_reachable_at, reach_checked_at, last_seen)
        VALUES (@site, @mac, @ip, @host, @comment, 'unifi', NULL, 'unifi',
         1, SYSUTCDATETIME(), SYSUTCDATETIME(), SYSUTCDATETIME());
    `);
}

// Remove synthetic "IP-<ip>" placeholder rows once a real-MAC row exists for the
// same IP (any source). Matches on IP alone — an IP belongs to one device, so a
// real MAC at that IP supersedes the MAC-less guess. OUTPUT yields one row per
// delete, so recordset.length is the count removed. Best-effort.
async function dedupSyntheticByIp(): Promise<number> {
  try {
    const pool = await getPool();
    const r = await pool.request().query<{ n: number }>(`
      DELETE s OUTPUT 1 AS n
      FROM dhcp_leases s
      WHERE s.mac_address LIKE 'IP-%'
        AND s.ip_address IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM dhcp_leases r
          WHERE r.ip_address = s.ip_address AND r.mac_address NOT LIKE 'IP-%'
        );
    `);
    return r.recordset.length;
  } catch {
    return 0;
  }
}

export interface UnifiRunResult { clients: number; upserted: number; errors: string[]; durationMs: number; }

let runInFlight = false;

// Pull the controller's connected-client list once and upsert it. Never throws.
// Returns null only if a run is already in flight.
export async function runUnifiCollectOnce(): Promise<UnifiRunResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  const errors: string[] = [];
  let clients = 0;
  let upserted = 0;
  try {
    const settings = await getAllSettings();
    const cfg = resolveConfig(settings);
    if (!cfg) return { clients: 0, upserted: 0, errors: [], durationMs: Date.now() - t0 };

    // Reuse the scan ranges to label each client's Lokalita by IP, so UniFi devices
    // carry the same site names (Brno/Zastavka/…) as the rest of the inventory.
    const ranges = parseScanRanges(settings['mikrotik.scan_ranges']);

    const login = await httpsJson(`${cfg.baseUrl}/api/login`, { method: 'POST', json: { username: cfg.user, password: cfg.pass } });
    if (login.status !== 200 || login.cookies.length === 0) {
      logActivity('error', 'unifi', `UniFi login failed (HTTP ${login.status})`);
      return { clients: 0, upserted: 0, errors: [`login ${login.status}`], durationMs: Date.now() - t0 };
    }
    const cookie = cookieHeader(login.cookies);

    const res = await httpsJson(`${cfg.baseUrl}/api/s/${cfg.site}/stat/sta`, { method: 'GET', cookie });
    if (res.status !== 200) {
      logActivity('error', 'unifi', `UniFi stat/sta failed (HTTP ${res.status})`);
      try { await httpsJson(`${cfg.baseUrl}/api/logout`, { method: 'POST', cookie }); } catch { /* ignore */ }
      return { clients: 0, upserted: 0, errors: [`sta ${res.status}`], durationMs: Date.now() - t0 };
    }

    let data: UnifiClient[] = [];
    try { data = (JSON.parse(res.body) as { data?: UnifiClient[] }).data ?? []; } catch { errors.push('parse'); }
    clients = data.length;

    for (const c of data) {
      const mac = (c.mac ?? '').trim().toUpperCase();   // colon+upper = RouterOS form, so keys match
      if (!mac) continue;
      const ip = ((c.ip || c.last_ip) ?? '').trim() || null;
      const host = (c.name || c.hostname || '').trim() || null;
      const site = (ip ? siteForIp(ip, ranges) : null) || c.last_connection_network_name || c.network || 'UniFi';
      const via = c.last_uplink_name || c.ap_mac || '';
      const comment = `UniFi · ${c.is_wired ? 'wired' : 'wifi'}${via ? ` · ${via}` : ''}`;
      try { await upsertUnifiClient(site, mac, ip, host, comment); upserted++; }
      catch { /* one client's DB error shouldn't abort the whole sync */ }
    }

    // Release the controller session (it caps concurrent logins).
    try { await httpsJson(`${cfg.baseUrl}/api/logout`, { method: 'POST', cookie }); } catch { /* ignore */ }

    // Dedup: a synthetic "IP-<ip>" scan row (a host the scan saw alive but couldn't
    // key — no MAC) is now redundant if UniFi supplied a real MAC at the SAME IP.
    // Drop the MAC-less placeholder so the device shows once, with its real MAC.
    const deduped = await dedupSyntheticByIp();

    const durationMs = Date.now() - t0;
    logActivity(errors.length ? 'warn' : 'info', 'unifi',
      `UniFi: ${upserted}/${clients} clients${deduped ? `, deduped ${deduped} IP-only row(s)` : ''}${errors.length ? ` · errors: ${errors.join('; ')}` : ''} (${(durationMs / 1000).toFixed(1)}s)`);
    return { clients, upserted, errors, durationMs };
  } catch (err) {
    logActivity('error', 'unifi', `UniFi collect failed: ${String(err).split('\n')[0]}`);
    return { clients: 0, upserted: 0, errors: [String(err)], durationMs: Date.now() - t0 };
  } finally {
    runInFlight = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;
const IDLE_RECHECK_SEC = 60;

// Standalone scheduler — mirrors the MikroTik/reachability collectors. Re-reads
// the enable flag + interval each cycle (so Settings changes apply live), and
// idles (re-checking every IDLE_RECHECK_SEC) while disabled/unconfigured so it
// never error-spams a controller that isn't set up yet.
export async function startUnifiSchedule(): Promise<void> {
  stopped = false;
  if (timer) { clearTimeout(timer); timer = null; }
  const loop = async () => {
    if (stopped) return;
    let nextSec = IDLE_RECHECK_SEC;
    try {
      const settings = await getAllSettings();
      const cfg = resolveConfig(settings);
      if (cfg) {
        await runUnifiCollectOnce();
        nextSec = cfg.intervalSec;
      }
    } catch (e) {
      console.error('UniFi schedule error', e);
    }
    if (!stopped) timer = setTimeout(loop, nextSec * 1000);
  };
  loop().catch((e) => console.error('UniFi schedule error', e));
  console.log('UniFi collector scheduled');
}
