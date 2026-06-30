import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { ServicePortMatrix, SvcCell, DiscoResult } from '../api.js';
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
  const [disco, setDisco] = useState<DiscoResult | null>(null);
  const [discoRunning, setDiscoRunning] = useState(false);
  const [discoFull, setDiscoFull] = useState(false);
  const [discoErr, setDiscoErr] = useState<string | null>(null);

  const runDiscovery = async () => {
    setDiscoRunning(true); setDiscoErr(null);
    try { setDisco(await api.serviceDiscovery(discoFull)); }
    catch (e) { setDiscoErr(String(e)); }
    finally { setDiscoRunning(false); }
  };

  const load = () => {
    setLoading(true);
    api.servicePorts().then((r) => { setData(r); setError(null); })
      .catch((e) => setError(String(e))).finally(() => setLoading(false));
  };
  useEffect(() => { load(); const tmr = setInterval(load, 30_000); return () => clearInterval(tmr); }, []);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
  const cellOf = (site: string, label: string): SvcCell => data?.cells?.[site]?.[label] ?? { online: 0, open: 0, offline: 0, closed: [] };
  const statusColor = (c: SvcCell) =>
    c.online === 0 ? 'var(--text-dim)' : c.open === c.online ? 'var(--ok)' : c.open === 0 ? 'var(--critical)' : 'var(--warning)';
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
                        {c.online === 0 && c.offline === 0 ? (
                          <span style={{ color: 'var(--text-dim)' }}>—</span>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'Consolas, monospace' }}>
                            {c.online > 0 && <><span style={{ color: statusColor(c), fontSize: 13 }}>●</span><b style={{ color: statusColor(c) }}>{c.open}/{c.online}</b></>}
                            {c.offline > 0 && <span style={{ color: 'var(--text-dim)' }}>{c.online > 0 ? '· ' : ''}{c.offline} off</span>}
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
          <span style={{ color: 'var(--text-dim)' }}>N off = {t('svcports.legendOffline')}</span>
          <span style={{ color: 'var(--text-dim)' }}>— {t('svcports.legendEmpty')}</span>
          <span style={{ marginLeft: 'auto' }}>{t('svcports.checkedAt')} {fmt(data?.checkedAt ?? null)}</span>
        </div>

        <div style={{ marginTop: 22, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>🔬 {t('svcports.disco.title')}</strong>
            <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={discoFull} onChange={(e) => setDiscoFull(e.target.checked)} disabled={discoRunning} />
              {t('svcports.disco.full')}
            </label>
            <button className="refresh-btn" onClick={runDiscovery} disabled={discoRunning} style={{ fontWeight: 600 }}>
              {discoRunning ? `… ${t('svcports.disco.running')}` : `▶ ${t('svcports.disco.run')}`}
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--text-dim)', margin: '0 0 10px', maxWidth: 780, lineHeight: 1.5 }}>{t('svcports.disco.help')}</p>
          {discoErr && <div style={{ color: 'var(--critical)', marginBottom: 8 }}>⚠ {discoErr}</div>}
          {disco && (
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 10 }}>
                {disco.scannedPorts} {t('svcports.disco.ports')} · {(disco.durationMs / 1000).toFixed(1)} s · {fmt(disco.ranAt)}{disco.full ? ' · 1–65535' : ''}
              </div>
              {disco.categories.length === 0 ? <div style={{ color: 'var(--text-dim)' }}>{t('svcports.disco.none')}</div> : disco.categories.map((c) => (
                <div key={c.category} style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.category} <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 12 }}>({c.sampled.length} {t('svcports.disco.sampled')}: {c.sampled.map((d) => d.ip).join(', ')})</span></div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {c.ports.length === 0 ? <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('svcports.disco.noports')}</span> : c.ports.map((p) => (
                      <span key={p.port} title={`${p.open}/${p.of}`} style={{ fontFamily: 'Consolas, monospace', fontSize: 11.5, padding: '2px 7px', borderRadius: 5, border: '1px solid var(--border)', background: p.open === p.of ? 'rgba(63,214,140,.12)' : 'rgba(245,165,36,.12)' }}>
                        {p.port} <span style={{ color: 'var(--text-dim)' }}>{p.open}/{p.of}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
