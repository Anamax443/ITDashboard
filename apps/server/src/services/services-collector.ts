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

interface RawService {
  Name: string;
  DisplayName: string | null;
  StartMode: string;
  State: string;
  DelayedAutoStart: boolean;
  TriggerStart: boolean;
}

const CONCURRENCY = 5;
let runInFlight = false;

async function fetchProblems(name: string): Promise<RawService[]> {
  const tcpOk = await tcpProbe(name, 135, 2000);
  if (!tcpOk) throw new Error('OFFLINE: TCP/135 unreachable');

  // Read Win32_Service for Auto + non-running, then check each one's registry
  // TriggerInfo and DelayedAutoStart flag to distinguish legitimate stopped states.
  const ps = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$opt = New-CimSessionOption -Protocol Dcom
$session = New-CimSession -ComputerName '${name}' -SessionOption $opt -ErrorAction Stop
try {
  $svcs = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter "StartMode='Auto' AND State<>'Running'"

  # For each, query registry remotely via WMI StdRegProv to check DelayedAutoStart + TriggerInfo
  $reg = Get-CimClass -CimSession $session -Namespace root\\default -ClassName StdRegProv -ErrorAction SilentlyContinue

  $result = @()
  foreach ($s in $svcs) {
    $path = "SYSTEM\\\\CurrentControlSet\\\\Services\\\\$($s.Name)"
    $delayed = $false
    $trigger = $false
    if ($reg) {
      try {
        $d = Invoke-CimMethod -CimSession $session -Namespace root\\default -ClassName StdRegProv -MethodName GetDWORDValue -Arguments @{ hDefKey = [uint32]2147483650; sSubKeyName = $path; sValueName = 'DelayedAutostart' } -ErrorAction SilentlyContinue
        if ($d -and $d.uValue -eq 1) { $delayed = $true }

        $t = Invoke-CimMethod -CimSession $session -Namespace root\\default -ClassName StdRegProv -MethodName EnumKey -Arguments @{ hDefKey = [uint32]2147483650; sSubKeyName = "$path\\\\TriggerInfo" } -ErrorAction SilentlyContinue
        if ($t -and $t.sNames -and $t.sNames.Count -gt 0) { $trigger = $true }
      } catch { }
    }
    $result += [pscustomobject]@{
      Name = $s.Name
      DisplayName = $s.DisplayName
      StartMode = $s.StartMode
      State = $s.State
      DelayedAutoStart = $delayed
      TriggerStart = $trigger
    }
  }
  $result | ConvertTo-Json -Compress -Depth 3
} finally {
  Remove-CimSession $session
}
`;
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `exit ${code}`));
      const t = stdout.trim();
      if (!t) return resolve([]);
      try {
        const parsed = JSON.parse(t) as RawService | RawService[];
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (e) { reject(e); }
    });
  });
}

async function replaceProblems(computerId: number, services: RawService[]): Promise<void> {
  const pool = await getPool();
  await pool.request().input('cid', computerId).query(`DELETE FROM service_problems WHERE computer_id = @cid`);
  for (const s of services) {
    await pool.request()
      .input('cid', computerId)
      .input('name', s.Name)
      .input('dn', s.DisplayName)
      .input('sm', s.StartMode)
      .input('st', s.State)
      .input('del', s.DelayedAutoStart ? 1 : 0)
      .input('trg', s.TriggerStart ? 1 : 0)
      .query(`
        INSERT INTO service_problems (computer_id, service_name, display_name, start_mode, state, delayed_start, trigger_start)
        VALUES (@cid, @name, @dn, @sm, @st, @del, @trg);
      `);
  }
}

interface Target { id: number; name: string; }

export async function runServicesScanOnce(): Promise<{ pcs: number; ok: number; fail: number; problems: number; durationMs: number } | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  try {
    const pool = await getPool();
    const r = await pool.request().query<Target>(`
      SELECT id, name FROM computers
      WHERE enabled = 1 AND monitor_enabled = 1 AND consecutive_failures < 10
    `);
    const targets = r.recordset;
    logActivity('info', 'services', `Starting service scan — ${targets.length} PCs`);

    let ok = 0, fail = 0, totalProblems = 0;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (c) => {
        const services = await fetchProblems(c.name);
        await replaceProblems(c.id, services);
        return services.length;
      }));
      for (let j = 0; j < results.length; j++) {
        const r2 = results[j]!;
        const c = batch[j]!;
        if (r2.status === 'fulfilled') {
          ok++;
          totalProblems += r2.value;
          if (r2.value > 0) logActivity('warn', 'services', `${c.name} → ${r2.value} stopped auto-service${r2.value === 1 ? '' : 's'}`);
          else logActivity('info', 'services', `${c.name} → all healthy`);
        } else {
          fail++;
          const errMsg = String(r2.reason).split('\n')[0]?.slice(0, 200) ?? 'unknown';
          logActivity('warn', 'services', `${c.name} → ${errMsg}`);
        }
      }
    }

    const durationMs = Date.now() - t0;
    logActivity('success', 'services', `Service scan done: ${ok} OK / ${fail} fail / ${totalProblems} problems (${(durationMs/1000).toFixed(1)}s)`);
    return { pcs: targets.length, ok, fail, problems: totalProblems, durationMs };
  } finally {
    runInFlight = false;
  }
}

let timer: NodeJS.Timeout | null = null;
export async function startServicesSchedule(): Promise<void> {
  const { getSetting } = await import('./settings.js');
  const dbVal = await getSetting('services.interval_sec').catch(() => undefined);
  const interval = Number(dbVal ?? process.env.SERVICES_POLL_INTERVAL_SEC ?? 900);
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runServicesScanOnce().catch((e) => console.error('Services scan error', e));
  }, interval * 1000);
  console.log(`Services collector scheduled every ${interval}s`);
}

export function rescheduleServices(intervalSec: number): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runServicesScanOnce().catch((e) => console.error('Services scan error', e));
  }, intervalSec * 1000);
  console.log(`Services collector rescheduled every ${intervalSec}s`);
}
