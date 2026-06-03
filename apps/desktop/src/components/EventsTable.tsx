import React, { useState } from 'react';
import type { EventItem, ComputerItem } from '../api.js';
import { levelName, levelLabel } from '../api.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';
import { HelpBox } from './HelpBox.js';
import { useI18n } from '../i18n.js';

interface Props {
  events: EventItem[];
  computers: ComputerItem[];
  filterComputer: string;
  filterLevel: '' | 'critical' | 'error' | 'warning';
  filterHours: number;
  onChangeComputer: (v: string) => void;
  onChangeLevel: (v: '' | 'critical' | 'error' | 'warning') => void;
  onChangeHours: (v: number) => void;
  onRefresh: () => void;
}

export function EventsTable(props: Props) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<EventItem | null>(null);
  const [search, setSearch] = useState('');
  const { sort, toggle } = useSort<EventItem>({ col: 'time_created', dir: 'desc' });

  const providers = Array.from(new Set(props.events.map((e) => e.provider_name).filter((p): p is string => !!p))).sort();
  const [filterProvider, setFilterProvider] = useState('');

  const filtered = props.events.filter((e) => {
    if (filterProvider && e.provider_name !== filterProvider) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !(e.message ?? '').toLowerCase().includes(q) &&
        !(e.computer ?? '').toLowerCase().includes(q) &&
        !String(e.event_id).includes(q) &&
        !(e.provider_name ?? '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  const sorted = useSortedItems(filtered, sort);

  return (
    <div className="panel events-panel">
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('events.help.intro')}</p>
          <p>{t('events.help.filters')}</p>
          <p>{t('events.help.noise')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>Recent events ({sorted.length})</h2>
        <div className="panel-actions filters">
          <input
            type="text"
            placeholder="Search msg/PC/ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 160 }}
          />
          <select value={props.filterComputer} onChange={(e) => props.onChangeComputer(e.target.value)}>
            <option value="">All computers</option>
            {props.computers.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <select value={filterProvider} onChange={(e) => setFilterProvider(e.target.value)}>
            <option value="">All sources</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={props.filterLevel} onChange={(e) => props.onChangeLevel(e.target.value as Props['filterLevel'])}>
            <option value="">All levels</option>
            <option value="critical">Critical</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
          </select>
          <select value={props.filterHours} onChange={(e) => props.onChangeHours(Number(e.target.value))}>
            <option value={1}>1h</option>
            <option value={24}>24h</option>
            <option value={168}>7d</option>
            <option value={720}>30d</option>
          </select>
          <button className="refresh-btn" onClick={props.onRefresh}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {sorted.length === 0 ? (
          <div className="empty">No events match your filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <SortHeader<EventItem> col="time_created" label="Time" sort={sort} toggle={toggle} width={130} />
                <SortHeader<EventItem> col="computer" label="Computer" sort={sort} toggle={toggle} width={120} />
                <SortHeader<EventItem> col="level" label="Level" sort={sort} toggle={toggle} width={70} />
                <SortHeader<EventItem> col="event_id" label="Event ID" sort={sort} toggle={toggle} width={70} />
                <SortHeader<EventItem> col="provider_name" label="Source" sort={sort} toggle={toggle} width={140} />
                <SortHeader<EventItem> col="log_name" label="Log" sort={sort} toggle={toggle} width={90} />
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const lvl = levelName(e.level);
                return (
                  <tr key={e.id} onClick={() => setSelected(e)} style={{ cursor: 'pointer' }}>
                    <td>{new Date(e.time_created).toLocaleString('cs-CZ')}</td>
                    <td>{e.computer}</td>
                    <td><span className={`level-pill ${lvl}`}>{levelLabel(e.level)}</span></td>
                    <td>{e.event_id}</td>
                    <td style={{ color: 'var(--text-dim)' }}>{e.provider_name ?? '—'}</td>
                    <td>{e.log_name}</td>
                    <td className="msg-cell" title={e.message ?? ''}>{e.message ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {selected && <EventDetail event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function EventDetail({ event, onClose }: { event: EventItem; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', padding: 24, borderRadius: 8, maxWidth: 720, maxHeight: '85vh', overflow: 'auto', width: '90%' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Event detail</h2>
          <button className="refresh-btn" onClick={onClose}>✕</button>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13 }}>
          <dt style={{ color: 'var(--text-dim)' }}>Time</dt><dd>{new Date(event.time_created).toLocaleString('cs-CZ')}</dd>
          <dt style={{ color: 'var(--text-dim)' }}>Computer</dt><dd>{event.computer}</dd>
          <dt style={{ color: 'var(--text-dim)' }}>Level</dt><dd>{levelLabel(event.level)}</dd>
          <dt style={{ color: 'var(--text-dim)' }}>Event ID</dt><dd>{event.event_id}</dd>
          <dt style={{ color: 'var(--text-dim)' }}>Log Name</dt><dd>{event.log_name}</dd>
          <dt style={{ color: 'var(--text-dim)' }}>Source</dt><dd>{event.provider_name ?? '—'}</dd>
        </dl>
        <h3 style={{ marginTop: 16, fontSize: 13, color: 'var(--text-dim)' }}>Message</h3>
        <pre style={{ background: 'var(--bg)', padding: 12, borderRadius: 4, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {event.message ?? '(empty)'}
        </pre>
      </div>
    </div>
  );
}
