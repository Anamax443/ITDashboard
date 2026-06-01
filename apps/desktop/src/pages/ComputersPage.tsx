import React, { useState } from 'react';
import type { ComputerItem, SyncResult } from '../api.js';
import { api, timeAgo } from '../api.js';

export function ComputersPage({ items, onRefreshLocal }: { items: ComputerItem[]; onRefreshLocal: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await api.syncComputers();
      setLastSync(result);
      onRefreshLocal();
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  };

  const enabled = items.filter((c) => c.enabled);
  const disabled = items.filter((c) => !c.enabled);

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div className="panel-header">
        <h2>Computers ({enabled.length} active · {disabled.length} disabled)</h2>
        <div className="panel-actions filters">
          {lastSync && (
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              Last sync: fetched {lastSync.fetched}, +{lastSync.inserted} new, {lastSync.updated} updated, {lastSync.removed} disabled ({(lastSync.durationMs / 1000).toFixed(1)}s)
            </span>
          )}
          {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          <button className="refresh-btn" onClick={runSync} disabled={syncing} style={{ minWidth: 130 }}>
            {syncing ? 'Syncing…' : '↻ Sync from AD'}
          </button>
        </div>
      </div>
      <div className="panel-body">
        {items.length === 0 ? (
          <div className="empty">No computers registered. Click "Sync from AD" to import.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>Name</th>
                <th>FQDN</th>
                <th>OS</th>
                <th>Last seen</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                  <td>{c.enabled ? '🟢' : '⚪'}</td>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{c.fqdn ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{c.os_version ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{timeAgo(c.last_seen)}</td>
                  <td style={{ color: c.enabled ? 'var(--ok)' : 'var(--text-dim)', fontSize: 11 }}>
                    {c.enabled ? 'Active' : 'Disabled'}
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
