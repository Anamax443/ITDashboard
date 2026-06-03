import React, { useEffect, useRef, useState } from 'react';
import type { ActivityLogEntry } from '../api.js';
import { api } from '../api.js';
import { HelpBox } from './HelpBox.js';

const LEVEL_COLORS: Record<ActivityLogEntry['level'], string> = {
  info: 'var(--text-dim)',
  warn: 'var(--warning)',
  error: 'var(--critical)',
  success: 'var(--ok)',
};

// navigator.clipboard requires a secure context (HTTPS or localhost). The dashboard
// is served plain HTTP on the internal LAN so we fall back to the legacy
// document.execCommand path when the modern API is unavailable.
async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ActivityLog({ height = 400, autoScroll = true }: { height?: number; autoScroll?: boolean }) {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [filterLevel, setFilterLevel] = useState<'' | ActivityLogEntry['level']>('');
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
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
      <div style={{ padding: 12 }}>
        <HelpBox title="What this tab shows">
          <p>Real-time stream of every background action: eventlog collector, AD sync, disk scan, services scan, firewall changes. Polled every 2s.</p>
          <p><strong>Source tags:</strong> <code>[checks]</code>, <code>[collector]</code>, <code>[disk]</code>, <code>[services]</code>, <code>[ad-sync]</code>, <code>[firewall]</code></p>
          <p><strong>Levels:</strong> Success (green) · Info (dim) · Warning (amber) · Error (red)</p>
          <p>Buffer is in-memory (last 500 entries), lost on service restart. For permanent audit see DB tables <code>collector_runs</code>, <code>ad_sync_runs</code>.</p>
          <p><strong>📋 Copy</strong> exports filtered lines as tab-separated text to clipboard.</p>
        </HelpBox>
      </div>
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
          <button
            className="refresh-btn"
            onClick={async () => {
              const text = filtered.map((e) =>
                `${new Date(e.ts).toLocaleString('cs-CZ')}\t[${e.source}]\t${e.level.toUpperCase()}\t${e.message}`
              ).join('\n');
              const ok = await copyToClipboard(text);
              setCopied(ok);
              setTimeout(() => setCopied(false), 2000);
            }}
            title="Copy filtered log lines to clipboard"
          >
            {copied ? '✓ Copied' : '📋 Copy'}
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
