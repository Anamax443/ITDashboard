import React, { useState } from 'react';
import type { EventItem, ComputerItem } from '../api.js';
import { levelName, levelLabel } from '../api.js';

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
  const [selected, setSelected] = useState<EventItem | null>(null);

  return (
    <div className="panel events-panel">
      <div className="panel-header">
        <h2>Recent events</h2>
        <div className="panel-actions filters">
          <select value={props.filterComputer} onChange={(e) => props.onChangeComputer(e.target.value)}>
            <option value="">All computers</option>
            {props.computers.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
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
        {props.events.length === 0 ? (
          <div className="empty">No events match your filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 130 }}>Time</th>
                <th style={{ width: 120 }}>Computer</th>
                <th style={{ width: 70 }}>Level</th>
                <th style={{ width: 70 }}>Event ID</th>
                <th style={{ width: 110 }}>Log</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {props.events.map((e) => {
                const lvl = levelName(e.level);
                return (
                  <tr key={e.id} onClick={() => setSelected(e)} style={{ cursor: 'pointer' }}>
                    <td>{new Date(e.time_created).toLocaleString('cs-CZ')}</td>
                    <td>{e.computer}</td>
                    <td><span className={`level-pill ${lvl}`}>{levelLabel(e.level)}</span></td>
                    <td>{e.event_id}</td>
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
        style={{ background: 'var(--surface)', padding: 24, borderRadius: 8, maxWidth: 700, maxHeight: '80vh', overflow: 'auto', width: '90%' }}
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
          <dt style={{ color: 'var(--text-dim)' }}>Log</dt><dd>{event.log_name}</dd>
          <dt style={{ color: 'var(--text-dim)' }}>Provider</dt><dd>{event.provider_name ?? '—'}</dd>
        </dl>
        <h3 style={{ marginTop: 16, fontSize: 13, color: 'var(--text-dim)' }}>Message</h3>
        <pre style={{ background: 'var(--bg)', padding: 12, borderRadius: 4, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {event.message ?? '(empty)'}
        </pre>
      </div>
    </div>
  );
}
