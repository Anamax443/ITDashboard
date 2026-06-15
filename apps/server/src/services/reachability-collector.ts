import { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';
import { getAllSettings } from './settings.js';

// Plain TCP connect — same helper the other collectors use. Resolves true if the
// port accepts a connection within the timeout, false on timeout/refused/error.
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

// ICMP fallback via the Windows `ping.exe` (Node has no built-in ICMP; raw
// sockets need privileges the service account lacks). Catches hosts that block
// TCP 135/445 (hardened firewall) but still answer ping. We require `TTL=` in
// the output — it appears only on a genuine echo reply and is NOT localized, so
// this works on a Czech/any-locale Windows and rejects router-sourced
// "Destination host unreachable" replies (which can still exit 0).
export function icmpPing(host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const proc = spawn('ping.exe', ['-n', '1', '-w', String(timeoutMs), host], { windowsHide: true });
      proc.stdout?.on('data', (b) => (out += b.toString()));
      proc.on('error', () => done(false));
      proc.on('close', () => done(/TTL=/i.test(out)));
      // Hard guard in case the process hangs.
      setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } done(false); }, timeoutMs + 1500);
    } catch {
      done(false);
    }
  });
}

interface Target { id: number; name: string; fqdn: string | null; ip_address: string | null; reachable: boolean | null; }

// Reachability is a cheap TCP connect, so we can fan out wide.
const CONCURRENCY = 16;
let runInFlight = false;
// Last summary count we logged — used to suppress the repeated identical
// "N/M on network" heartbeat when nothing changed between cycles.
let lastReachableCount = -1;

function parsePorts(raw: string | undefined): number[] {
  const ports = (raw ?? '')
    .split(/[\s,;]+/)
    .map((s) => Number(s.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return ports.length > 0 ? ports : [135, 445];
}

// EVERY enabled, non-excluded PC — independent of monitor_enabled and of the
// event-log collector's failure cap, so even parked / unmonitored boxes get a
// live reachability verdict.
async function listTargets(): Promise<Target[]> {
  const pool = await getPool();
  const r = await pool.request().query<Target>(`
    SELECT id, name, fqdn, ip_address, reachable
    FROM computers
    WHERE enabled = 1 AND excluded = 0
    ORDER BY name
  `);
  return r.recordset;
}

async function probeOne(t: Target, ports: number[], timeoutMs: number, pingFallback: boolean): Promise<boolean> {
  const host = t.fqdn || t.name;
  // Cheap TCP connects first; ICMP ping (spawns a process) only as a fallback
  // for hosts that answer nothing on the TCP ports.
  for (const port of ports) {
    if (await tcpProbe(host, port, timeoutMs)) return true;
  }
  if (pingFallback && await icmpPing(host, timeoutMs)) return true;
  return false;
}

async function persist(id: number, reachable: boolean): Promise<void> {
  const pool = await getPool();
  await pool.request()
    .input('id', id)
    .input('r', reachable ? 1 : 0)
    .query(`
      UPDATE computers
      SET reachable = @r,
          reach_checked_at = SYSUTCDATETIME(),
          last_reachable_at = CASE WHEN @r = 1 THEN SYSUTCDATETIME() ELSE last_reachable_at END
      WHERE id = @id;
    `);
}

export interface ReachabilityRunResult {
  pcs: number;
  reachable: number;
  unreachable: number;
  durationMs: number;
}

function boolSetting(v: string | undefined, fallback: boolean): boolean {
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

let reachTimer: NodeJS.Timeout | null = null;
let reachStopped = false;

/**
 * Standalone scheduler for the reachability (Status) probe — runs on its OWN
 * cadence (`reachability.interval_sec`, default 300s), independent of the
 * periodic-checks scan and its work-hours window, so Status never goes stale
 * overnight / weekends. Each cycle re-reads the enable flag
 * (`checks.run_reachability`) and the interval, so Settings changes take effect
 * without a restart.
 */
export async function startReachabilitySchedule(): Promise<void> {
  reachStopped = false;
  if (reachTimer) { clearTimeout(reachTimer); reachTimer = null; }
  const loop = async () => {
    if (reachStopped) return;
    let intervalSec = 300;
    try {
      const settings = await getAllSettings();
      if (boolSetting(settings['checks.run_reachability'], true)) {
        await runReachabilityProbeOnce();
      }
      const n = Number(settings['reachability.interval_sec']);
      if (Number.isFinite(n) && n >= 30) intervalSec = Math.floor(n);
    } catch (e) {
      console.error('Reachability schedule error', e);
    }
    if (!reachStopped) reachTimer = setTimeout(loop, intervalSec * 1000);
  };
  loop().catch((e) => console.error('Reachability schedule error', e));
  console.log('Reachability probe scheduled (independent of the checks window)');
}

/**
 * Probe every enabled, non-excluded PC once and record whether it is on the
 * network. Self-contained: never throws (a DB/probe error is logged and a
 * zero/partial result returned) so it can't fail a checks cycle. Returns null
 * only if a probe run is already in flight.
 */
export async function runReachabilityProbeOnce(): Promise<ReachabilityRunResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  try {
    const settings = await getAllSettings();
    const ports = parsePorts(settings['reachability.ports']);
    const timeoutMs = Number(settings['reachability.timeout_ms'] ?? 2000) || 2000;
    const pingFallback = boolSetting(settings['reachability.ping'], true);
    const targets = await listTargets();

    let reachable = 0;
    let unreachable = 0;
    let flips = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const t = targets[idx++];
        if (!t) continue;
        try {
          const ok = await probeOne(t, ports, timeoutMs, pingFallback);
          const prev = t.reachable == null ? null : Boolean(t.reachable);
          await persist(t.id, ok);
          // Per-PC line only on a state CHANGE (name + IP + new state) — logging
          // every PC each cycle would flood the activity log. First-time
          // classification (prev === null) is silent.
          if (prev !== null && prev !== ok) {
            flips++;
            logActivity(ok ? 'success' : 'warn', 'reachability', `${t.name} (${t.ip_address ?? 'no IP'}) → ${ok ? 'Active (on network)' : 'Offline'}`);
          }
          if (ok) reachable++; else unreachable++;
        } catch {
          // A single PC's DB write failing shouldn't abort the whole sweep.
          unreachable++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));

    const durationMs = Date.now() - t0;
    // Summary only when something moved (count changed or any PC flipped) — stops
    // the identical "126/211 on network" line repeating every cycle.
    if (reachable !== lastReachableCount || flips > 0) {
      logActivity('info', 'reachability', `Reachability: ${reachable}/${targets.length} on network${flips > 0 ? `, ${flips} change(s)` : ''} (${(durationMs / 1000).toFixed(1)}s)`);
    }
    lastReachableCount = reachable;
    return { pcs: targets.length, reachable, unreachable, durationMs };
  } catch (err) {
    logActivity('error', 'reachability', `Reachability probe failed: ${String(err).split('\n')[0]}`);
    return { pcs: 0, reachable: 0, unreachable: 0, durationMs: Date.now() - t0 };
  } finally {
    runInFlight = false;
  }
}
