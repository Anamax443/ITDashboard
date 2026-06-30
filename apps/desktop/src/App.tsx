import React, { useCallback, useEffect, useState } from 'react';
import { api, API_BASE } from './api.js';
import type { Summary, EventItem, TopEventId, ComputerItem, TimelineBucket, TopComputer, VersionInfo, DiskItem, ServiceProblem, PerfSummary, InactiveStats, PcHealthResult, CriticalServiceStatus, PortStatusComputer, DeviceItem, PrinterSuppliesResult, CommsResult, WanStatus } from './api.js';
import { parseDiskThresholds, summarizeDisks, summarizeMonitoredDisks, summarizeMonitoredServices, serviceMatchesExceptions, deviceDegraded, deviceProblemThresholds, isSnoozeActive, summarizeOs } from './api.js';
import { SummaryCards } from './components/SummaryCards.js';
import { HealthCards } from './components/HealthCards.js';
import { EventsTable } from './components/EventsTable.js';
import { TopEventIds } from './components/TopEventIds.js';
import { ComputersList } from './components/ComputersList.js';
import { CollectorStatus } from './components/CollectorStatus.js';
import { CommsHealth } from './components/CommsHealth.js';
import { WanHealth } from './components/WanHealth.js';
import { OsBreakdownChart } from './components/OsBreakdownChart.js';
import { TimelineChart } from './components/TimelineChart.js';
import { TopComputersChart } from './components/TopComputersChart.js';
import { ActivityLog } from './components/ActivityLog.js';
import { ComputersPage } from './pages/ComputersPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ServicesPage } from './pages/ServicesPage.js';
import { CriticalServicesPage } from './pages/CriticalServicesPage.js';
import { PortsPage } from './pages/PortsPage.js';
import { ServicePortsMatrix } from './pages/ServicePortsMatrix.js';
import { DevicesPage } from './pages/DevicesPage.js';
import { NetworkPage } from './pages/NetworkPage.js';
import { PresentationPage } from './pages/PresentationPage.js';
import { ManagerSummaryPage } from './pages/ManagerSummaryPage.js';
import { PrinterSuppliesPage } from './pages/PrinterSuppliesPage.js';
import { DatabasePage } from './pages/DatabasePage.js';
import { PerfPage } from './pages/PerfPage.js';
import { CrashesPage } from './pages/CrashesPage.js';
import { HelpBox } from './components/HelpBox.js';
import { AccessDenied } from './components/AccessDenied.js';
import { useI18n, useTheme } from './i18n.js';
import type { AccessCheck } from './api.js';

const REFRESH_MS = 30_000;

type View = 'dashboard' | 'summary' | 'events' | 'computers' | 'services' | 'critsvc' | 'ports' | 'svcports' | 'devices' | 'deviceprinters' | 'printers' | 'network' | 'database' | 'perf' | 'activity' | 'crashes' | 'settings' | 'presentation';

export function App() {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  const [access, setAccess] = useState<AccessCheck | null>(null);
  const [accessChecked, setAccessChecked] = useState(false);
  const [view, setView] = useState<View>('dashboard');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [topIds, setTopIds] = useState<TopEventId[]>([]);
  const [computers, setComputers] = useState<ComputerItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineBucket[]>([]);
  const [topComputers, setTopComputers] = useState<TopComputer[]>([]);

  const [filterComputer, setFilterComputer] = useState('');
  const [filterLevel, setFilterLevel] = useState<'' | 'critical' | 'error' | 'warning'>('');
  const [filterHours, setFilterHours] = useState(24);

  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [disks, setDisks] = useState<DiskItem[]>([]);
  const [serviceProblems, setServiceProblems] = useState<ServiceProblem[]>([]);
  const [criticalServices, setCriticalServices] = useState<CriticalServiceStatus[]>([]);
  const [ports, setPorts] = useState<PortStatusComputer[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [routerStatus, setRouterStatus] = useState<Awaited<ReturnType<typeof api.routersStatus>>>([]);
  const [printerSupplies, setPrinterSupplies] = useState<PrinterSuppliesResult | null>(null);
  // One-shot: arriving on the Ports tab via the dashboard tile pre-checks the
  // "only issues" filter so the operator lands on the problem machines.
  const [portsInitialOnlyIssues, setPortsInitialOnlyIssues] = useState(false);
  // Same one-shot for Devices → pre-checks "only printers".
  const [devicesInitialOnlyPrinters, setDevicesInitialOnlyPrinters] = useState(false);
  // Same one-shot for Devices → pre-checks "issues only" (loss/latency).
  const [devicesInitialOnlyLossy, setDevicesInitialOnlyLossy] = useState(false);
  // Same one-shot for Devices → pre-checks "uncategorized only".
  const [devicesInitialOnlyUncat, setDevicesInitialOnlyUncat] = useState(false);
  // Same one-shot for Printer status → pre-checks "only problematic" supplies.
  const [printersInitialOnlyProblem, setPrintersInitialOnlyProblem] = useState(false);
  // Same one-shot for Critical services → pre-checks "only down".
  const [critInitialOnlyDown, setCritInitialOnlyDown] = useState(false);
  // Same one-shot for Services → pre-checks "only ExitCode != 0".
  const [svcInitialOnlyNonzeroExit, setSvcInitialOnlyNonzeroExit] = useState(false);
  const [perfSummary, setPerfSummary] = useState<PerfSummary | null>(null);
  const [inactiveStats, setInactiveStats] = useState<InactiveStats | null>(null);
  const [pcHealth, setPcHealth] = useState<PcHealthResult | null>(null);
  // The "problem PCs" and "OS breakdown" tiles now live in the SummaryCards grid;
  // their detail panels expand below, toggled from here.
  const [healthOpen, setHealthOpen] = useState(false);
  const [osOpen, setOsOpen] = useState(false);
  const [crashStats, setCrashStats] = useState<{ pcs: number; total: number } | null>(null);
  const [comms, setComms] = useState<CommsResult | null>(null);
  const [commsOpen, setCommsOpen] = useState(false);
  const [wan, setWan] = useState<WanStatus | null>(null);
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({});
  const [computersPreFilter, setComputersPreFilter] = useState<'disk-critical' | 'disk-warning' | 'disk-email' | 'service-email' | 'failing' | 'inactive' | null>(null);
  const [computersOsFilter, setComputersOsFilter] = useState<{ bucket: string; stale: boolean | null } | null>(null);
  const [computersSearchPrefill, setComputersSearchPrefill] = useState<string | null>(null);

  // Cross-tab jump: any tab that renders a computer name calls this to
  // switch to Computers and pre-fill the search box with that hostname.
  const jumpToComputer = useCallback((name: string) => {
    setComputersSearchPrefill(name);
    setView('computers');
  }, []);

  useEffect(() => {
    api.accessCheck()
      .then((r) => { setAccess(r); setAccessChecked(true); })
      .catch(() => { setAccess({ ip: 'unknown', allowed: true }); setAccessChecked(true); });
  }, []);

  useEffect(() => {
    api.version().then(setVersion).catch(() => {});
    api.disks().then((r) => setDisks(r.items)).catch(() => {});
    api.serviceProblems().then((r) => setServiceProblems(r.items)).catch(() => {});
    api.criticalServices().then((r) => setCriticalServices(r.items)).catch(() => {});
    api.portStatus().then((r) => setPorts(r.items)).catch(() => {});
    api.devices().then((r) => setDevices(r.items)).catch(() => {});
    api.routersStatus().then(setRouterStatus).catch(() => {});
    api.printerSupplies().then(setPrinterSupplies).catch(() => {});
    api.perfSummary(7).then(setPerfSummary).catch(() => {});
    api.inactiveStats().then(setInactiveStats).catch(() => {});
    api.pcHealth().then(setPcHealth).catch(() => {});
    api.crashes().then((r) => setCrashStats({ pcs: new Set(r.items.map((c) => c.computer_id)).size, total: r.items.length })).catch(() => {});
    api.comms().then(setComms).catch(() => {});
    api.wan().then(setWan).catch(() => {});
    // Re-pull settings-derived data when Settings page broadcasts a save.
    const onSettingsSaved = (e: Event) => {
      const detail = (e as CustomEvent<{ changedKeys: string[] }>).detail;
      const keys = detail?.changedKeys ?? [];
      const isAll = keys.length === 0;
      if (isAll || keys.includes('inactive.threshold_days')) {
        api.inactiveStats().then(setInactiveStats).catch(() => {});
      }
      if (isAll || keys.some((k) => k.startsWith('faulty.'))) {
        api.pcHealth().then(setPcHealth).catch(() => {});
      }
      if (isAll || keys.some((k) => k.startsWith('alerts.services.port_checks') || k === 'alerts.services.port_timeout_ms')) {
        api.portStatus().then((r) => setPorts(r.items)).catch(() => {});
      }
      api.settings().then(setSettingsMap).catch(() => {});
    };
    window.addEventListener('itd:settings-saved', onSettingsSaved);
    // Initial settings load — MUST run before the cleanup return (it used to sit
    // after it = dead code, so settingsMap stayed empty on first load and
    // settings-derived UI — alert on/off flags, whitelist, disk thresholds —
    // read as "off"/defaults until the operator saved Settings once).
    api.settings().then(setSettingsMap).catch(() => {});
    return () => window.removeEventListener('itd:settings-saved', onSettingsSaved);
  }, []);

  // PC health is a heavier 14-day GROUP BY and changes slowly — refresh it on
  // its own slow cadence rather than every 30s with the rest of the dashboard.
  useEffect(() => {
    const t = setInterval(() => { api.pcHealth().then(setPcHealth).catch(() => {}); }, 300_000);
    return () => clearInterval(t);
  }, []);

  const thresholds = parseDiskThresholds(settingsMap);
  const diskSummary = summarizeDisks(disks, thresholds);
  const monitoredDiskSummary = summarizeMonitoredDisks(disks, computers, thresholds);
  const diskAlertsEnabled = ['1', 'true', 'yes', 'on'].includes((settingsMap['alerts.disk.enabled'] ?? '').toLowerCase());
  const monitoredServiceSummary = summarizeMonitoredServices(serviceProblems, computers, settingsMap);
  const serviceAlertsEnabled = ['1', 'true', 'yes', 'on'].includes((settingsMap['alerts.services.enabled'] ?? '').toLowerCase());
  // Critical-service summary for the dashboard tile: "down" = not Running on a
  // machine that is currently reachable (offline machines hold a stale state),
  // excluding services in that PC's per-PC exception list (deliberately ignored).
  const critTotal = criticalServices.length;
  // ESET agent coverage: distinct machines with the ESET service RUNNING, split
  // PC vs server (by os_version), each over its monitored total. Service is `ekrn`
  // (also match efsw / ESET Management Agent / any "eset" display name).
  const esetRe = /eset|ekrn|efsw|eraagent/i;
  const esetPcSet = new Set<number>();
  const esetSrvSet = new Set<number>();
  for (const c of criticalServices) {
    if (c.state !== 'Running' || !esetRe.test(`${c.service_name} ${c.display_name ?? ''}`)) continue;
    if (/server/i.test(c.os_version ?? '')) esetSrvSet.add(c.computer_id); else esetPcSet.add(c.computer_id);
  }
  const esetManaged = computers.filter((c) => c.enabled && !c.excluded);
  const esetSrvTotal = esetManaged.filter((c) => /server/i.test(c.os_version ?? '')).length;
  const esetPcTotal = esetManaged.length - esetSrvTotal;
  const critDown = criticalServices.filter((c) =>
    c.state !== 'Running' && c.reachable !== false
    && !serviceMatchesExceptions(c.service_name, c.display_name, c.exceptions)).length;
  // Ports tile: PCs that have at least one closed configured port, counting only
  // reachable machines (an offline PC holds a stale/unknown port state).
  const portsTotal = ports.length;
  const portsWithIssues = ports.filter((pc) => pc.reachable !== false && pc.ports.some((p) => !p.is_open)).length;
  // Printers tile: only operator-confirmed printers (category === 'printer').
  // Offline = effective reachability false (matched → AD computer's reachable;
  // unmatched → the lease ping). NULL (never probed) is not counted as offline.
  const confirmedPrinters = devices.filter((d) => d.category === 'printer');
  const printersTotal = confirmedPrinters.length;
  const printersOffline = confirmedPrinters.filter((d) => {
    const r = d.computer_id != null ? d.computer_reachable : d.reachable;
    return r === false;
  }).length;
  // Degraded devices: online but with loss/latency at/above the Settings thresholds.
  const problemTh = deviceProblemThresholds(settingsMap);
  const degradedDevices = devices.filter((d) => deviceDegraded(d, problemTh)).length;
  const devicesUnidentified = devices.filter((d) => !d.category).length;
  // Routers tile: how many configured routers are stale (FTP files not advancing /
  // can't be fetched). REST-only routers (stale === null) don't count as a problem.
  const routersTotal = routerStatus.length;
  const routersStale = routerStatus.filter((r) => r.stale === true || !!r.lastError).length;
  // Printer supplies tile: printers with any ink/toner/maintenance at or below the
  // "low" threshold (or empty). NULL levels ("some remaining") are not counted.
  const suppliesTotal = printerSupplies?.printers.length ?? 0;
  const suppliesLow = printerSupplies
    ? printerSupplies.printers.filter((p) => p.supplies.some((s) => s.level_pct != null && s.level_pct < printerSupplies.lowPct)).length
    : 0;

  const refreshComputers = useCallback(async () => {
    try {
      const c = await api.computers();
      setComputers(c.items);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const refresh = useCallback(async () => {
    // Communication health is its own lightweight aggregate — fire-and-forget so
    // it refreshes on the dashboard cadence without joining the indexed batch below.
    void api.comms().then(setComms).catch(() => {});
    void api.wan().then(setWan).catch(() => {});
    const results = await Promise.allSettled([
      api.summary(),
      api.events({
        computer: filterComputer || undefined,
        level: filterLevel || undefined,
        hours: filterHours,
        limit: 300,
      }),
      api.topIds(filterHours, 15),
      api.computers(),
      api.timeline(filterHours),
      api.topComputers(filterHours, 10),
      // Device-inventory data that drives homepage tiles (printers, devices,
      // loss/latency, ports, disks, services). Previously fetched only once on
      // mount, so those tiles went stale until an app reload — which made the
      // Přehled printer count disagree with the freshly-fetched Souhrn page.
      api.devices(),
      api.disks(),
      api.portStatus(),
      api.printerSupplies(),
      api.serviceProblems(),
      api.criticalServices(),
      api.routersStatus(),
    ]);
    if (results[0].status === 'fulfilled') setSummary(results[0].value);
    if (results[1].status === 'fulfilled') setEvents(results[1].value.items);
    if (results[2].status === 'fulfilled') setTopIds(results[2].value.items);
    if (results[3].status === 'fulfilled') setComputers(results[3].value.items);
    if (results[4].status === 'fulfilled') setTimeline(results[4].value.items);
    if (results[5].status === 'fulfilled') setTopComputers(results[5].value.items);
    if (results[6].status === 'fulfilled') setDevices(results[6].value.items);
    if (results[7].status === 'fulfilled') setDisks(results[7].value.items);
    if (results[8].status === 'fulfilled') setPorts(results[8].value.items);
    if (results[9].status === 'fulfilled') setPrinterSupplies(results[9].value);
    if (results[10].status === 'fulfilled') setServiceProblems(results[10].value.items);
    if (results[11].status === 'fulfilled') setCriticalServices(results[11].value.items);
    if (results[12].status === 'fulfilled') setRouterStatus(results[12].value);

    const errs = results.map((r, i) => r.status === 'rejected' ? `[${['summary','events','topIds','computers','timeline','topComputers','devices','disks','ports','supplies','services','critsvc','routers'][i]}] ${r.reason}` : null).filter(Boolean);
    setError(errs.length > 0 ? errs.join(' · ') : null);
    setLastFetch(new Date());
  }, [filterComputer, filterLevel, filterHours]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!accessChecked) return null;
  if (access && !access.allowed) return <AccessDenied ip={access.ip} />;

  return (
    <div className="app">
      <div className="topbar">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h1
            onClick={() => setView('dashboard')}
            style={{ cursor: 'pointer', userSelect: 'none' }}
            title={t('nav.dashboard')}
          >ITDashboard</h1>
          <div className="nav">
            <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>{t('nav.dashboard')}</button>
            <button className={view === 'summary' ? 'active' : ''} onClick={() => setView('summary')}>{t('nav.summary')}</button>
            <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>{t('nav.events')}</button>
            <button className={view === 'computers' ? 'active' : ''} onClick={() => setView('computers')}>{t('nav.computers')}</button>
            <button className={view === 'services' ? 'active' : ''} onClick={() => setView('services')}>{t('nav.services')}</button>
            <button className={view === 'critsvc' ? 'active' : ''} onClick={() => setView('critsvc')}>{t('nav.critsvc')}</button>
            <button className={view === 'ports' ? 'active' : ''} onClick={() => setView('ports')}>{t('nav.ports')}</button>
            <button className={view === 'svcports' ? 'active' : ''} onClick={() => setView('svcports')}>{t('nav.svcports')}</button>
            <button className={view === 'devices' ? 'active' : ''} onClick={() => setView('devices')}>{t('nav.devices')}</button>
            <button className={view === 'deviceprinters' ? 'active' : ''} onClick={() => setView('deviceprinters')}>{t('nav.devicePrinters')}</button>
            <button className={view === 'printers' ? 'active' : ''} onClick={() => setView('printers')}>{t('nav.printers')}</button>
            <button className={view === 'network' ? 'active' : ''} onClick={() => setView('network')}>{t('nav.network')}</button>
            <button className={view === 'database' ? 'active' : ''} onClick={() => setView('database')}>{t('nav.database')}</button>
            <button className={view === 'perf' ? 'active' : ''} onClick={() => setView('perf')}>{t('nav.perf')}</button>
            <button className={view === 'crashes' ? 'active' : ''} onClick={() => setView('crashes')}>💥 {t('nav.crashes')}</button>
            <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>{t('nav.activity')}</button>
            <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>{t('nav.settings')}</button>
            <a
              href={`${API_BASE}/docs?lang=${lang}`}
              target="_blank"
              rel="noreferrer"
              className=""
              style={{
                background: 'transparent', color: 'var(--text-dim)', border: '1px solid transparent',
                borderRadius: 4, padding: '4px 12px', fontSize: 13, textDecoration: 'none',
                cursor: 'pointer'
              }}
            >
              📖 {t('nav.docs')}
            </a>
            <button
              className={view === 'presentation' ? 'active' : ''}
              onClick={() => setView('presentation')}
              title={t('nav.presentationHint')}
            >
              🎞 {t('nav.presentation')}
            </button>
          </div>
        </div>
        <div className="meta" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', gap: 2, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
            {(['cs', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                title={t('topbar.lang')}
                style={{
                  background: lang === l ? 'var(--surface-hover)' : 'transparent',
                  color: lang === l ? 'var(--text)' : 'var(--text-dim)',
                  border: 'none', padding: '2px 8px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
                  textTransform: 'uppercase', fontWeight: lang === l ? 700 : 400,
                }}
              >{l}</button>
            ))}
          </div>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={`${t('topbar.theme')}: ${theme === 'dark' ? t('topbar.theme.dark') : t('topbar.theme.light')}`}
            style={{
              background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '2px 8px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >{theme === 'dark' ? '☀' : '☾'}</button>
          {version && (
            <span title={`${version.shaFull}\nbranch: ${version.branch ?? '?'}`}>
              <a href={`https://github.com/Anamax443/ITDashboard/commit/${version.shaFull}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                {version.sha}
              </a>
              {version.branch && <span style={{ color: 'var(--text-dim)' }}> · {version.branch}</span>}
            </span>
          )}
          <span>{t('topbar.api')}: {API_BASE}</span>
        </div>
      </div>

      {view === 'dashboard' && (
        <div className="dashboard-view">
          <HelpBox title={t('dashboard.help.title')}>
            <p>{t('dashboard.help.intro')}</p>
            <ul style={{ marginLeft: 16 }}>
              <li>{t('dashboard.help.bullet.events')}</li>
              <li>{t('dashboard.help.bullet.unreachable')}</li>
              <li>{t('dashboard.help.bullet.disk')}</li>
              <li>{t('dashboard.help.bullet.services')}</li>
              <li>{t('dashboard.help.bullet.inactive')}</li>
              <li>{t('dashboard.help.bullet.computers')}</li>
            </ul>
            <p>{t('dashboard.help.collector')}</p>
            <p>{t('dashboard.help.footer')}</p>
          </HelpBox>
          <CollectorStatus />
          <SummaryCards
            summary={summary}
            computers={computers}
            diskSummary={diskSummary}
            monitoredDiskSummary={monitoredDiskSummary}
            diskAlertsEnabled={diskAlertsEnabled}
            monitoredServiceSummary={monitoredServiceSummary}
            serviceAlertsEnabled={serviceAlertsEnabled}
            serviceProblems={serviceProblems}
            settings={settingsMap}
            criticalServicesDown={critDown}
            criticalServicesTotal={critTotal}
            esetPcRunning={esetPcSet.size}
            esetPcTotal={esetPcTotal}
            esetSrvRunning={esetSrvSet.size}
            esetSrvTotal={esetSrvTotal}
            onClickEset={() => setView('critsvc')}
            onClickCriticalServices={() => { setCritInitialOnlyDown(true); setView('critsvc'); }}
            portsWithIssues={portsWithIssues}
            portsTotal={portsTotal}
            onClickPorts={() => { setPortsInitialOnlyIssues(true); setView('ports'); }}
            printersOffline={printersOffline}
            printersTotal={printersTotal}
            onClickPrinters={() => { setDevicesInitialOnlyPrinters(true); setView('devices'); }}
            routersTotal={routersTotal}
            routersStale={routersStale}
            onClickRouters={() => setView('network')}
            degradedDevices={degradedDevices}
            devicesTotal={devices.length}
            onClickDegraded={() => { setDevicesInitialOnlyLossy(true); setView('devices'); }}
            devicesUnidentified={devicesUnidentified}
            onClickDevices={() => { setDevicesInitialOnlyUncat(true); setView('devices'); }}
            suppliesLow={suppliesLow}
            suppliesTotal={suppliesTotal}
            onClickSupplies={() => { setPrintersInitialOnlyProblem(true); setView('printers'); }}
            perfSummary={perfSummary}
            inactiveStats={inactiveStats}
            onClickMonitoredDisks={() => { setComputersPreFilter('disk-email'); setView('computers'); }}
            onClickMonitoredServices={() => { setComputersPreFilter('service-email'); setView('computers'); }}
            onClickServices={() => { setSvcInitialOnlyNonzeroExit(true); setView('services'); }}
            onClickPerf={() => setView('perf')}
            onClickCritical={() => { setFilterLevel('critical'); setFilterHours((summary?.window_days ?? 1) * 24); setView('events'); }}
            onClickError={() => { setFilterLevel('error'); setFilterHours((summary?.window_days ?? 1) * 24); setView('events'); }}
            onClickWarning={() => { setFilterLevel('warning'); setFilterHours((summary?.window_days ?? 1) * 24); setView('events'); }}
            onClickComputers={() => setView('computers')}
            onClickDiskCritical={() => { setComputersPreFilter('disk-critical'); setView('computers'); }}
            onClickDiskWarning={() => { setComputersPreFilter('disk-warning'); setView('computers'); }}
            onClickUnreachable={() => { setComputersPreFilter('failing'); setView('computers'); }}
            onClickInactive={() => { setComputersPreFilter('inactive'); setView('computers'); }}
            problemPcs={pcHealth ? { count: pcHealth.items.filter((i) => i.level === 'risk' && !isSnoozeActive(i.snoozedUntil)).length, threshold: pcHealth.thresholdRisk, windowDays: pcHealth.windowDays, snoozed: pcHealth.items.filter((i) => isSnoozeActive(i.snoozedUntil)).length } : null}
            onClickProblemPcs={() => setHealthOpen((o) => !o)}
            osBreakdown={(() => { const s = summarizeOs(computers, inactiveStats?.thresholdDays ?? 90); return { count: s.length, totalPcs: s.reduce((a, x) => a + x.total, 0), stale: s.reduce((a, x) => a + x.stale, 0) }; })()}
            onClickOs={() => setOsOpen((o) => !o)}
            crashes={crashStats}
            onClickCrashes={() => setView('crashes')}
            comms={comms}
            onClickComms={() => setCommsOpen((o) => !o)}
          />
          <WanHealth data={wan} />
          <CommsHealth data={comms} open={commsOpen} onOpenChange={setCommsOpen} />
          <HealthCards
            data={pcHealth}
            hideSummary
            open={healthOpen}
            onOpenChange={setHealthOpen}
            onJumpToComputer={jumpToComputer}
            onOpenEvents={(computer, level) => {
              setFilterComputer(computer);
              setFilterLevel(level);
              setFilterHours((pcHealth?.windowDays ?? 14) * 24);
              setView('events');
            }}
            onChanged={() => { api.pcHealth().then(setPcHealth).catch(() => {}); }}
          />
          <OsBreakdownChart
            items={computers}
            thresholdDays={inactiveStats?.thresholdDays ?? 90}
            hideSummary
            open={osOpen}
            onOpenChange={setOsOpen}
            onSelect={(bucket, staleness) => {
              setComputersOsFilter({ bucket, stale: staleness === 'stale' });
              setView('computers');
            }}
          />
        </div>
      )}

      {view === 'events' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <EventsTable
            events={events}
            computers={computers}
            filterComputer={filterComputer}
            filterLevel={filterLevel}
            filterHours={filterHours}
            onChangeComputer={setFilterComputer}
            onChangeLevel={setFilterLevel}
            onChangeHours={setFilterHours}
            onRefresh={refresh}
            onJumpToComputer={jumpToComputer}
            snoozeBanner={(() => {
              if (!filterComputer) return null;
              const p = pcHealth?.items.find((i) => i.name === filterComputer && isSnoozeActive(i.snoozedUntil));
              return p ? { until: p.snoozedUntil, by: p.snoozedBy, note: p.snoozeNote } : null;
            })()}
          />
        </div>
      )}

      {view === 'computers' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ComputersPage items={computers} onRefreshLocal={refreshComputers} initialFilter={computersPreFilter} onFilterConsumed={() => setComputersPreFilter(null)} inactiveThresholdDays={inactiveStats?.thresholdDays} initialSearch={computersSearchPrefill} onSearchPrefillConsumed={() => setComputersSearchPrefill(null)} initialOsFilter={computersOsFilter} onOsFilterConsumed={() => setComputersOsFilter(null)} />
        </div>
      )}

      {view === 'services' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ServicesPage onJumpToComputer={jumpToComputer} initialOnlyNonzeroExit={svcInitialOnlyNonzeroExit} onOnlyNonzeroExitConsumed={() => setSvcInitialOnlyNonzeroExit(false)} />
        </div>
      )}

      {view === 'critsvc' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <CriticalServicesPage onJumpToComputer={jumpToComputer} initialOnlyDown={critInitialOnlyDown} onOnlyDownConsumed={() => setCritInitialOnlyDown(false)} />
        </div>
      )}

      {view === 'summary' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ManagerSummaryPage settings={settingsMap} />
        </div>
      )}

      {view === 'ports' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <PortsPage onJumpToComputer={jumpToComputer} initialOnlyIssues={portsInitialOnlyIssues} onOnlyIssuesConsumed={() => setPortsInitialOnlyIssues(false)} />
        </div>
      )}

      {view === 'svcports' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ServicePortsMatrix />
        </div>
      )}

      {view === 'network' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <NetworkPage />
        </div>
      )}

      {view === 'presentation' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <PresentationPage />
        </div>
      )}

      {view === 'devices' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <DevicesPage onJumpToComputer={jumpToComputer} settings={settingsMap} initialOnlyPrinters={devicesInitialOnlyPrinters} onOnlyPrintersConsumed={() => setDevicesInitialOnlyPrinters(false)} initialOnlyLossy={devicesInitialOnlyLossy} onOnlyLossyConsumed={() => setDevicesInitialOnlyLossy(false)} initialOnlyUncategorized={devicesInitialOnlyUncat} onOnlyUncategorizedConsumed={() => setDevicesInitialOnlyUncat(false)} printerSupplies={printerSupplies} onJumpToPrinters={() => setView('printers')} />
        </div>
      )}

      {view === 'deviceprinters' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          {/* Fixed "Tiskárny" nav entry = the Devices inventory pre-filtered to printers
              (forced on each time this view mounts). */}
          <DevicesPage onJumpToComputer={jumpToComputer} settings={settingsMap} initialOnlyPrinters={true} onOnlyPrintersConsumed={() => { /* dedicated tab — keep on */ }} printerSupplies={printerSupplies} onJumpToPrinters={() => setView('printers')} />
        </div>
      )}

      {view === 'printers' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <PrinterSuppliesPage settings={settingsMap} initialOnlyProblem={printersInitialOnlyProblem} onOnlyProblemConsumed={() => setPrintersInitialOnlyProblem(false)} />
        </div>
      )}

      {view === 'database' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <DatabasePage />
        </div>
      )}

      {view === 'perf' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <PerfPage onJumpToComputer={jumpToComputer} />
        </div>
      )}

      {view === 'crashes' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <CrashesPage />
        </div>
      )}

      {view === 'activity' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ActivityLog height={window.innerHeight - 180} />
        </div>
      )}

      {view === 'settings' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <SettingsPage />
        </div>
      )}

      <div className="statusbar">
        <span>
          {error ? <span className="err">⚠ {error}</span> : <span className="ok">● {t('status.connected')}</span>}
        </span>
        <span>© {new Date().getFullYear()} Milan Trnka, IT</span>
        <span>
          {t('status.lastRefresh')}: {lastFetch ? lastFetch.toLocaleTimeString(lang === 'cs' ? 'cs-CZ' : 'en-US') : '—'} · {t('status.autoEvery')} {REFRESH_MS / 1000}s
        </span>
      </div>
    </div>
  );
}
