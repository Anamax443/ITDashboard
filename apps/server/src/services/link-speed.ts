import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

// Real link-speed test to a live PC/notebook: write an N-MB file from .213 to the
// client's C$ over SMB (= upload), read it back to .213 (= download), and compute
// Mb/s from the wall time. Both endpoints are real machines (not a weak router CPU),
// the transfer physically traverses the branch link, and it reuses the admin-share
// access the service account already has — so it measures the actual branch speed
// with no vantage problem. Random payload so SMB3 compression can't skew it.

const LOCAL_DIR = 'C:\\tmp\\itdash-speedtest';

let running = false;
export function isLinkSpeedRunning(): boolean { return running; }

export interface LinkSpeedResult {
  pc: string;
  sizeMB: number;
  upMbps: number | null;
  downMbps: number | null;
  upMs: number | null;
  downMs: number | null;
  error?: string;
}

// Cache a random source file of the requested size on .213 so we don't regenerate
// it every run. Written in chunks to keep memory flat.
async function ensureSource(sizeMB: number): Promise<string> {
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  const src = `${LOCAL_DIR}\\src-${sizeMB}.bin`;
  try {
    const st = await fs.stat(src);
    if (st.size === sizeMB * 1024 * 1024) return src;
  } catch { /* missing — create below */ }
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

export async function runLinkSpeedTest(pc: string, sizeMB: number): Promise<LinkSpeedResult> {
  if (running) return { pc, sizeMB, upMbps: null, downMbps: null, upMs: null, downMs: null, error: 'already_running' };
  running = true;
  const bytes = sizeMB * 1024 * 1024;
  const remoteDir = `\\\\${pc}\\C$\\tmp\\itdash-speedtest`;
  const remoteFile = `${remoteDir}\\spd-${sizeMB}.bin`;
  const localBack = `${LOCAL_DIR}\\back-${pc}.bin`;
  try {
    const src = await ensureSource(sizeMB);
    await fs.mkdir(remoteDir, { recursive: true });

    // UPLOAD: .213 -> client C$ over SMB.
    const t1 = Date.now();
    await pipeline(createReadStream(src), createWriteStream(remoteFile));
    const upMs = Date.now() - t1;

    // DOWNLOAD: client C$ -> .213.
    const t2 = Date.now();
    await pipeline(createReadStream(remoteFile), createWriteStream(localBack));
    const downMs = Date.now() - t2;

    await fs.rm(remoteFile, { force: true }).catch(() => {});
    await fs.rm(localBack, { force: true }).catch(() => {});
    return { pc, sizeMB, upMbps: mbps(bytes, upMs), downMbps: mbps(bytes, downMs), upMs, downMs };
  } catch (e) {
    await fs.rm(remoteFile, { force: true }).catch(() => {});
    await fs.rm(localBack, { force: true }).catch(() => {});
    return { pc, sizeMB, upMbps: null, downMbps: null, upMs: null, downMs: null, error: String(e).split('\n')[0]!.slice(0, 200) };
  } finally {
    running = false;
  }
}
