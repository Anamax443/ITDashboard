import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { ServicePortMatrix, SvcCell } from '../api.js';
import { useI18n } from '../i18n.js';

// Per-branch service-port consistency matrix: rows = sites, columns = service
// checks (printer 9100/515/631, phone SIP 5060, …). Each cell = how many devices
// of that category at that site answer on that port. Green = all open, red = none,
// amber = some — so a branch where a service is reachable differently stands out.
export function ServicePortsMatrix() {
  const { t } = useI18n();
  const [data, setData] = useState<ServicePortMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.servicePorts().then((r) => { setData(r); setError(null); })
      .catch((e) => setError(String(e))).finally(() => setLoading(false));
  };
  useEffect(() => { load(); const tmr = setInterval(load, 30_000); return () => clearInterval(tmr); }, []);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
  const cellOf = (site: string, label: string): SvcCell => data?.cells?.[site]?.[label] ?? { total: 0, open: 0, closed: [] };
  const statusColor = (c: SvcCell) =>
    c.total === 0 ? 'var(--text-dim)' : c.open === c.total ? 'var(--ok)' : c.open === 0 ? 'var(--critical)' : 'var(--warning)';
  const closedTitle = (c: SvcCell) =>
    c.closed.length ? `${t('svcports.closed')}: ${c.closed.map((d) => d.ip + (d.name ? ` (${d.name})` : '')).join(', ')}` : '';

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <div className="panel-header">
        <h2>🔎 {t('svcports.title')}</h2>
        <div className="panel-actions">
          <button className="refresh-btn" onClick={load} disabled={loading}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', marginBottom: 10 }}>⚠ {error}</div>}
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 12px', lineHeight: 1.5, maxWidth: 760 }}>
          {t('svcports.help')}
        </p>

        {data && data.checks.length > 0 && data.sites.length > 0 ? (
          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 12px', borderBottom: '2px solid var(--border)' }}>{t('svcports.site')}</th>
                {data.checks.map((ch) => (
                  <th key={ch.label} style={{ padding: '6px 14px', borderBottom: '2px solid var(--border)', textAlign: 'center', whiteSpace: 'nowrap' }}>
                    <div style={{ fontWeight: 600 }}>{ch.label.replace(/\s*\d+$/, '')}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'Consolas, monospace' }}>:{ch.port} · {ch.category}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sites.map((site) => (
                <tr key={site} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '7px 12px', fontWeight: 600, fontFamily: 'Consolas, monospace' }}>{site}</td>
                  {data.checks.map((ch) => {
                    const c = cellOf(site, ch.label);
                    return (
                      <td key={ch.label} title={closedTitle(c)} style={{ padding: '7px 14px', textAlign: 'center' }}>
                        {c.total === 0 ? (
                          <span style={{ color: 'var(--text-dim)' }}>—</span>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'Consolas, monospace' }}>
                            <span style={{ color: statusColor(c), fontSize: 13 }}>●</span>
                            <b style={{ color: statusColor(c) }}>{c.open}/{c.total}</b>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ color: 'var(--text-dim)' }}>{loading ? '…' : t('svcports.empty')}</div>
        )}

        <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11.5, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
          <span><span style={{ color: 'var(--ok)' }}>●</span> {t('svcports.legendOk')}</span>
          <span><span style={{ color: 'var(--warning)' }}>●</span> {t('svcports.legendSome')}</span>
          <span><span style={{ color: 'var(--critical)' }}>●</span> {t('svcports.legendNone')}</span>
          <span style={{ color: 'var(--text-dim)' }}>— {t('svcports.legendEmpty')}</span>
          <span style={{ marginLeft: 'auto' }}>{t('svcports.checkedAt')} {fmt(data?.checkedAt ?? null)}</span>
        </div>
      </div>
    </div>
  );
}
