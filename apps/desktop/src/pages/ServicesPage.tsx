import React, { useEffect, useState } from 'react';
import type { ServiceProblem } from '../api.js';
import { api, timeAgo } from '../api.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';

export function ServicesPage() {
  const [items, setItems] = useState<ServiceProblem[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: number; fail: number; problems: number; durationMs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideTriggerStart, setHideTriggerStart] = useState(true);
  const [hideDelayedStart, setHideDelayedStart] = useState(false);
  const [hidePerUser, setHidePerUser] = useState(true);
  const { sort, toggle } = useSort<ServiceProblem>({ col: 'computer', dir: 'asc' });

  const refresh = () => {
    api.serviceProblems().then((r) => setItems(r.items)).catch((e) => setError(String(e)));
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  const triggerScan = async () => {
    setError(null);
    setScanning(true);
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

  const filtered = items.filter((s) => {
    if (hideTriggerStart && s.trigger_start) return false;
    if (hideDelayedStart && s.delayed_start) return false;
    if (hidePerUser && s.per_user_start) return false;
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

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div className="panel-header">
        <h2>Stopped auto-services ({items.length} problems · {affectedPcs} PCs · {sorted.length} shown)</h2>
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
          {scanning && <span style={{ color: 'var(--accent)', fontSize: 11 }}>● Scanning…</span>}
          {!scanning && lastResult && (
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              <span style={{ color: 'var(--ok)' }}>{lastResult.ok} OK</span>
              {lastResult.fail > 0 && <> · <span style={{ color: 'var(--critical)' }}>{lastResult.fail} fail</span></>}
              {' · '}{lastResult.problems} problems ({(lastResult.durationMs / 1000).toFixed(1)}s)
            </span>
          )}
          {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          <button className="refresh-btn" onClick={triggerScan} disabled={scanning} title="Scan services on all monitored PCs">
            {scanning ? '…' : '🔧 Scan services'}
          </button>
        </div>
      </div>
      <div className="panel-body">
        {sorted.length === 0 ? (
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
