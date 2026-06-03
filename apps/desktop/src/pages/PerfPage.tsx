import React, { useCallback, useEffect, useState } from 'react';
import { api, timeAgo } from '../api.js';
import type { PerfCategory, PerfCulprit, PerfEventItem, PerfSummary, PerfTopPc } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { useI18n } from '../i18n.js';

const CATEGORIES: { value: '' | PerfCategory; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'boot', label: 'Boot' },
  { value: 'shutdown', label: 'Shutdown' },
  { value: 'standby', label: 'Standby' },
  { value: 'resume', label: 'Resume' },
  { value: 'other', label: 'Other' },
];

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function PerfPage() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<PerfSummary | null>(null);
  const [items, setItems] = useState<PerfEventItem[]>([]);
  const [culprits, setCulprits] = useState<PerfCulprit[]>([]);
  const [topPcs, setTopPcs] = useState<PerfTopPc[]>([]);
  const [days, setDays] = useState(7);
  const [category, setCategory] = useState<'' | PerfCategory>('');
  const [computer, setComputer] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api.perfSummary(days),
      api.perfEvents({
        days,
        category: category || undefined,
        computer: computer || undefined,
        limit: 500,
      }),
      api.perfTopCulprits(days, 15),
      api.perfTopPcs(days, 15),
    ]);
    if (results[0].status === 'fulfilled') setSummary(results[0].value);
    if (results[1].status === 'fulfilled') setItems(results[1].value.items);
    if (results[2].status === 'fulfilled') setCulprits(results[2].value.items);
    if (results[3].status === 'fulfilled') setTopPcs(results[3].value.items);
    const errs = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
    setError(errs.length > 0 ? errs.join(' · ') : null);
  }, [days, category, computer]);

  useEffect(() => { refresh(); }, [refresh]);

  const runScan = async () => {
    setScanning(true);
    setScanMessage(null);
    try {
      const r = await api.perfScan();
      if ('skipped' in r) {
        setScanMessage('Already running');
      } else {
        const channelNote = r.channelDisabled > 0 ? ` · ${r.channelDisabled} channel-disabled (Server SKU)` : '';
        setScanMessage(`Scanned ${r.pcs} PCs · ${r.ok} OK · ${r.fail} fail${channelNote} · +${r.events} events (${(r.durationMs/1000).toFixed(1)}s)`);
        await refresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', overflowY: 'auto' }}>
      <div className="panel-header">
        <h2>Performance events</h2>
        <div className="panel-actions filters">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Last 24h</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value as '' | PerfCategory)}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <input
            type="text"
            placeholder="Filter computer…"
            value={computer}
            onChange={(e) => setComputer(e.target.value)}
            style={{ minWidth: 160 }}
          />
          <button className="refresh-btn" onClick={runScan} disabled={scanning}>
            {scanning ? 'Scanning…' : '▶ Run perf scan'}
          </button>
          <button className="refresh-btn" onClick={refresh}>↻ Refresh</button>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 16 }}>

        <HelpBox title={t('help.tabTitle')}>
          <p>{t('perf.help.intro')}</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>{t('perf.help.ids')}</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>{t('perf.help.serverNote')}</p>
        </HelpBox>

        {scanMessage && <div style={{ color: 'var(--ok)', fontSize: 12, marginBottom: 8 }}>✓ {scanMessage}</div>}
        {error && <div style={{ color: 'var(--critical)', fontSize: 12, marginBottom: 8 }}>⚠ {error}</div>}

        <div className="cards" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 16 }}>
          <SmallCard label="Affected PCs" value={summary?.affected_pcs ?? '—'} />
          <SmallCard label="Boot events" value={summary?.boot_count ?? '—'} />
          <SmallCard label="Shutdown events" value={summary?.shutdown_count ?? '—'} />
          <SmallCard label="Standby events" value={summary?.standby_count ?? '—'} />
          <SmallCard label="Resume events" value={summary?.resume_count ?? '—'} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Top culprits</h3>
            <table className="datatable">
              <thead>
                <tr>
                  <th>Culprit</th>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Events</th>
                  <th style={{ textAlign: 'right' }}>PCs</th>
                  <th style={{ textAlign: 'right' }}>Avg time</th>
                  <th style={{ textAlign: 'right' }}>Max time</th>
                </tr>
              </thead>
              <tbody>
                {culprits.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text-dim)' }}>no data</td></tr>}
                {culprits.map((c, i) => (
                  <tr key={i}>
                    <td title={c.culprit}>{c.culprit}</td>
                    <td>{c.category}</td>
                    <td style={{ textAlign: 'right' }}>{c.event_count}</td>
                    <td style={{ textAlign: 'right' }}>{c.pc_count}</td>
                    <td style={{ textAlign: 'right' }}>{formatMs(c.avg_total_ms)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMs(c.max_total_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Most affected PCs</h3>
            <table className="datatable">
              <thead>
                <tr>
                  <th>Computer</th>
                  <th style={{ textAlign: 'right' }}>Events</th>
                  <th style={{ textAlign: 'right' }}>Boot</th>
                  <th style={{ textAlign: 'right' }}>Shutdown</th>
                  <th style={{ textAlign: 'right' }}>Avg boot</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {topPcs.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text-dim)' }}>no data</td></tr>}
                {topPcs.map((p) => (
                  <tr key={p.name} onClick={() => setComputer(p.name)} style={{ cursor: 'pointer' }} title="Click to filter">
                    <td>{p.name}</td>
                    <td style={{ textAlign: 'right' }}>{p.event_count}</td>
                    <td style={{ textAlign: 'right' }}>{p.boot_count}</td>
                    <td style={{ textAlign: 'right' }}>{p.shutdown_count}</td>
                    <td style={{ textAlign: 'right' }}>{formatMs(p.avg_boot_ms)}</td>
                    <td>{timeAgo(p.last_event_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <h3 style={{ margin: '16px 0 8px 0', fontSize: 14 }}>Recent events {items.length > 0 && <span style={{ color: 'var(--text-dim)', fontSize: 11, fontWeight: 'normal' }}>({items.length})</span>}</h3>
        <table className="datatable">
          <thead>
            <tr>
              <th>When</th>
              <th>Computer</th>
              <th>Category</th>
              <th>Event</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th style={{ textAlign: 'right' }}>Degradation</th>
              <th>Culprit</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--text-dim)' }}>no data — run a perf scan to populate</td></tr>}
            {items.map((it) => (
              <tr key={it.id}>
                <td title={it.time_created}>{timeAgo(it.time_created)}</td>
                <td>{it.computer}</td>
                <td>{it.category}</td>
                <td>{it.event_id}</td>
                <td style={{ textAlign: 'right' }}>{formatMs(it.total_time_ms)}</td>
                <td style={{ textAlign: 'right' }}>{formatMs(it.degradation_ms)}</td>
                <td title={it.culprit_name ?? ''}>{it.culprit_friendly ?? it.culprit_name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SmallCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card info">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
