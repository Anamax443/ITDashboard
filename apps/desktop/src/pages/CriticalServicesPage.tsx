import React, { useEffect, useState } from 'react';
import type { CriticalServiceStatus } from '../api.js';
import { api, timeAgo } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { ExportMenu, type ExportColumn } from '../components/ExportMenu.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';
import { useI18n } from '../i18n.js';

const isRunning = (s: CriticalServiceStatus) => s.state === 'Running';
const isStale = (s: CriticalServiceStatus) => s.reachable === false;

export function CriticalServicesPage({ onJumpToComputer }: { onJumpToComputer?: (name: string) => void } = {}) {
  const { t } = useI18n();
  const [items, setItems] = useState<CriticalServiceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyDown, setOnlyDown] = useState(false);
  const { sort, toggle } = useSort<CriticalServiceStatus>({ col: 'service_name', dir: 'asc' });

  const refresh = () => { api.criticalServices().then((r) => setItems(r.items)).catch((e) => setError(String(e))); };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  const machines = new Set(items.map((i) => i.computer_id)).size;
  const services = new Set(items.map((i) => i.service_name)).size;
  const down = items.filter((i) => !isRunning(i));
  const downLive = down.filter((i) => !isStale(i));
  const staleCount = items.filter(isStale).length;

  const filtered = items.filter((s) => {
    if (onlyDown && isRunning(s)) return false;
    if (search) {
      const q = search.toLowerCase();
      return s.service_name.toLowerCase().includes(q)
        || (s.display_name ?? '').toLowerCase().includes(q)
        || s.computer.toLowerCase().includes(q)
        || (s.ip_address ?? '').toLowerCase().includes(q);
    }
    return true;
  });
  // Down-first, then by the active sort.
  const base = useSortedItems(filtered, sort);
  const sorted = [...base].sort((a, b) => Number(isRunning(a)) - Number(isRunning(b)));

  const exportColumns: ExportColumn<CriticalServiceStatus>[] = [
    { key: 'service_name', label: 'Service', get: (r) => r.service_name },
    { key: 'display_name', label: 'Display name', get: (r) => r.display_name ?? '' },
    { key: 'computer', label: 'Computer', get: (r) => r.computer },
    { key: 'ip_address', label: 'IP', get: (r) => r.ip_address ?? '' },
    { key: 'state', label: 'State', get: (r) => r.state },
    { key: 'start_mode', label: 'Start mode', get: (r) => r.start_mode ?? '' },
    { key: 'reachable', label: 'On network', get: (r) => (r.reachable === false ? 'no' : r.reachable === true ? 'yes' : '?') },
    { key: 'collected_at', label: 'Last check', get: (r) => r.collected_at },
  ];

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('critsvc.help')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>
          🛡 {t('critsvc.title')}{' '}
          <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
            ({services} {t('critsvc.services')} · {machines} {t('critsvc.machines')} · <span style={{ color: downLive.length > 0 ? 'var(--critical)' : 'var(--ok)', fontWeight: 700 }}>{downLive.length} {t('critsvc.down')}</span>{staleCount > 0 ? <> · <span style={{ color: 'var(--warning)' }}>{staleCount} {t('critsvc.stale')}</span></> : ''})
          </span>
        </h2>
        <div className="panel-actions filters">
          <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 280 }} />
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={onlyDown} onChange={(e) => setOnlyDown(e.target.checked)} />
            {t('critsvc.onlyDown')}
          </label>
          <ExportMenu rows={sorted} columns={exportColumns} title="ITDashboard — Kritické služby" filterSummary={[search ? `search="${search}"` : '', onlyDown ? 'only-down' : ''].filter(Boolean).join(' AND ')} filenameBase="critical-services" />
          <button className="refresh-btn" onClick={refresh}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {sorted.length === 0 ? (
          <div className="empty">{items.length === 0 ? t('critsvc.empty') : t('critsvc.noMatch')}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <SortHeader<CriticalServiceStatus> col="service_name" label="Service" sort={sort} toggle={toggle} width={200} />
                <SortHeader<CriticalServiceStatus> col="display_name" label="Display name" sort={sort} toggle={toggle} />
                <SortHeader<CriticalServiceStatus> col="computer" label="Computer" sort={sort} toggle={toggle} width={160} />
                <SortHeader<CriticalServiceStatus> col="ip_address" label="IP" sort={sort} toggle={toggle} width={110} />
                <SortHeader<CriticalServiceStatus> col="state" label="State" sort={sort} toggle={toggle} width={100} />
                <SortHeader<CriticalServiceStatus> col="start_mode" label="Start" sort={sort} toggle={toggle} width={80} />
                <SortHeader<CriticalServiceStatus> col="collected_at" label="Last check" sort={sort} toggle={toggle} width={110} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={`${s.computer_id}-${s.service_name}`}>
                  <td style={{ fontFamily: 'Consolas, monospace', fontSize: 11, fontWeight: 600 }}>{s.service_name}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{s.display_name ?? '—'}</td>
                  <td style={{ fontWeight: 600 }}>
                    {onJumpToComputer ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(s.computer); }} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{s.computer}</a>
                    ) : s.computer}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'Consolas, monospace' }}>{s.ip_address ?? '—'}</td>
                  <td>
                    <span style={{ color: isRunning(s) ? 'var(--ok)' : 'var(--critical)', fontSize: 11, fontWeight: 700 }}>
                      {isRunning(s) ? '● ' : '○ '}{s.state}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{s.start_mode ?? '—'}</td>
                  <td style={{ color: isStale(s) ? 'var(--warning)' : 'var(--text-dim)', fontSize: 11 }} title={isStale(s) ? t('critsvc.staleTip') : ''}>
                    {timeAgo(s.collected_at)}{isStale(s) ? ` · ${t('critsvc.offline')}` : ''}
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
