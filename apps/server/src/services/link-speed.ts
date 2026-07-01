import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { getPool } from '../db/pool.js';
import { getAllSettings } from './settings.js';
import { logActivity } from './activity-log.js';
import { tcpProbeTimed } from './port-status-collector.js';

// Quick "is it alive at all" ICMP check — to tell an OFFLINE host (no ping) from a
// host that's up but has SMB/445 blocked (firewall), so offline doesn't read as a
// port error. Locale-independent TTL= match.
function pingAlive(host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ping', ['-n', '1', '-w', String(timeoutMs), host], { windowsHide: true, timeout: timeoutMs + 2000, maxBuffer: 1 << 16 },
      (_e, stdout) => resolve(/TTL=/i.test(stdout || '')));
  });
}

// Average ping RTT in ms (2 echoes), or null if unreachable — recorded per measurement.
function pingLatency(host: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ping', ['-n', '2', '-w', String(timeoutMs), host], { windowsHide: true, timeout: timeoutMs * 2 + 2000, maxBuffer: 1 << 16 },
      (_e, stdout) => {
        const t = [...(stdout || '').matchAll(/[<=]\s*(\d+)\s*ms/gi)].map((m) => Number(m[1]));
        resolve(t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null);
      });
  });
}

// Cycles + test filename come from settings (linkspeed.cycles / linkspeed.filename).
async function readOpts(): Promise<{ cycles: number; filename: string; okMbps: number }> {
  const s = await getAllSettings();
  const cycles = Math.max(1, Math.min(20, Number(s['linkspeed.cycles']) || 4));
  const filename = ((s['linkspeed.filename'] ?? '').trim() || 'itdash-speedtest.tmp').replace(/[\\/:*?"<>|]/g, '_');
  const okMbps = Number(s['linkspeed.ok_mbps']) || 200;
  return { cycles, filename, okMbps };
}

// Is the current local time inside the [start,end] "HH:MM" window (empty = always)?
function withinWindow(startStr: string | undefined, endStr: string | undefined): boolean {
  const a = /^(\d{1,2}):(\d{2})$/.exec((startStr ?? '').trim());
  const b = /^(\d{1,2}):(\d{2})$/.exec((endStr ?? '').trim());
  if (!a || !b) return true;
  const now = new Date(); const cur = now.getHours() * 60 + now.getMinutes();
  const s = +a[1]! * 60 + +a[2]!; const e = +b[1]! * 60 + +b[2]!;
  return s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e);
}

// Real link-speed test to a live PC/notebook: write an N-MB file from .213 to the
// client's C$ over SMB (= upload), read it back to .213 (= download), and compute
// Mb/s from the wall time. Both endpoints are real machines (not a weak router CPU),
// the transfer physically traverses the link, and it reuses the admin-share access
// the service account already has — so it measures the actual link/connection
// quality (and catches bad cables / 100-Mb ports / congested segments) with no
// vantage problem. Random payload so SMB3 compression can't skew it. The file is
// always deleted from the client afterwards; the target dir is created if missing.

const LOCAL_DIR = 'C:\\tmp\\itdash-speedtest';

export interface LinkSpeedResult {
  target: string;
  sizeMB: number;
  upMbps: number | null;
  downMbps: number | null;
  upMs: number | null;
  downMs: number | null;
  latencyMs: number | null;
  cycles: number;
  error?: string;
  measuredAt: string;
}

// Cache a random source file of the requested size on .213 (reused across runs).
async function ensureSource(sizeMB: number): Promise<string> {
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  const src = `${LOCAL_DIR}\\src-${sizeMB}.bin`;
  try { if ((await fs.stat(src)).size === sizeMB * 1024 * 1024) return src; } catch { /* create */ }
  const ws = createWriteStream(src);
  const CHUNK = 4 * 1024 * 1024;
  try {
    for (let written = 0; written < sizeMB * 1024 * 1024; written += CHUNK) {
      const buf = randomBytes(Math.min(CHUNK, sizeMB * 1024 * 1024 - written));
      if (!ws.write(buf)) await new Promise<void>((r) => ws.once('drain', () => r()));
    }
  } finally { ws.end(); }
  await new Promise<void>((res, rej) => { ws.once('finish', () => res()); ws.once('error', rej); });
  return src;
}

const mbps = (bytes: number, ms: number) => (ms > 0 ? Math.round((bytes * 8) / (ms / 1000) / 1e6 * 10) / 10 : null);

async function archive(r: LinkSpeedResult): Promise<void> {
  try {
    const pool = await getPool();
    await pool.request()
      .input('t', r.target).input('up', r.upMbps).input('down', r.downMbps)
      .input('ums', r.upMs).input('dms', r.downMs).input('sz', r.sizeMB).input('err', r.error ?? null).input('lat', r.latencyMs).input('cyc', r.cycles)
      .query(`INSERT INTO link_speed_results (target, up_mbps, down_mbps, up_ms, down_ms, size_mb, error, latency_ms, cycles)
              VALUES (@t,@up,@down,@ums,@dms,@sz,@err,@lat,@cyc)`);
  } catch (e) { console.error('link-speed archive failed', e); }
}

// One measurement (no concurrency guard) — N cycles of write-to-C$ + read-back, keep
// the BEST up/down of the cycles (transient AV/CPU dips don't understate capacity),
// plus a ping RTT. The test file (linkspeed.filename) is deleted afterwards.
async function measure(target: string, sizeMB: number, cycles: number, filename: string): Promise<LinkSpeedResult> {
  const bytes = sizeMB * 1024 * 1024;
  const remoteDir = `\\\\${target}\\C$\\tmp\\itdash-speedtest`;
  const remoteFile = `${remoteDir}\\${filename}`;
  const localBack = `${LOCAL_DIR}\\back-${target.replace(/[^\w.-]/g, '_')}.bin`;
  const base = { target, sizeMB, cycles, measuredAt: new Date().toISOString() };
  try {
    const src = await ensureSource(sizeMB);
    await fs.mkdir(remoteDir, { recursive: true });
    let bU = 0, bUms: number | null = null, bD = 0, bDms: number | null = null;
    for (let i = 0; i < cycles; i++) {
      const t1 = Date.now();
      await pipeline(createReadStream(src), createWriteStream(remoteFile));
      const upMs = Date.now() - t1;
      const t2 = Date.now();
      await pipeline(createReadStream(remoteFile), createWriteStream(localBack));
      const downMs = Date.now() - t2;
      const u = mbps(bytes, upMs) ?? 0, d = mbps(bytes, downMs) ?? 0;
      if (u > bU) { bU = u; bUms = upMs; }
      if (d > bD) { bD = d; bDms = downMs; }
    }
    const latencyMs = await pingLatency(target, 1000);
    await fs.rm(remoteDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(localBack, { force: true }).catch(() => {});
    return { ...base, upMbps: bU || null, downMbps: bD || null, upMs: bUms, downMs: bDms, latencyMs };
  } catch (e) {
    await fs.rm(remoteDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(localBack, { force: true }).catch(() => {});
    return { ...base, upMbps: null, downMbps: null, upMs: null, downMs: null, latencyMs: null, error: String(e).split('\n')[0]!.slice(0, 200) };
  }
}

let single = false;
// On-demand single PC test (used by the per-PC button). Archived to DB.
export async function runLinkSpeedTest(target: string, sizeMB: number): Promise<LinkSpeedResult> {
  if (single) return { target, sizeMB, upMbps: null, downMbps: null, upMs: null, downMs: null, latencyMs: null, cycles: 0, error: 'already_running', measuredAt: new Date().toISOString() };
  single = true;
  try { const { cycles, filename } = await readOpts(); const r = await measure(target, sizeMB, cycles, filename); await archive(r); return r; }
  finally { single = false; }
}

// --- batch (the measurement page) -----------------------------------------------
export interface BatchState {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  sizeMB: number;
  startedAt: string | null;
  results: LinkSpeedResult[];
}
let batch: BatchState = { running: false, total: 0, done: 0, current: null, sizeMB: 0, startedAt: null, results: [] };
let stopRequested = false;
export function getLinkSpeedStatus(): BatchState { return batch; }
// Abort a running batch after the current PC finishes (an in-flight transfer isn't
// cut mid-stream). Returns false if nothing is running.
export function stopLinkSpeed(): boolean { if (!batch.running) return false; stopRequested = true; return true; }

// "10.8.2.*", "10.8.2.180-182", bare IPs/hostnames, comma/space/newline separated.
// "all" must be pre-expanded by the caller (to active computer names) and passed in.
export function parseTargets(raw: string, allNames: string[]): string[] {
  const out = new Set<string>();
  for (const tok of String(raw).split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)) {
    if (tok.toLowerCase() === 'all') { allNames.forEach((n) => out.add(n)); continue; }
    let m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\*$/.exec(tok);
    if (m) { for (let i = 1; i <= 254; i++) out.add(`${m[1]}.${i}`); continue; }
    m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/.exec(tok);
    if (m) { const a = Math.min(+m[2]!, +m[3]!), b = Math.max(+m[2]!, +m[3]!); for (let i = a; i <= b; i++) out.add(`${m[1]}.${i}`); continue; }
    out.add(tok);
  }
  return [...out].slice(0, 512);
}

// Run a batch sequentially in the background (200 MB/PC — don't flood). Each target
// is SMB-prechecked (TCP 445) so dead/non-SMB IPs are skipped fast, then measured
// and archived. Progress is polled via getLinkSpeedStatus().
export async function runLinkSpeedBatch(targets: string[], sizeMB: number): Promise<void> {
  if (batch.running) return;
  stopRequested = false;
  batch = { running: true, total: targets.length, done: 0, current: null, sizeMB, startedAt: new Date().toISOString(), results: [] };
  const { cycles, filename, okMbps } = await readOpts();
  logActivity('info', 'linkspeed', `Měření spuštěno: ${targets.length} cílů · ${sizeMB} MB · ${cycles}× cyklů`);
  let nOk = 0, nSlow = 0, nOff = 0, nErr = 0;
  try {
    for (const t of targets) {
      if (stopRequested) break;
      batch.current = t;
      let r: LinkSpeedResult;
      if ((await tcpProbeTimed(t, 445, 2500)) == null) {
        // Offline host (no ping) vs up-but-445-blocked — don't measure either, but
        // label them differently so offline isn't mistaken for a port problem.
        const alive = await pingAlive(t, 1000);
        r = { target: t, sizeMB, upMbps: null, downMbps: null, upMs: null, downMs: null, latencyMs: null, cycles: 0, error: alive ? 'SMB/445 blokováno' : 'offline', measuredAt: new Date().toISOString() };
      } else {
        r = await measure(t, sizeMB, cycles, filename);
      }
      await archive(r);
      batch.results.push(r);
      batch.done++;
      // Log each result to the activity feed (warn = slow, error = hard error).
      const off = !!r.error && /offline/i.test(r.error);
      const isErr = !!r.error && !off;
      const slow = !r.error && r.upMbps != null && r.downMbps != null && Math.min(r.upMbps, r.downMbps) < okMbps;
      if (off) nOff++; else if (isErr) nErr++; else if (slow) nSlow++; else nOk++;
      const msg = r.error ? `${t}: ${r.error}` : `${t}: ↑${r.upMbps} ↓${r.downMbps} Mb/s${r.latencyMs != null ? ` · ${r.latencyMs} ms` : ''}${slow ? ' — POMALÉ' : ''}`;
      logActivity(isErr ? 'error' : slow ? 'warn' : 'info', 'linkspeed', msg);
    }
    logActivity('info', 'linkspeed', `Měření dokončeno: ${nOk} OK · ${nSlow} pomalé · ${nOff} offline · ${nErr} chyba`);
  } finally {
    batch.running = false;
    batch.current = null;
  }
}

// Resolve a raw target string into a concrete IP/host list: expand "all" to the IPs
// of active PCs/servers, expand ranges, then drop any host on the exclusion list
// (linkspeed.exclude_hosts — matched by hostname or IP). Shared by the route + the
// scheduler so both behave the same.
export async function expandTargets(raw: string): Promise<string[]> {
  const s = await getAllSettings();
  let allTargets: string[] = [];
  if (/\ball\b/i.test(raw)) {
    const pool = await getPool();
    allTargets = (await pool.request().query<{ ip_address: string }>(
      `SELECT ip_address FROM computers WHERE enabled=1 AND excluded=0 AND reachable=1 AND ip_address IS NOT NULL`)).recordset.map((r) => r.ip_address);
  }
  let targets = parseTargets(raw, allTargets);
  const excl = new Set((s['linkspeed.exclude_hosts'] ?? '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (excl.size && targets.length) {
    const pool = await getPool();
    const ipToName = new Map<string, string>();
    (await pool.request().query<{ ip_address: string; name: string }>(
      `SELECT ip_address, name FROM computers WHERE ip_address IS NOT NULL`)).recordset.forEach((r) => ipToName.set(r.ip_address, (r.name || '').toLowerCase()));
    targets = targets.filter((t) => !excl.has(t.toLowerCase()) && !excl.has(ipToName.get(t) || ''));
  }
  return targets;
}

// --- scheduled measurement -------------------------------------------------------
const boolS = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').toLowerCase());
let schedTimer: NodeJS.Timeout | null = null;
let schedStopped = false;
let lastSchedRunMs = Date.now();   // treat boot as "just ran" so a restart doesn't trigger an immediate sweep

export async function startLinkSpeedSchedule(): Promise<void> {
  schedStopped = false;
  if (schedTimer) { clearTimeout(schedTimer); schedTimer = null; }
  const loop = async () => {
    if (schedStopped) return;
    try {
      const s = await getAllSettings();
      if (boolS(s['linkspeed.enabled'])) {
        const hrs = Math.max(1, Number(s['linkspeed.interval_hours']) || 24);
        const raw = (s['linkspeed.targets'] ?? '').trim();
        const inWindow = withinWindow(s['linkspeed.window_start'], s['linkspeed.window_end']);
        if (raw && inWindow && !batch.running && Date.now() - lastSchedRunMs >= hrs * 3600 * 1000) {
          lastSchedRunMs = Date.now();
          const sizeMB = Math.max(1, Math.min(1024, Number(s['linkspeed.size_mb']) || 100));
          const targets = await expandTargets(raw);
          if (targets.length) void runLinkSpeedBatch(targets, sizeMB);
        }
      }
    } catch (e) {
      console.error('link-speed schedule error', e);
    }
    if (!schedStopped) schedTimer = setTimeout(loop, 30 * 60 * 1000);   // re-check every 30 min; run gated by interval
  };
  schedTimer = setTimeout(loop, 5 * 60 * 1000);   // first check 5 min after boot
  console.log('Link-speed schedule started (DB-driven enable/interval)');
}
