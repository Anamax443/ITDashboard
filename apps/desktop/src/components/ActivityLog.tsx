import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityLogEntry, ActivityHistoryItem } from '../api.js';
import { api } from '../api.js';
import { HelpBox } from './HelpBox.js';
import { useI18n } from '../i18n.js';

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
  const { t } = useI18n();
  const [mode, setMode] = useState<'live' | 'history'>('live');
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

  // Conditional return MUST come after all hooks so render order stays stable —
  // otherwise React throws "Rendered fewer hooks than expected".
  if (mode === 'history') {
    return <ActivityHistory height={height} onSwitchToLive={() => setMode('live')} />;
  }

  return (
    <div className="panel" style={{ minHeight: 0 }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('activity.live.help.intro')}</p>
          <p>{t('activity.live.help.tags')}</p>
          <p>{t('activity.live.help.buffer')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>Activity log ({filtered.length}) <span style={{ color: 'var(--text-dim)', fontSize: 11, fontWeight: 'normal' }}>· live</span></h2>
        <div className="panel-actions filters">
          <button className="refresh-btn" onClick={() => setMode('history')} title="Switch to persistent history (DB-backed)">📚 History</button>
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

const HOURS_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Last hour' },
  { value: 24, label: 'Last 24h' },
  { value: 24 * 7, label: 'Last 7 days' },
  { value: 24 * 30, label: 'Last 30 days' },
  { value: 24 * 90, label: 'Last 90 days' },
];

function ActivityHistory({ height, onSwitchToLive }: { height: number; onSwitchToLive: () => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<ActivityHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hours, setHours] = useState(24);
  const [level, setLevel] = useState<'' | ActivityHistoryItem['level']>('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const limit = 500;

  useEffect(() => {
    api.activitySources().then((r) => setSources(r.items.map((s) => s.source))).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.activityHistory({
        hours,
        level: level || undefined,
        source: source || undefined,
        search: search || undefined,
        limit,
        offset,
      });
      setItems(r.items);
      setTotal(r.total);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [hours, level, source, search, offset]);

  useEffect(() => { load(); }, [load]);

  // Reset paging when filters change
  useEffect(() => { setOffset(0); }, [hours, level, source, search]);

  const copy = async () => {
    const text = items.map((e) =>
      `${new Date(e.ts).toLocaleString('cs-CZ')}\t[${e.source}]\t${e.level.toUpperCase()}\t${e.message}`
    ).join('\n');
    const ok = await copyToClipboard(text);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="panel" style={{ minHeight: 0 }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('activity.history.help.intro')}</p>
          <p>{t('activity.history.help.filters').replace('{limit}', String(limit))}</p>
          <p>{t('activity.history.help.live')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>Activity history ({total.toLocaleString('cs-CZ')} {total === 1 ? 'match' : 'matches'}) <span style={{ color: 'var(--text-dim)', fontSize: 11, fontWeight: 'normal' }}>· DB</span></h2>
        <div className="panel-actions filters">
          <button className="refresh-btn" onClick={onSwitchToLive} title="Switch back to live in-memory log">▶ Live</button>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {HOURS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value as ActivityHistoryItem['level'] | '')}>
            <option value="">All levels</option>
            <option value="success">Success</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            type="text"
            placeholder="Search message…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 200 }}
          />
          <button className="refresh-btn" onClick={load} disabled={loading}>{loading ? '…' : '↻ Refresh'}</button>
          <button className="refresh-btn" onClick={copy} disabled={items.length === 0}>{copied ? '✓ Copied' : '📋 Copy'}</button>
        </div>
      </div>
      <div className="panel-body activity-log" style={{ height, fontFamily: 'Consolas, "Courier New", monospace', fontSize: 11, lineHeight: '16px' }}>
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {!error && items.length === 0 && !loading && <div className="empty">No matches</div>}
        {items.map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 8, padding: '1px 0' }}>
            <span style={{ color: 'var(--text-dim)', width: 130, flexShrink: 0 }}>
              {new Date(e.ts).toLocaleString('cs-CZ')}
            </span>
            <span style={{ color: 'var(--accent)', width: 90, flexShrink: 0 }}>[{e.source}]</span>
            <span style={{ color: LEVEL_COLORS[e.level], flex: 1 }}>{e.message}</span>
          </div>
        ))}
      </div>
      {total > limit && (
        <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', borderTop: '1px solid var(--border)' }}>
          <button className="refresh-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>← Prev</button>
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            {offset + 1}–{Math.min(offset + items.length, total)} of {total.toLocaleString('cs-CZ')}
          </span>
          <button className="refresh-btn" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>Next →</button>
        </div>
      )}
    </div>
  );
}
