import React, { useEffect, useState } from 'react';
import type { ServiceProblem, ServiceAggregate } from '../api.js';
import { api, timeAgo, serviceWhitelist, isServiceWhitelisted } from '../api.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';
import { HelpBox } from '../components/HelpBox.js';
import { ExportMenu, type ExportColumn } from '../components/ExportMenu.js';
import { useI18n } from '../i18n.js';

export function ServicesPage({ onJumpToComputer }: { onJumpToComputer?: (name: string) => void } = {}) {
  const { t } = useI18n();
  const [view, setView] = useState<'by-pc' | 'by-service'>('by-pc');
  const [items, setItems] = useState<ServiceProblem[]>([]);
  const [aggregate, setAggregate] = useState<ServiceAggregate[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: number; fail: number; problems: number; durationMs: number } | null>(null);
  const [scanStartedAt, setScanStartedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideTriggerStart, setHideTriggerStart] = useState(true);
  const [hideDelayedStart, setHideDelayedStart] = useState(false);
  const [hidePerUser, setHidePerUser] = useState(true);
  const [hideCompliant, setHideCompliant] = useState(false);
  const [onlyNonzeroExit, setOnlyNonzeroExit] = useState(true);
  const [hideWhitelisted, setHideWhitelisted] = useState(true);
  const { sort, toggle } = useSort<ServiceProblem>({ col: 'computer', dir: 'asc' });
  const { sort: aggSort, toggle: aggToggle } = useSort<ServiceAggregate>({ col: 'pc_count', dir: 'desc' });

  const refresh = () => {
    api.serviceProblems().then((r) => setItems(r.items)).catch((e) => setError(String(e)));
    api.servicesAggregate().then((r) => setAggregate(r.items)).catch(() => {});
    api.settings().then(setSettings).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  const triggerScan = async () => {
    setError(null);
    setScanning(true);
    setScanStartedAt(new Date());
    try {
      const result = await api.servicesScan();
      setLastResult({ ok: result.ok, fail: result.fail, problems: result.problems, durationMs: result.durationMs });
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  };

  // Elapsed seconds while scanning
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => {
      if (scanStartedAt) setElapsed(Math.floor((Date.now() - scanStartedAt.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [scanning, scanStartedAt]);

  // Globally-ignored services (alert whitelist, reused as a view filter). When
  // "Hide whitelisted" is on (default), they drop out of BOTH the table and the
  // top-line counts, so the numbers match the Dashboard tile.
  const whitelist = serviceWhitelist(settings);
  const visibleItems = hideWhitelisted
    ? items.filter((s) => !isServiceWhitelisted(s.service_name, s.display_name, whitelist))
    : items;

  const filtered = visibleItems.filter((s) => {
    // Hide trigger-start ONLY when the service exited gracefully (exit_code = 0).
    // A trigger-start service that crashed (exit_code != 0) is a real failure
    // and must always surface regardless of this filter.
    if (hideTriggerStart && s.trigger_start && s.exit_code === 0) return false;
    if (hideDelayedStart && s.delayed_start && s.exit_code === 0) return false;
    if (hidePerUser && s.per_user_start) return false;
    if (hideCompliant && s.is_compliant === true) return false;
    // Only ExitCode != 0: hide rows with exit_code = 0 (graceful). Keep null
    // (no data yet from current Sprint 1.7 backfill) visible so operator can
    // see them until the next scan populates the column.
    if (onlyNonzeroExit && s.exit_code === 0) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        s.computer.toLowerCase().includes(q) ||
        s.service_name.toLowerCase().includes(q) ||
        (s.display_name ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const sorted = useSortedItems(filtered, sort);
  const affectedPcs = new Set(visibleItems.map((i) => i.computer_id)).size;

  const driftCount = visibleItems.filter((s) => s.is_compliant === false).length;
  const compliantNoise = visibleItems.filter((s) => s.is_compliant === true).length;
  const unclassified = visibleItems.filter((s) => s.is_compliant === null).length;
  const crashCount = visibleItems.filter((s) => s.exit_code !== null && s.exit_code !== 0).length;
  const gracefulCount = visibleItems.filter((s) => s.exit_code === 0).length;

  const exportFilterParts: string[] = [];
  if (search) exportFilterParts.push(`search="${search}"`);
  if (hideTriggerStart) exportFilterParts.push('hide-trigger-graceful');
  if (hideDelayedStart) exportFilterParts.push('hide-delayed-graceful');
  if (hidePerUser) exportFilterParts.push('hide-per-user');
  if (hideCompliant) exportFilterParts.push('hide-compliant');
  if (onlyNonzeroExit) exportFilterParts.push('only-exitcode-nonzero');
  if (hideWhitelisted) exportFilterParts.push('hide-whitelisted');
  const exportFilterSummary = exportFilterParts.join(' AND ');
  const exportColumns: ExportColumn<ServiceProblem>[] = [
    { key: 'computer', label: 'Computer', get: (r) => r.computer },
    { key: 'service_name', label: 'Service', get: (r) => r.service_name },
    { key: 'display_name', label: 'Display name', get: (r) => r.display_name ?? '' },
    { key: 'state', label: 'State', get: (r) => r.state },
    { key: 'start_mode', label: 'Start mode', get: (r) => r.start_mode },
    { key: 'exit_code', label: 'Exit code', get: (r) => r.exit_code ?? '' },
    { key: 'service_specific_exit_code', label: 'ServiceSpecific exit', get: (r) => r.service_specific_exit_code ?? '' },
    { key: 'trigger_start', label: 'Trigger', get: (r) => r.trigger_start ? 'yes' : '' },
    { key: 'delayed_start', label: 'Delayed', get: (r) => r.delayed_start ? 'yes' : '' },
    { key: 'per_user_start', label: 'PerUser', get: (r) => r.per_user_start ? 'yes' : '' },
    { key: 'is_compliant', label: 'Compliance', get: (r) => r.is_compliant === true ? 'OK' : r.is_compliant === false ? 'Drift' : '?' },
    { key: 'collected_at', label: 'Last scan', get: (r) => r.collected_at },
  ];

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('services.help.intro')}</p>
          <p>{t('services.help.views')}</p>
          <p>{t('services.help.actions')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>Stopped auto-services ({visibleItems.length} total · <span style={{ color: 'var(--critical)', fontWeight: 700 }}>⚠ {crashCount} crashes</span> · <span style={{ color: 'var(--text-dim)' }}>{gracefulCount} graceful</span> · <span style={{ color: 'var(--critical)' }}>{driftCount} drift</span> · <span style={{ color: 'var(--ok)' }}>{compliantNoise} OK</span> · <span style={{ color: 'var(--text-dim)' }}>{unclassified} unclassified</span> · {affectedPcs} PCs · {sorted.length} shown)</h2>
        <div className="panel-actions filters">
          <input
            type="text"
            placeholder="Search PC / service…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 360 }}
          />
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }} title="Trigger-start services are designed to start only on specific events — usually not a real problem">
            <input type="checkbox" checked={hideTriggerStart} onChange={(e) => setHideTriggerStart(e.target.checked)} />
            Hide trigger-start
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }} title="Delayed-start services may still be in the delay window">
            <input type="checkbox" checked={hideDelayedStart} onChange={(e) => setHideDelayedStart(e.target.checked)} />
            Hide delayed-start
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }} title="Per-user service instances (suffix is LUID) — legitimately stopped when no user is logged on">
            <input type="checkbox" checked={hidePerUser} onChange={(e) => setHidePerUser(e.target.checked)} />
            Hide per-user
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }} title="Hide services that match a policy with OK status">
            <input type="checkbox" checked={hideCompliant} onChange={(e) => setHideCompliant(e.target.checked)} />
            Hide compliant
          </label>
          <label style={{ fontSize: 11, color: 'var(--critical)', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }} title="Show only services with a non-zero Win32 exit code (likely crashed, not a graceful trigger-start exit)">
            <input type="checkbox" checked={onlyNonzeroExit} onChange={(e) => setOnlyNonzeroExit(e.target.checked)} />
            ⚠ Only ExitCode != 0
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }} title="Hide globally-ignored services (the alert whitelist in Settings — e.g. browser/Google updaters). When on, they are excluded from the counts too, matching the Dashboard tile.">
            <input type="checkbox" checked={hideWhitelisted} onChange={(e) => setHideWhitelisted(e.target.checked)} />
            Hide whitelisted
          </label>
          {scanning && (
            <span style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 600 }}>
              ● Scanning… {elapsed}s
            </span>
          )}
          {!scanning && lastResult && (
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              <span style={{ color: 'var(--ok)' }}>{lastResult.ok} OK</span>
              {lastResult.fail > 0 && <> · <span style={{ color: 'var(--critical)' }}>{lastResult.fail} fail</span></>}
              {' · '}{lastResult.problems} problems ({(lastResult.durationMs / 1000).toFixed(1)}s)
            </span>
          )}
          {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          <button className="refresh-btn" onClick={triggerScan} disabled={scanning} title="Scan services on all monitored PCs">
            {scanning ? `… ${elapsed}s` : '🔧 Scan services'}
          </button>
          <a
            href={api.servicesGpoScriptUrl()}
            target="_blank"
            rel="noreferrer"
            className="refresh-btn"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
            title="Download PowerShell script that applies your current service policy. Suitable for GPO Computer Startup Script."
          >
            📤 GPO script
          </a>
          <ExportMenu rows={sorted} columns={exportColumns} title="ITDashboard — Služby" filterSummary={exportFilterSummary} filenameBase="services" />
          <button className="refresh-btn" onClick={() => setView(view === 'by-pc' ? 'by-service' : 'by-pc')}>
            {view === 'by-pc' ? '📊 By service' : '📋 By PC'}
          </button>
        </div>
      </div>
      <div className="panel-body">
        {view === 'by-service' ? (
          <ByServiceTable items={aggregate} sort={aggSort} toggle={aggToggle} search={search} hideCompliant={hideCompliant} hideTriggerStart={hideTriggerStart} hideDelayedStart={hideDelayedStart} hidePerUser={hidePerUser} whitelist={hideWhitelisted ? whitelist : []} />
        ) : sorted.length === 0 ? (
          <div className="empty">
            {items.length === 0
              ? 'No problems found — all monitored PCs have their auto-services running. (Or scan never ran — click 🔧 Scan services.)'
              : 'No services match your search.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <SortHeader<ServiceProblem> col="computer" label="Computer" sort={sort} toggle={toggle} width={140} />
                <SortHeader<ServiceProblem> col="service_name" label="Service" sort={sort} toggle={toggle} width={180} />
                <SortHeader<ServiceProblem> col="display_name" label="Display name" sort={sort} toggle={toggle} />
                <SortHeader<ServiceProblem> col="state" label="State" sort={sort} toggle={toggle} width={90} />
                <SortHeader<ServiceProblem> col="exit_code" label="Exit" sort={sort} toggle={toggle} width={70} />
                <th style={{ width: 110 }}>Start type</th>
                <th style={{ width: 80 }}>Drift</th>
                <SortHeader<ServiceProblem> col="collected_at" label="Last scan" sort={sort} toggle={toggle} width={100} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>
                    {onJumpToComputer ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(s.computer); }} style={{ color: 'var(--accent)', textDecoration: 'none' }} title={`Otevřít ${s.computer} v záložce Počítače`}>{s.computer}</a>
                    ) : s.computer}
                  </td>
                  <td style={{ fontFamily: 'Consolas, monospace', fontSize: 11 }}>{s.service_name}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{s.display_name ?? '—'}</td>
                  <td>
                    <span style={{
                      color: s.state === 'Stopped' ? 'var(--critical)' : 'var(--warning)',
                      fontSize: 11, fontWeight: 600,
                    }}>{s.state}</span>
                  </td>
                  <td style={{ fontSize: 11, fontFamily: 'Consolas, monospace' }} title={s.exit_code === 0 ? 'Graceful exit (Win32ExitCode = 0)' : s.exit_code === null ? 'No exit code reported' : `Win32 exit ${s.exit_code}${s.service_specific_exit_code != null ? ` / service-specific ${s.service_specific_exit_code}` : ''}`}>
                    {s.exit_code == null ? <span style={{ color: 'var(--text-dim)' }}>—</span>
                      : s.exit_code === 0 ? <span style={{ color: 'var(--text-dim)' }}>0</span>
                      : <span style={{ color: 'var(--critical)', fontWeight: 600 }}>{s.exit_code}</span>}
                  </td>
                  <td style={{ fontSize: 10 }}>
                    {s.trigger_start && <span style={{ color: 'var(--accent)' }}>● Trigger</span>}
                    {s.delayed_start && <span style={{ color: 'var(--warning)' }}>● Delayed</span>}
                    {s.per_user_start && <span style={{ color: 'var(--text-dim)' }}>● Per-user</span>}
                    {!s.trigger_start && !s.delayed_start && !s.per_user_start && <span style={{ color: 'var(--critical)' }}>● Auto</span>}
                  </td>
                  <td style={{ fontSize: 10 }}>
                    {s.is_compliant === true && <span style={{ color: 'var(--ok)' }}>● OK</span>}
                    {s.is_compliant === false && <span style={{ color: 'var(--critical)' }}>● Drift</span>}
                    {s.is_compliant === null && <span style={{ color: 'var(--text-dim)' }}>● ?</span>}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{timeAgo(s.collected_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ByServiceTable({ items, sort, toggle, search, hideCompliant, hideTriggerStart, hideDelayedStart, hidePerUser, whitelist }: {
  items: ServiceAggregate[];
  sort: { col: keyof ServiceAggregate; dir: 'asc' | 'desc' } | null;
  toggle: (col: keyof ServiceAggregate) => void;
  search: string;
  hideCompliant: boolean;
  hideTriggerStart: boolean;
  hideDelayedStart: boolean;
  hidePerUser: boolean;
  whitelist: RegExp[];
}) {
  const filtered = items.filter((s) => {
    if (isServiceWhitelisted(s.service_name, s.display_name, whitelist)) return false;
    if (hideTriggerStart && s.trigger_start) return false;
    if (hideDelayedStart && s.delayed_start) return false;
    if (hidePerUser && s.per_user_start) return false;
    if (hideCompliant && s.drift_count === 0 && s.unclassified_count === 0) return false;
    if (search) {
      const q = search.toLowerCase();
      return s.service_name.toLowerCase().includes(q) || (s.display_name ?? '').toLowerCase().includes(q);
    }
    return true;
  });
  const sorted = useSortedItems(filtered, sort);
  if (sorted.length === 0) return <div className="empty">No services match.</div>;
  return (
    <table>
      <thead>
        <tr>
          <SortHeader<ServiceAggregate> col="service_name" label="Service" sort={sort} toggle={toggle} width={220} />
          <SortHeader<ServiceAggregate> col="display_name" label="Display name" sort={sort} toggle={toggle} />
          <SortHeader<ServiceAggregate> col="pc_count" label="# PCs" sort={sort} toggle={toggle} width={70} />
          <SortHeader<ServiceAggregate> col="drift_count" label="Drift" sort={sort} toggle={toggle} width={70} />
          <SortHeader<ServiceAggregate> col="ok_count" label="OK" sort={sort} toggle={toggle} width={60} />
          <SortHeader<ServiceAggregate> col="unclassified_count" label="?" sort={sort} toggle={toggle} width={50} />
          <th style={{ width: 110 }}>Start type</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => (
          <tr key={s.service_name}>
            <td style={{ fontFamily: 'Consolas, monospace', fontSize: 11, fontWeight: 600 }}>{s.service_name}</td>
            <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{s.display_name ?? '—'}</td>
            <td style={{ fontWeight: 600 }}>{s.pc_count}</td>
            <td style={{ color: s.drift_count > 0 ? 'var(--critical)' : 'var(--text-dim)' }}>{s.drift_count}</td>
            <td style={{ color: s.ok_count > 0 ? 'var(--ok)' : 'var(--text-dim)' }}>{s.ok_count}</td>
            <td style={{ color: s.unclassified_count > 0 ? 'var(--warning)' : 'var(--text-dim)' }}>{s.unclassified_count}</td>
            <td style={{ fontSize: 10 }}>
              {s.trigger_start && <span style={{ color: 'var(--accent)' }}>● Trigger</span>}
              {s.delayed_start && <span style={{ color: 'var(--warning)' }}>● Delayed</span>}
              {s.per_user_start && <span style={{ color: 'var(--text-dim)' }}>● Per-user</span>}
              {!s.trigger_start && !s.delayed_start && !s.per_user_start && <span style={{ color: 'var(--critical)' }}>● Auto</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
