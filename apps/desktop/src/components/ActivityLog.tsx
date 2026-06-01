import React, { useEffect, useRef, useState } from 'react';
import type { ActivityLogEntry } from '../api.js';
import { api } from '../api.js';

const LEVEL_COLORS: Record<ActivityLogEntry['level'], string> = {
  info: 'var(--text-dim)',
  warn: 'var(--warning)',
  error: 'var(--critical)',
  success: 'var(--ok)',
};

export function ActivityLog({ height = 400, autoScroll = true }: { height?: number; autoScroll?: boolean }) {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [filterLevel, setFilterLevel] = useState<'' | ActivityLogEntry['level']>('');
  const [paused, setPaused] = useState(false);
  const seqRef = useRef<number>(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || paused) return;
      try {
        const res = await api.activityLog(200, seqRef.current);
        if (res.entries.length > 0) {
          setEntries((prev) => {
            // Merge: append new entries; cap at 500
            const combined = [...prev, ...res.entries];
            return combined.slice(-500);
          });
        }
        seqRef.current = res.seq;
      } catch {
        // silent — show "disconnected" later
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [paused]);

  useEffect(() => {
    if (autoScroll && !paused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [entries, autoScroll, paused]);

  const filtered = entries.filter((e) => {
    if (filterLevel && e.level !== filterLevel) return false;
    if (filter) {
      const q = filter.toLowerCase();
      if (!e.message.toLowerCase().includes(q) && !e.source.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="panel" style={{ minHeight: 0 }}>
      <div className="panel-header">
        <h2>Activity log ({filtered.length})</h2>
        <div className="panel-actions filters">
          <input
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: 140 }}
          />
          <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value as ActivityLogEntry['level'] | '')}>
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
          <button className="refresh-btn" onClick={() => setPaused((p) => !p)}>
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button className="refresh-btn" onClick={() => setEntries([])}>Clear</button>
        </div>
      </div>
      <div className="panel-body activity-log" style={{ height, fontFamily: 'Consolas, "Courier New", monospace', fontSize: 11, lineHeight: '16px' }}>
        {filtered.length === 0 ? (
          <div className="empty">Waiting for activity…</div>
        ) : (
          <>
            {filtered.map((e, i) => (
              <div key={`${e.ts}-${i}`} style={{ display: 'flex', gap: 8, padding: '1px 0' }}>
                <span style={{ color: 'var(--text-dim)', flex: '0 0 80px' }}>
                  {new Date(e.ts).toLocaleTimeString('cs-CZ')}
                </span>
                <span style={{ color: 'var(--accent)', flex: '0 0 90px' }}>[{e.source}]</span>
                <span style={{ color: LEVEL_COLORS[e.level], flex: 1 }}>{e.message}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </div>
  );
}
