import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';
import { collectFromPC, insertEvents } from './eventlog-collector.js';
import { fetchPcScan, upsertDisk, upsertPcInfo } from './disk-collector.js';
import { fetchServices, replaceProblems, replaceCritical } from './services-collector.js';
import { fetchPerfEvents, insertPerfEvents } from './perf-collector.js';
import { probeOnePcPorts } from './port-status-collector.js';
import { getSetting } from './settings.js';

// Runs all four collectors against a single PC sequentially. Used by the
// per-row "🔄 Refresh now" action in the Computers tab when the operator
// wants fresh data on the machine they are about to work with — no need
// to spin the whole fleet.

export interface SingleRefreshResult {
  computerId: number;
  computerName: string;
  ok: boolean;
  durationMs: number;
  steps: Array<{ step: string; ok: boolean; detail: string; durationMs: number }>;
}

interface ComputerRow {
  id: number;
  name: string;
  last_collected_at: Date | null;
}

const inFlight = new Set<number>();

export async function refreshSinglePc(computerId: number): Promise<SingleRefreshResult | null> {
  if (inFlight.has(computerId)) return null;
  inFlight.add(computerId);
  const t0 = Date.now();
  const steps: SingleRefreshResult['steps'] = [];

  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('id', computerId)
      .query<ComputerRow>(`SELECT TOP 1 id, name, last_collected_at FROM computers WHERE id = @id`);
    const target = r.recordset[0];
    if (!target) {
      logActivity('warn', 'refresh-pc', `Computer ${computerId} not found`);
      return null;
    }

    logActivity('info', 'refresh-pc', `Starting single-PC refresh: ${target.name}`);

    // 1) Disk + PC-info (also writes pc_user_history)
    const t1 = Date.now();
    let diskDetail = '';
    let diskOk = false;
    try {
      const scan = await fetchPcScan(target.name);
      for (const d of scan.disks) await upsertDisk(target.id, d);
      await upsertPcInfo(target.id, scan.info);
      diskDetail = `${scan.disks.length} drives, ip=${scan.info.IPAddress ?? '—'}, user=${scan.info.UserName ?? '—'}`;
      diskOk = true;
    } catch (err) {
      diskDetail = String(err).split('\n')[0]?.slice(0, 200) ?? 'unknown';
    }
    steps.push({ step: 'disk+info', ok: diskOk, detail: diskDetail, durationMs: Date.now() - t1 });

    // 2) Services
    const t2 = Date.now();
    let svcDetail = '';
    let svcOk = false;
    try {
      const critical = (await getSetting('alerts.services.critical_names').catch(() => undefined) ?? '')
        .split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
      const scan = await fetchServices(target.name, critical);
      await replaceProblems(target.id, scan.problems);
      await replaceCritical(target.id, scan.critical);
      svcDetail = `${scan.problems.length} problem service(s)`;
      svcOk = true;
    } catch (err) {
      svcDetail = String(err).split('\n')[0]?.slice(0, 200) ?? 'unknown';
    }
    steps.push({ step: 'services', ok: svcOk, detail: svcDetail, durationMs: Date.now() - t2 });

    // 3) Eventlog (since last_collected_at or last 1h cold-start)
    const t3 = Date.now();
    let evDetail = '';
    let evOk = false;
    try {
      const since = target.last_collected_at ?? new Date(Date.now() - 60 * 60 * 1000);
      const events = await collectFromPC(target.name, since);
      const added = await insertEvents(target.id, events);
      await pool.request().input('id', target.id).query(`
        UPDATE computers
        SET last_collected_at = SYSUTCDATETIME(),
            last_seen = SYSUTCDATETIME(),
            last_error = NULL,
            consecutive_failures = 0,
            last_status = 'online',
            reachable = 1,
            last_reachable_at = SYSUTCDATETIME(),
            reach_checked_at = SYSUTCDATETIME()
        WHERE id = @id;
      `);
      evDetail = `+${added} new event(s)`;
      evOk = true;
    } catch (err) {
      evDetail = String(err).split('\n')[0]?.slice(0, 200) ?? 'unknown';
    }
    steps.push({ step: 'eventlog', ok: evOk, detail: evDetail, durationMs: Date.now() - t3 });

    // 4) Perf events (cold-start window from setting)
    const t4 = Date.now();
    let perfDetail = '';
    let perfOk = false;
    try {
      const coldRaw = await getSetting('perf.cold_start_days').catch(() => undefined);
      const coldDays = (() => {
        const n = Number(coldRaw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 30;
      })();
      const lastPerf = await pool.request().input('id', target.id).query<{ ts: Date | null }>(
        `SELECT MAX(time_created) AS ts FROM perf_events WHERE computer_id = @id`,
      );
      const since = lastPerf.recordset[0]?.ts ?? new Date(Date.now() - coldDays * 24 * 3600 * 1000);
      const events = await fetchPerfEvents(target.name, since);
      const added = await insertPerfEvents(target.id, events);
      perfDetail = `+${added} perf event(s)`;
      perfOk = true;
    } catch (err) {
      const msg = String(err).split('\n')[0]?.slice(0, 200) ?? 'unknown';
      // channel-disabled is normal for Server SKU — surface as ok=true with note
      if (/There is not an event log/i.test(msg)) {
        perfDetail = 'channel disabled (Server SKU)';
        perfOk = true;
      } else {
        perfDetail = msg;
      }
    }
    steps.push({ step: 'perf', ok: perfOk, detail: perfDetail, durationMs: Date.now() - t4 });

    // 5) Ports — TCP-probe the configured ports and upsert into port_status so
    // the Ports tab reflects this PC's live availability right after a refresh.
    const t5 = Date.now();
    let portDetail = '';
    let portOk = false;
    try {
      const res = await probeOnePcPorts(target.id, target.name);
      portDetail = res.checks === 0 ? 'no ports configured' : `${res.open}/${res.checks} port(s) open`;
      portOk = true;
    } catch (err) {
      portDetail = String(err).split('\n')[0]?.slice(0, 200) ?? 'unknown';
    }
    steps.push({ step: 'ports', ok: portOk, detail: portDetail, durationMs: Date.now() - t5 });

    const allOk = steps.every((s) => s.ok);
    const durationMs = Date.now() - t0;
    logActivity(allOk ? 'success' : 'warn', 'refresh-pc',
      `${target.name} done (${(durationMs / 1000).toFixed(1)}s): ` +
      steps.map((s) => `${s.step}=${s.ok ? '✓' : '✗'}`).join(' '));

    return {
      computerId: target.id,
      computerName: target.name,
      ok: allOk,
      durationMs,
      steps,
    };
  } finally {
    inFlight.delete(computerId);
  }
}

export function isRefreshInFlight(computerId: number): boolean {
  return inFlight.has(computerId);
}
