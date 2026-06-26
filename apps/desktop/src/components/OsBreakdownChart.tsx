import React, { useState } from 'react';
import type { ComputerItem } from '../api.js';
import { summarizeOs, OS_UNKNOWN, OS_OTHER } from '../api.js';
import { Card } from './SummaryCards.js';
import { useI18n } from '../i18n.js';

/**
 * Dashboard OS distribution as a second-row tile that expands inline (like the
 * "problem PCs" tile). The tile shows the number of distinct OS buckets; click
 * it to reveal one horizontal bar per OS over the live managed fleet (enabled,
 * not excluded), each bar split into a live segment and a hatched "stale"
 * segment. Clicking a segment drills into the Computers list filtered to that
 * OS + staleness.
 */
export function OsBreakdownChart({ items, thresholdDays, onSelect, open: openProp, onOpenChange, hideSummary }: {
  items: ComputerItem[];
  thresholdDays: number;
  onSelect: (bucket: string, staleness: 'live' | 'stale') => void;
  // When the summary tile lives in the main dashboard grid, render only the panel.
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  hideSummary?: boolean;
}) {
  const { t } = useI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = hideSummary ? !!openProp : internalOpen;
  const setOpen = (o: boolean) => { if (hideSummary) onOpenChange?.(o); else setInternalOpen(o); };
  const stats = summarizeOs(items, thresholdDays);
  const max = Math.max(1, ...stats.map((s) => s.total));
  const totalPcs = stats.reduce((a, s) => a + s.total, 0);
  const totalStale = stats.reduce((a, s) => a + s.stale, 0);
  const label = (b: string) => (b === OS_UNKNOWN ? t('os.unknown') : b === OS_OTHER ? t('os.other') : b);

  return (
    <>
      {!hideSummary && (
        <div className="cards" style={{ marginTop: 10 }}>
          <Card
            label={`📊 ${t('os.title')}`}
            value={stats.length}
            sub={`${totalPcs} PC${totalStale > 0 ? ` · ${totalStale} ${t('os.stale')}` : ''}`}
            kind="info"
            onClick={stats.length > 0 ? () => setOpen(!open) : undefined}
          />
        </div>
      )}

      {open && stats.length > 0 && (
        <div className="panel" style={{ gridColumn: '1 / -1', marginTop: 10 }}>
          <div className="panel-header">
            <h2>
              📊 {t('os.title')}{' '}
              <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
                ({totalPcs}{totalStale > 0 ? ` · ${totalStale} ${t('os.stale')}` : ''})
              </span>
            </h2>
            <button className="refresh-btn" onClick={() => setOpen(false)} title={t('health.collapse')}>✕</button>
          </div>
          <div className="panel-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {stats.map((s) => {
                const liveW = (s.live / max) * 100;
                const staleW = (s.stale / max) * 100;
                return (
                  <div key={s.bucket} style={{ fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontWeight: 600 }}>{label(s.bucket)}</span>
                      <span style={{ color: 'var(--text-dim)' }}>
                        {s.total}{s.stale > 0 ? <> · <span style={{ color: 'var(--warning)' }}>{s.stale} {t('os.stale')}</span></> : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', height: 14, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
                      {s.live > 0 && (
                        <div
                          onClick={() => onSelect(s.bucket, 'live')}
                          title={`${label(s.bucket)} · ${s.live} ${t('os.live')} — ${t('os.clickFilter')}`}
                          style={{ width: `${liveW}%`, background: 'var(--accent)', cursor: 'pointer' }}
                        />
                      )}
                      {s.stale > 0 && (
                        <div
                          onClick={() => onSelect(s.bucket, 'stale')}
                          title={`${label(s.bucket)} · ${s.stale} ${t('os.stale')} — ${t('os.clickFilter')}`}
                          style={{
                            width: `${staleW}%`,
                            background: 'var(--warning)',
                            opacity: 0.6,
                            cursor: 'pointer',
                            backgroundImage:
                              'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(0,0,0,0.28) 3px, rgba(0,0,0,0.28) 6px)',
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
