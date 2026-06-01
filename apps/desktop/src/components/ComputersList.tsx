import React from 'react';
import type { ComputerItem } from '../api.js';
import { timeAgo } from '../api.js';

export function ComputersList({ items }: { items: ComputerItem[] }) {
  return (
    <div className="panel computers-panel">
      <div className="panel-header"><h2>Computers ({items.length})</h2></div>
      <div className="panel-body">
        {items.length === 0 ? (
          <div className="empty">No computers registered.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>OS</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                  <td>{c.name}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{c.os_version ?? '—'}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{timeAgo(c.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
