import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAllowedIPs } from './firewall.js';
import { logActivity } from './activity-log.js';

// In-memory whitelist refreshed at boot + after every PUT /firewall/whitelist.
// Source of truth remains the Windows Firewall rule "ITDashboard API (4000)".
//
// Scope: this guard is applied ONLY to the user-facing surfaces (frontend HTML
// bundle and /docs page), NOT to the JSON API endpoints. The server is on an
// internal domain network and the API itself is open to anyone in the domain
// — gating the UI just prevents incidental discovery / over-the-shoulder
// access by non-IT users browsing the LAN. If you need a true API-level
// security boundary, that's a different feature (auth tokens, mTLS, etc.).
let allowedList: string[] = [];
let bootLoaded = false;

// Always allow loopback so the service can reach itself (health probes,
// migrations runner, etc.) regardless of whitelist state.
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

function normalizeRequestIp(raw: string): string {
  // Fastify on dual-stack sockets reports v4-mapped v6 like "::ffff:10.8.2.180"
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
    bootLoaded = true;
    if (reason === 'boot') {
      console.log(`IP guard loaded ${ips.length} whitelist entries from firewall rule`);
    } else {
      logActivity('info', 'ip-guard', `Whitelist cache refreshed (${ips.length} entries)`);
    }
  } catch (err) {
    // Fail closed: if we cannot read the rule, the in-memory list stays empty
    // and only loopback is allowed. Better to lock the operator out than to
    // silently default to "allow all".
    const msg = String(err).split('\n')[0]?.slice(0, 300) ?? 'unknown';
    if (reason === 'boot') {
      console.error(`IP guard FAILED to load whitelist at boot — failing closed (loopback only): ${msg}`);
      bootLoaded = true;
    } else {
      logActivity('error', 'ip-guard', `Whitelist refresh failed — keeping previous cache: ${msg}`);
    }
  }
}

function forbiddenHtml(ip: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Forbidden</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;background:#1e1e1e;color:#ddd;padding:48px;max-width:680px;margin:auto}
code{background:#2d2d2d;padding:2px 6px;border-radius:3px}h1{color:#f48771}</style></head><body>
<h1>Access not configured</h1>
<p>Your IP <code>${ip}</code> is not on the ITDashboard access list.</p>
<p>The dashboard UI is restricted to a small set of IT operator workstations. The
JSON API itself remains reachable, but the user interface is gated to prevent
incidental access.</p>
<p>Ask the dashboard operator to add your IP via <em>Settings &rarr; Network access</em>.</p>
</body></html>`;
}

/**
 * Per-route Fastify preHandler. Use only on user-facing UI routes (frontend, /docs).
 * Returns 403 HTML if the remote IP is not in the whitelist.
 */
export async function ipGuardHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!bootLoaded) {
    reply.code(503);
    return reply.send({ error: 'IP guard not initialized' });
  }
  const remote = normalizeRequestIp(req.ip);
  if (isIpAllowed(remote)) return;
  req.log.warn({ remoteIp: remote, url: req.url }, 'IP guard rejected UI request');
  reply.code(403).type('text/html; charset=utf-8').send(forbiddenHtml(remote));
}

export function getCurrentWhitelist(): string[] {
  return [...allowedList];
}
