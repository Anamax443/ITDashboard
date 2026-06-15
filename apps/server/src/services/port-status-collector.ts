import { Socket } from 'node:net';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';
import { getAllSettings } from './settings.js';
import { icmpPing } from './reachability-collector.js';

// Live per-port availability for the "Ports" tab. Independent of the phase-2
// port ALERTS (alerts.ts): here we just TCP-connect each configured port of
// every monitored PC, measure latency, and upsert the latest verdict into
// `port_status`. The tab reads that table; "Probe now" and the per-PC refresh
// refresh it on demand. Port list + timeout are reused from the existing
// alerts.services.port_checks / port_timeout_ms settings (no duplicate config).

interface PortCheck { name: string; port: number; }

// Same "Name:Port" parser the alert path uses (alerts.ts) — kept in sync.
function parsePortChecks(raw: string | undefined): PortCheck[] {
  const out: PortCheck[] = [];
  for (const tok of (raw ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = tok.match(/^(.+):(\d{1,5})$/);
    if (!m) continue;
    const port = Number(m[2]);
    if (port >= 1 && port <= 65535) out.push({ name: m[1]!.trim(), port });
  }
  return out;
}

// TCP connect that also returns the connect latency in ms, or null on
// timeout/refused/error. Same shape as the other collectors' tcpProbe but timed.
function tcpProbeTimed(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const t0 = Date.now();
    const done = (ms: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ms);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); done(Date.now() - t0); });
    socket.once('error', () => { clearTimeout(timer); done(null); });
    socket.connect(port, host);
  });
}

interface Target { id: number; name: string; fqdn: string | null; reachable: boolean | null; }

const CONCURRENCY = 8;
let runInFlight = false;

function boolSetting(v: string | undefined, fallback: boolean): boolean {
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

// Every enabled, non-excluded PC — same population the reachability probe uses.
async function listTargets(): Promise<Target[]> {
  const pool = await getPool();
  const r = await pool.request().query<Target>(`
    SELECT id, name, fqdn, reachable
    FROM computers
    WHERE enabled = 1 AND excluded = 0
    ORDER BY name
  `);
  return r.recordset;
}

export interface PortProbeResult { checkName: string; port: number; open: boolean; latencyMs: number | null; }

async function probePcPortsRaw(host: string, checks: PortCheck[], timeoutMs: number): Promise<PortProbeResult[]> {
  const out: PortProbeResult[] = [];
  for (const chk of checks) {
    const ms = await tcpProbeTimed(host, chk.port, timeoutMs);
    out.push({ checkName: chk.name, port: chk.port, open: ms !== null, latencyMs: ms });
  }
  return out;
}

async function persistPcPorts(computerId: number, results: PortProbeResult[]): Promise<void> {
  const pool = await getPool();
  for (const r of results) {
    await pool.request()
      .input('cid', computerId).input('nm', r.checkName).input('port', r.port)
      .input('open', r.open ? 1 : 0).input('lat', r.latencyMs)
      .query(`
        MERGE port_status AS t USING (SELECT @cid AS cid, @nm AS nm) AS s
          ON t.computer_id = s.cid AND t.check_name = s.nm
        WHEN MATCHED THEN UPDATE SET port = @port, is_open = @open, latency_ms = @lat, checked_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (computer_id, check_name, port, is_open, latency_ms, checked_at)
          VALUES (@cid, @nm, @port, @open, @lat, SYSUTCDATETIME());
      `);
  }
}

// Probe one PC's configured ports and persist the result. Used by the per-row
// "Refresh now" action (step 5) and the per-PC on-demand probe endpoint, so a
// single PC always gets a fresh port verdict regardless of the schedule.
export async function probeOnePcPorts(computerId: number, host: string): Promise<{ checks: number; open: number; results: PortProbeResult[] }> {
  const settings = await getAllSettings();
  const checks = parsePortChecks(settings['alerts.services.port_checks']);
  const timeoutMs = Number(settings['alerts.services.port_timeout_ms'] ?? 2000) || 2000;
  if (checks.length === 0) return { checks: 0, open: 0, results: [] };
  const results = await probePcPortsRaw(host, checks, timeoutMs);
  await persistPcPorts(computerId, results);
  return { checks: results.length, open: results.filter((r) => r.open).length, results };
}

export interface PerPcProbeResult {
  computerId: number;
  host: string;
  ping: boolean;
  ports: PortProbeResult[];
}

// On-demand probe for a single PC: ICMP ping (reused from the reachability
// collector) + every configured TCP port. Persists the port results so the
// grid reflects the freshly observed state. The ping is live-only (not stored).
export async function probeComputerNow(computerId: number, host: string): Promise<PerPcProbeResult> {
  const settings = await getAllSettings();
  const timeoutMs = Number(settings['alerts.services.port_timeout_ms'] ?? 2000) || 2000;
  const pingEnabled = boolSetting(settings['reachability.ping'], true);
  const [ping, portRes] = await Promise.all([
    pingEnabled ? icmpPing(host, timeoutMs) : Promise.resolve(false),
    probeOnePcPorts(computerId, host),
  ]);
  return { computerId, host, ping, ports: portRes.results };
}

export interface PortStatusRunResult {
  pcs: number;
  probed: number;
  skippedOffline: number;
  openPorts: number;
  durationMs: number;
}

// Probe every enabled, non-excluded PC's configured ports once. PCs currently
// flagged offline (computers.reachable = 0) are skipped — the grid shows them
// offline from that flag, so re-probing dead boxes would just waste N connects
// per PC each cycle. Never throws; a single PC's failure keeps its last state.
export async function runPortStatusProbeOnce(): Promise<PortStatusRunResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  try {
    const settings = await getAllSettings();
    const checks = parsePortChecks(settings['alerts.services.port_checks']);
    const timeoutMs = Number(settings['alerts.services.port_timeout_ms'] ?? 2000) || 2000;
    if (checks.length === 0) {
      return { pcs: 0, probed: 0, skippedOffline: 0, openPorts: 0, durationMs: Date.now() - t0 };
    }
    const targets = await listTargets();

    let probed = 0;
    let skippedOffline = 0;
    let openPorts = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const t = targets[idx++];
        if (!t) continue;
        // reachable === false → known offline; skip. null (never probed) still
        // gets a probe so first-run PCs are not silently empty.
        if (t.reachable === false) { skippedOffline++; continue; }
        const host = t.fqdn || t.name;
        try {
          const results = await probePcPortsRaw(host, checks, timeoutMs);
          await persistPcPorts(t.id, results);
          probed++;
          openPorts += results.filter((r) => r.open).length;
        } catch {
          // Keep this PC's last-known port state on a transient error.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));

    const durationMs = Date.now() - t0;
    logActivity('info', 'port-status', `Port status: probed ${probed}/${targets.length} PC(s), ${skippedOffline} offline, ${openPorts} open port(s) (${(durationMs / 1000).toFixed(1)}s)`);
    return { pcs: targets.length, probed, skippedOffline, openPorts, durationMs };
  } catch (err) {
    logActivity('error', 'port-status', `Port status probe failed: ${String(err).split('\n')[0]}`);
    return { pcs: 0, probed: 0, skippedOffline: 0, openPorts: 0, durationMs: Date.now() - t0 };
  } finally {
    runInFlight = false;
  }
}

let psTimer: NodeJS.Timeout | null = null;
let psStopped = false;

// Standalone scheduler — mirrors the reachability probe. Runs on its own
// cadence (`port_status.interval_sec`, default 300s), re-reading the on/off flag
// (`checks.run_port_status`) and interval each cycle so Settings changes apply
// without a restart.
export async function startPortStatusSchedule(): Promise<void> {
  psStopped = false;
  if (psTimer) { clearTimeout(psTimer); psTimer = null; }
  const loop = async () => {
    if (psStopped) return;
    let intervalSec = 300;
    try {
      const settings = await getAllSettings();
      if (boolSetting(settings['checks.run_port_status'], true)) {
        await runPortStatusProbeOnce();
      }
      const n = Number(settings['port_status.interval_sec']);
      if (Number.isFinite(n) && n >= 30) intervalSec = Math.floor(n);
    } catch (e) {
      console.error('Port status schedule error', e);
    }
    if (!psStopped) psTimer = setTimeout(loop, intervalSec * 1000);
  };
  loop().catch((e) => console.error('Port status schedule error', e));
  console.log('Port status probe scheduled (independent of the checks window)');
}
