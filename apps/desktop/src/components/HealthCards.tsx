import React, { useState } from 'react';
import type { PcHealthResult } from '../api.js';
import { Card } from './SummaryCards.js';
import { useI18n } from '../i18n.js';

/**
 * Second dashboard row: a single "problem PCs" tile. Ranks PCs by a damped-blend
 * eventlog score (see GET /events/pc-health) so a single chatty source can't
 * flag a healthy box. The breakdown table (score · crit · err · warn · types ·
 * days) is hidden by default and expands inline only when the tile is clicked;
 * each row jumps to that PC.
 */
export function HealthCards({ data, onJumpToComputer }: {
  data: PcHealthResult | null;
  onJumpToComputer?: (name: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!data) return null;

  const risk = data.items.filter((i) => i.level === 'risk');
  const win = `${data.windowDays} d`;

  return (
    <>
      <div className="cards" style={{ marginTop: 10 }}>
        <Card
          label={`🩺 ${t('health.reinstall')}`}
          value={risk.length}
          sub={`${t('health.score')} ≥ ${data.thresholdRisk} · ${win}`}
          kind="critical"
          onClick={risk.length > 0 ? () => setOpen((o) => !o) : undefined}
        />
      </div>

      {open && risk.length > 0 && (
        <div className="panel" style={{ gridColumn: '1 / -1', marginTop: 10 }}>
          <div className="panel-header">
            <h2>
              🩺 {t('health.reinstall')}{' '}
              <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
                ({risk.length} · {win})
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
                </tr>
              </thead>
              <tbody>
                {risk.map((i) => (
                  <tr key={i.computer_id}>
                    <td style={{ fontWeight: 600 }}>
                      {onJumpToComputer ? (
                        <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(i.name); }} style={{ color: 'var(--accent)', textDecoration: 'none' }} title={`${t('health.openIn')} ${i.name}`}>{i.name}</a>
                      ) : i.name}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--critical)' }}>{i.score}</td>
                    <td style={{ textAlign: 'right', color: i.critical > 0 ? 'var(--critical)' : 'var(--text-dim)' }}>{i.critical}</td>
                    <td style={{ textAlign: 'right', color: i.error > 0 ? 'var(--error)' : 'var(--text-dim)' }}>{i.error}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{i.warning}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{i.signatures}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{i.active_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
