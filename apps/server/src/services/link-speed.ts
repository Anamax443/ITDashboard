import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { tcpProbeTimed } from './port-status-collector.js';

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
      .input('ums', r.upMs).input('dms', r.downMs).input('sz', r.sizeMB).input('err', r.error ?? null)
      .query(`INSERT INTO link_speed_results (target, up_mbps, down_mbps, up_ms, down_ms, size_mb, error)
              VALUES (@t,@up,@down,@ums,@dms,@sz,@err)`);
  } catch (e) { console.error('link-speed archive failed', e); }
}

// One measurement (no concurrency guard) — write to client C$, read back, clean up.
async function measure(target: string, sizeMB: number): Promise<LinkSpeedResult> {
  const bytes = sizeMB * 1024 * 1024;
  const remoteDir = `\\\\${target}\\C$\\tmp\\itdash-speedtest`;
  const remoteFile = `${remoteDir}\\spd-${sizeMB}.bin`;
  const localBack = `${LOCAL_DIR}\\back-${target.replace(/[^\w.-]/g, '_')}.bin`;
  const base = { target, sizeMB, measuredAt: new Date().toISOString() };
  try {
    const src = await ensureSource(sizeMB);
    await fs.mkdir(remoteDir, { recursive: true });
    const t1 = Date.now();
    await pipeline(createReadStream(src), createWriteStream(remoteFile));
    const upMs = Date.now() - t1;
    const t2 = Date.now();
    await pipeline(createReadStream(remoteFile), createWriteStream(localBack));
    const downMs = Date.now() - t2;
    await fs.rm(remoteFile, { force: true }).catch(() => {});
    await fs.rm(localBack, { force: true }).catch(() => {});
    return { ...base, upMbps: mbps(bytes, upMs), downMbps: mbps(bytes, downMs), upMs, downMs };
  } catch (e) {
    await fs.rm(remoteFile, { force: true }).catch(() => {});
    await fs.rm(localBack, { force: true }).catch(() => {});
    return { ...base, upMbps: null, downMbps: null, upMs: null, downMs: null, error: String(e).split('\n')[0]!.slice(0, 200) };
  }
}

let single = false;
// On-demand single PC test (used by the per-PC button). Archived to DB.
export async function runLinkSpeedTest(target: string, sizeMB: number): Promise<LinkSpeedResult> {
  if (single) return { target, sizeMB, upMbps: null, downMbps: null, upMs: null, downMs: null, error: 'already_running', measuredAt: new Date().toISOString() };
  single = true;
  try { const r = await measure(target, sizeMB); await archive(r); return r; }
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
export function getLinkSpeedStatus(): BatchState { return batch; }

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
  batch = { running: true, total: targets.length, done: 0, current: null, sizeMB, startedAt: new Date().toISOString(), results: [] };
  try {
    for (const t of targets) {
      batch.current = t;
      let r: LinkSpeedResult;
      if ((await tcpProbeTimed(t, 445, 2500)) == null) {
        r = { target: t, sizeMB, upMbps: null, downMbps: null, upMs: null, downMs: null, error: 'SMB nedostupné (445)', measuredAt: new Date().toISOString() };
      } else {
        r = await measure(t, sizeMB);
      }
      await archive(r);
      batch.results.push(r);
      batch.done++;
    }
  } finally {
    batch.running = false;
    batch.current = null;
  }
}
