import React from 'react';
import type { Summary, ComputerItem, DiskSummary } from '../api.js';

interface Props {
  summary: Summary | null;
  computers: ComputerItem[];
  diskSummary: DiskSummary | null;
  onClickDiskCritical?: () => void;
  onClickDiskWarning?: () => void;
}

export function SummaryCards({ summary, computers, diskSummary, onClickDiskCritical, onClickDiskWarning }: Props) {
  const enabledCount = computers.filter((c) => c.enabled).length;
  const total = computers.length;
  return (
    <div className="cards" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
      <Card label="Critical events (24h)" value={summary?.critical_24h ?? '—'} kind="critical" />
      <Card label="Errors (24h)" value={summary?.error_24h ?? '—'} kind="error" />
      <Card label="Warnings (24h)" value={summary?.warning_24h ?? '—'} kind="warning" />
      <Card
        label="Disk critical"
        value={diskSummary ? `${diskSummary.criticalPcs} PC` : '—'}
        sub={diskSummary ? `${diskSummary.criticalDrives} drives` : undefined}
        kind="critical"
        onClick={diskSummary && diskSummary.criticalPcs > 0 ? onClickDiskCritical : undefined}
      />
      <Card
        label="Disk warning"
        value={diskSummary ? `${diskSummary.warningPcs} PC` : '—'}
        sub={diskSummary ? `${diskSummary.warningDrives} drives` : undefined}
        kind="warning"
        onClick={diskSummary && diskSummary.warningPcs > 0 ? onClickDiskWarning : undefined}
      />
      <Card label="Computers" value={`${enabledCount}/${total}`} kind="info" />
    </div>
  );
}

function Card({ label, value, sub, kind, onClick }: { label: string; value: number | string; sub?: string; kind: 'critical' | 'error' | 'warning' | 'info'; onClick?: () => void }) {
  return (
    <div
      className={`card ${kind}`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', userSelect: 'none' }}
      title={onClick ? 'Click to filter computers' : undefined}
    >
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
