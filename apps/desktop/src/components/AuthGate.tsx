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
        let msg: string;
        if (j.error === 'invalid_credentials') msg = t('auth.invalidCredentials');
        else if (j.error === 'not_in_edit_group') msg = t('auth.notInEditGroup', { detail: String(j.detail ?? '') });
        else msg = t('auth.error', { detail: String(j.detail ?? j.error ?? '') });
        setError(msg);
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
            position: 'fixed', inset: 0,
            background: 'rgba(0, 0, 0, 0.78)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000,
          }}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); void submit(); }}
            style={{
              background: 'var(--bg)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 8,
              padding: 28, width: 460, boxShadow: '0 12px 48px rgba(0, 0, 0, 0.6)',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>{t('auth.modalTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 20, lineHeight: 1.5 }}>{t('auth.modalHint')}</div>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t('auth.user')}</label>
            <input
              autoFocus
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoComplete="username"
              placeholder="AXINETWORK\trnka_admin"
              style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.25)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 14, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t('auth.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.25)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 14, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />

            {error && <div style={{ color: 'var(--critical)', fontSize: 12, marginBottom: 14, padding: '8px 10px', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid var(--critical)', borderRadius: 4 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" onClick={cancel} disabled={submitting} className="refresh-btn" style={{ padding: '6px 16px', fontSize: 13 }}>
                {t('auth.cancel')}
              </button>
              <button type="submit" disabled={submitting || !user || !password} style={{ padding: '6px 20px', fontSize: 13, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 4, cursor: submitting ? 'default' : 'pointer', opacity: (submitting || !user || !password) ? 0.5 : 1 }}>
                {submitting ? t('auth.signingIn') : t('auth.signIn')}
              </button>
            </div>

            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>{t('auth.modalFooter', { mode: state.ldapMode })}</div>
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
