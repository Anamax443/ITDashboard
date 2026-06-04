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

export async function runRetentionOnce(triggerSource: 'manual' | 'scheduled' = 'manual'): Promise<void> {
  const eventsDays = await readNum('events.retention_days', 90);
  const activityDays = await readNum('activity.retention_days', 30);
  const pcUserDays = await readNum('pcUserHistory.retention_days', 90);
  logActivity('info', 'retention', `Starting (${triggerSource}) — events>${eventsDays}d, activity>${activityDays}d, pc_user_history>${pcUserDays}d`);

  const eventsRes = await callPurge('sp_purge_old_events', eventsDays);
  if (eventsRes.ok) {
    logActivity('success', 'retention', `events purge: ${eventsRes.rowsAffected} rows removed (${(eventsRes.durationMs/1000).toFixed(1)}s)`);
  } else {
    logActivity('error', 'retention', `events purge failed: ${eventsRes.error}`);
  }

  const activityRes = await callPurge('sp_purge_old_activity', activityDays);
  if (activityRes.ok) {
    logActivity('success', 'retention', `activity_log purge: ${activityRes.rowsAffected} rows removed (${(activityRes.durationMs/1000).toFixed(1)}s)`);
  } else {
    logActivity('error', 'retention', `activity_log purge failed: ${activityRes.error}`);
  }

  const pcUserRes = await callPurge('sp_purge_pc_user_history', pcUserDays);
  if (pcUserRes.ok) {
    logActivity('success', 'retention', `pc_user_history purge: ${pcUserRes.rowsAffected} rows removed (${(pcUserRes.durationMs/1000).toFixed(1)}s)`);
  } else {
    logActivity('error', 'retention', `pc_user_history purge failed: ${pcUserRes.error}`);
  }

  // Event-table duplicate cleanup. The collector uses a time-based
  // watermark with inclusive StartTime, so events landing in the overlap
  // window between two runs get inserted twice. sp_purge_duplicate_events
  // keeps the first (lowest id) row of each duplicate group and deletes
  // the rest. Lookback defaults to the same window as events.retention_days
  // so the dedup pass covers everything not yet purged.
  const dedupEnabled = (await getSetting('events.dedup_enabled').catch(() => '1')) === '1';
  if (dedupEnabled) {
    const dedupLookback = await readNum('events.dedup_lookback_days', eventsDays);
    const dedupRes = await callProc('sp_purge_duplicate_events', { lookback_days: dedupLookback });
    if (dedupRes.ok) {
      logActivity('success', 'retention', `events dedup: ${dedupRes.rowsAffected} duplicate rows removed within ${dedupLookback}d window (${(dedupRes.durationMs/1000).toFixed(1)}s)`);
    } else {
      logActivity('error', 'retention', `events dedup failed: ${dedupRes.error}`);
    }
  } else {
    logActivity('info', 'retention', 'events dedup skipped (events.dedup_enabled=0)');
  }
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
