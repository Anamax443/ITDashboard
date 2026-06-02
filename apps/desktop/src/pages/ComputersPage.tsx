import React, { useEffect, useState } from 'react';
import type { ComputerItem as CI, SyncResult, AdSyncRun, DiskItem } from '../api.js';
type ComputerItem = CI;
import { api, timeAgo, parseDiskThresholds } from '../api.js';
import { DisksCell } from '../components/DiskBar.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';

export function ComputersPage({ items, onRefreshLocal }: { items: ComputerItem[]; onRefreshLocal: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [lastSyncRun, setLastSyncRun] = useState<AdSyncRun | null>(null);
  const [history, setHistory] = useState<AdSyncRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [disks, setDisks] = useState<DiskItem[]>([]);
  const [diskSettings, setDiskSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    api.lastSync().then((r) => setLastSyncRun(r.last)).catch(() => {});
    api.syncHistory().then((r) => setHistory(r.items)).catch(() => {});
    api.disks().then((r) => setDisks(r.items)).catch(() => {});
    api.settings().then(setDiskSettings).catch(() => {});
  }, []);

  const thresholds = parseDiskThresholds(diskSettings);
  const disksByComputer = new Map<number, DiskItem[]>();
  for (const d of disks) {
    if (!disksByComputer.has(d.computer_id)) disksByComputer.set(d.computer_id, []);
    disksByComputer.get(d.computer_id)!.push(d);
  }

  const triggerDiskScan = async () => {
    setError(null);
    try {
      await api.disksCollect();
      const r = await api.disks();
      setDisks(r.items);
    } catch (err) {
      setError(String(err));
    }
  };
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'disabled'>('');
  const { sort, toggle } = useSort<ComputerItem>({ col: 'name', dir: 'asc' });

  const runSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await api.syncComputers();
      setLastSync(result);
      onRefreshLocal();
      // Refresh history
      const last = await api.lastSync();
      setLastSyncRun(last.last);
      const hist = await api.syncHistory();
      setHistory(hist.items);
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  };

  const filtered = items.filter((c) => {
    if (statusFilter === 'active' && !c.enabled) return false;
    if (statusFilter === 'disabled' && c.enabled) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !c.name.toLowerCase().includes(q) &&
        !(c.fqdn ?? '').toLowerCase().includes(q) &&
        !(c.os_version ?? '').toLowerCase().includes(q) &&
        !(c.ou_path ?? '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  const sorted = useSortedItems(filtered, sort);
  const enabled = items.filter((c) => c.enabled);
  const disabled = items.filter((c) => !c.enabled);
  const monitored = items.filter((c) => c.enabled && c.monitor_enabled).length;

  const toggleMonitor = async (c: ComputerItem) => {
    try {
      await api.setMonitor(c.id, !c.monitor_enabled);
      onRefreshLocal();
    } catch (err) {
      setError(String(err));
    }
  };

  const bulkSetMonitor = async (monitor: boolean) => {
    // Apply to ALL currently visible (filtered) rows — incl. disabled,
    // because the operator's choice should persist if PC reactivates later.
    const targetIds = sorted.map((c) => c.id);
    if (targetIds.length === 0) return;
    try {
      const result = await api.setMonitorBulk(targetIds, monitor);
      setError(null);
      onRefreshLocal();
      return result;
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div className="panel-header">
        <h2>Computers ({enabled.length} active · {monitored} monitored · {disabled.length} disabled)</h2>
        <div className="panel-actions filters">
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 160 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'active' | 'disabled' | '')}>
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
          {(lastSync || lastSyncRun) && (
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              {lastSync ? (
                <>Last sync: fetched {lastSync.fetched}, +{lastSync.inserted} new, {lastSync.updated} updated, {lastSync.removed} disabled ({(lastSync.durationMs / 1000).toFixed(1)}s)</>
              ) : lastSyncRun ? (
                <>Last sync: {timeAgo(lastSyncRun.finished_at ?? lastSyncRun.started_at)} ({lastSyncRun.fetched ?? '?'} fetched, +{lastSyncRun.inserted ?? 0} new)</>
              ) : null}
            </span>
          )}
          <button className="refresh-btn" onClick={() => bulkSetMonitor(true)} title="Enable monitoring for all visible active PCs">
            ✓ All
          </button>
          <button className="refresh-btn" onClick={() => bulkSetMonitor(false)} title="Disable monitoring for all visible active PCs">
            ✗ None
          </button>
          <button className="refresh-btn" onClick={triggerDiskScan} title="Scan disk space on all monitored PCs">
            💾 Scan disks
          </button>
          <button className="refresh-btn" onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide history' : 'History'}
          </button>
          {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          <button className="refresh-btn" onClick={runSync} disabled={syncing} style={{ minWidth: 130 }}>
            {syncing ? 'Syncing…' : '↻ Sync from AD'}
          </button>
        </div>
      </div>
      {showHistory && (
        <div style={{ padding: '8px 12px', background: 'var(--bg)', borderBottom: '1px solid var(--border)', maxHeight: 200, overflowY: 'auto' }}>
          <table style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th>Time</th><th>Source</th><th>Fetched</th><th>+New</th><th>Updated</th><th>Disabled</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{new Date(h.started_at).toLocaleString('cs-CZ')}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{h.trigger_source}</td>
                  <td>{h.fetched ?? '—'}</td>
                  <td style={{ color: 'var(--ok)' }}>+{h.inserted ?? 0}</td>
                  <td>{h.updated ?? 0}</td>
                  <td>{h.removed ?? 0}</td>
                  <td style={{ color: h.error ? 'var(--critical)' : 'var(--ok)' }} title={h.error ?? ''}>
                    {h.error ? '✗ Error' : h.finished_at ? '✓ OK' : '… running'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-body">
        {sorted.length === 0 ? (
          <div className="empty">{items.length === 0 ? 'No computers registered. Click "Sync from AD" to import.' : 'No computers match your filters.'}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th style={{ width: 70, textAlign: 'center' }} title="Collect events from this PC">Monitor</th>
                <SortHeader<ComputerItem> col="name" label="Name" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="ou_path" label="OU path" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="fqdn" label="FQDN" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="os_version" label="OS" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="last_seen" label="Last seen" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="enabled" label="Status" sort={sort} toggle={toggle} />
                <th style={{ width: 160 }}>Disks</th>
                <th style={{ width: 120 }}>Last collected</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                  <td>{c.enabled ? '🟢' : '⚪'}</td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={c.monitor_enabled}
                      onChange={() => toggleMonitor(c)}
                      title={c.enabled
                        ? (c.monitor_enabled ? 'Click to stop monitoring' : 'Click to start monitoring')
                        : 'PC is currently disabled in AD — monitoring will activate when it reappears'}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }} title={c.distinguished_name ?? ''}>{c.ou_path ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{c.fqdn ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{c.os_version ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{timeAgo(c.last_seen)}</td>
                  <td style={{ color: c.enabled ? 'var(--ok)' : 'var(--text-dim)', fontSize: 11 }}>
                    {c.enabled ? 'Active' : 'Disabled'}
                  </td>
                  <td><DisksCell disks={disksByComputer.get(c.id) ?? []} thresholds={thresholds} /></td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{timeAgo(c.last_collected_at ?? null)}</td>
                  <td style={{ color: c.last_error ? 'var(--critical)' : 'var(--text-dim)', fontSize: 11, maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.last_error ?? ''}>
                    {c.last_error ?? '—'}
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
