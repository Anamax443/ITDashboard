import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';
import { tryWithHostLock, keyForComputerId } from './host-lock.js';

// Precise interactive logon/logoff collector. Pulls Security 4624 (logon) and
// 4634 (logoff) from a PC, keeps ONLY interactive logon types (2 console, 7
// unlock, 10 RDP, 11 cached) — filtered server-side in the Get-WinEvent XPath so
// the network/service noise (type 3/5, verified ~99% of 4624 volume) never leaves
// the target — and pairs sessions 4624->4634 by LogonId into pc_logon_events.
//
// Sibling of eventlog-collector.ts (System/Application, Level 1-3) but a separate
// collector: different log (Security), different shape (structured EventData, not
// a rendered Message), different cursor (computers.last_logon_collected_at). It is
// a pure add-on — it never touches consecutive_failures / reachable / last_status
// (the eventlog + disk collectors own those), so a logon-collect hiccup can't
// affect a PC's reachability verdict.

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

export interface RawLogon {
  EventId: number;            // 4624 or 4634
  Time: string;               // ISO UTC
  User: string | null;        // TargetUserName
  Domain: string | null;      // TargetDomainName
  LogonType: string | null;   // '2' | '7' | '10' | '11'
  Ip: string | null;          // IpAddress (only meaningful on 4624)
  LogonId: string | null;     // TargetLogonId (hex)
}

const MAX_EVENTS_PER_PC_PER_RUN = 500;
const CONCURRENCY = 5;
const COLD_START_HOURS = 24;

// Accounts that produce interactive-type logons but are not humans. LogonType is
// already restricted to 2/7/10/11 by the query, but window-manager / font-driver
// pseudo-sessions and machine accounts still show up as type 2 on some boxes.
const SYSTEM_ACCOUNTS = new Set([
  'SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE', 'ANONYMOUS LOGON',
  'DWM-0', 'DWM-1', 'DWM-2', 'DWM-3', 'UMFD-0', 'UMFD-1', 'UMFD-2', 'UMFD-3',
]);

function isHumanUser(user: string | null): boolean {
  if (!user) return false;
  const u = user.trim();
  if (u === '' || u.endsWith('$')) return false;                  // machine accounts
  if (SYSTEM_ACCOUNTS.has(u.toUpperCase())) return false;
  if (/^(DWM|UMFD)-\d+$/i.test(u)) return false;
  return true;
}

let runInFlight = false;

/**
 * Pulls interactive logon (4624) + logoff (4634) events from a single PC via
 * Get-WinEvent -ComputerName (RPC over SMB), same transport as the sibling
 * eventlog collector. The account needs Event Log Readers on the target so it can
 * read the Security log. The interactive-type filter lives in the XPath so we
 * never pay to transfer/parse the type-3/5 flood.
 */
export async function collectLogonEvents(name: string, sinceUtc: Date, signal?: AbortSignal): Promise<RawLogon[]> {
  if (signal?.aborted) throw new Error('aborted');
  const sinceIso = sinceUtc.toISOString();
  const tcpOk = await tcpProbe(name, 135, 2000);
  if (!tcpOk) throw new Error('OFFLINE: TCP/135 unreachable');

  // Both 4624 and 4634 carry a LogonType Data element, so one uniform predicate
  // filters interactive sessions for both. The time bound is expressed in the
  // XPath itself (structured-query SystemTime comparison) — that is how you scope
  // a -FilterXPath query by time. sinceIso is JS-substituted before PS sees it and
  // the XPath lives in a literal here-string so its many single quotes survive.
  const ps = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$xpath = @'
*[System[(EventID=4624 or EventID=4634) and TimeCreated[@SystemTime>='${sinceIso}']] and (EventData[Data[@Name='LogonType']='2'] or EventData[Data[@Name='LogonType']='7'] or EventData[Data[@Name='LogonType']='10'] or EventData[Data[@Name='LogonType']='11'])]
'@
try {
  $events = Get-WinEvent -ComputerName '${name}' -LogName Security -FilterXPath $xpath -MaxEvents ${MAX_EVENTS_PER_PC_PER_RUN} -ErrorAction SilentlyContinue -ErrorVariable gwErr
  if (-not $events) {
    $real = $gwErr | Where-Object { $_.Exception.Message -notmatch 'No events were found' -and $_.Exception.Message -notmatch 'description string for parameter' }
    if ($real) { throw $real[0] }
    Write-Output '[]'
  } else {
    $out = foreach ($e in $events) {
      $x = [xml]$e.ToXml()
      $data = @{}
      foreach ($d in $x.Event.EventData.Data) { if ($d.Name) { $data[$d.Name] = [string]$d.'#text' } }
      [pscustomobject]@{
        EventId   = [int]$e.Id
        Time      = $e.TimeCreated.ToUniversalTime().ToString('o')
        User      = $data['TargetUserName']
        Domain    = $data['TargetDomainName']
        LogonType = $data['LogonType']
        Ip        = $data['IpAddress']
        LogonId   = $data['TargetLogonId']
      }
    }
    $out | ConvertTo-Json -Compress -Depth 4
  }
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
    const onAbort = () => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('aborted'));
      if (code !== 0) return reject(new Error(stderr.trim() || `PS exit ${code}`));
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return resolve([]);
        const parsed = JSON.parse(trimmed) as RawLogon | RawLogon[];
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export interface LogonUpsertResult {
  sessions: number;   // new 4624 logon rows inserted
  loggedOff: number;  // open sessions closed by a matching 4634
}

/**
 * Writes a batch of raw logon/logoff events into pc_logon_events. 4624 rows are
 * inserted (deduped on computer_id+logon_id+logon_at, since the >= cursor can
 * re-pull a boundary event); 4634 rows close the most-recent still-open session
 * with the same LogonId. Events are processed oldest-first so a logon inserted in
 * this same batch can be closed by its logoff in the same batch.
 */
export async function upsertLogonEvents(computerId: number, rows: RawLogon[]): Promise<LogonUpsertResult> {
  if (rows.length === 0) return { sessions: 0, loggedOff: 0 };
  const pool = await getPool();
  const ordered = [...rows].sort((a, b) => new Date(a.Time).getTime() - new Date(b.Time).getTime());

  let sessions = 0;
  let loggedOff = 0;
  for (const e of ordered) {
    if (!e.LogonId) continue;
    const t = new Date(e.Time);

    if (e.EventId === 4624) {
      if (!isHumanUser(e.User)) continue;
      const lt = Number(e.LogonType);
      const r = await pool.request()
        .input('cid', computerId)
        .input('user', e.User)
        .input('dom', e.Domain ?? null)
        .input('lt', Number.isFinite(lt) ? lt : 0)
        .input('ip', e.Ip && e.Ip !== '-' && e.Ip !== '::1' && e.Ip !== '127.0.0.1' ? e.Ip : null)
        .input('lid', e.LogonId)
        .input('t', t)
        .query(`
          IF NOT EXISTS (
            SELECT 1 FROM pc_logon_events
            WHERE computer_id = @cid AND logon_id = @lid AND logon_at = @t
          )
          INSERT INTO pc_logon_events (computer_id, user_name, domain, logon_type, ip_address, logon_id, logon_at)
          VALUES (@cid, @user, @dom, @lt, @ip, @lid, @t);
        `);
      sessions += r.rowsAffected[0] ?? 0;
    } else if (e.EventId === 4634) {
      // Close the most-recent still-open session for this LogonId whose logon is
      // at or before this logoff. LogonId is reused after a reboot, so scope the
      // pairing to open sessions and pick the latest — never re-close a row.
      const r = await pool.request()
        .input('cid', computerId)
        .input('lid', e.LogonId)
        .input('t', t)
        .query(`
          UPDATE ple SET logoff_at = @t
          FROM pc_logon_events ple
          WHERE ple.id = (
            SELECT TOP 1 id FROM pc_logon_events
            WHERE computer_id = @cid AND logon_id = @lid
              AND logoff_at IS NULL AND logon_at <= @t
            ORDER BY logon_at DESC
          );
        `);
      loggedOff += r.rowsAffected[0] ?? 0;
    }
  }
  return { sessions, loggedOff };
}

interface Target { id: number; name: string; last_logon_collected_at: Date | null; }

export interface LogonCollectResult {
  pcs: number;
  ok: number;
  fail: number;
  skipped: number;   // PC busy with another heavy op this cycle (host-lock) — retried next run
  sessions: number;
  loggedOff: number;
  durationMs: number;
}

export async function runLogonCollectorOnce(): Promise<LogonCollectResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  try {
    const pool = await getPool();
    const r = await pool.request().query<Target>(`
      SELECT id, name, last_logon_collected_at FROM computers
      -- Same live-reachability parking as the other per-PC collectors.
      WHERE enabled = 1 AND monitor_enabled = 1 AND excluded = 0
        AND (reachable = 1 OR (reachable IS NULL AND consecutive_failures < 10))
    `);
    const targets = r.recordset;
    logActivity('info', 'logon', `Starting logon scan — ${targets.length} PCs`);

    let ok = 0, fail = 0, skipped = 0, sessions = 0, loggedOff = 0;
    const runStartedAt = new Date();

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (c) => {
        // Low-priority background collector: only run if the PC is idle right now,
        // otherwise skip and let the next cycle catch it (see host-lock.ts).
        const lock = await tryWithHostLock(keyForComputerId(c.id), async () => {
          const since = c.last_logon_collected_at ?? new Date(Date.now() - COLD_START_HOURS * 3600 * 1000);
          const events = await collectLogonEvents(c.name, since);
          const res = await upsertLogonEvents(c.id, events);
          await pool.request()
            .input('id', c.id)
            .input('t', runStartedAt)
            .query(`UPDATE computers SET last_logon_collected_at = @t WHERE id = @id;`);
          return res;
        });
        return lock.ran ? { skipped: false as const, ...lock.value } : { skipped: true as const };
      }));

      for (let j = 0; j < results.length; j++) {
        const res = results[j]!;
        const c = batch[j]!;
        if (res.status === 'fulfilled') {
          if (res.value.skipped) {
            skipped++;
            continue;
          }
          ok++;
          sessions += res.value.sessions;
          loggedOff += res.value.loggedOff;
          if (res.value.sessions > 0 || res.value.loggedOff > 0) {
            logActivity('info', 'logon', `${c.name} → +${res.value.sessions} logon(s), ${res.value.loggedOff} logoff(s)`);
          }
        } else {
          fail++;
          const errMsg = String(res.reason).split('\n')[0]?.slice(0, 200) ?? 'unknown';
          logActivity('warn', 'logon', `${c.name} → ${errMsg}`);
        }
      }
    }

    const durationMs = Date.now() - t0;
    logActivity('success', 'logon',
      `Logon scan done: ${ok} OK / ${fail} fail / ${skipped} skipped / +${sessions} logons / ${loggedOff} logoffs (${(durationMs / 1000).toFixed(1)}s)`);
    return { pcs: targets.length, ok, fail, skipped, sessions, loggedOff, durationMs };
  } finally {
    runInFlight = false;
  }
}
