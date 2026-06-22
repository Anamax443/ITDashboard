import React from 'react';
import type { Summary, ComputerItem, DiskSummary, ServiceProblem, PerfSummary, InactiveStats } from '../api.js';
import { serviceWhitelist, isServiceWhitelisted } from '../api.js';
import { useI18n } from '../i18n.js';

interface Props {
  summary: Summary | null;
  computers: ComputerItem[];
  diskSummary: DiskSummary | null;
  monitoredDiskSummary?: { monitoredPcs: number; criticalPcs: number; criticalDrives: number } | null;
  diskAlertsEnabled?: boolean;
  monitoredServiceSummary?: { monitoredPcs: number; downServices: number; affectedPcs: number } | null;
  serviceAlertsEnabled?: boolean;
  serviceProblems: ServiceProblem[];
  settings: Record<string, string>;
  criticalServicesDown?: number;
  criticalServicesTotal?: number;
  onClickCriticalServices?: () => void;
  portsWithIssues?: number;
  portsTotal?: number;
  onClickPorts?: () => void;
  printersOffline?: number;
  printersTotal?: number;
  onClickPrinters?: () => void;
  degradedDevices?: number;
  devicesTotal?: number;
  onClickDegraded?: () => void;
  suppliesLow?: number;
  suppliesTotal?: number;
  onClickSupplies?: () => void;
  perfSummary: PerfSummary | null;
  inactiveStats: InactiveStats | null;
  onClickCritical?: () => void;
  onClickError?: () => void;
  onClickWarning?: () => void;
  onClickComputers?: () => void;
  onClickDiskCritical?: () => void;
  onClickDiskWarning?: () => void;
  onClickMonitoredDisks?: () => void;
  onClickMonitoredServices?: () => void;
  onClickUnreachable?: () => void;
  onClickServices?: () => void;
  onClickPerf?: () => void;
  onClickInactive?: () => void;
}

export function SummaryCards({
  summary, computers, diskSummary, monitoredDiskSummary, diskAlertsEnabled, monitoredServiceSummary, serviceAlertsEnabled, serviceProblems, settings, criticalServicesDown = 0, criticalServicesTotal = 0, onClickCriticalServices, portsWithIssues = 0, portsTotal = 0, onClickPorts, printersOffline = 0, printersTotal = 0, onClickPrinters, degradedDevices = 0, devicesTotal = 0, onClickDegraded, suppliesLow = 0, suppliesTotal = 0, onClickSupplies, perfSummary, inactiveStats,
  onClickCritical, onClickError, onClickWarning, onClickComputers,
  onClickDiskCritical, onClickDiskWarning, onClickMonitoredDisks, onClickMonitoredServices, onClickUnreachable, onClickServices, onClickPerf, onClickInactive,
}: Props) {
  const { t } = useI18n();
  const windowDays = summary?.window_days ?? 1;
  const windowLabel = windowDays === 1 ? '24h' : `${windowDays}d`;
  // Service problems: count real (not trigger/delayed/per-user) and not on the
  // global ignore whitelist (e.g. browser/Google updaters that legitimately idle).
  const svcWhitelist = serviceWhitelist(settings);
  const realServiceProblems = serviceProblems.filter(
    (s) => !s.trigger_start && !s.delayed_start && !s.per_user_start
      && !isServiceWhitelisted(s.service_name, s.display_name, svcWhitelist),
  );
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
  const mds = monitoredDiskSummary ?? { monitoredPcs: 0, criticalPcs: 0, criticalDrives: 0 };
  const mdsSub = mds.monitoredPcs === 0
    ? t('cards.diskMonitorNone')
    : mds.criticalPcs > 0
      ? `${mds.criticalDrives} ${t('cards.diskMonitorDrives')}${diskAlertsEnabled ? '' : ` · ${t('cards.diskMonitorOff')}`}`
      : `${mds.monitoredPcs} ${t('cards.diskMonitorWatched')}${diskAlertsEnabled ? '' : ` · ${t('cards.diskMonitorOff')}`}`;
  const mss = monitoredServiceSummary ?? { monitoredPcs: 0, downServices: 0, affectedPcs: 0 };
  const mssSub = mss.monitoredPcs === 0
    ? t('cards.diskMonitorNone')
    : mss.downServices > 0
      ? `${mss.downServices} ${t('cards.svcMonitorDown')}${serviceAlertsEnabled ? '' : ` · ${t('cards.diskMonitorOff')}`}`
      : `${mss.monitoredPcs} ${t('cards.diskMonitorWatched')}${serviceAlertsEnabled ? '' : ` · ${t('cards.diskMonitorOff')}`}`;
  return (
    <div className="cards">
      <Card label={`${t('cards.critical')} (${windowLabel})`} value={summary?.critical_24h ?? '—'} kind={!summary ? 'info' : summary.critical_24h > 0 ? 'critical' : 'ok'}
        onClick={summary && summary.critical_24h > 0 ? onClickCritical : undefined} />
      <Card label={`${t('cards.errors')} (${windowLabel})`} value={summary?.error_24h ?? '—'} kind={!summary ? 'info' : summary.error_24h > 0 ? 'error' : 'ok'}
        onClick={summary && summary.error_24h > 0 ? onClickError : undefined} />
      <Card label={`${t('cards.warnings')} (${windowLabel})`} value={summary?.warning_24h ?? '—'} kind={!summary ? 'info' : summary.warning_24h > 0 ? 'warning' : 'ok'}
        onClick={summary && summary.warning_24h > 0 ? onClickWarning : undefined} />
      <Card
        label={t('cards.unreachable')}
        value={unreachableCount}
        sub={unreachableSub}
        kind={unreachableCount > 0 ? 'critical' : 'ok'}
        onClick={unreachableCount > 0 ? onClickUnreachable : undefined}
      />
      <Card
        label={t('cards.diskCritical')}
        value={diskSummary ? `${diskSummary.criticalPcs} PC` : '—'}
        sub={diskSummary ? `${diskSummary.criticalDrives} drives` : undefined}
        kind={!diskSummary ? 'info' : diskSummary.criticalPcs > 0 ? 'critical' : 'ok'}
        onClick={diskSummary && diskSummary.criticalPcs > 0 ? onClickDiskCritical : undefined}
      />
      <Card
        label={t('cards.diskWarning')}
        value={diskSummary ? `${diskSummary.warningPcs} PC` : '—'}
        sub={diskSummary ? `${diskSummary.warningDrives} drives` : undefined}
        kind={!diskSummary ? 'info' : diskSummary.warningPcs > 0 ? 'warning' : 'ok'}
        onClick={diskSummary && diskSummary.warningPcs > 0 ? onClickDiskWarning : undefined}
      />
      <Card
        label={`📧 ${t('cards.diskMonitor')}`}
        value={mds.monitoredPcs === 0 ? '—' : `${mds.criticalPcs}/${mds.monitoredPcs} PC`}
        sub={mdsSub}
        kind={mds.monitoredPcs === 0 ? 'info' : mds.criticalPcs > 0 ? 'critical' : 'ok'}
        onClick={mds.monitoredPcs > 0 ? onClickMonitoredDisks : undefined}
      />
      <Card
        label={`🔔 ${t('cards.svcMonitor')}`}
        value={mss.monitoredPcs === 0 ? '—' : `${mss.affectedPcs}/${mss.monitoredPcs} PC`}
        sub={mssSub}
        kind={mss.monitoredPcs === 0 ? 'info' : mss.downServices > 0 ? 'critical' : 'ok'}
        onClick={mss.monitoredPcs > 0 ? onClickMonitoredServices : undefined}
      />
      <Card
        label={t('cards.stoppedServices')}
        value={servicesPcsAffected}
        sub={realServiceProblems.length > 0 ? `${realServiceProblems.length} service${realServiceProblems.length === 1 ? '' : 's'}` : 'all healthy'}
        kind={servicesPcsAffected > 0 ? 'error' : 'ok'}
        onClick={servicesPcsAffected > 0 ? onClickServices : undefined}
      />
      <Card
        label={`🛡 ${t('cards.criticalSvc')}`}
        value={criticalServicesDown}
        sub={criticalServicesTotal > 0 ? `${criticalServicesTotal - criticalServicesDown}/${criticalServicesTotal} OK` : '—'}
        kind={criticalServicesTotal === 0 ? 'info' : criticalServicesDown > 0 ? 'critical' : 'ok'}
        onClick={criticalServicesTotal > 0 ? onClickCriticalServices : undefined}
      />
      <Card
        label={`🔌 ${t('cards.ports')}`}
        value={portsTotal === 0 ? '—' : `${portsWithIssues}/${portsTotal} PC`}
        sub={portsTotal > 0 ? `${portsTotal - portsWithIssues}/${portsTotal} OK` : '—'}
        kind={portsTotal === 0 ? 'info' : portsWithIssues > 0 ? 'critical' : 'ok'}
        onClick={portsTotal > 0 ? onClickPorts : undefined}
      />
      <Card
        label={`🖨 ${t('cards.printers')}`}
        value={printersTotal === 0 ? '—' : `${printersOffline}/${printersTotal}`}
        sub={printersTotal === 0 ? t('cards.printersNone') : printersOffline > 0 ? `${printersOffline} ${t('cards.printersOffline')}` : `${printersTotal} ${t('cards.printersOk')}`}
        kind={printersTotal === 0 ? 'info' : printersOffline > 0 ? 'critical' : 'ok'}
        onClick={printersTotal > 0 ? onClickPrinters : undefined}
      />
      <Card
        label={`📉 ${t('cards.degraded')}`}
        value={devicesTotal === 0 ? '—' : degradedDevices}
        sub={devicesTotal === 0 ? '—' : degradedDevices > 0 ? t('cards.degradedSub') : t('cards.degradedOk')}
        kind={devicesTotal === 0 ? 'info' : degradedDevices > 0 ? 'warning' : 'ok'}
        onClick={degradedDevices > 0 ? onClickDegraded : undefined}
      />
      <Card
        label={`🖨 ${t('cards.supplies')}`}
        value={suppliesTotal === 0 ? '—' : `${suppliesLow}/${suppliesTotal}`}
        sub={suppliesTotal === 0 ? t('cards.suppliesNone') : suppliesLow > 0 ? `${suppliesLow} ${t('cards.suppliesLow')}` : t('cards.suppliesOk')}
        kind={suppliesTotal === 0 ? 'info' : suppliesLow > 0 ? 'warning' : 'ok'}
        onClick={suppliesTotal > 0 ? onClickSupplies : undefined}
      />
      <Card
        label={t('cards.slowBootShutdown')}
        value={perfSummary ? perfSummary.affected_pcs : '—'}
        sub={perfSummary ? `${perfSummary.total_events} event${perfSummary.total_events === 1 ? '' : 's'}` : undefined}
        kind={!perfSummary ? 'info' : perfSummary.affected_pcs > 0 ? 'warning' : 'ok'}
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
        kind={!inactiveStats ? 'info' : (inactiveStats.enabledInactive + inactiveStats.disabledInactive) > 0 ? 'warning' : 'ok'}
        onClick={inactiveStats && (inactiveStats.enabledInactive + inactiveStats.disabledInactive) > 0 ? onClickInactive : undefined}
      />
      <Card label={t('cards.computers')} value={`${enabledCount}/${total}`} kind="info"
        onClick={onClickComputers} />
    </div>
  );
}

export function Card({ label, value, sub, kind, onClick, badge, badgeTitle }: { label: string; value: number | string; sub?: string; kind: 'critical' | 'error' | 'warning' | 'info' | 'ok'; onClick?: () => void; badge?: React.ReactNode; badgeTitle?: string }) {
  return (
    <div
      className={`card ${kind}`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', userSelect: 'none', position: 'relative' }}
      title={onClick ? 'Click to drill down' : undefined}
    >
      {badge != null && (
        <div
          title={badgeTitle}
          style={{
            position: 'absolute', top: 6, right: 8, fontSize: 11, fontWeight: 700,
            lineHeight: 1, padding: '3px 7px', borderRadius: 10,
            background: 'rgba(120,130,150,0.22)', color: 'var(--text)',
            border: '1px solid var(--border, rgba(255,255,255,0.15))',
          }}
        >{badge}</div>
      )}
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
