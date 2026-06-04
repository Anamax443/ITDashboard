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

async function readNum(key: string, fallback: number): Promise<number> {
  const v = await getSetting(key).catch(() => undefined);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type RetentionStepName = 'events_purge' | 'activity_log_purge' | 'pc_user_history_purge' | 'events_dedup';

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
  logActivity('info', 'retention', `Starting (${triggerSource}) — events>${eventsDays}d, activity>${activityDays}d, pc_user_history>${pcUserDays}d`);

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
