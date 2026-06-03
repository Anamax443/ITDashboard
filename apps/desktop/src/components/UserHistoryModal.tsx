import React, { useEffect, useState } from 'react';
import { api, timeAgo } from '../api.js';
import type { PcUserHistoryItem } from '../api.js';
import { useI18n } from '../i18n.js';

interface Props {
  computerId: number;
  computerName: string;
  onClose: () => void;
}

function durationHuman(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86400_000) return `${(ms / 3600_000).toFixed(1)}h`;
  return `${(ms / 86400_000).toFixed(1)}d`;
}

export function UserHistoryModal({ computerId, computerName, onClose }: Props) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<PcUserHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.userHistory(computerId, 365)
      .then((r) => setItems(r.items))
      .catch((e) => setError(String(e)));
  }, [computerId]);

  const locale = lang === 'cs' ? 'cs-CZ' : 'en-US';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
          minWidth: 560, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto',
          color: 'var(--text)', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>
            {t('userHistory.title')} · <span style={{ color: 'var(--accent)' }}>{computerName}</span>
          </h3>
          <button
            className="refresh-btn"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: 18, cursor: 'pointer' }}
            title={t('userHistory.close')}
          >×</button>
        </div>
        <div style={{ padding: 16 }}>
          {error && <div style={{ color: 'var(--critical)', fontSize: 12 }}>⚠ {error}</div>}
          {!error && items === null && <div style={{ color: 'var(--text-dim)' }}>…</div>}
          {!error && items && items.length === 0 && <div style={{ color: 'var(--text-dim)' }}>{t('userHistory.empty')}</div>}
          {!error && items && items.length > 0 && (
            <table className="datatable" style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th>{t('userHistory.user')}</th>
                  <th>{t('userHistory.firstSeen')}</th>
                  <th>{t('userHistory.lastSeen')}</th>
                  <th>{t('userHistory.ip')}</th>
                  <th style={{ textAlign: 'right' }}>{t('userHistory.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td style={{ fontFamily: 'Consolas, monospace' }}>{it.user_name}</td>
                    <td title={new Date(it.first_seen).toISOString()}>
                      {new Date(it.first_seen).toLocaleString(locale)}
                    </td>
                    <td title={`${new Date(it.last_seen).toISOString()} · ${timeAgo(it.last_seen)}`}>
                      {new Date(it.last_seen).toLocaleString(locale)}
                    </td>
                    <td style={{ fontFamily: 'Consolas, monospace', color: 'var(--text-dim)' }}>
                      {it.ip_address ?? '—'}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>
                      {durationHuman(it.first_seen, it.last_seen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
