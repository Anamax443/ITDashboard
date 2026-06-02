import React, { useCallback, useEffect, useState } from 'react';
import { api, API_BASE } from './api.js';
import type { Summary, EventItem, TopEventId, ComputerItem, TimelineBucket, TopComputer, VersionInfo, DiskItem, ServiceProblem } from './api.js';
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

const REFRESH_MS = 30_000;

type View = 'dashboard' | 'events' | 'computers' | 'services' | 'activity' | 'settings';

export function App() {
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
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({});
  const [computersPreFilter, setComputersPreFilter] = useState<'disk-critical' | 'disk-warning' | 'failing' | null>(null);

  useEffect(() => {
    api.version().then(setVersion).catch(() => {});
    api.disks().then((r) => setDisks(r.items)).catch(() => {});
    api.serviceProblems().then((r) => setServiceProblems(r.items)).catch(() => {});
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

  return (
    <div className="app">
      <div className="topbar">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h1>ITDashboard</h1>
          <div className="nav">
            <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button>
            <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>Events</button>
            <button className={view === 'computers' ? 'active' : ''} onClick={() => setView('computers')}>Computers</button>
            <button className={view === 'services' ? 'active' : ''} onClick={() => setView('services')}>Services</button>
            <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>Activity</button>
            <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>Settings</button>
            <a
              href={`${API_BASE}/docs`}
              target="_blank"
              rel="noreferrer"
              className=""
              style={{
                background: 'transparent', color: 'var(--text-dim)', border: '1px solid transparent',
                borderRadius: 4, padding: '4px 12px', fontSize: 13, textDecoration: 'none',
                cursor: 'pointer'
              }}
            >
              📖 Docs
            </a>
          </div>
        </div>
        <div className="meta">
          {version && (
            <span title={`${version.shaFull}\nbranch: ${version.branch ?? '?'}`}>
              <a href={`https://github.com/Anamax443/ITDashboard/commit/${version.shaFull}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                {version.sha}
              </a>
              {version.branch && <span style={{ color: 'var(--text-dim)' }}> · {version.branch}</span>}
              <span style={{ margin: '0 8px' }}>·</span>
            </span>
          )}
          API: {API_BASE}
        </div>
      </div>

      {view === 'dashboard' && (
        <>
          <CollectorStatus />
          <SummaryCards
            summary={summary}
            computers={computers}
            diskSummary={diskSummary}
            serviceProblems={serviceProblems}
            onClickServices={() => setView('services')}
            onClickCritical={() => { setFilterLevel('critical'); setFilterHours(24); setView('events'); }}
            onClickError={() => { setFilterLevel('error'); setFilterHours(24); setView('events'); }}
            onClickWarning={() => { setFilterLevel('warning'); setFilterHours(24); setView('events'); }}
            onClickComputers={() => setView('computers')}
            onClickDiskCritical={() => { setComputersPreFilter('disk-critical'); setView('computers'); }}
            onClickDiskWarning={() => { setComputersPreFilter('disk-warning'); setView('computers'); }}
            onClickUnreachable={() => { setComputersPreFilter('failing'); setView('computers'); }}
          />
          <div className="charts-row">
            <TimelineChart buckets={timeline} hours={filterHours} />
            <TopComputersChart items={topComputers} />
          </div>
          <div className="panels" style={{ gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' }}>
            <TopEventIds items={topIds} />
            <ComputersList items={computers} />
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
          <ComputersPage items={computers} onRefreshLocal={refreshComputers} initialFilter={computersPreFilter} onFilterConsumed={() => setComputersPreFilter(null)} />
        </div>
      )}

      {view === 'services' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ServicesPage />
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
          {error ? <span className="err">⚠ {error}</span> : <span className="ok">● Connected</span>}
        </span>
        <span>
          Last refresh: {lastFetch ? lastFetch.toLocaleTimeString('cs-CZ') : '—'} · auto every {REFRESH_MS / 1000}s
        </span>
      </div>
    </div>
  );
}
