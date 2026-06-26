import { getPool } from '../db/pool.js';
import { getSetting } from './settings.js';
import { logActivity } from './activity-log.js';

// Daily retention purges. sp_purge_old_events and sp_purge_old_activity exist
// in the schema but nothing was calling them — `events` and `activity_log`
// were growing forever. Reviewer flagged this as a P0 ops gap. Runs once a
// day at the configured hour (default 02:00) regardless of the periodic
// checks window; retention is a maintenance task, not user-facing work.
//
// Retention days are read from settings on every tick so they apply live:
//   events  →  events.retention_days (default 90)
//   activity_log  →  activity.retention_days (default 30)

interface RetentionResult {
  ok: boolean;
  rowsAffected: number;
  durationMs: number;
  error?: string;
}

export interface RetentionRunReport {
  triggerSource: 'manual' | 'scheduled';
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  steps: Array<{
    name: string;
    ok: boolean;
    rowsAffected: number;
    durationMs: number;
    detail: string;
    error?: string;
  }>;
}

let lastReport: RetentionRunReport | null = null;
let running = false;

export function getLastRetentionReport(): RetentionRunReport | null {
  return lastReport;
}

export function isRetentionRunning(): boolean {
  return running;
}

async function callProc(procName: string, inputs: Record<string, number>): Promise<RetentionResult> {
  const t0 = Date.now();
  try {
    const pool = await getPool();
    const req = pool.request();
    for (const [k, v] of Object.entries(inputs)) req.input(k, v);
    const r = await req.execute(procName);
    return {
      ok: true,
      rowsAffected: r.rowsAffected.reduce((a, b) => a + b, 0),
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      rowsAffected: 0,
      durationMs: Date.now() - t0,
      error: String(err).split('\n')[0]?.slice(0, 300) ?? 'unknown',
    };
  }
}

async function callPurge(procName: string, retentionDays: number): Promise<RetentionResult> {
  return callProc(procName, { retention_days: retentionDays });
}

// Raw parameterized DELETE (no stored proc). Used by the device-inventory steps,
// which the schema purges inline in the collector rather than via sp_purge_* procs.
async function callQuery(sql: string, inputs: Record<string, number>): Promise<RetentionResult> {
  const t0 = Date.now();
  try {
    const pool = await getPool();
    const req = pool.request();
    for (const [k, v] of Object.entries(inputs)) req.input(k, v);
    const r = await req.query(sql);
    return { ok: true, rowsAffected: r.rowsAffected.reduce((a, b) => a + b, 0), durationMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, rowsAffected: 0, durationMs: Date.now() - t0, error: String(err).split('\n')[0]?.slice(0, 300) ?? 'unknown' };
  }
}

// Device-inventory purges. These mirror the inline pruning the MikroTik collector
// runs each cycle (see mikrotik-collector.ts) — replicated here as discrete steps so
// an operator can force a purge from the retention panel between collect runs. Kept
// byte-for-byte identical to the collector's queries so behaviour stays consistent.
const SQL_PURGE_PING_SAMPLES =
  `DELETE FROM device_ping_samples WHERE sample_at < DATEADD(HOUR, -(@win + 1), SYSUTCDATETIME())`;
const SQL_PURGE_IP_HISTORY =
  `DELETE FROM device_ip_history WHERE last_seen < DATEADD(DAY, -@days, SYSUTCDATETIME())`;
const SQL_PURGE_GHOST_LEASES = `
  DELETE FROM dhcp_leases
  WHERE last_seen < DATEADD(DAY, -@days, SYSUTCDATETIME())
    AND (reach_checked_at IS NULL OR reach_checked_at < DATEADD(DAY, -@days, SYSUTCDATETIME()))
    AND (last_reachable_at IS NULL OR last_reachable_at < DATEADD(DAY, -@days, SYSUTCDATETIME()))
    -- Never prune a device the operator has IDENTIFIED (confirmed category other than
    -- phone, or a name / note) — it stays in inventory, shown offline.
    AND NOT EXISTS (
      SELECT 1 FROM device_categories dc WHERE dc.mac_address = dhcp_leases.mac_address
        AND ((dc.category IS NOT NULL AND dc.category NOT IN ('', 'phone'))
          OR (dc.name IS NOT NULL AND dc.name <> '')
          OR (dc.note IS NOT NULL AND dc.note <> '')))`;

async function readNum(key: string, fallback: number): Promise<number> {
  const v = await getSetting(key).catch(() => undefined);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type RetentionStepName = 'events_purge' | 'activity_log_purge' | 'pc_user_history_purge' | 'perf_purge' | 'ad_sync_runs_purge' | 'dhcp_leases_purge' | 'device_ip_history_purge' | 'ping_samples_purge' | 'events_dedup';

export async function runRetentionOnce(
  triggerSource: 'manual' | 'scheduled' = 'manual',
  stepsFilter?: RetentionStepName[],
): Promise<RetentionRunReport> {
  if (running) {
    throw new Error('Retention run already in progress');
  }
  running = true;
  try {
    return await runRetentionInner(triggerSource, stepsFilter);
  } finally {
    running = false;
  }
}

async function runRetentionInner(
  triggerSource: 'manual' | 'scheduled',
  stepsFilter?: RetentionStepName[],
): Promise<RetentionRunReport> {
  const shouldRun = (name: RetentionStepName): boolean =>
    !stepsFilter || stepsFilter.includes(name);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const eventsDays = await readNum('events.retention_days', 90);
  const activityDays = await readNum('activity.retention_days', 30);
  const pcUserDays = await readNum('pcUserHistory.retention_days', 90);
  const perfDays = await readNum('perf.retention_days', 180);
  const adRunsDays = await readNum('adsync.runs_retention_days', 90);
  // Device-inventory steps mirror the collector's inline pruning. Read raw (not via
  // readNum) so "0 = keep forever" is honoured for ghosts/history instead of falling
  // back to a default; loss window always prunes, so it keeps the readNum default.
  const leaseDaysRaw = Number(await getSetting('devices.lease_retention_days').catch(() => undefined));
  const histDaysRaw = Number(await getSetting('devices.history_retention_days').catch(() => undefined));
  const lossHours = await readNum('devices.loss_window_hours', 24);
  logActivity('info', 'retention', `Starting (${triggerSource}) — events>${eventsDays}d, activity>${activityDays}d, pc_user_history>${pcUserDays}d, perf>${perfDays}d, ad_sync_runs>${adRunsDays}d`);

  const steps: RetentionRunReport['steps'] = [];

  if (shouldRun('events_purge')) {
    const eventsRes = await callPurge('sp_purge_old_events', eventsDays);
    if (eventsRes.ok) logActivity('success', 'retention', `events purge: ${eventsRes.rowsAffected} rows removed (${(eventsRes.durationMs/1000).toFixed(1)}s)`);
    else              logActivity('error',   'retention', `events purge failed: ${eventsRes.error}`);
    steps.push({ name: 'events_purge', ok: eventsRes.ok, rowsAffected: eventsRes.rowsAffected, durationMs: eventsRes.durationMs, detail: `> ${eventsDays}d`, error: eventsRes.error });
  }

  if (shouldRun('activity_log_purge')) {
    const activityRes = await callPurge('sp_purge_old_activity', activityDays);
    if (activityRes.ok) logActivity('success', 'retention', `activity_log purge: ${activityRes.rowsAffected} rows removed (${(activityRes.durationMs/1000).toFixed(1)}s)`);
    else                logActivity('error',   'retention', `activity_log purge failed: ${activityRes.error}`);
    steps.push({ name: 'activity_log_purge', ok: activityRes.ok, rowsAffected: activityRes.rowsAffected, durationMs: activityRes.durationMs, detail: `> ${activityDays}d`, error: activityRes.error });
  }

  if (shouldRun('pc_user_history_purge')) {
    const pcUserRes = await callPurge('sp_purge_pc_user_history', pcUserDays);
    if (pcUserRes.ok) logActivity('success', 'retention', `pc_user_history purge: ${pcUserRes.rowsAffected} rows removed (${(pcUserRes.durationMs/1000).toFixed(1)}s)`);
    else              logActivity('error',   'retention', `pc_user_history purge failed: ${pcUserRes.error}`);
    steps.push({ name: 'pc_user_history_purge', ok: pcUserRes.ok, rowsAffected: pcUserRes.rowsAffected, durationMs: pcUserRes.durationMs, detail: `> ${pcUserDays}d`, error: pcUserRes.error });
  }

  if (shouldRun('perf_purge')) {
    const perfRes = await callPurge('sp_purge_old_perf', perfDays);
    if (perfRes.ok) logActivity('success', 'retention', `perf_events purge: ${perfRes.rowsAffected} rows removed (${(perfRes.durationMs/1000).toFixed(1)}s)`);
    else            logActivity('error',   'retention', `perf_events purge failed: ${perfRes.error}`);
    steps.push({ name: 'perf_purge', ok: perfRes.ok, rowsAffected: perfRes.rowsAffected, durationMs: perfRes.durationMs, detail: `> ${perfDays}d`, error: perfRes.error });
  }

  if (shouldRun('ad_sync_runs_purge')) {
    const adRes = await callPurge('sp_purge_ad_sync_runs', adRunsDays);
    if (adRes.ok) logActivity('success', 'retention', `ad_sync_runs purge: ${adRes.rowsAffected} rows removed (${(adRes.durationMs/1000).toFixed(1)}s)`);
    else          logActivity('error',   'retention', `ad_sync_runs purge failed: ${adRes.error}`);
    steps.push({ name: 'ad_sync_runs_purge', ok: adRes.ok, rowsAffected: adRes.rowsAffected, durationMs: adRes.durationMs, detail: `> ${adRunsDays}d`, error: adRes.error });
  }

  if (shouldRun('ping_samples_purge')) {
    const res = await callQuery(SQL_PURGE_PING_SAMPLES, { win: Math.floor(lossHours) });
    if (res.ok) logActivity('success', 'retention', `device_ping_samples purge: ${res.rowsAffected} rows removed (${(res.durationMs/1000).toFixed(1)}s)`);
    else        logActivity('error',   'retention', `device_ping_samples purge failed: ${res.error}`);
    steps.push({ name: 'ping_samples_purge', ok: res.ok, rowsAffected: res.rowsAffected, durationMs: res.durationMs, detail: `> ${Math.floor(lossHours)}h (+1h)`, error: res.error });
  }

  if (shouldRun('dhcp_leases_purge')) {
    if (Number.isFinite(leaseDaysRaw) && leaseDaysRaw >= 1) {
      const res = await callQuery(SQL_PURGE_GHOST_LEASES, { days: Math.floor(leaseDaysRaw) });
      if (res.ok) logActivity('success', 'retention', `dhcp_leases ghost purge: ${res.rowsAffected} rows removed (${(res.durationMs/1000).toFixed(1)}s)`);
      else        logActivity('error',   'retention', `dhcp_leases ghost purge failed: ${res.error}`);
      steps.push({ name: 'dhcp_leases_purge', ok: res.ok, rowsAffected: res.rowsAffected, durationMs: res.durationMs, detail: `> ${Math.floor(leaseDaysRaw)}d`, error: res.error });
    } else {
      steps.push({ name: 'dhcp_leases_purge', ok: true, rowsAffected: 0, durationMs: 0, detail: 'skipped (0 = keep forever)' });
    }
  }

  if (shouldRun('device_ip_history_purge')) {
    if (Number.isFinite(histDaysRaw) && histDaysRaw >= 1) {
      const res = await callQuery(SQL_PURGE_IP_HISTORY, { days: Math.floor(histDaysRaw) });
      if (res.ok) logActivity('success', 'retention', `device_ip_history purge: ${res.rowsAffected} rows removed (${(res.durationMs/1000).toFixed(1)}s)`);
      else        logActivity('error',   'retention', `device_ip_history purge failed: ${res.error}`);
      steps.push({ name: 'device_ip_history_purge', ok: res.ok, rowsAffected: res.rowsAffected, durationMs: res.durationMs, detail: `> ${Math.floor(histDaysRaw)}d`, error: res.error });
    } else {
      steps.push({ name: 'device_ip_history_purge', ok: true, rowsAffected: 0, durationMs: 0, detail: 'skipped (0 = keep forever)' });
    }
  }

  if (shouldRun('events_dedup')) {
    const dedupEnabled = (await getSetting('events.dedup_enabled').catch(() => '1')) === '1';
    if (dedupEnabled || stepsFilter) {
      // Manual run with explicit step selection bypasses the dedup_enabled
      // setting — operator explicitly asked to run this step, honor that.
      const dedupLookback = await readNum('events.dedup_lookback_days', eventsDays);
      const dedupRes = await callProc('sp_purge_duplicate_events', { lookback_days: dedupLookback });
      if (dedupRes.ok) logActivity('success', 'retention', `events dedup: ${dedupRes.rowsAffected} duplicate rows removed within ${dedupLookback}d window (${(dedupRes.durationMs/1000).toFixed(1)}s)`);
      else             logActivity('error',   'retention', `events dedup failed: ${dedupRes.error}`);
      steps.push({ name: 'events_dedup', ok: dedupRes.ok, rowsAffected: dedupRes.rowsAffected, durationMs: dedupRes.durationMs, detail: `lookback ${dedupLookback}d`, error: dedupRes.error });
    } else {
      logActivity('info', 'retention', 'events dedup skipped (events.dedup_enabled=0)');
      steps.push({ name: 'events_dedup', ok: true, rowsAffected: 0, durationMs: 0, detail: 'skipped (disabled in settings)' });
    }
  }

  const finishedAtMs = Date.now();
  const report: RetentionRunReport = {
    triggerSource,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    totalDurationMs: finishedAtMs - startedAtMs,
    steps,
  };
  lastReport = report;
  return report;
}

let timer: NodeJS.Timeout | null = null;
let nextRunAt: Date | null = null;

function msUntilNext(hour: number, minute = 0): { ms: number; at: Date } {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return { ms: next.getTime() - now.getTime(), at: next };
}

async function scheduleNext(): Promise<void> {
  const hourRaw = await getSetting('retention.run_at_hour').catch(() => undefined);
  const hour = Number(hourRaw);
  const targetHour = Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 2;
  const { ms, at } = msUntilNext(targetHour);
  nextRunAt = at;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      await runRetentionOnce('scheduled');
    } catch (err) {
      console.error('[retention] scheduled run failed:', err);
    } finally {
      void scheduleNext();
    }
  }, ms);
  console.log(`Retention next run scheduled for ${at.toISOString()} (in ${(ms / 1000 / 60).toFixed(0)} min)`);
}

export async function startRetentionSchedule(): Promise<void> {
  await scheduleNext();
}

export function getRetentionNextRun(): string | null {
  return nextRunAt?.toISOString() ?? null;
}
