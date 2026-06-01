import React from 'react';
import type { TopComputer } from '../api.js';

export function TopComputersChart({ items }: { items: TopComputer[] }) {
  const max = Math.max(1, ...items.map((i) => i.total));

  return (
    <div className="panel">
      <div className="panel-header"><h2>Top noisy PCs (24h)</h2></div>
      <div className="panel-body">
        {items.length === 0 ? (
          <div className="empty">No events.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {items.map((c) => {
              const critW = (c.critical_count / max) * 100;
              const errW = (c.error_count / max) * 100;
              const warnW = (c.warning_count / max) * 100;
              return (
                <div key={c.name} style={{ fontSize: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                    <span style={{ color: 'var(--text-dim)' }}>{c.total}</span>
                  </div>
                  <div style={{ display: 'flex', height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden', marginTop: 2 }}>
                    <div style={{ width: `${critW}%`, background: 'var(--critical)' }} title={`Critical: ${c.critical_count}`} />
                    <div style={{ width: `${errW}%`, background: 'var(--error)' }} title={`Error: ${c.error_count}`} />
                    <div style={{ width: `${warnW}%`, background: 'var(--warning)' }} title={`Warning: ${c.warning_count}`} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
