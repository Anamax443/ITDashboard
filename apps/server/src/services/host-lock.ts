import { getPool } from '../db/pool.js';

// Per-host serialization: only ONE heavy operation (SMB C$, WMI, remote exec) may
// touch a given PC at a time. Different PCs still run fully in parallel. Cheap probes
// (ping / TCP / SNMP) deliberately do NOT take this lock — they're idempotent and
// cheap, locking them would only add latency.
//
// The lock KEY is the computer's DB identity (`pc:<id>`), NOT its IP or hostname:
//  - IP is dynamic (DHCP) — keying on it would let the same PC be locked twice after
//    a lease change, and would never match a lock taken by hostname.
//  - Callers may reference a PC by IP (link-speed) OR by hostname (crash-dump). Both
//    are resolved to the SAME `pc:<id>` via the current DB ip↔name mapping, so a lock
//    taken "by hostname" and one taken "by IP" collapse onto one identity (the
//    both-directions check the user asked for). A host not in the inventory falls back
//    to `raw:<lowercased>` and only self-serializes.

const tails = new Map<string, Promise<void>>();

// Run fn while holding the host's lock; queues behind any in-progress holder for the
// same key. FIFO. A predecessor's failure never blocks the queue.
export async function withHostLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => next);
  tails.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === chained) tails.delete(key);   // drop key once the queue drains
  }
}

// Non-blocking variant for LOW-PRIORITY periodic collectors (crash-dump, event-log,
// printers…): run only if the PC is idle right now, otherwise skip — the caller
// retries next cycle. Prevents a background sweep from stalling for minutes behind a
// long link-speed run on one PC.
export async function tryWithHostLock<T>(key: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  if (tails.has(key)) return { ran: false };            // someone holds/queues this PC
  return { ran: true, value: await withHostLock(key, fn) };
}

// Lock key for a caller that already has the DB id (most robust — immune to IP churn).
export const keyForComputerId = (id: number): string => `pc:${id}`;

// Resolve an IP OR hostname string to a canonical lock key. Both directions are
// checked (ip_address and name columns) so either reference maps to the same `pc:<id>`.
// Cached briefly to avoid a query per lock; TTL kept short so DHCP changes are picked
// up quickly.
let cache: { at: number; byIp: Map<string, number>; byName: Map<string, number> } | null = null;
const TTL_MS = 30_000;

async function loadMap() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const pool = await getPool();
  const rows = (await pool.request().query<{ id: number; ip_address: string | null; name: string | null }>(
    `SELECT id, ip_address, name FROM computers`)).recordset;
  const byIp = new Map<string, number>(), byName = new Map<string, number>();
  for (const r of rows) {
    if (r.ip_address) byIp.set(r.ip_address.trim().toLowerCase(), r.id);
    if (r.name) byName.set(r.name.trim().toLowerCase(), r.id);
  }
  cache = { at: Date.now(), byIp, byName };
  return cache;
}

export async function hostKey(host: string): Promise<string> {
  const h = (host || '').trim().toLowerCase();
  if (!h) return 'raw:';
  const m = await loadMap();
  const id = m.byIp.get(h) ?? m.byName.get(h);   // check IP first, then hostname
  return id != null ? keyForComputerId(id) : `raw:${h}`;
}
