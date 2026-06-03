import React, { useCallback, useEffect, useState } from 'react';
import { api, API_BASE } from './api.js';
import type { Summary, EventItem, TopEventId, ComputerItem, TimelineBucket, TopComputer, VersionInfo, DiskItem, ServiceProblem, PerfSummary, InactiveStats } from './api.js';
import { parseDiskThresholds, summarizeDisks } from './api.js';
import { SummaryCards } from './components/SummaryCards.js';
import { EventsTable } from './components/EventsTable.js';
import { TopEventIds } from './components/TopEventIds.js';
import { ComputersList } from './components/ComputersList.js';
import { CollectorStatus } from './components/CollectorStatus.js';
import { TimelineChart } from './components/TimelineChart.js';
import { TopComputersChart } from './components/TopComputersChart.js';
import { ActivityLog } from './components/ActivityLog.js';
import { ComputersPage } from './pages/ComputersPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ServicesPage } from './pages/ServicesPage.js';
import { PerfPage } from './pages/PerfPage.js';
import { HelpBox } from './components/HelpBox.js';
import { AccessDenied } from './components/AccessDenied.js';
import { useI18n, useTheme } from './i18n.js';
import type { AccessCheck } from './api.js';

const REFRESH_MS = 30_000;

type View = 'dashboard' | 'events' | 'computers' | 'services' | 'perf' | 'activity' | 'settings';

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
  const [perfSummary, setPerfSummary] = useState<PerfSummary | null>(null);
  const [inactiveStats, setInactiveStats] = useState<InactiveStats | null>(null);
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({});
  const [computersPreFilter, setComputersPreFilter] = useState<'disk-critical' | 'disk-warning' | 'failing' | 'inactive' | null>(null);

  useEffect(() => {
    api.accessCheck()
      .then((r) => { setAccess(r); setAccessChecked(true); })
      .catch(() => { setAccess({ ip: 'unknown', allowed: true }); setAccessChecked(true); });
  }, []);

  useEffect(() => {
    api.version().then(setVersion).catch(() => {});
    api.disks().then((r) => setDisks(r.items)).catch(() => {});
    api.serviceProblems().then((r) => setServiceProblems(r.items)).catch(() => {});
    api.perfSummary(7).then(setPerfSummary).catch(() => {});
    api.inactiveStats().then(setInactiveStats).catch(() => {});
    api.settings().then(setSettingsMap).catch(() => {});
  }, []);

  const thresholds = parseDiskThresholds(settingsMap);
  const diskSummary = summarizeDisks(disks, thresholds);

  const refreshComputers = useCallback(async () => {
    try {
      const c = await api.computers();
      setComputers(c.items);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const refresh = useCallback(async () => {
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
    ]);
    if (results[0].status === 'fulfilled') setSummary(results[0].value);
    if (results[1].status === 'fulfilled') setEvents(results[1].value.items);
    if (results[2].status === 'fulfilled') setTopIds(results[2].value.items);
    if (results[3].status === 'fulfilled') setComputers(results[3].value.items);
    if (results[4].status === 'fulfilled') setTimeline(results[4].value.items);
    if (results[5].status === 'fulfilled') setTopComputers(results[5].value.items);

    const errs = results.map((r, i) => r.status === 'rejected' ? `[${['summary','events','topIds','computers','timeline','topComputers'][i]}] ${r.reason}` : null).filter(Boolean);
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
            <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>{t('nav.events')}</button>
            <button className={view === 'computers' ? 'active' : ''} onClick={() => setView('computers')}>{t('nav.computers')}</button>
            <button className={view === 'services' ? 'active' : ''} onClick={() => setView('services')}>{t('nav.services')}</button>
            <button className={view === 'perf' ? 'active' : ''} onClick={() => setView('perf')}>{t('nav.perf')}</button>
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
        <>
          <HelpBox title="What this dashboard shows">
            <p><strong>Summary overview</strong> of fleet health. Each card is clickable and drills down to the relevant tab with the appropriate filter pre-applied.</p>
            <ul style={{ marginLeft: 16 }}>
              <li><strong>Critical / Errors / Warnings (24h)</strong> — click → Events tab pre-filtered by level</li>
              <li><strong>Unreachable</strong> — PCs where collectors fail; subtitle breaks down offline / RPC fail / auth → Computers tab</li>
              <li><strong>Disk critical / warning</strong> — PCs with drives below thresholds → Computers tab</li>
              <li><strong>Stopped services</strong> — PCs with non-noise stopped auto-services → Services tab</li>
              <li><strong>Computers</strong> — active / total inventory → Computers tab</li>
            </ul>
            <p><strong>Events timeline</strong> shows stacked hourly bars for the last 24h. <strong>Collector bar</strong> shows live progress of the eventlog scan (▶ Run now / ⏹ Stop) and can run all checks sequentially (eventlog → disk → services).</p>
            <p>The detailed lists (Events, Computers, Services, Activity, Settings) have their own tabs.</p>
          </HelpBox>
          <CollectorStatus />
          <SummaryCards
            summary={summary}
            computers={computers}
            diskSummary={diskSummary}
            serviceProblems={serviceProblems}
            perfSummary={perfSummary}
            inactiveStats={inactiveStats}
            onClickServices={() => setView('services')}
            onClickPerf={() => setView('perf')}
            onClickCritical={() => { setFilterLevel('critical'); setFilterHours(24); setView('events'); }}
            onClickError={() => { setFilterLevel('error'); setFilterHours(24); setView('events'); }}
            onClickWarning={() => { setFilterLevel('warning'); setFilterHours(24); setView('events'); }}
            onClickComputers={() => setView('computers')}
            onClickDiskCritical={() => { setComputersPreFilter('disk-critical'); setView('computers'); }}
            onClickDiskWarning={() => { setComputersPreFilter('disk-warning'); setView('computers'); }}
            onClickUnreachable={() => { setComputersPreFilter('failing'); setView('computers'); }}
            onClickInactive={() => { setComputersPreFilter('inactive'); setView('computers'); }}
          />
          <div className="charts-row" style={{ gridTemplateColumns: '1fr' }}>
            <TimelineChart buckets={timeline} hours={filterHours} />
          </div>
        </>
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
          />
        </div>
      )}

      {view === 'computers' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ComputersPage items={computers} onRefreshLocal={refreshComputers} initialFilter={computersPreFilter} onFilterConsumed={() => setComputersPreFilter(null)} inactiveThresholdDays={inactiveStats?.thresholdDays} />
        </div>
      )}

      {view === 'services' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ServicesPage />
        </div>
      )}

      {view === 'perf' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <PerfPage />
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
        <span>
          {t('status.lastRefresh')}: {lastFetch ? lastFetch.toLocaleTimeString(lang === 'cs' ? 'cs-CZ' : 'en-US') : '—'} · {t('status.autoEvery')} {REFRESH_MS / 1000}s
        </span>
      </div>
    </div>
  );
}
