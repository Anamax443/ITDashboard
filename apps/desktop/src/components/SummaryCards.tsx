import React from 'react';
import type { Summary, ComputerItem, DiskSummary, ServiceProblem, PerfSummary, InactiveStats } from '../api.js';
import { useI18n } from '../i18n.js';

interface Props {
  summary: Summary | null;
  computers: ComputerItem[];
  diskSummary: DiskSummary | null;
  serviceProblems: ServiceProblem[];
  perfSummary: PerfSummary | null;
  inactiveStats: InactiveStats | null;
  onClickCritical?: () => void;
  onClickError?: () => void;
  onClickWarning?: () => void;
  onClickComputers?: () => void;
  onClickDiskCritical?: () => void;
  onClickDiskWarning?: () => void;
  onClickUnreachable?: () => void;
  onClickServices?: () => void;
  onClickPerf?: () => void;
  onClickInactive?: () => void;
}

export function SummaryCards({
  summary, computers, diskSummary, serviceProblems, perfSummary, inactiveStats,
  onClickCritical, onClickError, onClickWarning, onClickComputers,
  onClickDiskCritical, onClickDiskWarning, onClickUnreachable, onClickServices, onClickPerf, onClickInactive,
}: Props) {
  const { t } = useI18n();
  // Service problems: count real (not trigger/delayed/per-user)
  const realServiceProblems = serviceProblems.filter((s) => !s.trigger_start && !s.delayed_start && !s.per_user_start);
  const servicesPcsAffected = new Set(realServiceProblems.map((s) => s.computer_id)).size;
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
    <div className="cards" style={{ gridTemplateColumns: 'repeat(10, 1fr)' }}>
      <Card label={t('cards.critical')} value={summary?.critical_24h ?? '—'} kind="critical"
        onClick={summary && summary.critical_24h > 0 ? onClickCritical : undefined} />
      <Card label={t('cards.errors')} value={summary?.error_24h ?? '—'} kind="error"
        onClick={summary && summary.error_24h > 0 ? onClickError : undefined} />
      <Card label={t('cards.warnings')} value={summary?.warning_24h ?? '—'} kind="warning"
        onClick={summary && summary.warning_24h > 0 ? onClickWarning : undefined} />
      <Card
        label={t('cards.unreachable')}
        value={unreachableCount}
        sub={unreachableSub}
        kind="critical"
        onClick={unreachableCount > 0 ? onClickUnreachable : undefined}
      />
      <Card
        label={t('cards.diskCritical')}
        value={diskSummary ? `${diskSummary.criticalPcs} PC` : '—'}
        sub={diskSummary ? `${diskSummary.criticalDrives} drives` : undefined}
        kind="critical"
        onClick={diskSummary && diskSummary.criticalPcs > 0 ? onClickDiskCritical : undefined}
      />
      <Card
        label={t('cards.diskWarning')}
        value={diskSummary ? `${diskSummary.warningPcs} PC` : '—'}
        sub={diskSummary ? `${diskSummary.warningDrives} drives` : undefined}
        kind="warning"
        onClick={diskSummary && diskSummary.warningPcs > 0 ? onClickDiskWarning : undefined}
      />
      <Card
        label={t('cards.stoppedServices')}
        value={servicesPcsAffected}
        sub={realServiceProblems.length > 0 ? `${realServiceProblems.length} service${realServiceProblems.length === 1 ? '' : 's'}` : 'all healthy'}
        kind="error"
        onClick={servicesPcsAffected > 0 ? onClickServices : undefined}
      />
      <Card
        label={t('cards.slowBootShutdown')}
        value={perfSummary ? perfSummary.affected_pcs : '—'}
        sub={perfSummary ? `${perfSummary.total_events} event${perfSummary.total_events === 1 ? '' : 's'}` : undefined}
        kind="warning"
        onClick={perfSummary && perfSummary.affected_pcs > 0 ? onClickPerf : undefined}
      />
      <Card
        label={inactiveStats ? `${t('cards.inactive')} (${inactiveStats.thresholdDays}d+)` : t('cards.inactive')}
        value={inactiveStats ? inactiveStats.enabledInactive + inactiveStats.disabledInactive : '—'}
        sub={inactiveStats
          ? t('cards.inactiveSub')
              .replace('{enabled}', String(inactiveStats.enabledInactive))
              .replace('{disabled}', String(inactiveStats.disabledInactive))
          : undefined}
        kind="warning"
        onClick={inactiveStats && (inactiveStats.enabledInactive + inactiveStats.disabledInactive) > 0 ? onClickInactive : undefined}
      />
      <Card label={t('cards.computers')} value={`${enabledCount}/${total}`} kind="info"
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
