import React from 'react';
import type { WanStatus, WanLink } from '../api.js';
import { useI18n } from '../i18n.js';

// Always-visible dashboard strip: current link health (RTT + packet loss) to each
// branch office and to the internet, measured live from the app server. One chip
// per site, colour-coded green/amber/red. The operator wants the *current* state —
// "is each branch running as it should" — at a glance, no drill-down needed.
export function WanHealth({ data }: { data: WanStatus | null }) {
  const { t } = useI18n();
  if (!data || !data.enabled || (data.branches.length === 0 && !data.internet)) return null;

  const chip = (l: WanLink, isInternet = false) => {
    const status = !l.alive ? 'down'
      : (l.lossPct >= data.lossWarnPct || (l.latencyMs != null && l.latencyMs >= data.latencyWarnMs)) ? 'warn'
        : 'ok';
    const col = status === 'down' ? 'var(--critical)' : status === 'warn' ? 'var(--warning)' : 'var(--ok)';
    return (
      <div key={`${l.site}-${l.ip}`} title={l.ip} style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${col}`, borderRadius: 6, padding: '6px 11px', minWidth: 122, background: 'rgba(120,130,150,.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12.5 }}>
          <span style={{ color: col, fontSize: 13 }}>●</span>{isInternet ? `🌐 ${t('wan.internet')}` : l.site}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', fontFamily: 'Consolas, monospace', marginTop: 2 }}>
          {l.alive ? `${l.latencyMs ?? '—'} ms · ${l.lossPct}% ${t('wan.loss')}` : t('wan.down')}
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '2px 0 6px' }}>
        📡 {t('wan.title')}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
        {data.internet && chip(data.internet, true)}
        {data.branches.map((b) => chip(b))}
      </div>
    </div>
  );
}
