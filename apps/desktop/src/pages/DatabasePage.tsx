import React, { useEffect, useState } from 'react';
import type { DatabaseOverview } from '../api.js';
import { api } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { Card } from '../components/SummaryCards.js';
import { useI18n } from '../i18n.js';

// Database footprint: whole-DB size (data + log + used) and a per-table breakdown
// so the operator can see which tables eat the space. Read-only; refreshes on
// demand (catalog stats don't change second-to-second).

function fmtKb(kb: number): string {
  if (kb == null) return '—';
  if (kb < 1024) return `${kb} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function DatabasePage() {
  const { t } = useI18n();
  const [data, setData] = useState<DatabaseOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.database()
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  const db = data?.db;
  const tables = data?.tables ?? [];
  const maxReserved = tables.reduce((m, x) => Math.max(m, x.reserved_kb), 0) || 1;

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('db.help')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>
          🗄 {t('db.title')}{' '}
          {db && <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>({db.name} · {tables.length} {t('db.tables')})</span>}
        </h2>
        <div className="panel-actions filters">
          <button className="refresh-btn" onClick={refresh} disabled={loading}>{loading ? '…' : '↻'} {t('db.refresh')}</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {db && (
          <div className="cards" style={{ marginBottom: 12 }}>
            <Card label={t('db.total')} value={fmtKb(db.total_kb)} kind="info" />
            <Card label={t('db.data')} value={fmtKb(db.data_kb)} sub={`${fmtKb(db.data_used_kb)} ${t('db.used')}`} kind="info" />
            <Card label={t('db.log')} value={fmtKb(db.log_kb)} kind="info" />
          </div>
        )}
        {tables.length === 0 ? (
          <div className="empty">{loading ? '…' : t('db.empty')}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('db.table')}</th>
                <th style={{ width: 120, textAlign: 'right' }}>{t('db.rows')}</th>
                <th style={{ width: 120, textAlign: 'right' }}>{t('db.reserved')}</th>
                <th style={{ width: 120, textAlign: 'right' }}>{t('db.dataSize')}</th>
                <th style={{ width: 220 }} />
              </tr>
            </thead>
            <tbody>
              {tables.map((x) => (
                <tr key={x.table_name}>
                  <td style={{ fontFamily: 'Consolas, monospace', fontSize: 12, fontWeight: 600 }}>{x.table_name}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'Consolas, monospace', fontSize: 12 }}>{x.row_count.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'Consolas, monospace', fontSize: 12, fontWeight: 700 }}>{fmtKb(x.reserved_kb)}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'Consolas, monospace', fontSize: 12, color: 'var(--text-dim)' }}>{fmtKb(x.data_kb)}</td>
                  <td>
                    <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.max(1, Math.round((x.reserved_kb / maxReserved) * 100))}%`, background: 'var(--accent)' }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
