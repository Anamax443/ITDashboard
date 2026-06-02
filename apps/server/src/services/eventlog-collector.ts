import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => { clearTimeout(t); done(true); });
    socket.once('error', () => { clearTimeout(t); done(false); });
    socket.connect(port, host);
  });
}

interface ComputerRow {
  id: number;
  name: string;
  last_collected_at: Date | null;
  consecutive_failures: number;
}

interface RawEvent {
  TimeCreated: string;
  Id: number;
  Level: number;
  LogName: string;
  ProviderName: string | null;
  MachineName: string;
  Message: string | null;
  TaskDisplayName: string | null;
}

const MAX_FAILURES_BEFORE_SKIP = 10;
const MAX_EVENTS_PER_PC_PER_RUN = 500;
const CONCURRENCY = 5;

let runInFlight = false;
let currentAbortController: AbortController | null = null;

interface InFlightProgress {
  startedAt: string;
  triggerSource: 'scheduled' | 'manual';
  totalPcs: number;
  processedPcs: number;
  succeededPcs: number;
  failedPcs: number;
  eventsAddedSoFar: number;
  currentlyProcessing: string[];
  recentFailures: { name: string; error: string }[];
}

let currentProgress: InFlightProgress | null = null;

/**
 * Pulls events from a single PC via Get-WinEvent -ComputerName (RPC over SMB),
 * which is more widely available in domain environments than WinRM/PSRemoting.
 * Runs under the API service account (svc-itdashboard); the account needs
 * Event Log Readers membership on the target PC (typically granted via GPO).
 */
async function collectFromPC(name: string, sinceUtc: Date, signal?: AbortSignal): Promise<RawEvent[]> {
  if (signal?.aborted) throw new Error('aborted');
  const sinceIso = sinceUtc.toISOString();
  // Pre-flight TCP probe to RPC endpoint mapper — distinguishes offline from RPC misconfigured.
  const tcpOk = await tcpProbe(name, 135, 2000);
  if (!tcpOk) throw new Error('OFFLINE: TCP/135 unreachable');

  const ps = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$startTime = [DateTime]::Parse('${sinceIso}').ToUniversalTime()
try {
  Get-WinEvent -ComputerName '${name}' -FilterHashtable @{
    LogName = 'System','Application'
    Level = 1,2,3
    StartTime = $startTime
  } -MaxEvents ${MAX_EVENTS_PER_PC_PER_RUN} -ErrorAction Stop |
    Select-Object @{n='TimeCreated';e={$_.TimeCreated.ToUniversalTime().ToString('o')}},
      Id, Level, LogName, ProviderName, MachineName,
      @{n='Message';e={$_.Message}},
      @{n='TaskDisplayName';e={$_.TaskDisplayName}} |
    ConvertTo-Json -Compress -Depth 4
} catch {
  if ($_.FullyQualifiedErrorId -match 'NoMatchingEventsFound' -or $_.Exception.Message -match 'No events were found') {
    Write-Output '[]'
  } else {
    throw
  }
}
`;

  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('aborted'));
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `PS exit ${code}`));
      }
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return resolve([]);
        const parsed = JSON.parse(trimmed) as RawEvent | RawEvent[];
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function insertEvents(computerId: number, events: RawEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const pool = await getPool();
  let added = 0;
  for (const e of events) {
    const r = await pool.request()
      .input('cid', computerId)
      .input('log', e.LogName)
      .input('eid', e.Id)
      .input('lvl', e.Level)
      .input('t', new Date(e.TimeCreated))
      .input('prov', e.ProviderName)
      .input('task', e.TaskDisplayName)
      .input('msg', e.Message)
      .query(`
        INSERT INTO events (computer_id, log_name, event_id, level, time_created, provider_name, task, message)
        VALUES (@cid, @log, @eid, @lvl, @t, @prov, @task, @msg);
      `);
    added += r.rowsAffected[0] ?? 0;
  }
  return added;
}

async function listTargets(): Promise<ComputerRow[]> {
  const pool = await getPool();
  const r = await pool.request().query<ComputerRow>(`
    SELECT id, name, last_collected_at, consecutive_failures
    FROM computers
    WHERE enabled = 1
      AND monitor_enabled = 1
      AND consecutive_failures < ${MAX_FAILURES_BEFORE_SKIP}
    ORDER BY ISNULL(last_collected_at, '1900-01-01') ASC;
  `);
  return r.recordset;
}

async function markSuccess(computerId: number, runStartedAt: Date): Promise<void> {
  const pool = await getPool();
  await pool.request()
    .input('id', computerId)
    .input('t', runStartedAt)
    .query(`
      UPDATE computers
      SET last_collected_at = @t,
          last_seen = @t,
          last_error = NULL,
          consecutive_failures = 0,
          last_status = 'online'
      WHERE id = @id;
    `);
}

function classifyError(msg: string): 'offline' | 'rpc_unavailable' | 'access_denied' | 'unknown' {
  if (msg.startsWith('OFFLINE') || msg.includes('No such host') || msg.includes('network path was not found')) return 'offline';
  if (msg.includes('RPC server is unavailable')) return 'rpc_unavailable';
  if (msg.includes('Access is denied') || msg.includes('Access denied')) return 'access_denied';
  return 'unknown';
}

async function markFailure(computerId: number, errorMsg: string): Promise<void> {
  const pool = await getPool();
  const status = classifyError(errorMsg);
  await pool.request()
    .input('id', computerId)
    .input('err', errorMsg.slice(0, 4000))
    .input('st', status)
    .query(`
      UPDATE computers
      SET last_error = @err,
          consecutive_failures = consecutive_failures + 1,
          last_status = @st
      WHERE id = @id;
    `);
}

export interface CollectorRunResult {
  runId: number;
  pcsTotal: number;
  pcsSucceeded: number;
  pcsFailed: number;
  eventsAdded: number;
  durationMs: number;
}

export async function runCollectorOnce(triggerSource: 'scheduled' | 'manual' = 'scheduled'): Promise<CollectorRunResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  const pool = await getPool();
  const runStart = await pool.request().input('src', triggerSource).query<{ id: number }>(`
    INSERT INTO collector_runs (trigger_source) OUTPUT INSERTED.id VALUES (@src);
  `);
  const runId = runStart.recordset[0]?.id ?? 0;
  const t0 = Date.now();

  try {
    const targets = await listTargets();
    logActivity('info', 'collector', `Starting run (${triggerSource}) — ${targets.length} target PCs, concurrency ${CONCURRENCY}`);
    let succeeded = 0;
    let failed = 0;
    let totalAdded = 0;
    const runStartedAt = new Date();

    currentProgress = {
      startedAt: runStartedAt.toISOString(),
      triggerSource,
      totalPcs: targets.length,
      processedPcs: 0,
      succeededPcs: 0,
      failedPcs: 0,
      eventsAddedSoFar: 0,
      currentlyProcessing: [],
      recentFailures: [],
    };

    // Process in batches of CONCURRENCY
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      if (signal.aborted) {
        logActivity('warn', 'collector', `Aborted after ${i} PCs`);
        break;
      }
      const batch = targets.slice(i, i + CONCURRENCY);
      currentProgress.currentlyProcessing = batch.map((c) => c.name);

      const results = await Promise.allSettled(
        batch.map(async (c) => {
          const since = c.last_collected_at ?? new Date(Date.now() - 60 * 60 * 1000); // 1h cold start
          const events = await collectFromPC(c.name, since, signal);
          const added = await insertEvents(c.id, events);
          await markSuccess(c.id, runStartedAt);
          return added;
        }),
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        const c = batch[j]!;
        if (r.status === 'fulfilled') {
          succeeded++;
          totalAdded += r.value;
          currentProgress.eventsAddedSoFar += r.value;
          logActivity('info', 'collector', `${c.name} → ${r.value === 0 ? 'no new events' : `+${r.value} events`}`);
        } else {
          failed++;
          const errMsg = String(r.reason).split('\n')[0]?.slice(0, 200) ?? 'unknown';
          await markFailure(c.id, String(r.reason));
          currentProgress.recentFailures.unshift({ name: c.name, error: errMsg });
          if (currentProgress.recentFailures.length > 5) currentProgress.recentFailures.length = 5;
          logActivity('warn', 'collector', `${c.name} → ${errMsg}`);
        }
      }
      currentProgress.processedPcs += batch.length;
      currentProgress.succeededPcs = succeeded;
      currentProgress.failedPcs = failed;
    }

    const durationMs = Date.now() - t0;
    const aborted = signal.aborted;
    await pool.request()
      .input('id', runId).input('total', targets.length).input('succ', succeeded)
      .input('fail', failed).input('added', totalAdded).input('notes', aborted ? 'aborted by operator' : null)
      .query(`
        UPDATE collector_runs
        SET finished_at = SYSUTCDATETIME(),
            pcs_total = @total, pcs_succeeded = @succ, pcs_failed = @fail,
            events_added = @added, notes = @notes
        WHERE id = @id;
      `);

    const status = aborted ? 'aborted' : 'done';
    logActivity(aborted ? 'warn' : 'success', 'collector', `Run ${status}: ${succeeded} OK / ${failed} fail / +${totalAdded} events (${(durationMs/1000).toFixed(1)}s)`);
    return { runId, pcsTotal: targets.length, pcsSucceeded: succeeded, pcsFailed: failed, eventsAdded: totalAdded, durationMs };
  } finally {
    runInFlight = false;
    currentProgress = null;
    currentAbortController = null;
  }
}

export function stopCollector(): boolean {
  if (!runInFlight || !currentAbortController) return false;
  logActivity('warn', 'collector', 'Stop requested by operator');
  currentAbortController.abort();
  return true;
}

let scheduledTimer: NodeJS.Timeout | null = null;

export async function startCollectorSchedule(): Promise<void> {
  const { getSetting } = await import('./settings.js');
  const dbVal = await getSetting('collector.interval_sec').catch(() => undefined);
  const intervalSec = Number(dbVal ?? process.env.COLLECTOR_POLL_INTERVAL_SEC ?? 300);
  if (scheduledTimer) clearInterval(scheduledTimer);
  scheduledTimer = setInterval(() => {
    runCollectorOnce('scheduled').catch((err) => {
      console.error('Scheduled collector run failed:', err);
    });
  }, intervalSec * 1000);
  console.log(`Collector scheduled every ${intervalSec}s`);
}

export function rescheduleCollector(intervalSec: number): void {
  if (scheduledTimer) clearInterval(scheduledTimer);
  scheduledTimer = setInterval(() => {
    runCollectorOnce('scheduled').catch((err) => console.error('Scheduled collector run failed:', err));
  }, intervalSec * 1000);
  console.log(`Collector rescheduled every ${intervalSec}s`);
}

export async function getCollectorStatus() {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT TOP 1 id, started_at, finished_at, pcs_total, pcs_succeeded, pcs_failed,
           events_added, trigger_source
    FROM collector_runs
    ORDER BY id DESC;
  `);
  return {
    inFlight: runInFlight,
    progress: currentProgress,
    lastRun: r.recordset[0] ?? null,
  };
}
