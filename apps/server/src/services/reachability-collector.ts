import { Socket } from 'node:net';
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

interface Target { id: number; name: string; fqdn: string | null; }

// Reachability is a cheap TCP connect, so we can fan out wide.
const CONCURRENCY = 16;
let runInFlight = false;

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
    SELECT id, name, fqdn
    FROM computers
    WHERE enabled = 1 AND excluded = 0
    ORDER BY name
  `);
  return r.recordset;
}

async function probeOne(t: Target, ports: number[], timeoutMs: number): Promise<boolean> {
  const host = t.fqdn || t.name;
  for (const port of ports) {
    if (await tcpProbe(host, port, timeoutMs)) return true;
  }
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
    const targets = await listTargets();

    let reachable = 0;
    let unreachable = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const t = targets[idx++];
        if (!t) continue;
        try {
          const ok = await probeOne(t, ports, timeoutMs);
          await persist(t.id, ok);
          if (ok) reachable++; else unreachable++;
        } catch {
          // A single PC's DB write failing shouldn't abort the whole sweep.
          unreachable++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));

    const durationMs = Date.now() - t0;
    logActivity('info', 'reachability', `Reachability probe: ${reachable}/${targets.length} on network (${(durationMs / 1000).toFixed(1)}s)`);
    return { pcs: targets.length, reachable, unreachable, durationMs };
  } catch (err) {
    logActivity('error', 'reachability', `Reachability probe failed: ${String(err).split('\n')[0]}`);
    return { pcs: 0, reachable: 0, unreachable: 0, durationMs: Date.now() - t0 };
  } finally {
    runInFlight = false;
  }
}
