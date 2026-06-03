/**
 * In-memory ring buffer of recent activity events for the live view, plus
 * fire-and-forget DB persistence for cross-restart history. Filled by every
 * collector / scheduler / sync. Live view polls /activity/log; the persistent
 * history is queried via /activity/history with filters.
 */
import { getPool } from '../db/pool.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface ActivityLogEntry {
  ts: string;
  level: LogLevel;
  source: string;
  message: string;
}

const MAX_ENTRIES = 500;
const buffer: ActivityLogEntry[] = [];
let seq = 0;

async function persistEntry(entry: ActivityLogEntry): Promise<void> {
  try {
    const pool = await getPool();
    await pool.request()
      .input('ts', new Date(entry.ts))
      .input('lvl', entry.level)
      .input('src', entry.source)
      .input('msg', entry.message)
      .query(`INSERT INTO activity_log (ts, level, source, message) VALUES (@ts, @lvl, @src, @msg);`);
  } catch (err) {
    // Don't loop back through logActivity — that would recurse if the DB write
    // itself failed. Console-only so collector runs aren't blocked by DB hiccups.
    console.error('[activity-log] persist failed:', err);
  }
}

export function logActivity(level: LogLevel, source: string, message: string): void {
  const entry: ActivityLogEntry = {
    ts: new Date().toISOString(),
    level,
    source,
    message,
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  seq++;

  const consolePrefix = `[${source}]`;
  if (level === 'error') console.error(consolePrefix, message);
  else if (level === 'warn') console.warn(consolePrefix, message);
  else console.log(consolePrefix, message);

  // Fire-and-forget — never awaited so collector cadence isn't tied to DB latency.
  void persistEntry(entry);
}

export function getRecent(limit = 200, sinceSeq?: number): { entries: ActivityLogEntry[]; seq: number } {
  if (sinceSeq != null && sinceSeq >= seq) return { entries: [], seq };
  const slice = buffer.slice(-limit);
  return { entries: slice, seq };
}

export function lastLine(): ActivityLogEntry | null {
  return buffer[buffer.length - 1] ?? null;
}
