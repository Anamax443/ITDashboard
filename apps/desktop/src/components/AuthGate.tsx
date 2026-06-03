import React, { useEffect, useState, useCallback } from 'react';
import { API_BASE } from '../api.js';
import { useI18n } from '../i18n.js';

export type AuthState = {
  authenticated: boolean;
  user: string | null;
  expiresAt: number | null;
  ldapMode: 'ldap' | 'stub' | 'disabled' | 'unknown';
};

const Ctx = React.createContext<{
  state: AuthState;
  refresh: () => Promise<void>;
  ensure: () => Promise<boolean>;
  signOut: () => Promise<void>;
} | null>(null);

export function useAuth() {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<AuthState>({ authenticated: false, user: null, expiresAt: null, ldapMode: 'unknown' });
  const [showModal, setShowModal] = useState(false);
  const [pendingResolve, setPendingResolve] = useState<((ok: boolean) => void) | null>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/whoami`, { credentials: 'include' });
      const j = await res.json();
      setState({
        authenticated: Boolean(j.authenticated),
        user: j.user ?? null,
        expiresAt: j.expiresAt ?? null,
        ldapMode: j.ldapMode ?? 'unknown',
      });
    } catch {
      setState({ authenticated: false, user: null, expiresAt: null, ldapMode: 'unknown' });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const ensure = useCallback(async (): Promise<boolean> => {
    await refresh();
    return new Promise((resolve) => {
      if (state.authenticated) { resolve(true); return; }
      setUser('');
      setPassword('');
      setError(null);
      setShowModal(true);
      setPendingResolve(() => resolve);
    });
  }, [refresh, state.authenticated]);

  const signOut = useCallback(async () => {
    try { await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' }); } catch { /* ignore */ }
    setState({ authenticated: false, user: null, expiresAt: null, ldapMode: state.ldapMode });
  }, [state.ldapMode]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ user, password }),
      });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error === 'invalid_credentials' ? t('auth.invalidCredentials') : t('auth.error', { detail: String(j.detail ?? j.error ?? '') }));
        setSubmitting(false);
        return;
      }
      setState({ authenticated: true, user: j.user, expiresAt: j.expiresAt, ldapMode: state.ldapMode });
      setShowModal(false);
      if (pendingResolve) { pendingResolve(true); setPendingResolve(null); }
    } catch (e) {
      setError(t('auth.error', { detail: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = () => {
    setShowModal(false);
    if (pendingResolve) { pendingResolve(false); setPendingResolve(null); }
  };

  return (
    <Ctx.Provider value={{ state, refresh, ensure, signOut }}>
      {children}
      {showModal && (
        <div
          onClick={cancel}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
          }}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); void submit(); }}
            style={{
              background: 'var(--panel)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6,
              padding: 24, width: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{t('auth.modalTitle')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 16 }}>{t('auth.modalHint')}</div>

            <label style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>{t('auth.user')}</label>
            <input
              autoFocus
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoComplete="username"
              placeholder="AXINETWORK\trnka_admin or trnka_admin@AXINETWORK.LOC"
              style={{ width: '100%', padding: '6px 10px', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 12, fontSize: 12 }}
            />

            <label style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>{t('auth.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{ width: '100%', padding: '6px 10px', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 12, fontSize: 12 }}
            />

            {error && <div style={{ color: 'var(--critical)', fontSize: 11, marginBottom: 12 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={cancel} disabled={submitting} className="refresh-btn" style={{ padding: '4px 12px', fontSize: 12 }}>
                {t('auth.cancel')}
              </button>
              <button type="submit" disabled={submitting || !user || !password} style={{ padding: '4px 16px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 4, cursor: submitting ? 'default' : 'pointer' }}>
                {submitting ? t('auth.signingIn') : t('auth.signIn')}
              </button>
            </div>

            <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-dim)' }}>{t('auth.modalFooter', { mode: state.ldapMode })}</div>
          </form>
        </div>
      )}
    </Ctx.Provider>
  );
}

export async function getLaunchUrl(target: string, tool: string, baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/launch-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ target, tool }),
    });
    const j = await res.json();
    if (!j.ok) return null;
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}tk=${encodeURIComponent(j.token)}`;
  } catch {
    return null;
  }
}
