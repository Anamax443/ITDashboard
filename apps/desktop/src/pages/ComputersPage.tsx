import React, { useEffect, useState } from 'react';
import type { ComputerItem as CI, SyncResult, AdSyncRun, DiskItem } from '../api.js';
type ComputerItem = CI;
import { api, timeAgo, parseDiskThresholds, evaluateDiskWithScope, osBucket, isStaleComputer, OS_UNKNOWN, OS_OTHER } from '../api.js';
import { DisksCell } from '../components/DiskBar.js';
import { HelpBox } from '../components/HelpBox.js';
import { UserHistoryModal } from '../components/UserHistoryModal.js';
import { PcActionsButton } from '../components/PcActions.js';
import { ExportMenu, type ExportColumn } from '../components/ExportMenu.js';
import { useI18n } from '../i18n.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';

export function ComputersPage({ items, onRefreshLocal, initialFilter, onFilterConsumed, inactiveThresholdDays, initialSearch, onSearchPrefillConsumed, initialOsFilter, onOsFilterConsumed, initialIdFilter, onIdFilterConsumed }: { items: ComputerItem[]; onRefreshLocal: () => void; initialFilter?: 'disk-critical' | 'disk-warning' | 'disk-email' | 'service-email' | 'failing' | 'inactive' | null; onFilterConsumed?: () => void; inactiveThresholdDays?: number; initialSearch?: string | null; onSearchPrefillConsumed?: () => void; initialOsFilter?: { bucket: string; stale: boolean | null } | null; onOsFilterConsumed?: () => void; initialIdFilter?: { ids: number[]; label: string } | null; onIdFilterConsumed?: () => void }) {
  const { t } = useI18n();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [lastSyncRun, setLastSyncRun] = useState<AdSyncRun | null>(null);
  const [history, setHistory] = useState<AdSyncRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userHistoryFor, setUserHistoryFor] = useState<{ id: number; name: string } | null>(null);

  const [disks, setDisks] = useState<DiskItem[]>([]);
  const [diskSettings, setDiskSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    api.lastSync().then((r) => setLastSyncRun(r.last)).catch(() => {});
    api.syncHistory().then((r) => setHistory(r.items)).catch(() => {});
    api.disks().then((r) => setDisks(r.items)).catch(() => {});
    api.settings().then(setDiskSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialFilter) {
      setStatusFilter(initialFilter);
      setOsFilter(null);
      setIdFilter(null);
      onFilterConsumed?.();
    }
  }, [initialFilter, onFilterConsumed]);

  useEffect(() => {
    if (initialSearch) {
      setSearch(initialSearch);
      // Clear status pre-filter when jumping by name from another tab —
      // operator wants to see THIS PC regardless of its disk/inactive state.
      setStatusFilter('');
      setOsFilter(null);
      setIdFilter(null);
      onSearchPrefillConsumed?.();
    }
  }, [initialSearch, onSearchPrefillConsumed]);

  useEffect(() => {
    if (initialOsFilter) {
      setOsFilter(initialOsFilter);
      // OS drill-down owns the view: drop any status/search filter so the
      // numbers match the Dashboard chart segment that was clicked.
      setStatusFilter('');
      setSearch('');
      setIdFilter(null);
      onOsFilterConsumed?.();
    }
  }, [initialOsFilter, onOsFilterConsumed]);

  useEffect(() => {
    if (initialIdFilter) {
      setIdFilter(initialIdFilter);
      // Explicit PC-set drill-down (e.g. reinstall candidates) owns the view.
      setStatusFilter('');
      setOsFilter(null);
      setSearch('');
      onIdFilterConsumed?.();
    }
  }, [initialIdFilter, onIdFilterConsumed]);

  const thresholds = parseDiskThresholds(diskSettings);
  const disksByComputer = new Map<number, DiskItem[]>();
  for (const d of disks) {
    if (!disksByComputer.has(d.computer_id)) disksByComputer.set(d.computer_id, []);
    disksByComputer.get(d.computer_id)!.push(d);
  }

  const [diskScanState, setDiskScanState] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [diskScanResult, setDiskScanResult] = useState<{ ok: number; fail: number; drives: number; durationMs: number } | null>(null);

  const triggerDiskScan = async () => {
    setError(null);
    setDiskScanState('scanning');
    try {
      const result = await api.disksCollect();
      setDiskScanResult({ ok: result.ok, fail: result.fail, drives: result.drives, durationMs: result.durationMs });
      setDiskScanState('done');
      const r = await api.disks();
      setDisks(r.items);
      setTimeout(() => setDiskScanState('idle'), 10000);
    } catch (err) {
      setError(String(err));
      setDiskScanState('idle');
    }
  };
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'disabled' | 'monitored' | 'unmonitored' | 'failing' | 'offline' | 'disk-critical' | 'disk-warning' | 'disk-email' | 'service-email' | 'excluded' | 'inactive'>('');
  // OS drill-down from the Dashboard chart: filter to one OS bucket, optionally
  // restricted to live (stale=false) or stale (stale=true) machines.
  const [osFilter, setOsFilter] = useState<{ bucket: string; stale: boolean | null } | null>(null);
  // Drill-down to an explicit PC set (e.g. reinstall candidates from the Dashboard).
  const [idFilter, setIdFilter] = useState<{ ids: number[]; label: string } | null>(null);

  // Status chips and the OS / id drill-downs are mutually exclusive: picking a
  // status chip clears them so filters never silently stack.
  useEffect(() => {
    if (statusFilter !== '') { setOsFilter(null); setIdFilter(null); }
  }, [statusFilter]);
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

  // Map computers → worst disk status
  const worstDiskByComputer = new Map<number, 'critical' | 'warning' | 'ok'>();
  for (const d of disks) {
    // Per-tier drive-letter scope: a drive is checked for critical thresholds
    // only if in critScope, and checked for warning thresholds only if in
    // warnScope. Typical setup: critScope = "C" (system), warnScope = "<>C"
    // (everything else). Drives outside BOTH scopes are inert for the PC
    // status (they still appear in the Disks column for situational awareness).
    const s = evaluateDiskWithScope(d, thresholds);
    const cur = worstDiskByComputer.get(d.computer_id);
    const rank = { critical: 3, warning: 2, ok: 1 };
    if (!cur || rank[s] > rank[cur]) worstDiskByComputer.set(d.computer_id, s);
  }

  const osThreshold = inactiveThresholdDays ?? 90;
  const filtered = items.filter((c) => {
    // Explicit PC-set drill-down (reinstall candidates etc.).
    if (idFilter && !idFilter.ids.includes(c.id)) return false;
    // OS drill-down from the Dashboard chart. Mirror the chart scope exactly:
    // live managed fleet only (enabled, not excluded), same OS bucket, and the
    // requested staleness (null = both live and stale).
    if (osFilter) {
      if (!c.enabled || c.excluded) return false;
      if (osBucket(c.os_version) !== osFilter.bucket) return false;
      if (osFilter.stale !== null && isStaleComputer(c, osThreshold) !== osFilter.stale) return false;
    }
    // Hide excluded by default unless filter is set to 'excluded'
    if (statusFilter !== 'excluded' && c.excluded) return false;
    if (statusFilter === 'excluded' && !c.excluded) return false;
    if (statusFilter === 'active' && !c.enabled) return false;
    if (statusFilter === 'disabled' && c.enabled) return false;
    if (statusFilter === 'monitored' && (!c.enabled || !c.monitor_enabled)) return false;
    if (statusFilter === 'unmonitored' && (!c.enabled || c.monitor_enabled)) return false;
    if (statusFilter === 'failing' && (!c.enabled || (c.consecutive_failures ?? 0) === 0)) return false;
    if (statusFilter === 'offline' && !(c.enabled && !c.excluded && c.reachable === false)) return false;
    if (statusFilter === 'disk-critical' && worstDiskByComputer.get(c.id) !== 'critical') return false;
    if (statusFilter === 'disk-warning' && worstDiskByComputer.get(c.id) !== 'warning') return false;
    if (statusFilter === 'disk-email' && !c.disk_email_monitor) return false;
    if (statusFilter === 'service-email' && !c.service_email_monitor) return false;
    if (statusFilter === 'inactive') {
      if (c.excluded) return false;
      const t = inactiveThresholdDays ?? 90;
      const cutoff = Date.now() - t * 86400000;
      const seenMs = c.last_seen ? new Date(c.last_seen).getTime() : null;
      if (seenMs !== null && seenMs >= cutoff) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (
        !c.name.toLowerCase().includes(q) &&
        !(c.fqdn ?? '').toLowerCase().includes(q) &&
        !(c.os_version ?? '').toLowerCase().includes(q) &&
        !(c.ou_path ?? '').toLowerCase().includes(q) &&
        !(c.ip_address ?? '').toLowerCase().includes(q) &&
        !(c.current_user ?? '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  const sorted = useSortedItems(filtered, sort);
  const enabled = items.filter((c) => c.enabled);
  const disabled = items.filter((c) => !c.enabled);

  // Export filter summary + columns
  const filterParts: string[] = [];
  if (search) filterParts.push(`search="${search}"`);
  if (statusFilter) filterParts.push(`status=${statusFilter}`);
  if (osFilter) filterParts.push(`os=${osFilter.bucket}${osFilter.stale === null ? '' : osFilter.stale ? ':stale' : ':live'}`);
  const filterSummary = filterParts.join(' AND ');
  const exportColumns: ExportColumn<ComputerItem>[] = [
    { key: 'name', label: 'Name', get: (r) => r.name },
    { key: 'fqdn', label: 'FQDN', get: (r) => r.fqdn ?? '' },
    { key: 'ip_address', label: 'IP', get: (r) => r.ip_address ?? '' },
    { key: 'os_version', label: 'OS', get: (r) => r.os_version ?? '' },
    { key: 'current_user', label: 'User', get: (r) => r.current_user ?? '' },
    { key: 'enabled', label: 'Enabled', get: (r) => r.enabled ? 'yes' : 'no' },
    { key: 'monitor_enabled', label: 'Monitor', get: (r) => r.monitor_enabled ? 'yes' : 'no' },
    { key: 'last_status', label: 'Status', get: (r) => r.last_status ?? '' },
    { key: 'last_seen', label: 'Last seen', get: (r) => r.last_seen ?? '' },
    { key: 'consecutive_failures', label: 'Fails', get: (r) => r.consecutive_failures ?? 0 },
    { key: 'last_collected_at', label: 'Last collected', get: (r) => r.last_collected_at ?? '' },
    { key: 'ou_path', label: 'OU', get: (r) => r.ou_path ?? '' },
  ];
  const monitored = items.filter((c) => c.enabled && !c.excluded && c.monitor_enabled).length;
  const unmonitored = items.filter((c) => c.enabled && !c.excluded && !c.monitor_enabled).length;
  const failing = items.filter((c) => c.enabled && !c.excluded && (c.consecutive_failures ?? 0) > 0).length;
  const offlineCount = items.filter((c) => c.enabled && !c.excluded && c.reachable === false).length;
  const excludedCount = items.filter((c) => c.excluded).length;
  const inactiveThreshold = inactiveThresholdDays ?? 90;
  const inactiveCutoff = Date.now() - inactiveThreshold * 86400000;
  const inactiveCount = items.filter((c) => {
    if (c.excluded) return false;
    const seenMs = c.last_seen ? new Date(c.last_seen).getTime() : null;
    return seenMs === null || seenMs < inactiveCutoff;
  }).length;

  const toggleMonitor = async (c: ComputerItem) => {
    try {
      await api.setMonitor(c.id, !c.monitor_enabled);
      onRefreshLocal();
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleExcluded = async (c: ComputerItem) => {
    try {
      await api.setExcluded(c.id, !c.excluded);
      onRefreshLocal();
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleServiceEmailMonitor = async (c: ComputerItem) => {
    try {
      await api.setServiceEmailMonitor(c.id, !c.service_email_monitor);
      onRefreshLocal();
    } catch (err) {
      setError(String(err));
    }
  };


  // Bulk-toggle a per-PC flag for ALL currently visible (filtered) rows.
  const bulkSetFlag = async (flag: 'disk_email_monitor' | 'service_email_monitor' | 'excluded', value: boolean) => {
    const targetIds = sorted.map((c) => c.id);
    if (targetIds.length === 0) return;
    try {
      await api.bulkSetFlag(targetIds, flag, value);
      setError(null);
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
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('computers.help.intro')}</p>
          <p>{t('computers.help.chips')}</p>
          <p>{t('computers.help.monitor')}</p>
          <p>{t('computers.help.actions')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>Computers</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>({items.length} total · {sorted.length} shown)</span>
          {osFilter && (
            <span
              onClick={() => setOsFilter(null)}
              title={t('os.clickFilter')}
              style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'var(--accent)', color: '#fff' }}
            >
              {t('os.filterLabel')}: {osFilter.bucket === OS_UNKNOWN ? t('os.unknown') : osFilter.bucket === OS_OTHER ? t('os.other') : osFilter.bucket}
              {osFilter.stale !== null && <span style={{ opacity: 0.85, fontWeight: 600 }}>· {osFilter.stale ? t('os.stale') : t('os.live')}</span>}
              <span style={{ opacity: 0.9 }}>✕</span>
            </span>
          )}
          {idFilter && (
            <span
              onClick={() => setIdFilter(null)}
              title={t('os.clickFilter')}
              style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'var(--critical)', color: '#fff' }}
            >
              🩺 {idFilter.label} ({idFilter.ids.length})
              <span style={{ opacity: 0.9 }}>✕</span>
            </span>
          )}
          <StatusChip label="active" count={enabled.length} active={statusFilter === 'active'} color="var(--ok)" onClick={() => setStatusFilter(statusFilter === 'active' ? '' : 'active')} />
          <StatusChip label="monitored" count={monitored} active={statusFilter === 'monitored'} color="var(--accent)" onClick={() => setStatusFilter(statusFilter === 'monitored' ? '' : 'monitored')} />
          <StatusChip label="unmonitored" count={unmonitored} active={statusFilter === 'unmonitored'} color="var(--warning)" onClick={() => setStatusFilter(statusFilter === 'unmonitored' ? '' : 'unmonitored')} />
          <StatusChip label="failing" count={failing} active={statusFilter === 'failing'} color="var(--critical)" onClick={() => setStatusFilter(statusFilter === 'failing' ? '' : 'failing')} />
          <StatusChip label="offline" count={offlineCount} active={statusFilter === 'offline'} color="var(--text-dim)" onClick={() => setStatusFilter(statusFilter === 'offline' ? '' : 'offline')} />
          <StatusChip label="disk critical" count={Array.from(worstDiskByComputer.values()).filter((s) => s === 'critical').length} active={statusFilter === 'disk-critical'} color="var(--critical)" onClick={() => setStatusFilter(statusFilter === 'disk-critical' ? '' : 'disk-critical')} />
          <StatusChip label="disk warning" count={Array.from(worstDiskByComputer.values()).filter((s) => s === 'warning').length} active={statusFilter === 'disk-warning'} color="var(--warning)" onClick={() => setStatusFilter(statusFilter === 'disk-warning' ? '' : 'disk-warning')} />
          <StatusChip label="📧 disk" count={items.filter((c) => c.disk_email_monitor).length} active={statusFilter === 'disk-email'} color="var(--accent)" onClick={() => setStatusFilter(statusFilter === 'disk-email' ? '' : 'disk-email')} />
          <StatusChip label="🔔 svc" count={items.filter((c) => c.service_email_monitor).length} active={statusFilter === 'service-email'} color="var(--accent)" onClick={() => setStatusFilter(statusFilter === 'service-email' ? '' : 'service-email')} />
          <StatusChip label={`inactive ${inactiveThreshold}d+`} count={inactiveCount} active={statusFilter === 'inactive'} color="var(--warning)" onClick={() => setStatusFilter(statusFilter === 'inactive' ? '' : 'inactive')} />
          <StatusChip label="disabled" count={disabled.length} active={statusFilter === 'disabled'} color="var(--text-dim)" onClick={() => setStatusFilter(statusFilter === 'disabled' ? '' : 'disabled')} />
          <StatusChip label="excluded" count={excludedCount} active={statusFilter === 'excluded'} color="var(--text-dim)" onClick={() => setStatusFilter(statusFilter === 'excluded' ? '' : 'excluded')} />
        </h2>
        <div className="panel-actions filters">
          <input
            type="text"
            placeholder="Search… (AND default, OR / -exclude / &quot;phrase&quot;)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 320 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="">All status</option>
            <option value="active">Active (in AD)</option>
            <option value="disabled">Disabled (gone from AD)</option>
            <option value="monitored">Monitored</option>
            <option value="unmonitored">Unmonitored</option>
            <option value="failing">Failing collector</option>
            <option value="offline">Offline (off network)</option>
            <option value="disk-critical">Disk critical</option>
            <option value="disk-warning">Disk warning</option>
            <option value="disk-email">📧 Disk monitored</option>
            <option value="service-email">🔔 Service monitored</option>
            <option value="inactive">Inactive ({inactiveThreshold}d+)</option>
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
          {diskScanState === 'scanning' && (
            <span style={{ color: 'var(--accent)', fontSize: 11 }}>● Scanning disks…</span>
          )}
          {diskScanState === 'done' && diskScanResult && (
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              <span style={{ color: 'var(--ok)' }}>{diskScanResult.ok} OK</span>
              {diskScanResult.fail > 0 && <> · <span style={{ color: 'var(--critical)' }}>{diskScanResult.fail} fail</span></>}
              {' · '}{diskScanResult.drives} drives ({(diskScanResult.durationMs / 1000).toFixed(1)}s)
            </span>
          )}
          <button className="refresh-btn" onClick={triggerDiskScan} disabled={diskScanState === 'scanning'} title="Scan disk space on all monitored PCs">
            {diskScanState === 'scanning' ? '…' : '🩺 Scan disks'}
          </button>
          <button className="refresh-btn" onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide history' : 'History'}
          </button>
          {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          <button className="refresh-btn" onClick={runSync} disabled={syncing} style={{ minWidth: 130 }}>
            {syncing ? 'Syncing…' : '↻ Sync from AD'}
          </button>
          <ExportMenu rows={sorted} columns={exportColumns} title="ITDashboard — Počítače" filterSummary={filterSummary} filenameBase="computers" />
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
                <th style={{ width: 70, textAlign: 'center' }} title="Permanently exclude from all stats and views">Exclude<BulkToggle onAll={() => bulkSetFlag('excluded', true)} onNone={() => bulkSetFlag('excluded', false)} /></th>
                <th style={{ width: 112, textAlign: 'center' }} title={t('computers.diskEmail.title')}>📧 Disk<BulkToggle onAll={() => bulkSetFlag('disk_email_monitor', true)} onNone={() => bulkSetFlag('disk_email_monitor', false)} /></th>
                <th style={{ width: 64, textAlign: 'center' }} title={t('computers.svcEmail.title')}>🔔 Služby<BulkToggle onAll={() => bulkSetFlag('service_email_monitor', true)} onNone={() => bulkSetFlag('service_email_monitor', false)} /></th>
                <SortHeader<ComputerItem> col="name" label="Name" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="ou_path" label="OU path" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="fqdn" label="FQDN" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="os_version" label="OS" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="ip_address" label="IP" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="current_user" label="User" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="last_seen" label="Last seen" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="last_status" label="Status" sort={sort} toggle={toggle} />
                <th style={{ width: 160 }}>Disks</th>
                <th style={{ width: 120 }}>Last collected</th>
                <th>Last error</th>
                <th style={{ width: 90 }}>{t('actions.title')}</th>
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
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={c.excluded}
                      onChange={() => toggleExcluded(c)}
                      title={c.excluded ? 'Excluded — click to re-include in stats' : 'Click to exclude from all dashboards and stats'}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <DiskEmailCell c={c} onSaved={onRefreshLocal} onError={setError} />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!c.service_email_monitor}
                      onChange={() => toggleServiceEmailMonitor(c)}
                      title={t('computers.svcEmail.toggle')}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    <span
                      onClick={() => setUserHistoryFor({ id: c.id, name: c.name })}
                      style={{ cursor: 'pointer', borderBottom: '1px dotted var(--accent)' }}
                      title="Click for login history"
                    >{c.name}</span>
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }} title={c.distinguished_name ?? ''}>{c.ou_path ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{c.fqdn ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{c.os_version ?? '—'}</td>
                  <td
                    style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'Consolas, monospace' }}
                    title={c.pc_info_collected_at ? `Collected ${timeAgo(c.pc_info_collected_at)}` : ''}
                  >{c.ip_address ?? '—'}</td>
                  <td
                    style={{ color: 'var(--text-dim)', fontSize: 11 }}
                    title={c.current_user_seen_at ? `Last seen logged in: ${timeAgo(c.current_user_seen_at)}` : ''}
                  >{c.current_user ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{timeAgo(c.last_seen)}</td>
                  <td style={{ fontSize: 11 }}>
                    {(() => {
                      // Status now means LIVE network reachability (TCP probe),
                      // not "did the event-log collector succeed":
                      //   Disabled = AD account disabled
                      //   Active   = reachable on the network now
                      //   Offline  = not reachable (powered off / disconnected)
                      // The event-log collector's struggle is a secondary marker
                      // ("logs") shown next to Active when the box is up but its
                      // event log can't be read (permissions / RPC).
                      if (!c.enabled) return <span style={{ color: 'var(--text-dim)' }}>Disabled</span>;
                      const logsFailing = c.last_status === 'access_denied'
                        || c.last_status === 'rpc_unavailable'
                        || c.last_status === 'unknown'
                        || ((c.consecutive_failures ?? 0) > 0);
                      if (c.reachable === true) return (
                        <span style={{ color: 'var(--ok)' }}>● Active{logsFailing && (
                          <span style={{ color: 'var(--warning)', marginLeft: 6, fontSize: 10 }} title={c.last_error ?? 'Event-log collection is failing on this PC'}>· ⚠ logs</span>
                        )}</span>
                      );
                      if (c.reachable === false) return <span style={{ color: 'var(--text-dim)' }} title={c.last_reachable_at ? `Last on network: ${timeAgo(c.last_reachable_at)}` : 'Never seen on network'}>○ Offline</span>;
                      // reachable == null → not probed yet; fall back to the
                      // event-log collector's last verdict until the first probe.
                      return c.last_status === 'online' ? <span style={{ color: 'var(--ok)' }}>● Online</span>
                        : c.last_status === 'offline' ? <span style={{ color: 'var(--text-dim)' }}>○ Offline</span>
                        : c.last_status === 'rpc_unavailable' ? <span style={{ color: 'var(--warning)' }}>⚠ RPC fail</span>
                        : c.last_status === 'access_denied' ? <span style={{ color: 'var(--critical)' }}>✗ Access denied</span>
                        : c.last_status === 'unknown' ? <span style={{ color: 'var(--critical)' }}>? Unknown</span>
                        : <span style={{ color: 'var(--text-dim)' }}>— not probed</span>;
                    })()}
                  </td>
                  <td><DisksCell disks={disksByComputer.get(c.id) ?? []} thresholds={thresholds} /></td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{timeAgo(c.last_collected_at ?? null)}</td>
                  <td style={{ color: c.last_error ? 'var(--critical)' : 'var(--text-dim)', fontSize: 11, maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.last_error ?? ''}>
                    {c.last_error ?? '—'}
                  </td>
                  <td>
                    <PcActionsButton name={c.name} fqdn={c.fqdn} ipAddress={c.ip_address} disks={disks.filter((d) => d.computer_id === c.id)} computerId={c.id} onRefreshed={onRefreshLocal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {userHistoryFor && (
        <UserHistoryModal
          computerId={userHistoryFor.id}
          computerName={userHistoryFor.name}
          onClose={() => setUserHistoryFor(null)}
        />
      )}
    </div>
  );
}

function StatusChip({ label, count, active, color, onClick }: { label: string; count: number; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? color : 'transparent',
        color: active ? 'white' : color,
        border: `1px solid ${color}`,
        borderRadius: 12,
        padding: '2px 10px',
        cursor: 'pointer',
        fontSize: 11,
        fontFamily: 'inherit',
        fontWeight: active ? 700 : 500,
      }}
      title={`Filter by ${label}`}
    >
      {count} {label}
    </button>
  );
}

// Tiny "✓ all / ✗ none" toggle shown in a checkbox column header — sets that
// flag for all currently visible (filtered) rows.
function BulkToggle({ onAll, onNone }: { onAll: () => void; onNone: () => void }) {
  const btn: React.CSSProperties = {
    background: 'transparent', border: '1px solid var(--border)', borderRadius: 3,
    color: 'var(--text-dim)', fontSize: 10, lineHeight: 1, padding: '1px 4px',
    cursor: 'pointer', fontFamily: 'inherit',
  };
  return (
    <div style={{ display: 'flex', gap: 3, justifyContent: 'center', marginTop: 3 }} onClick={(e) => e.stopPropagation()}>
      <button type="button" style={btn} title="All visible" onClick={onAll}>✓</button>
      <button type="button" style={btn} title="None visible" onClick={onNone}>✗</button>
    </div>
  );
}

// Per-PC disk email monitoring: a checkbox (enable) plus a drive-letter field.
// Empty letters = all in-scope drives; "C" or "C,F" = only those. Letters save
// on blur / Enter and are disabled until the PC is enabled.
function DiskEmailCell({ c, onSaved, onError }: { c: ComputerItem; onSaved: () => void; onError: (e: string) => void }) {
  const { t } = useI18n();
  const [drives, setDrives] = useState(c.disk_email_drives ?? '');
  useEffect(() => { setDrives(c.disk_email_drives ?? ''); }, [c.disk_email_drives]);

  const on = !!c.disk_email_monitor;

  const toggleEnabled = async () => {
    try {
      await api.setDiskEmailMonitor(c.id, { enabled: !on });
      onSaved();
    } catch (err) {
      onError(String(err));
    }
  };

  const saveDrives = async () => {
    const next = drives.trim();
    if (next === (c.disk_email_drives ?? '').trim()) return;
    try {
      await api.setDiskEmailMonitor(c.id, { drives: next });
      onSaved();
    } catch (err) {
      onError(String(err));
      setDrives(c.disk_email_drives ?? '');
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
      <input
        type="checkbox"
        checked={on}
        onChange={toggleEnabled}
        title={t('computers.diskEmail.toggle')}
        style={{ cursor: 'pointer' }}
      />
      <input
        type="text"
        value={drives}
        disabled={!on}
        onChange={(e) => setDrives(e.target.value)}
        onBlur={saveDrives}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        placeholder={t('computers.diskEmail.allPlaceholder')}
        title={t('computers.diskEmail.lettersTitle')}
        style={{
          width: 52,
          padding: '2px 4px',
          fontSize: 11,
          fontFamily: 'Consolas, monospace',
          textAlign: 'center',
          background: on ? 'var(--surface)' : 'transparent',
          color: on ? 'var(--text)' : 'var(--text-dim)',
          border: '1px solid var(--border)',
          borderRadius: 3,
          opacity: on ? 1 : 0.4,
        }}
      />
    </div>
  );
}
