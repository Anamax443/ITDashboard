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

interface RawPerfEvent {
  TimeCreated: string;
  Id: number;
  Level: number;
  TotalTime: string | null;
  DegradationTime: string | null;
  Name: string | null;
  FriendlyName: string | null;
  Message: string | null;
}

interface Target { id: number; name: string; }

const CONCURRENCY = 5;
const MAX_EVENTS_PER_PC_PER_RUN = 200;
const COLD_START_DAYS_DEFAULT = 30; // setting perf.cold_start_days overrides

let runInFlight = false;

function categoryFromId(id: number): 'boot' | 'shutdown' | 'standby' | 'resume' | 'other' {
  if (id >= 100 && id < 200) return 'boot';
  if (id >= 200 && id < 300) return 'shutdown';
  if (id >= 300 && id < 400) return 'standby';
  if (id >= 400 && id < 500) return 'resume';
  return 'other';
}

function parseBigIntOrNull(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchPerfEvents(name: string, sinceUtc: Date): Promise<RawPerfEvent[]> {
  const tcpOk = await tcpProbe(name, 135, 2000);
  if (!tcpOk) throw new Error('OFFLINE: TCP/135 unreachable');

  const sinceIso = sinceUtc.toISOString();
  // Microsoft-Windows-Diagnostics-Performance/Operational is enabled by default on Win10/11/Server.
  // EventData fields vary by event ID, so we extract by name from the XML.
  const ps = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$startTime = [DateTime]::Parse('${sinceIso}').ToUniversalTime()
try {
  $events = Get-WinEvent -ComputerName '${name}' -FilterHashtable @{
    LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'
    StartTime = $startTime
  } -MaxEvents ${MAX_EVENTS_PER_PC_PER_RUN} -ErrorAction Stop
  $out = foreach ($e in $events) {
    $data = @{}
    try {
      $xml = [xml]$e.ToXml()
      foreach ($d in $xml.Event.EventData.Data) { $data[$d.Name] = $d.'#text' }
    } catch { }
    [pscustomobject]@{
      TimeCreated = $e.TimeCreated.ToUniversalTime().ToString('o')
      Id = $e.Id
      Level = $e.Level
      TotalTime = $data['TotalTime']
      DegradationTime = $data['DegradationTime']
      Name = $data['Name']
      FriendlyName = $data['FriendlyName']
      Message = $e.Message
    }
  }
  ,$out | ConvertTo-Json -Compress -Depth 4
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
    proc.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `PS exit ${code}`));
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return resolve([]);
        const parsed = JSON.parse(trimmed) as RawPerfEvent | RawPerfEvent[] | null;
        if (parsed == null) return resolve([]);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (e) { reject(e); }
    });
  });
}

async function insertPerfEvents(computerId: number, events: RawPerfEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const pool = await getPool();
  let added = 0;
  for (const e of events) {
    try {
      const r = await pool.request()
        .input('cid', computerId)
        .input('t', new Date(e.TimeCreated))
        .input('eid', e.Id)
        .input('lvl', e.Level)
        .input('cat', categoryFromId(e.Id))
        .input('total', parseBigIntOrNull(e.TotalTime))
        .input('degr', parseBigIntOrNull(e.DegradationTime))
        .input('name', e.Name)
        .input('friendly', e.FriendlyName)
        .input('msg', e.Message)
        .query(`
          IF NOT EXISTS (
            SELECT 1 FROM perf_events
            WHERE computer_id = @cid AND time_created = @t AND event_id = @eid
          )
          INSERT INTO perf_events
            (computer_id, time_created, event_id, level, category,
             total_time_ms, degradation_ms, culprit_name, culprit_friendly, message)
          VALUES (@cid, @t, @eid, @lvl, @cat, @total, @degr, @name, @friendly, @msg);
        `);
      added += r.rowsAffected[0] ?? 0;
    } catch {
      // unique-constraint races / malformed event → skip silently, keep going
    }
  }
  return added;
}

export interface PerfCollectResult {
  pcs: number;
  ok: number;
  fail: number;
  channelDisabled: number;
  events: number;
  durationMs: number;
}

const CHANNEL_NOT_AVAILABLE_RE = /There is not an event log on/i;

export async function runPerfCollectorOnce(): Promise<PerfCollectResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  try {
    const { getSetting } = await import('./settings.js');
    const coldStartRaw = await getSetting('perf.cold_start_days').catch(() => undefined);
    const coldStartDays = (() => {
      const n = Number(coldStartRaw);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : COLD_START_DAYS_DEFAULT;
    })();
    const coldStartMs = coldStartDays * 24 * 3600 * 1000;

    const pool = await getPool();
    const r = await pool.request().query<Target & { last_perf_collected_at: Date | null }>(`
      SELECT id, name,
        (SELECT MAX(time_created) FROM perf_events WHERE computer_id = c.id) AS last_perf_collected_at
      FROM computers c
      WHERE enabled = 1 AND monitor_enabled = 1 AND excluded = 0 AND consecutive_failures < 10
    `);
    const targets = r.recordset;
    logActivity('info', 'perf', `Starting perf scan — ${targets.length} PCs (cold-start ${coldStartDays}d)`);

    let ok = 0, fail = 0, channelDisabled = 0, totalEvents = 0;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (c) => {
        const since = c.last_perf_collected_at ?? new Date(Date.now() - coldStartMs);
        const events = await fetchPerfEvents(c.name, since);
        const added = await insertPerfEvents(c.id, events);
        return added;
      }));
      for (let j = 0; j < results.length; j++) {
        const r2 = results[j]!;
        const c = batch[j]!;
        if (r2.status === 'fulfilled') {
          ok++;
          totalEvents += r2.value;
          if (r2.value > 0) logActivity('info', 'perf', `${c.name} → +${r2.value} perf events`);
        } else {
          const errMsg = String(r2.reason).split('\n')[0]?.slice(0, 200) ?? 'unknown';
          // The Diagnostics-Performance channel is disabled by default on Windows Server SKU.
          // Treat that as a known no-op (not a failure) and don't spam the activity log per-PC —
          // a single aggregate line at the end of the run is enough.
          if (CHANNEL_NOT_AVAILABLE_RE.test(errMsg)) {
            channelDisabled++;
          } else {
            fail++;
            logActivity('warn', 'perf', `${c.name} → ${errMsg}`);
          }
        }
      }
    }

    const durationMs = Date.now() - t0;
    const channelNote = channelDisabled > 0 ? ` / ${channelDisabled} channel-disabled` : '';
    logActivity('success', 'perf', `Perf scan done: ${ok} OK / ${fail} fail${channelNote} / +${totalEvents} events (${(durationMs/1000).toFixed(1)}s)`);
    return { pcs: targets.length, ok, fail, channelDisabled, events: totalEvents, durationMs };
  } finally {
    runInFlight = false;
  }
}
