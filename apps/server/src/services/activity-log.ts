/**
 * In-memory ring buffer of recent activity events.
 * Filled by collector, AD sync, and scheduler. Polled by dashboard /activity/log.
 * Resets on API restart — for permanent history use collector_runs / ad_sync_runs tables.
 */

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
}

export function getRecent(limit = 200, sinceSeq?: number): { entries: ActivityLogEntry[]; seq: number } {
  if (sinceSeq != null && sinceSeq >= seq) return { entries: [], seq };
  const slice = buffer.slice(-limit);
  return { entries: slice, seq };
}

export function lastLine(): ActivityLogEntry | null {
  return buffer[buffer.length - 1] ?? null;
}
