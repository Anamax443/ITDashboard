import React from 'react';
import type { DiskItem, DiskThresholds } from '../api.js';
import { evaluateDisk } from '../api.js';

const COLOR_FOR: Record<'critical' | 'warning' | 'ok', string> = {
  critical: 'var(--critical)',
  warning: 'var(--warning)',
  ok: 'var(--ok)',
};

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + ' GB';
}

export function DisksCell({ disks, thresholds }: { disks: DiskItem[]; thresholds: DiskThresholds }) {
  if (disks.length === 0) return <span style={{ color: 'var(--text-dim)' }}>—</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {disks.map((d) => {
        const status = evaluateDisk(d, thresholds);
        const usedPct = d.total_bytes > 0 ? (1 - d.free_bytes / d.total_bytes) * 100 : 0;
        const color = COLOR_FOR[status];
        return (
          <div key={d.id} title={`${d.drive_letter} ${d.volume_label ?? ''} — Free ${formatGb(d.free_bytes)} of ${formatGb(d.total_bytes)} (${(100 - usedPct).toFixed(1)}% free)`} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10 }}>
            <span style={{ width: 22, fontWeight: 600, color: color }}>{d.drive_letter}</span>
            <div style={{ flex: 1, height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden', position: 'relative', minWidth: 60 }}>
              <div style={{ position: 'absolute', inset: 0, width: `${usedPct}%`, background: color, opacity: 0.8 }} />
            </div>
            <span style={{ color: 'var(--text-dim)', minWidth: 50, textAlign: 'right' }}>{formatGb(d.free_bytes)}</span>
          </div>
        );
      })}
    </div>
  );
}
