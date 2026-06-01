import React, { useCallback, useEffect, useState } from 'react';
import { api, API_BASE } from './api.js';
import type { Summary, EventItem, TopEventId, ComputerItem } from './api.js';
import { SummaryCards } from './components/SummaryCards.js';
import { EventsTable } from './components/EventsTable.js';
import { TopEventIds } from './components/TopEventIds.js';
import { ComputersList } from './components/ComputersList.js';
import { ComputersPage } from './pages/ComputersPage.js';

const REFRESH_MS = 30_000;

type View = 'dashboard' | 'computers';

export function App() {
  const [view, setView] = useState<View>('dashboard');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [topIds, setTopIds] = useState<TopEventId[]>([]);
  const [computers, setComputers] = useState<ComputerItem[]>([]);

  const [filterComputer, setFilterComputer] = useState('');
  const [filterLevel, setFilterLevel] = useState<'' | 'critical' | 'error' | 'warning'>('');
  const [filterHours, setFilterHours] = useState(24);

  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const refreshComputers = useCallback(async () => {
    try {
      const c = await api.computers();
      setComputers(c.items);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, e, t, c] = await Promise.all([
        api.summary(),
        api.events({
          computer: filterComputer || undefined,
          level: filterLevel || undefined,
          hours: filterHours,
          limit: 300,
        }),
        api.topIds(filterHours, 15),
        api.computers(),
      ]);
      setSummary(s);
      setEvents(e.items);
      setTopIds(t.items);
      setComputers(c.items);
      setError(null);
      setLastFetch(new Date());
    } catch (err) {
      setError(String(err));
    }
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
            <button className={view === 'computers' ? 'active' : ''} onClick={() => setView('computers')}>Computers</button>
          </div>
        </div>
        <div className="meta">API: {API_BASE}</div>
      </div>

      {view === 'dashboard' && (
        <>
          <SummaryCards summary={summary} computers={computers} />
          <div className="panels">
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
            <TopEventIds items={topIds} />
            <ComputersList items={computers} />
          </div>
        </>
      )}

      {view === 'computers' && (
        <div className="panels" style={{ gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }}>
          <ComputersPage items={computers} onRefreshLocal={refreshComputers} />
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
