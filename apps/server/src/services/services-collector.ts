import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';
import { evaluateAndSendServiceAlerts, evaluateAndSendPortAlerts } from './alerts.js';

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
  ExitCode: number | null;
  ServiceSpecificExitCode: number | null;
}

// Per-user service instances have a LUID suffix that changes per user session,
// e.g. CDPUserSvc_d666212, cbdhsvc_d666212, OneSyncSvc_d666212.
// They're legitimately stopped when no user is logged on.
const PER_USER_SUFFIX = /_[a-f0-9]{4,12}$/i;
function isPerUserService(name: string): boolean {
  return PER_USER_SUFFIX.test(name);
}

const CONCURRENCY = 5;
let runInFlight = false;

export async function fetchProblems(name: string): Promise<RawService[]> {
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
      ExitCode = $s.ExitCode
      ServiceSpecificExitCode = $s.ServiceSpecificExitCode
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

interface PolicyRow { id: number; pattern: string; expected_start_mode: string | null; expected_state: string | null; priority: number; }
let policyCache: PolicyRow[] | null = null;
let policyCacheTs = 0;

async function loadPolicies(): Promise<PolicyRow[]> {
  // Refresh every 60s
  if (policyCache && Date.now() - policyCacheTs < 60_000) return policyCache;
  const pool = await getPool();
  const r = await pool.request().query<PolicyRow>(`
    SELECT id, pattern, expected_start_mode, expected_state, priority
    FROM service_policy
    ORDER BY priority ASC, id ASC
  `);
  policyCache = r.recordset;
  policyCacheTs = Date.now();
  return policyCache;
}

function globMatch(pattern: string, str: string): boolean {
  // Support * and ? wildcards; otherwise plain text
  const re = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(re, 'i').test(str);
}

function classifyAgainstPolicy(svc: RawService, policies: PolicyRow[]): { isCompliant: boolean | null; policyId: number | null } {
  for (const p of policies) {
    if (globMatch(p.pattern, svc.Name) || (svc.DisplayName && globMatch(p.pattern, svc.DisplayName))) {
      const startOk = p.expected_start_mode == null || p.expected_start_mode === svc.StartMode;
      const stateOk = p.expected_state == null || p.expected_state === svc.State;
      return { isCompliant: startOk && stateOk, policyId: p.id };
    }
  }
  // No policy matched → unclassified
  return { isCompliant: null, policyId: null };
}

export async function replaceProblems(computerId: number, services: RawService[]): Promise<void> {
  const pool = await getPool();
  const policies = await loadPolicies();
  await pool.request().input('cid', computerId).query(`DELETE FROM service_problems WHERE computer_id = @cid`);
  for (const s of services) {
    const cls = classifyAgainstPolicy(s, policies);
    await pool.request()
      .input('cid', computerId)
      .input('name', s.Name)
      .input('dn', s.DisplayName)
      .input('sm', s.StartMode)
      .input('st', s.State)
      .input('del', s.DelayedAutoStart ? 1 : 0)
      .input('trg', s.TriggerStart ? 1 : 0)
      .input('pu', isPerUserService(s.Name) ? 1 : 0)
      .input('comp', cls.isCompliant == null ? null : (cls.isCompliant ? 1 : 0))
      .input('pid', cls.policyId)
      .input('ec', s.ExitCode ?? null)
      .input('sec', s.ServiceSpecificExitCode ?? null)
      .query(`
        INSERT INTO service_problems (computer_id, service_name, display_name, start_mode, state, delayed_start, trigger_start, per_user_start, is_compliant, policy_id, exit_code, service_specific_exit_code)
        VALUES (@cid, @name, @dn, @sm, @st, @del, @trg, @pu, @comp, @pid, @ec, @sec);
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
      WHERE enabled = 1 AND monitor_enabled = 1 AND excluded = 0 AND consecutive_failures < 10
    `);
    const targets = r.recordset;
    logActivity('info', 'services', `Starting service scan — ${targets.length} PCs`);

    let ok = 0, fail = 0, totalProblems = 0;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (c) => {
        const services = await fetchProblems(c.name);
        await replaceProblems(c.id, services);
        return services;
      }));
      for (let j = 0; j < results.length; j++) {
        const r2 = results[j]!;
        const c = batch[j]!;
        if (r2.status === 'fulfilled') {
          ok++;
          const all = r2.value;
          totalProblems += all.length;
          if (all.length === 0) {
            logActivity('info', 'services', `${c.name} → all healthy`);
          } else {
            const real = all.filter((s) => !s.TriggerStart && !s.DelayedAutoStart && !isPerUserService(s.Name));
            const trigger = all.filter((s) => s.TriggerStart).length;
            const delayed = all.filter((s) => s.DelayedAutoStart).length;
            const perUser = all.filter((s) => isPerUserService(s.Name)).length;
            const parts: string[] = [];
            if (real.length > 0) parts.push(`${real.length} real`);
            if (trigger > 0) parts.push(`${trigger} trigger`);
            if (delayed > 0) parts.push(`${delayed} delayed`);
            if (perUser > 0) parts.push(`${perUser} per-user`);
            const breakdown = parts.join(' / ');
            if (real.length > 0) {
              const names = real.slice(0, 5).map((s) => s.Name).join(', ');
              const more = real.length > 5 ? ` (+${real.length - 5})` : '';
              logActivity('warn', 'services', `${c.name} → ${breakdown}: ${names}${more}`);
            } else {
              logActivity('info', 'services', `${c.name} → ${breakdown} (all legitimate)`);
            }
          }
        } else {
          fail++;
          const errMsg = String(r2.reason).split('\n')[0]?.slice(0, 200) ?? 'unknown';
          logActivity('warn', 'services', `${c.name} → ${errMsg}`);
        }
      }
    }

    const durationMs = Date.now() - t0;
    logActivity('success', 'services', `Service scan done: ${ok} OK / ${fail} fail / ${totalProblems} problems (${(durationMs/1000).toFixed(1)}s)`);

    // Fire critical-service email alerts off fresh data. Self-contained (checks
    // the master enable flag + debounce/throttle internally) and never throws.
    try {
      await evaluateAndSendServiceAlerts();
    } catch (err) {
      logActivity('error', 'alerts', `Service alert evaluation failed: ${String(err).split('\n')[0]}`);
    }
    try {
      await evaluateAndSendPortAlerts();
    } catch (err) {
      logActivity('error', 'alerts', `Port alert evaluation failed: ${String(err).split('\n')[0]}`);
    }

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
