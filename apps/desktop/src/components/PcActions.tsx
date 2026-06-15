import React, { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.js';

// Per-row action for the Computers tab: refresh ALL monitored data for a single
// PC (disk + PC-info, services, eventlog, perf, ports) without spinning the
// whole fleet. The old launcher / remote-management content (MMC, RDP, PsExec,
// admin shares, copy helpers) was removed — only the refresh remains.

interface Props {
  name: string;            // PC name, e.g. ZAST5W11
  computerId?: number;     // for single-PC refresh endpoint
  onRefreshed?: () => void;
}

export function PcActionsButton({ name, computerId, onRefreshed }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{ ok: boolean; durationMs: number; steps: { step: string; ok: boolean; detail: string }[] } | null>(null);
  const onClose = () => {
    // If a manual single-PC refresh ran in this modal, re-sync the main Computers
    // list on close so the freshly collected data is visible immediately without
    // waiting for the next background poll.
    if (refreshResult && onRefreshed) onRefreshed();
    setRefreshResult(null);
    setOpen(false);
  };

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  const doRefresh = async () => {
    if (!computerId || refreshing) return;
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const r = await api.refreshPc(computerId);
      setRefreshResult({ ok: r.ok, durationMs: r.durationMs, steps: r.steps });
      flash(t('actions.refreshDone').replace('{sec}', (r.durationMs / 1000).toFixed(1)));
      if (onRefreshed) onRefreshed();
    } catch (e) {
      flash(`${t('actions.refreshFailed')}: ${String(e).slice(0, 100)}`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <button
        className="refresh-btn"
        onClick={() => setOpen(!open)}
        title={t('actions.refreshTitle')}
        style={{ padding: '2px 8px', fontSize: 11 }}
      >🔄 {t('actions.title')}</button>

      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
              minWidth: 480, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto', color: 'var(--text)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>
                {t('actions.title')} · <span style={{ color: 'var(--accent)' }}>{name}</span>
              </h3>
              <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>

            <div style={{ padding: 16, fontSize: 12, lineHeight: 1.6 }}>
              {computerId && (
                <div style={{
                  background: 'rgba(34, 197, 94, 0.10)',
                  border: '1px solid var(--ok)',
                  borderRadius: 4, padding: '10px 12px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{t('actions.refreshTitle')}</div>
                      <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>{t('actions.refreshDesc')}</div>
                    </div>
                    <button
                      className="refresh-btn"
                      onClick={doRefresh}
                      disabled={refreshing}
                      style={{ background: 'var(--ok)', color: 'white', border: 'none', padding: '4px 12px', fontSize: 12, fontWeight: 600 }}
                    >{refreshing ? t('actions.refreshing') : t('actions.refreshNow')}</button>
                  </div>
                  {refreshResult && (
                    <div style={{ marginTop: 8, fontSize: 11 }}>
                      {refreshResult.steps.map((s) => (
                        <div key={s.step} style={{ display: 'flex', gap: 6 }}>
                          <span style={{ color: s.ok ? 'var(--ok)' : 'var(--critical)' }}>{s.ok ? '✓' : '✗'}</span>
                          <span style={{ minWidth: 80 }}>{s.step}</span>
                          <span style={{ color: 'var(--text-dim)' }}>{s.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {toast && (
                <div style={{ position: 'sticky', bottom: 0, marginTop: 12, color: 'var(--ok)', fontWeight: 600 }}>
                  ✓ {toast}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
