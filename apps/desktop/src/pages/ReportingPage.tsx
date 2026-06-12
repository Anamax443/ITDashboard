import React, { useEffect, useMemo, useState } from 'react';
import type { OverviewReport, ReportMachine } from '../api.js';
import { api, timeAgo } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { ExportMenu, type ExportColumn } from '../components/ExportMenu.js';
import { useI18n, type TKey } from '../i18n.js';

type Filter = 'all' | 'servers' | 'pcs' | 'online' | 'offline' | 'monitored' | 'failing';

function sinceText(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

function passesFilter(m: ReportMachine, f: Filter): boolean {
  switch (f) {
    case 'servers': return m.kind === 'server';
    case 'pcs': return m.kind === 'pc';
    case 'online': return m.status === 'active';
    case 'offline': return m.status === 'offline';
    case 'monitored': return m.monitored;
    case 'failing': return m.consecutiveFailures > 0;
    default: return true;
  }
}

export function ReportingPage({ onJumpToComputer }: { onJumpToComputer?: (name: string) => void } = {}) {
  const { t } = useI18n();
  const [rep, setRep] = useState<OverviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = () => { api.reportOverview().then(setRep).catch((e) => setError(String(e))); };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rep?.machines ?? [])
      .filter((m) => passesFilter(m, filter))
      .filter((m) => !q || m.name.toLowerCase().includes(q) || (m.ip ?? '').toLowerCase().includes(q) || (m.os ?? '').toLowerCase().includes(q));
  }, [rep, filter, search]);

  const visibleNames = visible.map((m) => m.name);
  const allVisibleSelected = visible.length > 0 && visibleNames.every((n) => selected.has(n));

  const toggle = (name: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const selectAllVisible = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allVisibleSelected) visibleNames.forEach((n) => next.delete(n));
    else visibleNames.forEach((n) => next.add(n));
    return next;
  });
  const clearSel = () => setSelected(new Set());

  const exportColumns: ExportColumn<ReportMachine>[] = [
    { key: 'name', label: 'Machine', get: (r) => r.name },
    { key: 'ip', label: 'IP', get: (r) => r.ip ?? '' },
    { key: 'kind', label: 'Type', get: (r) => r.kind },
    { key: 'status', label: 'Status', get: (r) => r.status },
    { key: 'os', label: 'OS', get: (r) => r.os ?? '' },
    { key: 'monitored', label: 'Monitored', get: (r) => (r.monitored ? 'yes' : 'no') },
    { key: 'lastSeen', label: 'Last seen', get: (r) => r.lastSeen ?? '' },
    { key: 'lastReachableAt', label: 'Last reachable', get: (r) => r.lastReachableAt ?? '' },
    { key: 'consecutiveFailures', label: 'Collect failures', get: (r) => r.consecutiveFailures },
  ];

  const t0 = rep?.totals;
  // Email targets: the checked rows, or — when nothing is checked — everything
  // currently visible (respecting the active filter + search).
  const emailNames = selected.size > 0 ? visibleNames.filter((n) => selected.has(n)) : visibleNames;
  const emailCount = selected.size > 0 ? [...selected].length : visible.length;

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('reporting.help')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>
          📋 {t('reporting.title')}{' '}
          {t0 && (
            <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
              ({t0.total} {t('reporting.machines')} · <span style={{ color: t0.offline > 0 ? 'var(--critical)' : 'var(--ok)', fontWeight: 700 }}>{t0.offline} offline</span>)
            </span>
          )}
        </h2>
        <div className="panel-actions filters">
          <input type="text" placeholder={t('reporting.search')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
          <button onClick={selectAllVisible} title={t('reporting.selectAllHint')}>{allVisibleSelected ? t('reporting.clearVisible') : t('reporting.selectAll')}</button>
          {selected.size > 0 && <button onClick={clearSel}>{t('reporting.clear')} ({selected.size})</button>}
          <SendReportButton names={emailNames} count={emailCount} usingSelection={selected.size > 0} />
          <ExportMenu rows={visible} columns={exportColumns} title="ITDashboard — Reporting" filterSummary={[filter !== 'all' ? filter : '', search ? `search="${search}"` : ''].filter(Boolean).join(' AND ')} filenameBase="fleet-overview" />
          <button className="refresh-btn" onClick={refresh}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {!rep || !t0 ? (
          <div className="empty">…</div>
        ) : (
          <div style={{ padding: 12 }}>
            <StatRow totals={t0} active={filter} onPick={setFilter} />

            {visible.length === 0 ? (
              <div className="empty">{t('reporting.noMatch')}</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 28, textAlign: 'center' }}>
                      <input type="checkbox" checked={allVisibleSelected} onChange={selectAllVisible} title={t('reporting.selectAllHint')} />
                    </th>
                    <th style={{ textAlign: 'left', width: 180 }}>{t('reporting.col.machine')}</th>
                    <th style={{ textAlign: 'left', width: 120 }}>{t('reporting.col.ip')}</th>
                    <th style={{ textAlign: 'left', width: 70 }}>{t('reporting.col.type')}</th>
                    <th style={{ textAlign: 'left', width: 100 }}>{t('reporting.col.status')}</th>
                    <th style={{ textAlign: 'left' }}>{t('reporting.col.os')}</th>
                    <th style={{ textAlign: 'left', width: 150 }}>{t('reporting.col.last')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((m) => (
                    <tr key={m.name} style={selected.has(m.name) ? { background: 'var(--surface-hover)' } : undefined}>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={selected.has(m.name)} onChange={() => toggle(m.name)} />
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {onJumpToComputer ? (
                          <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(m.name); }} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{m.name}</a>
                        ) : m.name}
                      </td>
                      <td style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'Consolas, monospace' }}>{m.ip ?? '—'}</td>
                      <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{m.kind === 'server' ? t('reporting.type.server') : 'PC'}</td>
                      <td>
                        <span style={{ color: m.status === 'offline' ? 'var(--critical)' : 'var(--ok)', fontSize: 11, fontWeight: 700 }}>
                          {m.status === 'offline' ? '○ ' : '● '}{t(`reporting.status.${m.status}` as TKey)}
                        </span>
                        {m.consecutiveFailures > 0 && <span style={{ color: 'var(--warning)', fontSize: 11 }} title={t('reporting.failingTip')}> ⚠</span>}
                      </td>
                      <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{m.os ?? '—'}</td>
                      <td style={{ color: m.status === 'offline' ? 'var(--critical)' : 'var(--text-dim)', fontSize: 11 }}>
                        {m.status === 'offline'
                          ? `offline ${sinceText(m.lastReachableAt)}`
                          : (m.lastSeen ? `${t('reporting.lastSeen')} ${timeAgo(m.lastSeen)}` : '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatRow({ totals, active, onPick }: { totals: OverviewReport['totals']; active: Filter; onPick: (f: Filter) => void }) {
  const { t } = useI18n();
  const cell = (label: string, val: number, filter: Filter | null, color?: string) => {
    const isActive = filter !== null && filter === active;
    return (
      <div
        onClick={filter ? () => onPick(filter === active && filter !== 'all' ? 'all' : filter) : undefined}
        style={{
          textAlign: 'center', minWidth: 78, padding: '4px 8px', borderRadius: 6,
          cursor: filter ? 'pointer' : 'default',
          background: isActive ? 'var(--surface-hover)' : 'transparent',
          border: isActive ? '1px solid var(--accent)' : '1px solid transparent',
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 700, color: color ?? 'var(--text)' }}>{val}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '4px 2px 16px', alignItems: 'flex-end' }}>
      {cell(t('reporting.stat.total'), totals.total, 'all')}
      {cell(t('reporting.stat.servers'), totals.servers, 'servers')}
      {cell(t('reporting.stat.pcs'), totals.pcs, 'pcs')}
      {cell(t('reporting.stat.active'), totals.active, 'online', 'var(--ok)')}
      {cell(t('reporting.stat.offline'), totals.offline, 'offline', totals.offline > 0 ? 'var(--critical)' : 'var(--ok)')}
      {cell(t('reporting.stat.disabled'), totals.disabled, null, 'var(--text-dim)')}
      {cell(t('reporting.stat.monitored'), totals.monitored, 'monitored')}
      {cell(t('reporting.stat.failing'), totals.failing, 'failing', totals.failing > 0 ? 'var(--warning)' : 'var(--text)')}
    </div>
  );
}

function SendReportButton({ names, count, usingSelection }: { names: string[]; count: number; usingSelection: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await api.sendReportEmail(names);
      setMsg(t('reporting.sendOk', { recipients: r.recipients, total: r.total, offline: r.offline }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={send}
        disabled={busy || count === 0}
        title={usingSelection ? t('reporting.sendSelectedHint') : t('reporting.sendVisibleHint')}
        style={{ cursor: busy || count === 0 ? 'default' : 'pointer' }}
      >
        {busy ? t('reporting.sending') : `✉ ${t('reporting.sendEmail')} (${count})`}
      </button>
      {msg && <span style={{ color: 'var(--ok)', fontSize: 11 }}>{msg}</span>}
      {err && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {err}</span>}
    </span>
  );
}
