import { Client } from 'ldapts';

const LDAP_URL = process.env.AD_LDAP_URL ?? '';
const LDAP_DOMAIN = process.env.AD_LDAP_DOMAIN ?? 'AXINETWORK.LOC';
const LDAP_BASE_DN = process.env.AD_LDAP_BASE_DN ?? '';
const LDAP_TIMEOUT_MS = Number(process.env.AD_LDAP_TIMEOUT_MS ?? 5000);
const EDIT_GROUP = process.env.AD_EDIT_GROUP ?? '';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const ALLOW_STUB = process.env.AD_LDAP_STUB === '1';

// Production guard: stub mode accepts any non-empty credential and is for
// first-deploy local testing only. Refuse to boot in production if it is set,
// so a forgotten env var cannot silently open the edit tier to anyone.
if (NODE_ENV === 'production' && ALLOW_STUB) {
  throw new Error('AD_LDAP_STUB=1 is not allowed when NODE_ENV=production. Set AD_LDAP_URL to a real LDAP endpoint or unset AD_LDAP_STUB before booting.');
}

export type LdapBindResult =
  | { ok: true; canonicalUser: string }
  | { ok: false; reason: 'invalid_credentials' | 'ldap_unreachable' | 'misconfigured' | 'timeout' | 'not_in_edit_group' | 'unknown'; detail?: string };

function normalizeUser(input: string): string {
  const t = input.trim();
  if (!t) return t;
  if (t.includes('\\')) return t;
  if (t.includes('@')) return t;
  return `${t}@${LDAP_DOMAIN}`;
}

async function checkEditGroupMembership(client: Client, canonicalUser: string): Promise<boolean> {
  // If no AD_EDIT_GROUP is configured, deny by default in production (we
  // require an explicit group gate for the edit tier) and allow in dev so
  // the AD wiring can be iterated against without a real group yet.
  if (!EDIT_GROUP) return NODE_ENV !== 'production';
  if (!LDAP_BASE_DN) return false;

  // Use AD's transitive group resolution (LDAP_MATCHING_RULE_IN_CHAIN, OID
  // 1.2.840.113556.1.4.1941) so nested group memberships are honored — a
  // user added to ITDashboard-Editors via an intermediate group still
  // resolves to ok.
  const userFilterValue = canonicalUser.includes('@') ? canonicalUser : `${canonicalUser}@${LDAP_DOMAIN}`;
  const sam = canonicalUser.includes('\\') ? canonicalUser.split('\\')[1] : canonicalUser.split('@')[0];
  const filter = `(&(objectCategory=person)(objectClass=user)(|(userPrincipalName=${userFilterValue})(sAMAccountName=${sam}))(memberOf:1.2.840.113556.1.4.1941:=${EDIT_GROUP}))`;
  try {
    const { searchEntries } = await client.search(LDAP_BASE_DN, { scope: 'sub', filter, attributes: ['distinguishedName'], sizeLimit: 1 });
    return searchEntries.length > 0;
  } catch {
    return false;
  }
}

export async function ldapBind(user: string, password: string): Promise<LdapBindResult> {
  if (!user || !password) return { ok: false, reason: 'invalid_credentials' };

  if (!LDAP_URL) {
    if (ALLOW_STUB) {
      return { ok: true, canonicalUser: normalizeUser(user) };
    }
    return { ok: false, reason: 'misconfigured', detail: 'AD_LDAP_URL not set (set AD_LDAP_STUB=1 to allow stub validation for testing only; not permitted with NODE_ENV=production)' };
  }

  const canonical = normalizeUser(user);
  const client = new Client({ url: LDAP_URL, timeout: LDAP_TIMEOUT_MS, connectTimeout: LDAP_TIMEOUT_MS });
  try {
    await client.bind(canonical, password);
    const inGroup = await checkEditGroupMembership(client, canonical);
    if (!inGroup) {
      const detail = EDIT_GROUP
        ? `User ${canonical} is not a member of edit group DN ${EDIT_GROUP} (transitive resolution).`
        : 'AD_EDIT_GROUP not configured and NODE_ENV=production — edit tier requires an explicit group gate.';
      return { ok: false, reason: 'not_in_edit_group', detail };
    }
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

export function editGroupConfigured(): boolean {
  return Boolean(EDIT_GROUP);
}
