import { execFile } from 'node:child_process';
import { getAllSettings } from './settings.js';

// Live WAN-link health: pings each branch router (from mikrotik.routers) and one
// public internet target FROM the app server, every wan.interval_sec. Keeps only
// the LATEST snapshot in memory (the operator cares about the *current* state, not
// history) — surfaced on the dashboard so each branch's link quality is visible at
// a glance. Reuses the proven locale-independent ping parse (CS "čas"/EN "time").

export interface WanLink {
  site: string;
  ip: string;
  alive: boolean;
  lossPct: number;
  latencyMs: number | null;
}
export interface WanSnapshot {
  branches: WanLink[];
  internet: WanLink | null;
  checkedAt: string;
}

let snapshot: WanSnapshot | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;
let stopped = false;
let nextRunAt: Date | null = null;
const IDLE_RECHECK_SEC = 120;

const boolSetting = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').toLowerCase());

export function getWanSnapshot(): WanSnapshot | null { return snapshot; }
export function getWanNextRun(): Date | null { return nextRunAt; }

// Tolerant "Site=IP[,Site=IP]" parse (same form the /network/routers route uses).
function parseRouters(raw: string | undefined): Array<{ site: string; ip: string }> {
  return (raw ?? '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
    .map((tok) => { const i = tok.indexOf('='); return i > 0 ? { site: tok.slice(0, i).trim(), ip: tok.slice(i + 1).trim() } : null; })
    .filter((r): r is { site: string; ip: string } => !!r && !!r.site && !!r.ip);
}

// One ICMP burst via Windows ping.exe → avg RTT + loss%. ping.exe exits non-zero
// on loss, so the error is ignored and stdout is parsed regardless.
function pingHost(ip: string, count: number, perPingTimeoutMs: number): Promise<{ alive: boolean; lossPct: number; latencyMs: number | null }> {
  return new Promise((resolve) => {
    execFile('ping', ['-n', String(count), '-w', String(perPingTimeoutMs), ip],
      { windowsHide: true, timeout: count * perPingTimeoutMs + 4000, maxBuffer: 1 << 20 },
      (_err, stdout) => {
        const output = stdout || '';
        let received = 0;
        const times: number[] = [];
        for (const line of output.split(/\r?\n/)) {
          if (!/TTL=/i.test(line)) continue;          // a real reply line (locale-independent)
          received++;
          const m = line.match(/[<=]\s*(\d+)\s*ms/i);
          if (m) times.push(Number(m[1]));
        }
        const lossPct = Math.max(0, Math.min(100, Math.round(((count - received) / count) * 100)));
        const latencyMs = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
        resolve({ alive: received > 0, lossPct, latencyMs });
      });
  });
}

export async function runWanProbeOnce(): Promise<WanSnapshot | null> {
  if (running) return snapshot;
  running = true;
  try {
    const s = await getAllSettings();
    const count = Math.max(1, Math.min(20, Number(s['wan.ping_count']) || 5));
    const perTimeout = 1000;
    const routers = parseRouters(s['mikrotik.routers']);
    const internetTarget = (s['wan.internet_target'] ?? '1.1.1.1').trim();

    const branches = await Promise.all(routers.map(async (r) => ({ site: r.site, ip: r.ip, ...(await pingHost(r.ip, count, perTimeout)) })));
    let internet: WanLink | null = null;
    if (internetTarget) internet = { site: 'internet', ip: internetTarget, ...(await pingHost(internetTarget, count, perTimeout)) };

    snapshot = { branches, internet, checkedAt: new Date().toISOString() };
    return snapshot;
  } finally {
    running = false;
  }
}

export async function startWanMonitorSchedule(): Promise<void> {
  stopped = false;
  if (timer) { clearTimeout(timer); timer = null; }
  const loop = async () => {
    if (stopped) return;
    let nextSec = IDLE_RECHECK_SEC;
    try {
      const s = await getAllSettings();
      if (boolSetting(s['wan.enabled'] ?? '1')) {
        await runWanProbeOnce();
        const iv = Number(s['wan.interval_sec']);
        nextSec = Number.isFinite(iv) && iv >= 30 ? iv : 60;
      }
    } catch (e) {
      console.error('WAN monitor error', e);
    }
    if (!stopped) {
      timer = setTimeout(loop, nextSec * 1000);
      nextRunAt = new Date(Date.now() + nextSec * 1000);
    }
  };
  loop().catch((e) => console.error('WAN monitor error', e));
  console.log('WAN monitor scheduled (DB-driven enable/interval)');
}
