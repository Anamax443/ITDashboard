import React, { useEffect, useState } from 'react';
import type { ServiceProblem, ServiceAggregate } from '../api.js';
import { api, timeAgo } from '../api.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';
import { HelpBox } from '../components/HelpBox.js';

export function ServicesPage() {
  const [view, setView] = useState<'by-pc' | 'by-service'>('by-pc');
  const [items, setItems] = useState<ServiceProblem[]>([]);
  const [aggregate, setAggregate] = useState<ServiceAggregate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: number; fail: number; problems: number; durationMs: number } | null>(null);
  const [scanStartedAt, setScanStartedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideTriggerStart, setHideTriggerStart] = useState(true);
  const [hideDelayedStart, setHideDelayedStart] = useState(false);
  const [hidePerUser, setHidePerUser] = useState(true);
  const [hideCompliant, setHideCompliant] = useState(false);
  const { sort, toggle } = useSort<ServiceProblem>({ col: 'computer', dir: 'asc' });
  const { sort: aggSort, toggle: aggToggle } = useSort<ServiceAggregate>({ col: 'pc_count', dir: 'desc' });

  const refresh = () => {
    api.serviceProblems().then((r) => setItems(r.items)).catch((e) => setError(String(e)));
    api.servicesAggregate().then((r) => setAggregate(r.items)).catch(() => {});
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

  const filtered = items.filter((s) => {
    if (hideTriggerStart && s.trigger_start) return false;
    if (hideDelayedStart && s.delayed_start) return false;
    if (hidePerUser && s.per_user_start) return false;
    if (hideCompliant && s.is_compliant === true) return false;
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
  const affectedPcs = new Set(items.map((i) => i.computer_id)).size;

  const driftCount = items.filter((s) => s.is_compliant === false).length;
  const compliantNoise = items.filter((s) => s.is_compliant === true).length;
  const unclassified = items.filter((s) => s.is_compliant === null).length;

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title="What this tab shows">
          <p>Lists Windows services whose <strong>StartMode = Automatic</strong> but <strong>State ≠ Running</strong> on each monitored PC.</p>
          <p><strong>Drift</strong> column compares each row against your <code>service_policy</code> rules (DB-backed, seeded with known noise patterns like <code>GoogleUpdater*</code>, <code>Intel(R)*</code>, etc):</p>
          <ul style={{ marginLeft: 16 }}>
            <li><span style={{ color: 'var(--ok)' }}>● OK</span> — service matches an expected pattern (e.g. GoogleUpdater is allowed to be Manual+Stopped)</li>
            <li><span style={{ color: 'var(--critical)' }}>● Drift</span> — service violates its policy (e.g. CCAgent should be Running but is Stopped)</li>
            <li><span style={{ color: 'var(--text-dim)' }}>● Unclassified</span> — no policy rule matches this service yet; review manually</li>
          </ul>
          <p>Categories:</p>
          <ul style={{ marginLeft: 16 }}>
            <li><strong>Auto</strong> (red) — pure Automatic, should be running; real candidates for investigation</li>
            <li><strong>Trigger</strong> (blue) — Auto+Trigger Start: designed to start only on events (device plug-in, GPO change). Legitimately stopped.</li>
            <li><strong>Delayed</strong> (amber) — Auto+Delayed: starts ~2 min after boot. May still be in delay window.</li>
            <li><strong>Per-user</strong> (grey) — per-user service instance (suffix is LUID). Stopped when no user is logged on. Filtered by default.</li>
          </ul>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>Stopped auto-services ({items.length} total · <span style={{ color: 'var(--critical)' }}>{driftCount} drift</span> · <span style={{ color: 'var(--ok)' }}>{compliantNoise} OK</span> · <span style={{ color: 'var(--text-dim)' }}>{unclassified} unclassified</span> · {affectedPcs} PCs · {sorted.length} shown)</h2>
        <div className="panel-actions filters">
          <input
            type="text"
            placeholder="Search PC / service…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 180 }}
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
          <button className="refresh-btn" onClick={() => setView(view === 'by-pc' ? 'by-service' : 'by-pc')}>
            {view === 'by-pc' ? '📊 By service' : '📋 By PC'}
          </button>
        </div>
      </div>
      <div className="panel-body">
        {view === 'by-service' ? (
          <ByServiceTable items={aggregate} sort={aggSort} toggle={aggToggle} search={search} hideCompliant={hideCompliant} hideTriggerStart={hideTriggerStart} hideDelayedStart={hideDelayedStart} hidePerUser={hidePerUser} />
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
                <th style={{ width: 110 }}>Start type</th>
                <th style={{ width: 80 }}>Drift</th>
                <SortHeader<ServiceProblem> col="collected_at" label="Last scan" sort={sort} toggle={toggle} width={100} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.computer}</td>
                  <td style={{ fontFamily: 'Consolas, monospace', fontSize: 11 }}>{s.service_name}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{s.display_name ?? '—'}</td>
                  <td>
                    <span style={{
                      color: s.state === 'Stopped' ? 'var(--critical)' : 'var(--warning)',
                      fontSize: 11, fontWeight: 600,
                    }}>{s.state}</span>
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

function ByServiceTable({ items, sort, toggle, search, hideCompliant, hideTriggerStart, hideDelayedStart, hidePerUser }: {
  items: ServiceAggregate[];
  sort: { col: keyof ServiceAggregate; dir: 'asc' | 'desc' } | null;
  toggle: (col: keyof ServiceAggregate) => void;
  search: string;
  hideCompliant: boolean;
  hideTriggerStart: boolean;
  hideDelayedStart: boolean;
  hidePerUser: boolean;
}) {
  const filtered = items.filter((s) => {
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
