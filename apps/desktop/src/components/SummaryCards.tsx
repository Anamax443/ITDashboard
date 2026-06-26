import React, { useState, useEffect } from 'react';
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
// '1' = full (important), 'B' = half height + smaller font.
type TileSize = '1' | 'B';
type TileLayout = Record<string, { pos?: string; size?: TileSize }>;
function loadLayout(raw: string | undefined): TileLayout {
  try {
    const obj = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: TileLayout = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') out[k] = { pos: v };               // legacy format
      else if (v && typeof v === 'object') {
        const o = v as { pos?: unknown; size?: unknown };
        out[k] = { pos: typeof o.pos === 'string' ? o.pos : undefined, size: o.size === 'B' ? 'B' : '1' };
      }
    }
    return out;
  } catch { return {}; }
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
  problemPcs?: { count: number; threshold: number; windowDays: number; snoozed: number } | null;
  onClickProblemPcs?: () => void;
  osBreakdown?: { count: number; totalPcs: number; stale: number } | null;
  onClickOs?: () => void;
}

export function SummaryCards({
  summary, computers, diskSummary, monitoredDiskSummary, diskAlertsEnabled, monitoredServiceSummary, serviceAlertsEnabled, serviceProblems, settings, criticalServicesDown = 0, criticalServicesTotal = 0, onClickCriticalServices, esetPcRunning = 0, esetPcTotal = 0, esetSrvRunning = 0, esetSrvTotal = 0, onClickEset, portsWithIssues = 0, portsTotal = 0, onClickPorts, printersOffline = 0, printersTotal = 0, onClickPrinters, routersTotal = 0, routersStale = 0, onClickRouters, degradedDevices = 0, devicesTotal = 0, onClickDegraded, devicesUnidentified = 0, onClickDevices, suppliesLow = 0, suppliesTotal = 0, onClickSupplies, perfSummary, inactiveStats,
  onClickCritical, onClickError, onClickWarning, onClickComputers,
  onClickDiskCritical, onClickDiskWarning, onClickMonitoredDisks, onClickMonitoredServices, onClickUnreachable, onClickServices, onClickPerf, onClickInactive,
  problemPcs, onClickProblemPcs, osBreakdown, onClickOs,
}: Props) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<TileLayout>(() => loadLayout(settings['dashboard.tile_layout']));
  // Settings load async — re-sync once the persisted value arrives (or changes),
  // so a refresh restores the saved arrangement instead of resetting to default.
  const rawLayout = settings['dashboard.tile_layout'] || '';
  useEffect(() => { setLayout(loadLayout(rawLayout)); }, [rawLayout]);
  const [editMode, setEditMode] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [editSize, setEditSize] = useState<TileSize>('1');
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
    ...(problemPcs ? [{ id: 'problemPcs', el: <Card label={`🩺 ${t('health.reinstall')}`} value={problemPcs.count} sub={`${t('health.score')} ≥ ${problemPcs.threshold} · ${problemPcs.windowDays} d`} kind={problemPcs.count > 0 ? 'critical' as const : 'ok' as const} onClick={onClickProblemPcs} badge={problemPcs.snoozed > 0 ? `💤 ${problemPcs.snoozed}` : undefined} /> }] : []),
    ...(osBreakdown ? [{ id: 'osBreakdown', el: <Card label={`📊 ${t('os.title')}`} value={osBreakdown.count} sub={`${osBreakdown.totalPcs} PC${osBreakdown.stale > 0 ? ` · ${osBreakdown.stale} ${t('os.stale')}` : ''}`} kind="info" onClick={onClickOs} /> }] : []),
  ];

  // --- Tile placement ---------------------------------------------------------
  // Each tile has a cell (column letter + row) and a size ('1' = full, 'B' = half
  // height + smaller font). Placed tiles hold their cell; the rest auto-flow into
  // free cells. Editing FREEZES every tile's current cell first, so later edits
  // move only the tiles involved (no reshuffle of the whole grid).
  const sizeOf = (id: string): TileSize => (layout[id]?.size === 'B' ? 'B' : '1');
  const overrides = new Map<string, { row: number; col: number }>();
  for (const tl of tiles) {
    const raw = layout[tl.id]?.pos;
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
  const placed = tiles.map((tl) => ({ tile: tl, size: sizeOf(tl.id), ...(overrides.get(tl.id) ?? takeFree()) }));

  // Full explicit snapshot — every tile pinned to its current cell. Edits start
  // from this so unrelated tiles never move.
  const freeze = (): TileLayout => {
    const out: TileLayout = {};
    for (const pl of placed) out[pl.tile.id] = { pos: fmtPos(pl.row, pl.col), size: pl.size };
    return out;
  };
  const persist = (next: TileLayout) => {
    setLayout(next);
    api.saveSettings({ 'dashboard.tile_layout': JSON.stringify(next) }).catch(() => {});
  };
  const openEditor = (tileId: string) => {
    setEditing(tileId);
    setEditVal(layout[tileId]?.pos ?? '');
    setEditSize(sizeOf(tileId));
    setLayoutErr(null);
  };
  // Apply BOTH position and size from the editor in one go.
  const commit = (tileId: string) => {
    const v = editVal.trim();
    const p = v === '' ? null : parsePos(v);
    if (v !== '' && !p) { setLayoutErr(t('cards.layout.invalid')); return; }
    const next = freeze();
    const myOld = next[tileId]?.pos;
    if (p) {
      const targetPos = fmtPos(p.row, p.col);
      // Swap with whoever holds the target cell — keeps every cell unique, no dupes.
      const occupantId = Object.keys(next).find((id) => id !== tileId && next[id]!.pos === targetPos);
      if (occupantId && myOld) next[occupantId] = { ...next[occupantId], pos: myOld };
      next[tileId] = { pos: targetPos, size: editSize };
    } else {
      next[tileId] = { size: editSize };  // empty position = auto-flow
    }
    persist(next); setEditing(null); setLayoutErr(null);
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
      <div className="cards" style={{ display: 'grid', gridTemplateColumns: `repeat(${LAYOUT_COLS}, minmax(140px, 1fr))`, alignItems: 'start', justifyContent: 'start' }}>
        {placed.map(({ tile, row, col, size }) => (
          <div key={tile.id} style={{ gridColumn: col, gridRow: row, position: 'relative', height: size === 'B' ? 42 : 84 }}>
            {editMode && <div style={{ position: 'absolute', inset: 0, zIndex: 3 }} />}
            {editMode && editing !== tile.id && (
              <button
                onClick={() => openEditor(tile.id)}
                title={t('cards.layout.edit')}
                style={{ position: 'absolute', top: 3, left: 4, zIndex: 6, fontSize: 10, lineHeight: 1, padding: '2px 6px', background: layout[tile.id]?.pos ? 'var(--accent)' : 'rgba(120,130,150,0.35)', color: layout[tile.id]?.pos ? '#fff' : 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}
              >✏️ {fmtPos(row, col)} · {size === 'B' ? t('cards.layout.halfShort') : t('cards.layout.fullShort')}</button>
            )}
            {editMode && editing === tile.id && (
              <div style={{ position: 'absolute', top: 3, left: 4, zIndex: 7, width: 168, background: 'var(--surface)', border: '1px solid var(--accent)', borderRadius: 6, padding: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('cards.layout.posLabel')}</label>
                <input
                  autoFocus
                  value={editVal}
                  onChange={(e) => setEditVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commit(tile.id); else if (e.key === 'Escape') { setEditing(null); setLayoutErr(null); } }}
                  placeholder={t('cards.layout.placeholder')}
                  style={{ width: '100%', fontSize: 12, padding: '3px 5px', boxSizing: 'border-box' }}
                />
                <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('cards.layout.sizeLabel')}</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['1', 'B'] as const).map((s) => (
                    <button key={s} onClick={() => setEditSize(s)}
                      style={{ flex: 1, fontSize: 11, padding: '3px 4px', cursor: 'pointer', borderRadius: 5, border: '1px solid var(--border)', fontWeight: editSize === s ? 700 : 400, background: editSize === s ? 'var(--accent)' : 'transparent', color: editSize === s ? '#fff' : 'var(--text)' }}>
                      {s === '1' ? t('cards.layout.full') : t('cards.layout.half')}
                    </button>
                  ))}
                </div>
                {layoutErr && <span style={{ fontSize: 10, color: 'var(--critical)' }}>{layoutErr}</span>}
                <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                  <button onClick={() => commit(tile.id)} style={{ flex: 1, fontSize: 11, padding: '3px 4px', cursor: 'pointer', borderRadius: 5, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600 }}>{t('cards.layout.save')}</button>
                  <button onClick={() => { setEditing(null); setLayoutErr(null); }} title={t('cards.layout.cancel')} style={{ fontSize: 11, padding: '3px 8px', cursor: 'pointer', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>✕</button>
                </div>
              </div>
            )}
            {React.cloneElement(tile.el, { key: tile.id, size })}
          </div>
        ))}
      </div>
    </>
  );
}

export function Card({ label, value, sub, kind, onClick, badge, badgeTitle, size = '1' }: { label: string; value: number | string; sub?: string; kind: 'critical' | 'error' | 'warning' | 'info' | 'ok'; onClick?: () => void; badge?: React.ReactNode; badgeTitle?: string; size?: '1' | 'B' }) {
  // size 'B' = half height + smaller font (minor tile); sub is dropped to keep it short.
  const half = size === 'B';
  return (
    <div
      className={`card ${kind}`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', userSelect: 'none', position: 'relative', width: '100%', maxWidth: 'none', height: '100%', boxSizing: 'border-box', overflow: 'hidden', padding: half ? '5px 11px' : 12 }}
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
      <div className="label" style={half ? { fontSize: 9 } : undefined}>{label}</div>
      <div className="value" style={half ? { fontSize: 17, marginTop: 1 } : undefined}>{value}</div>
      {sub && !half && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
