import { Client } from 'ldapts';

const LDAP_URL = process.env.AD_LDAP_URL ?? '';
const LDAP_DOMAIN = process.env.AD_LDAP_DOMAIN ?? 'AXINETWORK.LOC';
const LDAP_TIMEOUT_MS = Number(process.env.AD_LDAP_TIMEOUT_MS ?? 5000);
const ALLOW_STUB = process.env.AD_LDAP_STUB === '1';

export type LdapBindResult =
  | { ok: true; canonicalUser: string }
  | { ok: false; reason: 'invalid_credentials' | 'ldap_unreachable' | 'misconfigured' | 'timeout' | 'unknown'; detail?: string };

function normalizeUser(input: string): string {
  const t = input.trim();
  if (!t) return t;
  if (t.includes('\\')) return t;
  if (t.includes('@')) return t;
  return `${t}@${LDAP_DOMAIN}`;
}

export async function ldapBind(user: string, password: string): Promise<LdapBindResult> {
  if (!user || !password) return { ok: false, reason: 'invalid_credentials' };

  if (!LDAP_URL) {
    if (ALLOW_STUB) {
      return { ok: true, canonicalUser: normalizeUser(user) };
    }
    return { ok: false, reason: 'misconfigured', detail: 'AD_LDAP_URL not set (set AD_LDAP_STUB=1 to allow stub validation for testing only)' };
  }

  const canonical = normalizeUser(user);
  const client = new Client({ url: LDAP_URL, timeout: LDAP_TIMEOUT_MS, connectTimeout: LDAP_TIMEOUT_MS });
  try {
    await client.bind(canonical, password);
    return { ok: true, canonicalUser: canonical };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    if (lower.includes('invalid credentials') || lower.includes('49')) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('econnreset')) {
      return { ok: false, reason: 'ldap_unreachable', detail: message };
    }
    if (lower.includes('timeout')) return { ok: false, reason: 'timeout', detail: message };
    return { ok: false, reason: 'unknown', detail: message };
  } finally {
    try { await client.unbind(); } catch { /* noop */ }
  }
}

export function ldapConfigured(): boolean {
  return Boolean(LDAP_URL) || ALLOW_STUB;
}

export function ldapMode(): 'ldap' | 'stub' | 'disabled' {
  if (LDAP_URL) return 'ldap';
  if (ALLOW_STUB) return 'stub';
  return 'disabled';
}
