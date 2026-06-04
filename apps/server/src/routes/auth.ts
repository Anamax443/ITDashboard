import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createSession, getSession, deleteSession, createLaunchToken, redeemLaunchToken, getSessionStats } from '../auth/session-store.js';
import { ldapBind, ldapConfigured, ldapMode } from '../auth/ldap.js';
import { logActivity } from '../services/activity-log.js';

const COOKIE_NAME = 'itd-session';
// `secure` flag is environment-driven via ITD_COOKIE_SECURE so the
// flip can be staged with the IIS+TLS rollout (MIKOS-side CR). Until
// TLS reverse proxy is up, the dashboard runs on plain HTTP and a
// secure cookie would never be sent back by the browser. Operator
// sets ITD_COOKIE_SECURE=1 simultaneously with the IIS deploy.
// Per oponentura 2026-06-04 (CR DC Windows Auth review) commitment 2:
// production deployment MUST set ITD_COOKIE_SECURE=1 once IIS+TLS is
// in front.
const COOKIE_OPTS = {
  httpOnly: true as const,
  sameSite: 'strict' as const,
  secure: process.env.ITD_COOKIE_SECURE === '1',
  path: '/',
  maxAge: 8 * 60 * 60,
};

const ALLOWED_TOOLS = ['mmc', 'services', 'eventvwr', 'taskschd', 'rdp', 'explorer', 'ps', 'psexec'] as const;
type Tool = typeof ALLOWED_TOOLS[number];

const HOST_RE = /^[a-zA-Z0-9._-]{1,63}$/;

function clientIp(req: FastifyRequest): string {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? 'unknown';
}

function ua(req: FastifyRequest): string {
  return String(req.headers['user-agent'] ?? 'unknown').slice(0, 256);
}

function sessionIdFromReq(req: FastifyRequest): string | null {
  const cookies = (req as unknown as { cookies?: Record<string, string | undefined> }).cookies ?? {};
  return cookies[COOKIE_NAME] ?? null;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const SessionBody = z.object({ user: z.string().min(1).max(256), password: z.string().min(1).max(512) });

  app.post('/api/auth/session', async (req, reply) => {
    const parsed = SessionBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });

    const bind = await ldapBind(parsed.data.user, parsed.data.password);
    if (!bind.ok) {
      logActivity('warn', 'auth', `LDAP bind failed reason=${bind.reason} user=${parsed.data.user} ip=${clientIp(req)}`);
      return reply.code(401).send({ ok: false, error: bind.reason, detail: bind.detail });
    }

    const session = createSession({ user: bind.canonicalUser, password: parsed.data.password, ip: clientIp(req), userAgent: ua(req) });
    reply.setCookie(COOKIE_NAME, session.id, COOKIE_OPTS);
    logActivity('info', 'auth', `session_created user=${session.user} ip=${session.ip} mode=${ldapMode()}`);
    return reply.send({ ok: true, user: session.user, expiresAt: session.expiresAt });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const id = sessionIdFromReq(req);
    if (id) {
      deleteSession(id);
      logActivity('info', 'auth', `session_destroyed ip=${clientIp(req)}`);
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/whoami', async (req, reply) => {
    const id = sessionIdFromReq(req);
    if (!id) return reply.send({ ok: false, authenticated: false, ldapMode: ldapMode(), ldapConfigured: ldapConfigured() });
    const session = getSession(id);
    if (!session) {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return reply.send({ ok: false, authenticated: false, expired: true, ldapMode: ldapMode(), ldapConfigured: ldapConfigured() });
    }
    return reply.send({ ok: true, authenticated: true, user: session.user, expiresAt: session.expiresAt, ldapMode: ldapMode() });
  });

  const LaunchBody = z.object({ target: z.string().regex(HOST_RE), tool: z.enum(ALLOWED_TOOLS) });

  app.post('/api/auth/launch-token', async (req, reply) => {
    const id = sessionIdFromReq(req);
    if (!id) return reply.code(401).send({ ok: false, error: 'no_session' });
    const session = getSession(id);
    if (!session) {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return reply.code(401).send({ ok: false, error: 'session_expired' });
    }
    const parsed = LaunchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });

    const token = createLaunchToken({ sessionId: session.id, target: parsed.data.target, tool: parsed.data.tool });
    logActivity('info', 'auth', `launch_token_created user=${session.user} target=${parsed.data.target} tool=${parsed.data.tool} ip=${clientIp(req)}`);
    return reply.send({ ok: true, token: token.token, expiresAt: token.expiresAt });
  });

  app.get<{ Querystring: { token?: string } }>('/api/auth/redeem', async (req, reply) => {
    const t = req.query.token;
    if (!t || typeof t !== 'string') return reply.code(400).send({ ok: false, error: 'token_missing' });
    const r = redeemLaunchToken(t);
    if (!r.ok) {
      logActivity('warn', 'auth', `redeem_failed reason=${r.reason} ip=${clientIp(req)}`);
      return reply.code(401).send({ ok: false, error: r.reason });
    }
    logActivity('info', 'auth', `redeem_ok user=${r.session.user} target=${r.token.target} tool=${r.token.tool} ip=${clientIp(req)}`);
    return reply.send({ ok: true, user: r.session.user, password: r.session.password, target: r.token.target, tool: r.token.tool });
  });

  app.get('/api/auth/stats', async () => {
    const s = getSessionStats();
    return { ok: true, ...s, ldapMode: ldapMode() };
  });
}
