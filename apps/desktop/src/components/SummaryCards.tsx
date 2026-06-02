import React from 'react';
import type { Summary, ComputerItem, DiskSummary } from '../api.js';

interface Props {
  summary: Summary | null;
  computers: ComputerItem[];
  diskSummary: DiskSummary | null;
  onClickCritical?: () => void;
  onClickError?: () => void;
  onClickWarning?: () => void;
  onClickComputers?: () => void;
  onClickDiskCritical?: () => void;
  onClickDiskWarning?: () => void;
  onClickUnreachable?: () => void;
}

export function SummaryCards({
  summary, computers, diskSummary,
  onClickCritical, onClickError, onClickWarning, onClickComputers,
  onClickDiskCritical, onClickDiskWarning, onClickUnreachable,
}: Props) {
  const enabledCount = computers.filter((c) => c.enabled).length;
  const total = computers.length;
  const monitoredFailing = computers.filter((c) => c.enabled && c.monitor_enabled && (c.consecutive_failures ?? 0) > 0);
  const unreachableCount = monitoredFailing.length;
  const offlineCount = monitoredFailing.filter((c) => c.last_status === 'offline').length;
  const rpcCount = monitoredFailing.filter((c) => c.last_status === 'rpc_unavailable').length;
  const accessCount = monitoredFailing.filter((c) => c.last_status === 'access_denied').length;
  const unknownCount = unreachableCount - offlineCount - rpcCount - accessCount;
  const unreachableSub =
    [
      offlineCount > 0 ? `${offlineCount} offline` : null,
      rpcCount > 0 ? `${rpcCount} RPC` : null,
      accessCount > 0 ? `${accessCount} auth` : null,
      unknownCount > 0 ? `${unknownCount} other` : null,
    ].filter(Boolean).join(' · ') || 'RPC fail / offline';
  return (
    <div className="cards" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
      <Card label="Critical events (24h)" value={summary?.critical_24h ?? '—'} kind="critical"
        onClick={summary && summary.critical_24h > 0 ? onClickCritical : undefined} />
      <Card label="Errors (24h)" value={summary?.error_24h ?? '—'} kind="error"
        onClick={summary && summary.error_24h > 0 ? onClickError : undefined} />
      <Card label="Warnings (24h)" value={summary?.warning_24h ?? '—'} kind="warning"
        onClick={summary && summary.warning_24h > 0 ? onClickWarning : undefined} />
      <Card
        label="Unreachable"
        value={unreachableCount}
        sub={unreachableSub}
        kind="critical"
        onClick={unreachableCount > 0 ? onClickUnreachable : undefined}
      />
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
      <Card label="Computers" value={`${enabledCount}/${total}`} kind="info"
        onClick={onClickComputers} />
    </div>
  );
}

function Card({ label, value, sub, kind, onClick }: { label: string; value: number | string; sub?: string; kind: 'critical' | 'error' | 'warning' | 'info'; onClick?: () => void }) {
  return (
    <div
      className={`card ${kind}`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', userSelect: 'none' }}
      title={onClick ? 'Click to drill down' : undefined}
    >
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
