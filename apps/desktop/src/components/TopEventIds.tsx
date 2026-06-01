import React from 'react';
import type { TopEventId } from '../api.js';
import { levelName, levelLabel } from '../api.js';

export function TopEventIds({ items }: { items: TopEventId[] }) {
  const maxCnt = Math.max(1, ...items.map((i) => i.cnt));
  return (
    <div className="panel top-ids-panel">
      <div className="panel-header"><h2>Top event IDs (24h)</h2></div>
      <div className="panel-body">
        {items.length === 0 ? (
          <div className="empty">No events.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Level</th>
                <th style={{ textAlign: 'right' }}>Count</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const lvl = levelName(i.level);
                const pct = (i.cnt / maxCnt) * 100;
                return (
                  <tr key={`${i.event_id}-${i.log_name}-${i.level}`}>
                    <td>{i.event_id}</td>
                    <td><span className={`level-pill ${lvl}`}>{levelLabel(i.level)}</span></td>
                    <td style={{ textAlign: 'right', position: 'relative' }}>
                      <div style={{ position: 'absolute', inset: 0, background: 'var(--surface-hover)', width: `${pct}%`, opacity: 0.4 }} />
                      <span style={{ position: 'relative' }}>{i.cnt}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
