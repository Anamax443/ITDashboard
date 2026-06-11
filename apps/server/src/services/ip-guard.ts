import { getAllowedIPs } from './firewall.js';
import { logActivity } from './activity-log.js';

// In-memory whitelist refreshed at boot + after every PUT /firewall/whitelist.
// Source of truth remains the Windows Firewall rule "ITDashboard API (4000)".
//
// Scope: used by the GET /access-check endpoint that the frontend calls on
// mount to decide whether to render the dashboard or an "access not
// configured" screen. This is a UX gate, NOT a security boundary — the
// server lives on an internal domain network and the JSON API is
// intentionally reachable by anyone in the domain. The whitelist only
// prevents incidental UI discovery by non-IT users browsing the LAN.
let allowedList: string[] = [];

// Always allow loopback so the service can reach itself.
const ALWAYS_ALLOW = new Set<string>(['127.0.0.1', '::1']);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n * 256) + x;
  }
  return n >>> 0;
}

export function normalizeRequestIp(raw: string): string {
  // Fastify on dual-stack sockets reports v4-mapped v6 like "::ffff:10.0.0.5"
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

function matchesEntry(remoteIp: string, entry: string): boolean {
  if (entry === remoteIp) return true;
  if (entry.includes('/')) {
    const [base, bitsStr] = entry.split('/');
    const bits = Number(bitsStr);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const baseInt = ipv4ToInt(base ?? '');
    const ipInt = ipv4ToInt(remoteIp);
    if (baseInt === null || ipInt === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xFFFFFFFF : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return (baseInt & mask) === (ipInt & mask);
  }
  return false;
}

export function isIpAllowed(remoteIpRaw: string): boolean {
  const ip = normalizeRequestIp(remoteIpRaw);
  if (ALWAYS_ALLOW.has(ip)) return true;
  for (const entry of allowedList) {
    if (matchesEntry(ip, entry)) return true;
  }
  return false;
}

export async function refreshIpGuard(reason: 'boot' | 'update'): Promise<void> {
  try {
    const ips = await getAllowedIPs();
    allowedList = ips;
    if (reason === 'boot') {
      console.log(`Access-check whitelist loaded with ${ips.length} entries from firewall rule`);
    } else {
      logActivity('info', 'access-check', `Whitelist cache refreshed (${ips.length} entries)`);
    }
  } catch (err) {
    const msg = String(err).split('\n')[0]?.slice(0, 300) ?? 'unknown';
    if (reason === 'boot') {
      console.error(`Access-check FAILED to load whitelist at boot — cache stays empty: ${msg}`);
    } else {
      logActivity('error', 'access-check', `Whitelist refresh failed — keeping previous cache: ${msg}`);
    }
  }
}

export function getCurrentWhitelist(): string[] {
  return [...allowedList];
}
