import { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';
import { getAllSettings } from './settings.js';

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
export function tcpProbeTimed(host: string, port: number, timeoutMs: number): Promise<number | null> {
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

// Remove port_status rows for checks no longer in the configured set, so the
// grid always reflects current Settings (removing a port from the list makes it
// disappear instead of lingering). Scope to one PC with `computerId`, or omit to
// prune the whole table. An empty `names` deletes all rows in scope.
async function prunePortStatus(names: string[], computerId?: number): Promise<void> {
  const pool = await getPool();
  const req = pool.request();
  if (computerId != null) req.input('cid', computerId);
  if (names.length === 0) {
    await req.query(computerId != null ? `DELETE FROM port_status WHERE computer_id = @cid` : `DELETE FROM port_status`);
    return;
  }
  const scope = computerId != null ? 'computer_id = @cid AND ' : '';
  const params = names.map((n, i) => { req.input(`n${i}`, n); return `@n${i}`; });
  await req.query(`DELETE FROM port_status WHERE ${scope}check_name NOT IN (${params.join(',')})`);
}

// Set of port-check names currently configured in Settings — used by the API to
// filter the grid so it never shows a port the operator has removed.
export async function configuredCheckNames(): Promise<Set<string>> {
  const settings = await getAllSettings();
  return new Set(parsePortChecks(settings['alerts.services.port_checks']).map((c) => c.name));
}

// Probe one PC's configured ports and persist the result. Used by the per-row
// "Refresh now" action (step 5) and the per-PC on-demand probe endpoint, so a
// single PC always gets a fresh port verdict regardless of the schedule.
export async function probeOnePcPorts(computerId: number, host: string): Promise<{ checks: number; open: number; results: PortProbeResult[] }> {
  const settings = await getAllSettings();
  const checks = parsePortChecks(settings['alerts.services.port_checks']);
  const timeoutMs = Number(settings['alerts.services.port_timeout_ms'] ?? 2000) || 2000;
  if (checks.length === 0) {
    await prunePortStatus([], computerId);
    return { checks: 0, open: 0, results: [] };
  }
  const results = await probePcPortsRaw(host, checks, timeoutMs);
  await persistPcPorts(computerId, results);
  // Drop this PC's stale rows for ports removed from the config.
  await prunePortStatus(checks.map((c) => c.name), computerId);
  return { checks: results.length, open: results.filter((r) => r.open).length, results };
}

export interface PerPcProbeResult {
  computerId: number;
  host: string;
  ping: boolean;
  ports: PortProbeResult[];
  /** cmd-like transcript (raw ping.exe output + per-port lines) for display. */
  console: string;
}

// Hostnames come from AD (computer name / FQDN): letters, digits, dot, dash,
// underscore only. Reject anything else so we never pass operator-unseen input
// into the cmd line below.
const HOST_RE = /^[A-Za-z0-9._-]{1,255}$/;

// Run ping.exe and capture its FULL stdout for display. We go through
// `cmd /c chcp 65001 & ping …` so the (localized, e.g. Czech) output comes back
// as UTF-8 and renders correctly in the console modal — a bare ping.exe spawn
// emits the OEM codepage (cp852) which would mangle accents. TTL= in the output
// marks a genuine echo reply (not a router "host unreachable", which exits 0).
export function pingWithOutput(host: string, count: number, timeoutMs: number): Promise<{ alive: boolean; output: string }> {
  return new Promise((resolve) => {
    if (!HOST_RE.test(host)) { resolve({ alive: false, output: `Invalid host: ${host}` }); return; }
    let out = '';
    let settled = false;
    const done = (alive: boolean) => { if (!settled) { settled = true; resolve({ alive, output: out }); } };
    try {
      const proc = spawn('cmd.exe', ['/d', '/s', '/c', `chcp 65001>nul & ping -n ${count} -w ${timeoutMs} ${host}`], { windowsHide: true });
      proc.stdout?.on('data', (b) => (out += b.toString('utf8')));
      proc.stderr?.on('data', (b) => (out += b.toString('utf8')));
      proc.on('error', (e) => { out += String(e); done(false); });
      proc.on('close', () => done(/TTL=/i.test(out)));
      // Hard guard: count replies, each up to timeoutMs, plus slack.
      setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } done(/TTL=/i.test(out)); }, count * (timeoutMs + 1000) + 2000);
    } catch (e) {
      out += String(e);
      done(false);
    }
  });
}

// On-demand probe for a single PC: ICMP ping (4 echoes, like cmd) + every
// configured TCP port. Persists the port results so the grid reflects the
// freshly observed state, and returns a cmd-like transcript for the UI console.
export async function probeComputerNow(computerId: number, host: string): Promise<PerPcProbeResult> {
  const settings = await getAllSettings();
  const timeoutMs = Number(settings['alerts.services.port_timeout_ms'] ?? 2000) || 2000;
  const pingEnabled = boolSetting(settings['reachability.ping'], true);
  const [pingRes, portRes] = await Promise.all([
    pingEnabled ? pingWithOutput(host, 4, timeoutMs) : Promise.resolve({ alive: false, output: '(ping disabled in settings)' }),
    probeOnePcPorts(computerId, host),
  ]);

  const lines: string[] = [];
  lines.push(`> ping -n 4 ${host}`);
  lines.push('');
  lines.push(pingRes.output.replace(/\r\n/g, '\n').trimEnd());
  lines.push('');
  lines.push(`> port check (TCP, timeout ${timeoutMs} ms)`);
  if (portRes.results.length === 0) {
    lines.push('(no ports configured)');
  } else {
    for (const p of portRes.results) {
      const label = `${p.checkName}:${p.port}`.padEnd(16);
      lines.push(`${label} ${p.open ? `open${p.latencyMs != null ? ` (${p.latencyMs} ms)` : ''}` : 'closed'}`);
    }
  }

  return { computerId, host, ping: pingRes.alive, ports: portRes.results, console: lines.join('\n') };
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
      // No ports configured → the grid should be empty too.
      await prunePortStatus([]);
      return { pcs: 0, probed: 0, skippedOffline: 0, openPorts: 0, durationMs: Date.now() - t0 };
    }
    // Drop rows for ports removed from the config before re-probing the fleet.
    await prunePortStatus(checks.map((c) => c.name));
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
