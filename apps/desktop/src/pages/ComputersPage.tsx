import React, { useEffect, useState } from 'react';
import type { ComputerItem as CI, SyncResult, AdSyncRun, DiskItem } from '../api.js';
type ComputerItem = CI;
import { api, timeAgo, parseDiskThresholds } from '../api.js';
import { DisksCell } from '../components/DiskBar.js';
import { HelpBox } from '../components/HelpBox.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';

export function ComputersPage({ items, onRefreshLocal, initialFilter, onFilterConsumed }: { items: ComputerItem[]; onRefreshLocal: () => void; initialFilter?: 'disk-critical' | 'disk-warning' | 'failing' | null; onFilterConsumed?: () => void }) {
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

  useEffect(() => {
    if (initialFilter) {
      setStatusFilter(initialFilter);
      onFilterConsumed?.();
    }
  }, [initialFilter, onFilterConsumed]);

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
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'disabled' | 'monitored' | 'unmonitored' | 'failing' | 'disk-critical' | 'disk-warning' | 'excluded'>('');
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
    const s = (function () {
      const freePct = d.total_bytes > 0 ? (d.free_bytes / d.total_bytes) * 100 : 100;
      const freeGb = d.free_bytes / 1024 ** 3;
      const t = thresholds;
      const pctCrit = freePct < t.criticalPct, pctWarn = freePct < t.warningPct;
      const gbCrit = freeGb < t.criticalGb, gbWarn = freeGb < t.warningGb;
      if (t.mode === 'pct') return pctCrit ? 'critical' : pctWarn ? 'warning' : 'ok';
      if (t.mode === 'gb') return gbCrit ? 'critical' : gbWarn ? 'warning' : 'ok';
      if (pctCrit || gbCrit) return 'critical';
      if (pctWarn || gbWarn) return 'warning';
      return 'ok';
    })() as 'critical' | 'warning' | 'ok';
    const cur = worstDiskByComputer.get(d.computer_id);
    const rank = { critical: 3, warning: 2, ok: 1 };
    if (!cur || rank[s] > rank[cur]) worstDiskByComputer.set(d.computer_id, s);
  }

  const filtered = items.filter((c) => {
    // Hide excluded by default unless filter is set to 'excluded'
    if (statusFilter !== 'excluded' && c.excluded) return false;
    if (statusFilter === 'excluded' && !c.excluded) return false;
    if (statusFilter === 'active' && !c.enabled) return false;
    if (statusFilter === 'disabled' && c.enabled) return false;
    if (statusFilter === 'monitored' && (!c.enabled || !c.monitor_enabled)) return false;
    if (statusFilter === 'unmonitored' && (!c.enabled || c.monitor_enabled)) return false;
    if (statusFilter === 'failing' && (!c.enabled || (c.consecutive_failures ?? 0) === 0)) return false;
    if (statusFilter === 'disk-critical' && worstDiskByComputer.get(c.id) !== 'critical') return false;
    if (statusFilter === 'disk-warning' && worstDiskByComputer.get(c.id) !== 'warning') return false;
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
  const monitored = items.filter((c) => c.enabled && !c.excluded && c.monitor_enabled).length;
  const unmonitored = items.filter((c) => c.enabled && !c.excluded && !c.monitor_enabled).length;
  const failing = items.filter((c) => c.enabled && !c.excluded && (c.consecutive_failures ?? 0) > 0).length;
  const excludedCount = items.filter((c) => c.excluded).length;

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
        <HelpBox title="What this tab shows">
          <p>Full inventory of domain computers synced from <code>Get-ADComputer</code>. Use this tab to decide which PCs to actively monitor and which to permanently exclude.</p>
          <p><strong>Three operator-controlled flags:</strong></p>
          <ul style={{ marginLeft: 16 }}>
            <li><strong>Monitor</strong> checkbox — pause/resume collectors for this PC (e.g. PC in maintenance). Persists across AD syncs.</li>
            <li><strong>Exclude</strong> checkbox — permanently hide from all stats, dashboard cards, lists. For decommissioned PCs / test VMs.</li>
            <li><strong>Active</strong> status — set by AD sync; reflects whether PC exists in AD. PCs removed from AD become Disabled but their events are preserved.</li>
          </ul>
          <p><strong>Bulk operations:</strong> use search/status chips to narrow the visible list, then <strong>✓ All</strong> or <strong>✗ None</strong> to toggle Monitor for all visible rows.</p>
          <p><strong>Disks column</strong> — colored bars per drive (red = critical, amber = warning, green = OK). Thresholds configurable in Settings → Disk space.</p>
          <p><strong>Status column</strong> — last collector reachability: Online / Offline (TCP/135 unreachable) / RPC fail (firewall) / Access denied (Event Log Readers missing).</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>Computers</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>({items.length} total · {sorted.length} shown)</span>
          <StatusChip label="active" count={enabled.length} active={statusFilter === 'active'} color="var(--ok)" onClick={() => setStatusFilter(statusFilter === 'active' ? '' : 'active')} />
          <StatusChip label="monitored" count={monitored} active={statusFilter === 'monitored'} color="var(--accent)" onClick={() => setStatusFilter(statusFilter === 'monitored' ? '' : 'monitored')} />
          <StatusChip label="unmonitored" count={unmonitored} active={statusFilter === 'unmonitored'} color="var(--warning)" onClick={() => setStatusFilter(statusFilter === 'unmonitored' ? '' : 'unmonitored')} />
          <StatusChip label="failing" count={failing} active={statusFilter === 'failing'} color="var(--critical)" onClick={() => setStatusFilter(statusFilter === 'failing' ? '' : 'failing')} />
          <StatusChip label="disk critical" count={Array.from(worstDiskByComputer.values()).filter((s) => s === 'critical').length} active={statusFilter === 'disk-critical'} color="var(--critical)" onClick={() => setStatusFilter(statusFilter === 'disk-critical' ? '' : 'disk-critical')} />
          <StatusChip label="disk warning" count={Array.from(worstDiskByComputer.values()).filter((s) => s === 'warning').length} active={statusFilter === 'disk-warning'} color="var(--warning)" onClick={() => setStatusFilter(statusFilter === 'disk-warning' ? '' : 'disk-warning')} />
          <StatusChip label="disabled" count={disabled.length} active={statusFilter === 'disabled'} color="var(--text-dim)" onClick={() => setStatusFilter(statusFilter === 'disabled' ? '' : 'disabled')} />
          <StatusChip label="excluded" count={excludedCount} active={statusFilter === 'excluded'} color="var(--text-dim)" onClick={() => setStatusFilter(statusFilter === 'excluded' ? '' : 'excluded')} />
        </h2>
        <div className="panel-actions filters">
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 160 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="">All status</option>
            <option value="active">Active (in AD)</option>
            <option value="disabled">Disabled (gone from AD)</option>
            <option value="monitored">Monitored</option>
            <option value="unmonitored">Unmonitored</option>
            <option value="failing">Failing collector</option>
            <option value="disk-critical">Disk critical</option>
            <option value="disk-warning">Disk warning</option>
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
            {diskScanState === 'scanning' ? '…' : '💾 Scan disks'}
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
                <th style={{ width: 70, textAlign: 'center' }} title="Permanently exclude from all stats and views">Exclude</th>
                <SortHeader<ComputerItem> col="name" label="Name" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="ou_path" label="OU path" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="fqdn" label="FQDN" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="os_version" label="OS" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="ip_address" label="IP" sort={sort} toggle={toggle} />
                <SortHeader<ComputerItem> col="current_user" label="User" sort={sort} toggle={toggle} />
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
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={c.excluded}
                      onChange={() => toggleExcluded(c)}
                      title={c.excluded ? 'Excluded — click to re-include in stats' : 'Click to exclude from all dashboards and stats'}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }} title={c.distinguished_name ?? ''}>{c.ou_path ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{c.fqdn ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{c.os_version ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'Consolas, monospace' }}>{c.ip_address ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }} title={c.current_user_seen_at ? `Last seen logged in: ${timeAgo(c.current_user_seen_at)}` : ''}>{c.current_user ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{timeAgo(c.last_seen)}</td>
                  <td style={{ fontSize: 11 }}>
                    {!c.enabled
                      ? <span style={{ color: 'var(--text-dim)' }}>Disabled</span>
                      : c.last_status === 'online' ? <span style={{ color: 'var(--ok)' }}>● Online</span>
                      : c.last_status === 'offline' ? <span style={{ color: 'var(--text-dim)' }}>○ Offline</span>
                      : c.last_status === 'rpc_unavailable' ? <span style={{ color: 'var(--warning)' }}>⚠ RPC fail</span>
                      : c.last_status === 'access_denied' ? <span style={{ color: 'var(--critical)' }}>✗ Access denied</span>
                      : c.last_status === 'unknown' ? <span style={{ color: 'var(--critical)' }}>? Unknown</span>
                      : <span style={{ color: 'var(--ok)' }}>Active</span>}
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
