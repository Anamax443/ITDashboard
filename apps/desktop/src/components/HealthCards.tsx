import React, { useState } from 'react';
import type { PcHealthResult } from '../api.js';
import { api, isSnoozeActive } from '../api.js';
import { Card } from './SummaryCards.js';
import { useI18n } from '../i18n.js';

type EventLevel = '' | 'critical' | 'error' | 'warning';

/**
 * Second dashboard row: a single "problem PCs" tile. Ranks PCs by a damped-blend
 * eventlog score (see GET /events/pc-health) so a single chatty source can't
 * flag a healthy box. The breakdown table (score · crit · err · warn · types ·
 * days) is hidden by default and expands inline only when the tile is clicked.
 * Score and the crit/err/warn cells are click-throughs to the filtered Events
 * tab; the score cell tooltip explains how the score is computed.
 *
 * Each risk row can be temporarily "resolved / snoozed" by the operator for a
 * chosen number of days (signed). A snoozed PC drops out of the tile count and
 * moves to a collapsible "Snoozed" list; it returns to standard automatically
 * when the snooze expires (or when the operator clears it early).
 */
export function HealthCards({ data, onJumpToComputer, onOpenEvents, onChanged }: {
  data: PcHealthResult | null;
  onJumpToComputer?: (name: string) => void;
  onOpenEvents?: (computer: string, level: EventLevel) => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [note, setNote] = useState('');
  const [by, setBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;

  // Risk-level boxes that are NOT snoozed drive the tile; snoozed ones (any level)
  // move to the separate list so the warning system isn't flooded by resolved noise.
  const activeRisk = data.items.filter((i) => i.level === 'risk' && !isSnoozeActive(i.snoozedUntil));
  const snoozed = data.items.filter((i) => isSnoozeActive(i.snoozedUntil));
  const win = `${data.windowDays} d`;
  const sc = data.scoring;
  const scoreTip = t('health.scoreTip')
    .replace('{win}', String(data.windowDays))
    .replace(/\{cap\}/g, String(sc.cap))
    .replace('{wc}', String(sc.weightCritical))
    .replace('{we}', String(sc.weightError))
    .replace('{ww}', String(sc.weightWarning))
    .replace('{wb}', String(sc.weightBreadth))
    .replace('{wp}', String(sc.weightPersistence));

  const startSnooze = (name: string) => {
    setEditing(name);
    setDays(data.snoozeDefaultDays || 7);
    setNote('');
    setBy('');
    setErr(null);
  };

  const submitSnooze = async (name: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.snoozePc(name, days, note.trim() || undefined, by.trim() || undefined);
      setEditing(null);
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg === 'signature_required' ? t('health.snoozeSignatureRequired') : msg);
    } finally {
      setBusy(false);
    }
  };

  const clearSnooze = async (name: string) => {
    setBusy(true);
    try {
      await api.unsnoozePc(name);
      onChanged?.();
    } catch { /* surfaced by the list not updating; keep UI quiet */ }
    finally { setBusy(false); }
  };

  const fmtDate = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  };

  // Clickable numeric cell → filtered Events tab.
  const cell = (value: number, color: string, name: string, level: EventLevel) => {
    const active = !!onOpenEvents && value > 0;
    return (
      <td
        onClick={active ? () => onOpenEvents!(name, level) : undefined}
        title={active ? `${t('health.openEvents')} ${level || 'all'} · ${name}` : undefined}
        style={{ textAlign: 'right', color: value > 0 ? color : 'var(--text-dim)', cursor: active ? 'pointer' : 'default' }}
      >{value}</td>
    );
  };

  return (
    <>
      <div className="cards" style={{ marginTop: 10 }}>
        <Card
          label={`🩺 ${t('health.reinstall')}`}
          value={activeRisk.length}
          sub={`${t('health.score')} ≥ ${data.thresholdRisk} · ${win}`}
          kind={activeRisk.length > 0 ? 'critical' : 'ok'}
          onClick={(activeRisk.length > 0 || snoozed.length > 0) ? () => setOpen((o) => !o) : undefined}
          badge={snoozed.length > 0 ? `💤 ${snoozed.length}` : undefined}
          badgeTitle={snoozed.length > 0 ? `${snoozed.length} ${t('health.snoozedTileBadge')}` : undefined}
        />
      </div>

      {open && (activeRisk.length > 0 || snoozed.length > 0) && (
        <div className="panel" style={{ gridColumn: '1 / -1', marginTop: 10 }}>
          <div className="panel-header">
            <h2>
              🩺 {t('health.reinstall')}{' '}
              <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
                ({activeRisk.length} · {win})
              </span>
            </h2>
            <button className="refresh-btn" onClick={() => setOpen(false)} title={t('health.collapse')}>✕</button>
          </div>
          <div className="panel-body">
            <table>
              <thead>
                <tr>
                  <th>Computer</th>
                  <th style={{ width: 80, textAlign: 'right' }}>{t('health.score')}</th>
                  <th style={{ width: 70, textAlign: 'right', color: 'var(--critical)' }}>crit</th>
                  <th style={{ width: 70, textAlign: 'right', color: 'var(--error)' }}>err</th>
                  <th style={{ width: 70, textAlign: 'right', color: 'var(--warning)' }}>warn</th>
                  <th style={{ width: 70, textAlign: 'right' }}>{t('health.types')}</th>
                  <th style={{ width: 70, textAlign: 'right' }}>{t('health.days')}</th>
                  <th style={{ width: 150, textAlign: 'right' }}>{t('health.action')}</th>
                </tr>
              </thead>
              <tbody>
                {activeRisk.map((i) => (
                  <React.Fragment key={i.computer_id}>
                    <tr>
                      <td style={{ fontWeight: 600 }}>
                        {onJumpToComputer ? (
                          <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(i.name); }} style={{ color: 'var(--accent)', textDecoration: 'none' }} title={`${t('health.openIn')} ${i.name}`}>{i.name}</a>
                        ) : i.name}
                      </td>
                      <td
                        onClick={onOpenEvents ? () => onOpenEvents(i.name, '') : undefined}
                        title={scoreTip}
                        style={{ textAlign: 'right', fontWeight: 700, color: 'var(--critical)', cursor: onOpenEvents ? 'pointer' : 'default' }}
                      >{i.score}</td>
                      {cell(i.critical, 'var(--critical)', i.name, 'critical')}
                      {cell(i.error, 'var(--error)', i.name, 'error')}
                      {cell(i.warning, 'var(--warning)', i.name, 'warning')}
                      <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{i.signatures}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{i.active_days}</td>
                      <td style={{ textAlign: 'right' }}>
                        {editing !== i.name && (
                          <button className="refresh-btn" disabled={busy} onClick={() => startSnooze(i.name)} title={t('health.snoozeTitle')}>✓ {t('health.snooze')}</button>
                        )}
                      </td>
                    </tr>
                    {editing === i.name && (
                      <tr>
                        <td colSpan={8} style={{ background: 'var(--bg-elev, rgba(255,255,255,0.03))', padding: '10px 12px' }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                            <strong>💤 {t('health.snoozeTitle')} — {i.name}</strong>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              {t('health.snoozeDaysLabel')}:
                              <input type="number" min={1} max={90} value={days}
                                onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                                style={{ width: 64 }} />
                            </label>
                            <input type="text" placeholder={t('health.snoozeNote')} value={note}
                              onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 220px', minWidth: 160 }} />
                            <input type="text" placeholder={t('health.snoozeBy')} value={by}
                              onChange={(e) => setBy(e.target.value)} style={{ flex: '0 1 220px', minWidth: 140 }} />
                            <button className="refresh-btn" disabled={busy} onClick={() => submitSnooze(i.name)}>{t('health.snoozeConfirm')}</button>
                            <button className="refresh-btn" disabled={busy} onClick={() => { setEditing(null); setErr(null); }}>{t('health.cancel')}</button>
                          </div>
                          {err && <div style={{ color: 'var(--critical)', marginTop: 6, fontSize: 12 }}>{err}</div>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
                {activeRisk.length === 0 && (
                  <tr><td colSpan={8} style={{ color: 'var(--text-dim)', textAlign: 'center', padding: 12 }}>{t('health.allSnoozed')}</td></tr>
                )}
              </tbody>
            </table>

            {snoozed.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <button className="refresh-btn" onClick={() => setSnoozedOpen((o) => !o)}>
                  💤 {t('health.snoozedList')} ({snoozed.length}) {snoozedOpen ? '▲' : '▼'}
                </button>
                {snoozedOpen && (
                  <table style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th>Computer</th>
                        <th style={{ width: 80, textAlign: 'right' }}>{t('health.score')}</th>
                        <th style={{ width: 110 }}>{t('health.snoozedUntil')}</th>
                        <th style={{ width: 160 }}>{t('health.snoozeBySig')}</th>
                        <th>{t('health.snoozeNote')}</th>
                        <th style={{ width: 170, textAlign: 'right' }}>{t('health.action')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snoozed.map((i) => (
                        <tr key={i.computer_id} style={{ opacity: 0.7 }}>
                          <td style={{ fontWeight: 600 }}>
                            {onJumpToComputer ? (
                              <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(i.name); }} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{i.name}</a>
                            ) : i.name}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{i.score}</td>
                          <td>{fmtDate(i.snoozedUntil)}</td>
                          <td style={{ color: 'var(--text-dim)' }}>{i.snoozedBy}</td>
                          <td style={{ color: 'var(--text-dim)' }}>{i.snoozeNote}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="refresh-btn" disabled={busy} onClick={() => clearSnooze(i.name)} title={t('health.unsnooze')}>↩ {t('health.unsnooze')}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
