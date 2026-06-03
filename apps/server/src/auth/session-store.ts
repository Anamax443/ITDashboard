import { randomBytes } from 'node:crypto';

export type Session = {
  id: string;
  user: string;
  password: string;
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number;
  ip: string;
  userAgent: string;
};

export type LaunchToken = {
  token: string;
  sessionId: string;
  target: string;
  tool: string;
  createdAt: number;
  expiresAt: number;
  redeemed: boolean;
  redeemedAt?: number;
};

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_HARD_MAX_MS = 8 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 1000;

const sessions = new Map<string, Session>();
const tokens = new Map<string, LaunchToken>();

function newId(byteLen = 32): string {
  return randomBytes(byteLen).toString('base64url');
}

export function createSession(input: { user: string; password: string; ip: string; userAgent: string }): Session {
  const now = Date.now();
  const id = newId(32);
  const session: Session = {
    id,
    user: input.user,
    password: input.password,
    createdAt: now,
    expiresAt: now + SESSION_HARD_MAX_MS,
    lastActivityAt: now,
    ip: input.ip,
    userAgent: input.userAgent,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | null {
  const s = sessions.get(id);
  if (!s) return null;
  const now = Date.now();
  if (s.expiresAt < now) {
    sessions.delete(id);
    return null;
  }
  if (now - s.lastActivityAt > SESSION_IDLE_MS) {
    sessions.delete(id);
    return null;
  }
  s.lastActivityAt = now;
  return s;
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}

export function createLaunchToken(input: { sessionId: string; target: string; tool: string }): LaunchToken {
  const now = Date.now();
  const token = newId(24);
  const t: LaunchToken = {
    token,
    sessionId: input.sessionId,
    target: input.target,
    tool: input.tool,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
    redeemed: false,
  };
  tokens.set(token, t);
  return t;
}

export function redeemLaunchToken(token: string): { ok: true; token: LaunchToken; session: Session } | { ok: false; reason: string } {
  const t = tokens.get(token);
  if (!t) return { ok: false, reason: 'token_unknown' };
  const now = Date.now();
  if (t.redeemed) return { ok: false, reason: 'token_already_redeemed' };
  if (t.expiresAt < now) {
    tokens.delete(token);
    return { ok: false, reason: 'token_expired' };
  }
  const session = sessions.get(t.sessionId);
  if (!session) return { ok: false, reason: 'session_expired' };
  if (session.expiresAt < now) {
    sessions.delete(session.id);
    return { ok: false, reason: 'session_expired' };
  }
  t.redeemed = true;
  t.redeemedAt = now;
  return { ok: true, token: t, session };
}

export function sweepExpired(): { sessions: number; tokens: number } {
  const now = Date.now();
  let sessionsRemoved = 0;
  let tokensRemoved = 0;
  for (const [id, s] of sessions) {
    if (s.expiresAt < now || now - s.lastActivityAt > SESSION_IDLE_MS) {
      sessions.delete(id);
      sessionsRemoved++;
    }
  }
  for (const [id, t] of tokens) {
    if (t.expiresAt < now || t.redeemed) {
      tokens.delete(id);
      tokensRemoved++;
    }
  }
  return { sessions: sessionsRemoved, tokens: tokensRemoved };
}

export function getSessionStats(): { activeSessions: number; pendingTokens: number } {
  return { activeSessions: sessions.size, pendingTokens: tokens.size };
}

setInterval(sweepExpired, 60_000).unref();
