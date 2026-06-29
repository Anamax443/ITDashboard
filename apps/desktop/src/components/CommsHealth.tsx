import React from 'react';
import type { CommsResult } from '../api.js';
import { useI18n } from '../i18n.js';

// Drill-down for the "Komunikace" dashboard tile: one row per communication
// channel (SQL, MikroTik REST, FTP, collector, e-mail, UniFi) with an at-a-glance
// status dot, a human detail and the last error / last-OK time. Collapsible,
// toggled by the tile (same open/onOpenChange pattern as HealthCards).
export function CommsHealth({ data, open, onOpenChange }: {
  data: CommsResult | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  if (!open || !data) return null;

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
  // Explicit map — t() keys are a strict literal union, so no template strings.
  const LABEL_KEY: Record<string, Parameters<typeof t>[0]> = {
    database: 'comms.ch.database',
    mikrotik_rest: 'comms.ch.mikrotik_rest',
    ftp: 'comms.ch.ftp',
    collector: 'comms.ch.collector',
    email: 'comms.ch.email',
    unifi: 'comms.ch.unifi',
  };
  const label = (key: string) => t(LABEL_KEY[key] ?? 'comms.title');

  return (
    <div style={{ marginTop: 14, border: '1px solid var(--accent)', borderRadius: 8, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>📶 {t('comms.title')}</strong>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {data.overall === 'down' ? t('cards.commsDbDown')
            : data.overall === 'ok' ? `${data.okCount}/${data.total} ${t('comms.allOk')}`
              : `${data.total - data.okCount} ${t('cards.commsDown')}`}
        </span>
        <button className="refresh-btn" style={{ marginLeft: 'auto' }} onClick={() => onOpenChange(false)}>✕</button>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          {data.channels.map((c) => {
            const dot = !c.enabled ? { ch: '—', col: 'var(--text-dim)' }
              : c.ok ? { ch: '●', col: 'var(--ok)' }
                : { ch: '●', col: 'var(--critical)' };
            return (
              <tr key={c.key} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '7px 8px', width: 22, color: dot.col, fontSize: 15, textAlign: 'center' }} title={c.enabled ? (c.ok ? 'OK' : 'chyba') : 'vypnuto'}>{dot.ch}</td>
                <td style={{ padding: '7px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>{label(c.key)}</td>
                <td style={{ padding: '7px 8px', color: 'var(--text-dim)' }}>
                  {c.detail}
                  {c.lastError && <div style={{ color: 'var(--critical)', marginTop: 2, fontFamily: 'Consolas, monospace', fontSize: 11.5 }}>{c.lastError}</div>}
                </td>
                <td style={{ padding: '7px 8px', color: 'var(--text-dim)', whiteSpace: 'nowrap', textAlign: 'right', fontSize: 11.5 }}>
                  {c.lastOk ? `${t('comms.lastOk')} ${fmt(c.lastOk)}` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>{t('comms.checkedAt')} {fmt(data.checkedAt)}</div>
    </div>
  );
}
