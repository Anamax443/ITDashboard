import React from 'react';
import type { ComputerItem } from '../api.js';
import { summarizeOs, OS_UNKNOWN, OS_OTHER } from '../api.js';
import { useI18n } from '../i18n.js';

/**
 * Dashboard OS distribution. One horizontal bar per OS bucket over the live
 * managed fleet (enabled, not excluded). Each bar is split into a live segment
 * and a hatched "stale" segment (machines past the inactivity threshold that
 * are not yet deactivated). Clicking either segment drills into the Computers
 * list filtered to that OS + staleness.
 */
export function OsBreakdownChart({ items, thresholdDays, onSelect }: {
  items: ComputerItem[];
  thresholdDays: number;
  onSelect: (bucket: string, staleness: 'live' | 'stale') => void;
}) {
  const { t } = useI18n();
  const stats = summarizeOs(items, thresholdDays);
  const max = Math.max(1, ...stats.map((s) => s.total));
  const totalPcs = stats.reduce((a, s) => a + s.total, 0);
  const totalStale = stats.reduce((a, s) => a + s.stale, 0);
  const label = (b: string) => (b === OS_UNKNOWN ? t('os.unknown') : b === OS_OTHER ? t('os.other') : b);

  return (
    <div className="panel" style={{ gridColumn: '1 / -1' }}>
      <div className="panel-header">
        <h2>
          {t('os.title')}{' '}
          <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
            ({totalPcs}{totalStale > 0 ? ` · ${totalStale} ${t('os.stale')}` : ''})
          </span>
        </h2>
      </div>
      <div className="panel-body">
        {stats.length === 0 ? (
          <div className="empty">{t('os.empty')}</div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
