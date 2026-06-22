import { execFile } from 'node:child_process';
import { getPool } from '../db/pool.js';
import { getAllSettings } from './settings.js';
import { boolSetting } from './alerts-util.js';
import { logActivity } from './activity-log.js';
import { parseNetViewPrinters, type SharedPrinter } from './netview-util.js';

// Shared / USB printers collector. A USB (or otherwise locally-attached) printer
// shared from a PC has no IP of its own, so the network scan can't see it — but it
// shows up as a printer-type SMB share of its host PC. We enumerate those with
// `net view \\<pc>` (verified to work where WMI is access-denied) and store each as
// a device row in the SAME inventory (dhcp_leases, source='share') so it appears in
// the Devices tab and the printer-status page, and PERSISTS even when offline.
//
// Identity only (the operator goal): printer name + which PC it lives on. The host
// PC is carried in `comment`, and the row's ip_address is the PC's IP so it pairs to
// the AD computer by IP (the Devices "AD" column then shows the PC too).

const SITE = 'USB';                 // logical "site" grouping for shared printers
const CONCURRENCY = 8;
let inFlight = false;

// Stable synthetic MAC-key per (host, share name) — fits dhcp_leases.mac_address
// NVARCHAR(32), e.g. "SHR-10.90.183.12-74213".
function shareKey(hostId: string, name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (((h << 5) + h) + name.charCodeAt(i)) | 0;
  return `SHR-${hostId}-${(h >>> 0) % 100000}`;
}

interface PcTarget { id: number; name: string; fqdn: string | null; ip: string | null; }

// Only reachable, enabled, non-excluded PCs (net view on a dead box just times out).
async function listReachablePcs(): Promise<PcTarget[]> {
  const pool = await getPool();
  const r = await pool.request().query<PcTarget>(`
    SELECT id, name, fqdn, ip_address AS ip
    FROM computers
    WHERE enabled = 1 AND excluded = 0 AND reachable = 1
    ORDER BY name
  `);
  return r.recordset;
}

// Run `net view \\<host>` and parse its printer shares. ok=false on any error
// (offline / access denied / timeout) so the caller does NOT prune that PC's
// last-known shares — they persist (shown offline via the host's reachability).
function netViewPrinters(host: string, timeoutMs: number): Promise<{ ok: boolean; printers: SharedPrinter[] }> {
  return new Promise((resolve) => {
    execFile('net', ['view', `\\\\${host}`], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
      const out = stdout || '';
      resolve({ ok: !err, printers: parseNetViewPrinters(out) });
    });
  });
}

async function upsertShare(pcName: string, ip: string | null, printer: SharedPrinter): Promise<string> {
  const mac = shareKey(ip ?? pcName, printer.name);
  const pool = await getPool();
  await pool.request()
    .input('site', SITE).input('mac', mac).input('ip', ip).input('host', printer.name).input('pc', pcName)
    .query(`
      MERGE dhcp_leases AS t USING (SELECT @site AS site, @mac AS mac) AS s
        ON t.site = s.site AND t.mac_address = s.mac
      WHEN MATCHED THEN UPDATE SET
        ip_address = @ip, host_name = @host, comment = @pc, source = 'share',
        dynamic = 0, status = 'share', last_seen = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (site, mac_address, ip_address, host_name, comment, source, dynamic, status)
        VALUES (@site, @mac, @ip, @host, @pc, 'share', 0, 'share');
    `);
  return mac;
}

// After a SUCCESSFUL net view, drop this PC's share rows that are no longer shared
// (genuine removal). Never called when net view failed, so an offline PC keeps its
// last-known shares.
async function pruneStaleShares(pcName: string, keepMacs: string[]): Promise<void> {
  const pool = await getPool();
  const req = pool.request().input('site', SITE).input('pc', pcName);
  if (keepMacs.length === 0) {
    await req.query(`DELETE FROM dhcp_leases WHERE site = @site AND comment = @pc AND source = 'share'`);
    return;
  }
  const params = keepMacs.map((m, i) => { req.input(`k${i}`, m); return `@k${i}`; });
  await req.query(`DELETE FROM dhcp_leases WHERE site = @site AND comment = @pc AND source = 'share' AND mac_address NOT IN (${params.join(',')})`);
}

export interface SharedPrintersRunResult { pcs: number; probed: number; printers: number; durationMs: number; }

export async function runSharedPrintersOnce(): Promise<SharedPrintersRunResult | null> {
  if (inFlight) return null;
  inFlight = true;
  const t0 = Date.now();
  try {
    const settings = await getAllSettings();
    const timeoutMs = Number(settings['shared_printers.timeout_ms'] ?? 8000) || 8000;
    const targets = await listReachablePcs();
    let probed = 0;
    let printers = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const pc = targets[idx++];
        if (!pc) continue;
        const host = pc.ip || pc.fqdn || pc.name;
        try {
          const { ok, printers: found } = await netViewPrinters(host, timeoutMs);
          if (!ok) continue; // offline / denied — keep last-known shares
          probed++;
          const keep: string[] = [];
          for (const p of found) keep.push(await upsertShare(pc.name, pc.ip, p));
          await pruneStaleShares(pc.name, keep);
          printers += found.length;
        } catch { /* keep this PC's last-known shares on a transient error */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));
    const durationMs = Date.now() - t0;
    logActivity('info', 'shared-printers',
      `Shared printers: ${printers} on ${probed}/${targets.length} reachable PC(s) (${(durationMs / 1000).toFixed(1)}s)`);
    return { pcs: targets.length, probed, printers, durationMs };
  } catch (err) {
    logActivity('error', 'shared-printers', `Shared printers scan failed: ${String(err).split('\n')[0]}`);
    return { pcs: 0, probed: 0, printers: 0, durationMs: Date.now() - t0 };
  } finally {
    inFlight = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;

// Own slow schedule (printers change rarely) — default 1h, re-reads the enable
// flag + interval each cycle so Settings changes apply without a restart.
export async function startSharedPrintersSchedule(): Promise<void> {
  stopped = false;
  if (timer) { clearTimeout(timer); timer = null; }
  const loop = async () => {
    if (stopped) return;
    let intervalSec = 3600;
    try {
      const settings = await getAllSettings();
      if (boolSetting(settings['checks.run_shared_printers'] ?? '1')) {
        await runSharedPrintersOnce();
      }
      const n = Number(settings['shared_printers.interval_sec']);
      if (Number.isFinite(n) && n >= 300) intervalSec = Math.floor(n);
    } catch (e) {
      console.error('Shared printers schedule error', e);
    }
    if (!stopped) timer = setTimeout(loop, intervalSec * 1000);
  };
  loop().catch((e) => console.error('Shared printers schedule error', e));
  console.log('Shared printers scan scheduled (net view, hourly)');
}
