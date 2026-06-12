import React from 'react';
import type { PcHealthResult } from '../api.js';
import { Card } from './SummaryCards.js';
import { useI18n } from '../i18n.js';

/**
 * Second row of dashboard tiles: "faulty PC / reinstall candidate" detection.
 * Ranks PCs by a damped-blend eventlog score (see GET /events/pc-health) so a
 * single chatty source can't flag a healthy box. Two tiles (reinstall risk /
 * watch) drill into the Computers tab filtered to that PC set; a panel lists the
 * worst PCs with their score breakdown, each row jumps to that PC.
 */
export function HealthCards({ data, onSelectCandidates, onJumpToComputer }: {
  data: PcHealthResult | null;
  onSelectCandidates: (ids: number[], label: string) => void;
  onJumpToComputer?: (name: string) => void;
}) {
  const { t } = useI18n();
  if (!data) return null;

  const risk = data.items.filter((i) => i.level === 'risk');
  const watch = data.items.filter((i) => i.level === 'watch');
  const win = `${data.windowDays} d`;
  const riskLabel = `${t('health.reinstall')} (${win})`;
  const watchLabel = `${t('health.watch')} (${win})`;

  return (
    <>
      <div className="cards" style={{ gridTemplateColumns: 'repeat(12, 1fr)', marginTop: 12 }}>
        <Card
          label={`🩺 ${t('health.reinstall')}`}
          value={risk.length}
          sub={`${t('health.score')} ≥ ${data.thresholdRisk} · ${win}`}
          kind="critical"
          onClick={risk.length > 0 ? () => onSelectCandidates(risk.map((i) => i.computer_id), riskLabel) : undefined}
        />
        <Card
          label={t('health.watch')}
          value={watch.length}
          sub={`${t('health.score')} ≥ ${data.thresholdWatch} · ${win}`}
          kind="warning"
          onClick={watch.length > 0 ? () => onSelectCandidates(watch.map((i) => i.computer_id), watchLabel) : undefined}
        />
      </div>

      {data.items.length > 0 && (
        <div className="panel" style={{ gridColumn: '1 / -1', marginTop: 12 }}>
          <div className="panel-header">
            <h2>
              🩺 {t('health.reinstall')}{' '}
              <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
                ({data.items.length} · {win})
              </span>
            </h2>
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
                {data.items.slice(0, 20).map((i) => (
                  <tr key={i.computer_id}>
                    <td style={{ fontWeight: 600 }}>
                      {onJumpToComputer ? (
                        <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(i.name); }} style={{ color: 'var(--accent)', textDecoration: 'none' }} title={`${t('health.openIn')} ${i.name}`}>{i.name}</a>
                      ) : i.name}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: i.level === 'risk' ? 'var(--critical)' : 'var(--warning)' }}>{i.score}</td>
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
