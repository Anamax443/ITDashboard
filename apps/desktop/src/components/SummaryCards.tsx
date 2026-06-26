import React, { useState } from 'react';
import type { Summary, ComputerItem, DiskSummary, ServiceProblem, PerfSummary, InactiveStats } from '../api.js';
import { api, serviceWhitelist, isServiceWhitelisted } from '../api.js';
import { useI18n } from '../i18n.js';

// Dashboard tile layout: the operator can pin a tile to an explicit grid cell
// (column letter A–H + row number, e.g. "B3"). Pinned tiles hold their cell; the
// rest auto-flow into the remaining free cells. Persisted in the
// `dashboard.tile_layout` setting. No two pinned tiles may share a cell.
const LAYOUT_COLS = 8;
const COL_LETTERS = 'ABCDEFGH';
function parsePos(s: string): { row: number; col: number } | null {
  const m = /^([A-Ha-h])\s*0*(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const col = COL_LETTERS.indexOf(m[1]!.toUpperCase()) + 1;
  const row = parseInt(m[2]!, 10);
  if (col < 1 || col > LAYOUT_COLS || row < 1) return null;
  return { row, col };
}
function fmtPos(row: number, col: number): string {
  return `${COL_LETTERS[col - 1]}${row}`;
}

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
  esetPcRunning?: number;
  esetPcTotal?: number;
  esetSrvRunning?: number;
  esetSrvTotal?: number;
  onClickEset?: () => void;
  portsWithIssues?: number;
  portsTotal?: number;
  onClickPorts?: () => void;
  printersOffline?: number;
  printersTotal?: number;
  onClickPrinters?: () => void;
  routersTotal?: number;
  routersStale?: number;
  onClickRouters?: () => void;
  degradedDevices?: number;
  devicesUnidentified?: number;
  onClickDevices?: () => void;
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
  summary, computers, diskSummary, monitoredDiskSummary, diskAlertsEnabled, monitoredServiceSummary, serviceAlertsEnabled, serviceProblems, settings, criticalServicesDown = 0, criticalServicesTotal = 0, onClickCriticalServices, esetPcRunning = 0, esetPcTotal = 0, esetSrvRunning = 0, esetSrvTotal = 0, onClickEset, portsWithIssues = 0, portsTotal = 0, onClickPorts, printersOffline = 0, printersTotal = 0, onClickPrinters, routersTotal = 0, routersStale = 0, onClickRouters, degradedDevices = 0, devicesTotal = 0, onClickDegraded, devicesUnidentified = 0, onClickDevices, suppliesLow = 0, suppliesTotal = 0, onClickSupplies, perfSummary, inactiveStats,
  onClickCritical, onClickError, onClickWarning, onClickComputers,
  onClickDiskCritical, onClickDiskWarning, onClickMonitoredDisks, onClickMonitoredServices, onClickUnreachable, onClickServices, onClickPerf, onClickInactive,
}: Props) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<Record<string, string>>(() => {
    try { return JSON.parse(settings['dashboard.tile_layout'] || '{}') as Record<string, string>; }
    catch { return {}; }
  });
  const [editMode, setEditMode] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [layoutErr, setLayoutErr] = useState<string | null>(null);
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
  // ESET coverage: how many machines have the ESET service RUNNING, split PC vs
  // server, each over its monitored total (a gap = machines with no running ESET).
  const esetTot = esetPcTotal + esetSrvTotal;
  const esetRun = esetPcRunning + esetSrvRunning;
  const esetGap = (esetPcTotal > 0 && esetPcRunning < esetPcTotal) || (esetSrvTotal > 0 && esetSrvRunning < esetSrvTotal);
  const tiles: { id: string; el: React.ReactElement }[] = [
    { id: 'critical', el: <Card label={`${t('cards.critical')} (${windowLabel})`} value={summary?.critical_24h ?? '—'} kind={!summary ? 'info' : summary.critical_24h > 0 ? 'critical' : 'ok'} onClick={summary && summary.critical_24h > 0 ? onClickCritical : undefined} /> },
    { id: 'errors', el: <Card label={`${t('cards.errors')} (${windowLabel})`} value={summary?.error_24h ?? '—'} kind={!summary ? 'info' : summary.error_24h > 0 ? 'error' : 'ok'} onClick={summary && summary.error_24h > 0 ? onClickError : undefined} /> },
    { id: 'warnings', el: <Card label={`${t('cards.warnings')} (${windowLabel})`} value={summary?.warning_24h ?? '—'} kind={!summary ? 'info' : summary.warning_24h > 0 ? 'warning' : 'ok'} onClick={summary && summary.warning_24h > 0 ? onClickWarning : undefined} /> },
    { id: 'unreachable', el: <Card label={t('cards.unreachable')} value={unreachableCount} sub={unreachableSub} kind={unreachableCount > 0 ? 'critical' : 'ok'} onClick={unreachableCount > 0 ? onClickUnreachable : undefined} /> },
    { id: 'diskCritical', el: <Card label={t('cards.diskCritical')} value={diskSummary ? `${diskSummary.criticalPcs} PC` : '—'} sub={diskSummary ? `${diskSummary.criticalDrives} drives` : undefined} kind={!diskSummary ? 'info' : diskSummary.criticalPcs > 0 ? 'critical' : 'ok'} onClick={diskSummary && diskSummary.criticalPcs > 0 ? onClickDiskCritical : undefined} /> },
    { id: 'diskWarning', el: <Card label={t('cards.diskWarning')} value={diskSummary ? `${diskSummary.warningPcs} PC` : '—'} sub={diskSummary ? `${diskSummary.warningDrives} drives` : undefined} kind={!diskSummary ? 'info' : diskSummary.warningPcs > 0 ? 'warning' : 'ok'} onClick={diskSummary && diskSummary.warningPcs > 0 ? onClickDiskWarning : undefined} /> },
    { id: 'diskMonitor', el: <Card label={`📧 ${t('cards.diskMonitor')}`} value={mds.monitoredPcs === 0 ? '—' : `${mds.criticalPcs}/${mds.monitoredPcs} PC`} sub={mdsSub} kind={mds.monitoredPcs === 0 ? 'info' : mds.criticalPcs > 0 ? 'critical' : 'ok'} onClick={mds.monitoredPcs > 0 ? onClickMonitoredDisks : undefined} /> },
    { id: 'svcMonitor', el: <Card label={`🔔 ${t('cards.svcMonitor')}`} value={mss.monitoredPcs === 0 ? '—' : `${mss.affectedPcs}/${mss.monitoredPcs} PC`} sub={mssSub} kind={mss.monitoredPcs === 0 ? 'info' : mss.downServices > 0 ? 'critical' : 'ok'} onClick={mss.monitoredPcs > 0 ? onClickMonitoredServices : undefined} /> },
    { id: 'stoppedServices', el: <Card label={t('cards.stoppedServices')} value={servicesPcsAffected} sub={realServiceProblems.length > 0 ? `${realServiceProblems.length} service${realServiceProblems.length === 1 ? '' : 's'}` : 'all healthy'} kind={servicesPcsAffected > 0 ? 'error' : 'ok'} onClick={servicesPcsAffected > 0 ? onClickServices : undefined} /> },
    { id: 'criticalSvc', el: <Card label={`🛡 ${t('cards.criticalSvc')}`} value={criticalServicesDown} sub={criticalServicesTotal > 0 ? `${criticalServicesTotal - criticalServicesDown}/${criticalServicesTotal} OK` : '—'} kind={criticalServicesTotal === 0 ? 'info' : criticalServicesDown > 0 ? 'critical' : 'ok'} onClick={criticalServicesTotal > 0 ? onClickCriticalServices : undefined} /> },
    { id: 'ports', el: <Card label={`🔌 ${t('cards.ports')}`} value={portsTotal === 0 ? '—' : `${portsWithIssues}/${portsTotal} PC`} sub={portsTotal > 0 ? `${portsTotal - portsWithIssues}/${portsTotal} OK` : '—'} kind={portsTotal === 0 ? 'info' : portsWithIssues > 0 ? 'critical' : 'ok'} onClick={portsTotal > 0 ? onClickPorts : undefined} /> },
    { id: 'printers', el: <Card label={`🖨 ${t('cards.printers')}`} value={printersTotal === 0 ? '—' : `${printersOffline}/${printersTotal}`} sub={printersTotal === 0 ? t('cards.printersNone') : printersOffline > 0 ? `${printersOffline} ${t('cards.printersOffline')}` : `${printersTotal} ${t('cards.printersOk')}`} kind={printersTotal === 0 ? 'info' : printersOffline > 0 ? 'critical' : 'ok'} onClick={printersTotal > 0 ? onClickPrinters : undefined} /> },
    { id: 'degraded', el: <Card label={`📉 ${t('cards.degraded')}`} value={devicesTotal === 0 ? '—' : degradedDevices} sub={devicesTotal === 0 ? '—' : degradedDevices > 0 ? t('cards.degradedSub') : t('cards.degradedOk')} kind={devicesTotal === 0 ? 'info' : degradedDevices > 0 ? 'warning' : 'ok'} onClick={degradedDevices > 0 ? onClickDegraded : undefined} /> },
    { id: 'devices', el: <Card label={`🖧 ${t('cards.devices')}`} value={devicesTotal === 0 ? '—' : `${devicesUnidentified}/${devicesTotal}`} sub={devicesTotal === 0 ? '—' : devicesUnidentified > 0 ? `${devicesUnidentified} ${t('cards.devicesUnident')}` : t('cards.devicesAllSorted')} kind={devicesTotal === 0 ? 'info' : devicesUnidentified > 0 ? 'warning' : 'ok'} onClick={devicesTotal > 0 ? onClickDevices : undefined} /> },
    { id: 'routers', el: <Card label={`📡 ${t('cards.routers')}`} value={routersTotal === 0 ? '—' : `${routersStale}/${routersTotal}`} sub={routersTotal === 0 ? '—' : routersStale > 0 ? `${routersStale} ${t('cards.routersStale')}` : t('cards.routersAllFresh')} kind={routersTotal === 0 ? 'info' : routersStale > 0 ? 'critical' : 'ok'} onClick={routersTotal > 0 ? onClickRouters : undefined} /> },
    { id: 'supplies', el: <Card label={`🖨 ${t('cards.supplies')}`} value={suppliesTotal === 0 ? '—' : `${suppliesLow}/${suppliesTotal}`} sub={suppliesTotal === 0 ? t('cards.suppliesNone') : suppliesLow > 0 ? `${suppliesLow} ${t('cards.suppliesLow')}` : t('cards.suppliesOk')} kind={suppliesTotal === 0 ? 'info' : suppliesLow > 0 ? 'warning' : 'ok'} onClick={suppliesTotal > 0 ? onClickSupplies : undefined} /> },
    { id: 'slowBoot', el: <Card label={t('cards.slowBootShutdown')} value={perfSummary ? perfSummary.affected_pcs : '—'} sub={perfSummary ? `${perfSummary.total_events} event${perfSummary.total_events === 1 ? '' : 's'}` : undefined} kind={!perfSummary ? 'info' : perfSummary.affected_pcs > 0 ? 'warning' : 'ok'} onClick={perfSummary && perfSummary.affected_pcs > 0 ? onClickPerf : undefined} /> },
    { id: 'inactive', el: <Card label={inactiveStats ? `${t('cards.inactive')} (${inactiveStats.thresholdDays}d+)` : t('cards.inactive')} value={inactiveStats ? inactiveStats.enabledInactive + inactiveStats.disabledInactive : '—'} sub={inactiveStats ? t('cards.inactiveSub').replace('{enabled}', String(inactiveStats.enabledInactive)).replace('{disabled}', String(inactiveStats.disabledInactive)) : undefined} kind={!inactiveStats ? 'info' : (inactiveStats.enabledInactive + inactiveStats.disabledInactive) > 0 ? 'warning' : 'ok'} onClick={inactiveStats && (inactiveStats.enabledInactive + inactiveStats.disabledInactive) > 0 ? onClickInactive : undefined} /> },
    { id: 'eset', el: <Card label={t('cards.eset')} value={`${esetRun}/${esetTot}`} sub={`PC ${esetPcRunning}/${esetPcTotal} · ${t('cards.esetSrv')} ${esetSrvRunning}/${esetSrvTotal}`} kind={esetTot === 0 ? 'info' : esetGap ? 'warning' : 'ok'} onClick={onClickEset} /> },
    { id: 'computers', el: <Card label={t('cards.computers')} value={`${enabledCount}/${total}`} kind="info" onClick={onClickComputers} /> },
  ];

  // --- Tile placement: pinned overrides hold their cell, the rest auto-flow ---
  const overrides = new Map<string, { row: number; col: number }>();
  for (const tl of tiles) {
    const raw = layout[tl.id];
    if (raw) { const p = parsePos(raw); if (p) overrides.set(tl.id, p); }
  }
  const cellKey = (r: number, c: number) => `${r}:${c}`;
  const occupied = new Set<string>();
  for (const p of overrides.values()) occupied.add(cellKey(p.row, p.col));
  const cursor = { row: 1, col: 1 };
  const takeFree = () => {
    while (occupied.has(cellKey(cursor.row, cursor.col))) {
      cursor.col++; if (cursor.col > LAYOUT_COLS) { cursor.col = 1; cursor.row++; }
    }
    const pos = { row: cursor.row, col: cursor.col };
    occupied.add(cellKey(pos.row, pos.col));
    cursor.col++; if (cursor.col > LAYOUT_COLS) { cursor.col = 1; cursor.row++; }
    return pos;
  };
  const placed = tiles.map((tl) => ({ tile: tl, ...(overrides.get(tl.id) ?? takeFree()) }));

  const persist = (next: Record<string, string>) => {
    setLayout(next);
    api.saveSettings({ 'dashboard.tile_layout': JSON.stringify(next) }).catch(() => {});
  };
  const commitEdit = (tileId: string) => {
    const v = editVal.trim();
    if (v === '') { const next = { ...layout }; delete next[tileId]; persist(next); setEditing(null); setLayoutErr(null); return; }
    const p = parsePos(v);
    if (!p) { setLayoutErr(t('cards.layout.invalid')); return; }
    // No two PINNED tiles may share a cell (auto-flow tiles never collide — they
    // fill whatever cells are left after the pins).
    for (const tl of tiles) {
      if (tl.id === tileId) continue;
      const raw = layout[tl.id]; if (!raw) continue;
      const op = parsePos(raw); if (!op) continue;
      if (op.row === p.row && op.col === p.col) { setLayoutErr(t('cards.layout.taken')); return; }
    }
    persist({ ...layout, [tileId]: fmtPos(p.row, p.col) });
    setEditing(null); setLayoutErr(null);
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginBottom: editMode ? 6 : 0 }}>
        {editMode && <span style={{ fontSize: 11, color: 'var(--text-dim)', marginRight: 'auto' }}>{t('cards.layout.hint')}</span>}
        <button
          onClick={() => { setEditMode(!editMode); setEditing(null); setLayoutErr(null); }}
          title={t('cards.layout.edit')}
          style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer', background: editMode ? 'var(--accent)' : 'rgba(120,130,150,0.18)', color: editMode ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 6 }}
        >{editMode ? t('cards.layout.done') : '✏️'}</button>
      </div>
      <div className="cards" style={{ display: 'grid', gridTemplateColumns: `repeat(${LAYOUT_COLS}, minmax(140px, 1fr))`, alignItems: 'stretch', justifyContent: 'start' }}>
        {placed.map(({ tile, row, col }) => (
          <div key={tile.id} style={{ gridColumn: col, gridRow: row, position: 'relative' }}>
            {editMode && <div style={{ position: 'absolute', inset: 0, zIndex: 3 }} />}
            {editMode && (editing === tile.id ? (
              <div style={{ position: 'absolute', top: 3, left: 4, zIndex: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                  <input
                    autoFocus
                    value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(tile.id); else if (e.key === 'Escape') { setEditing(null); setLayoutErr(null); } }}
                    placeholder={t('cards.layout.placeholder')}
                    style={{ width: 50, fontSize: 11, padding: '1px 4px' }}
                  />
                  <button onClick={() => commitEdit(tile.id)} title="OK" style={{ fontSize: 11, padding: '1px 5px', cursor: 'pointer' }}>✓</button>
                  <button onClick={() => { setEditing(null); setLayoutErr(null); }} title={t('cards.layout.cancel')} style={{ fontSize: 11, padding: '1px 5px', cursor: 'pointer' }}>✕</button>
                </div>
                {layoutErr && <span style={{ fontSize: 10, color: 'var(--critical)', background: 'var(--surface)', padding: '1px 3px', borderRadius: 4 }}>{layoutErr}</span>}
              </div>
            ) : (
              <button
                onClick={() => { setEditing(tile.id); setEditVal(layout[tile.id] ?? ''); setLayoutErr(null); }}
                title={t('cards.layout.edit')}
                style={{ position: 'absolute', top: 3, left: 4, zIndex: 6, fontSize: 10, lineHeight: 1, padding: '2px 5px', background: layout[tile.id] ? 'var(--accent)' : 'rgba(120,130,150,0.25)', color: layout[tile.id] ? '#fff' : 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}
              >✏️ {fmtPos(row, col)}</button>
            ))}
            {React.cloneElement(tile.el, { key: tile.id })}
          </div>
        ))}
      </div>
    </>
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
