import React from 'react';
import type { TimelineBucket } from '../api.js';

interface Props {
  buckets: TimelineBucket[];
  hours: number;
}

const COLORS = { 1: 'var(--critical)', 2: 'var(--error)', 3: 'var(--warning)' } as const;
const LEVELS = [3, 2, 1] as const; // stack order: warning bottom, critical top

export function TimelineChart({ buckets, hours }: Props) {
  // Group by bucket
  const byBucket = new Map<string, { 1: number; 2: number; 3: number; total: number }>();
  for (const b of buckets) {
    const k = b.bucket;
    if (!byBucket.has(k)) byBucket.set(k, { 1: 0, 2: 0, 3: 0, total: 0 });
    const x = byBucket.get(k)!;
    if (b.level === 1 || b.level === 2 || b.level === 3) {
      x[b.level] = b.cnt;
      x.total += b.cnt;
    }
  }

  // Fill missing hour buckets
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const points: { ts: Date; counts: { 1: number; 2: number; 3: number; total: number } }[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const ts = new Date(now.getTime() - i * 3600 * 1000);
    const key = ts.toISOString();
    // SQL bucket is at start of hour UTC; match by hour
    const matchKey = Array.from(byBucket.keys()).find((k) => new Date(k).getTime() === ts.getTime());
    const counts = matchKey ? byBucket.get(matchKey)! : { 1: 0, 2: 0, 3: 0, total: 0 };
    points.push({ ts, counts });
  }

  const maxTotal = Math.max(1, ...points.map((p) => p.counts.total));

  const W = 800;
  const H = 120;
  const padX = 8;
  const padY = 8;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const barW = (innerW / points.length) * 0.85;
  const gap = (innerW / points.length) * 0.15;

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header">
        <h2>Events timeline ({hours}h)</h2>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-dim)' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: COLORS[1], marginRight: 4 }}/>Critical</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: COLORS[2], marginRight: 4 }}/>Error</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: COLORS[3], marginRight: 4 }}/>Warning</span>
        </div>
      </div>
      <div className="panel-body" style={{ overflow: 'visible' }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block' }}>
          {points.map((p, i) => {
            const x = padX + i * (barW + gap);
            let yCursor = padY + innerH;
            const heights = LEVELS.map((lvl) => {
              const v = p.counts[lvl];
              const h = (v / maxTotal) * innerH;
              const rect = { x, y: yCursor - h, w: barW, h, lvl };
              yCursor -= h;
              return rect;
            });
            return (
              <g key={p.ts.getTime()}>
                {heights.map((r) => (
                  <rect key={r.lvl} x={r.x} y={r.y} width={r.w} height={r.h} fill={COLORS[r.lvl as 1 | 2 | 3]}>
                    <title>{p.ts.toLocaleString('cs-CZ')} — total {p.counts.total}</title>
                  </rect>
                ))}
              </g>
            );
          })}
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
          <span>{points[0]?.ts.toLocaleTimeString('cs-CZ', { hour: '2-digit' })}</span>
          <span>now</span>
        </div>
      </div>
    </div>
  );
}
