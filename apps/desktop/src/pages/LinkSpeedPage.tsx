import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import type { LinkSpeedStatus, LinkSpeedHistoryRow } from '../api.js';
import { useI18n } from '../i18n.js';

// "Měření linky": enter targets (IP list / 10.8.2.* / 10.8.2.180-182 / all), the
// server writes a file to each PC's C$ over SMB and reads it back, computing up/down
// Mb/s. Verdict by the WORSE direction vs the OK threshold (catches 100-Mb ports /
// bad cables on a 1 Gb network). Results are archived; recent history shown below.
export function LinkSpeedPage() {
  const { t } = useI18n();
  const [targets, setTargets] = useState('');
  const [size, setSize] = useState('');
  const [status, setStatus] = useState<LinkSpeedStatus | null>(null);
  const [history, setHistory] = useState<LinkSpeedHistoryRow[]>([]);
  const [okMbps, setOkMbps] = useState(200);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const loadStatus = () => api.linkSpeedStatus().then((s) => {
    setStatus(s); setOkMbps(s.okMbps);
    if (size === '') setSize(String(s.defaultSizeMB));
    if (wasRunning.current && !s.running) loadHistory();   // batch just finished
    wasRunning.current = s.running;
  }).catch(() => {});
  const loadHistory = () => api.linkSpeedHistory(300).then((r) => { setHistory(r.items); setOkMbps(r.okMbps); }).catch(() => {});

  useEffect(() => { loadStatus(); loadHistory(); const tmr = setInterval(loadStatus, 2000); return () => clearInterval(tmr); }, []);

  const run = async () => {
    setError(null);
    try {
      const r = await api.linkSpeedRun(targets, Number(size) || undefined);
      if (r.error) setError(r.error === 'already_running' ? t('linkspeed.busy') : r.error);
      else { wasRunning.current = true; loadStatus(); }
    } catch (e) { setError(String(e)); }
  };

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
  const verdict = (up: number | null, down: number | null) => {
    if (up == null || down == null) return { label: '—', color: 'var(--text-dim)' };
    return Math.min(up, down) >= okMbps
      ? { label: 'OK', color: 'var(--ok)' }
      : { label: t('linkspeed.problem'), color: 'var(--critical)' };
  };
  const running = status?.running ?? false;

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <div className="panel-header">
        <h2>⚡ {t('linkspeed.title')}</h2>
        <div className="panel-actions"><button className="refresh-btn" onClick={() => { loadStatus(); loadHistory(); }}>↻</button></div>
      </div>
      <div className="panel-body">
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 12px', lineHeight: 1.5, maxWidth: 820 }}>{t('linkspeed.help')}</p>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>{t('linkspeed.targets')}</div>
            <textarea value={targets} onChange={(e) => setTargets(e.target.value)} rows={4} placeholder={"10.8.2.180-182\n10.8.2.*\nTRNKAMW11\nall"}
              style={{ width: 320, fontFamily: 'Consolas, monospace', fontSize: 12.5, padding: 6, resize: 'vertical' }} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>{t('linkspeed.size')}</div>
            <input type="number" min={1} max={1024} value={size} onChange={(e) => setSize(e.target.value)} style={{ width: 90, padding: 5 }} />
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4 }}>{t('linkspeed.okAt')} ≥ {okMbps} Mb/s</div>
            <button className="refresh-btn" onClick={run} disabled={running || !targets.trim()} style={{ fontWeight: 600, marginTop: 8 }}>
              {running ? `… ${t('linkspeed.running')}` : `▶ ${t('linkspeed.run')}`}
            </button>
          </div>
        </div>
        {error && <div style={{ color: 'var(--critical)', marginBottom: 10 }}>⚠ {error}</div>}

        {status && (running || status.results.length > 0) && (
          <div style={{ marginBottom: 16 }}>
            {running && <div style={{ fontSize: 12, marginBottom: 6 }}>{t('linkspeed.progress')}: <b>{status.done}/{status.total}</b>{status.current ? ` · ${status.current}` : ''} <span style={{ color: 'var(--text-dim)' }}>({status.sizeMB} MB)</span></div>}
            <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%', maxWidth: 720 }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--text-dim)' }}>
                <th style={{ padding: '4px 10px' }}>{t('linkspeed.target')}</th><th style={{ padding: '4px 10px' }}>↑ Mb/s</th><th style={{ padding: '4px 10px' }}>↓ Mb/s</th><th style={{ padding: '4px 10px' }}>{t('linkspeed.verdict')}</th>
              </tr></thead>
              <tbody>
                {[...status.results].reverse().map((r, i) => { const v = verdict(r.upMbps, r.downMbps); return (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)', fontFamily: 'Consolas, monospace' }}>
                    <td style={{ padding: '5px 10px' }}>{r.target}</td>
                    <td style={{ padding: '5px 10px' }}>{r.upMbps ?? '—'}</td>
                    <td style={{ padding: '5px 10px' }}>{r.downMbps ?? '—'}</td>
                    <td style={{ padding: '5px 10px', color: v.color, fontWeight: 600 }}>{r.error ? r.error : v.label}</td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
        )}

        <h3 style={{ fontSize: 14, margin: '6px 0 8px' }}>{t('linkspeed.history')}</h3>
        {history.length === 0 ? <div style={{ color: 'var(--text-dim)' }}>{t('linkspeed.noHistory')}</div> : (
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%', maxWidth: 820 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--text-dim)' }}>
              <th style={{ padding: '4px 10px' }}>{t('linkspeed.target')}</th><th style={{ padding: '4px 10px' }}>↑</th><th style={{ padding: '4px 10px' }}>↓</th><th style={{ padding: '4px 10px' }}>{t('linkspeed.verdict')}</th><th style={{ padding: '4px 10px' }}>MB</th><th style={{ padding: '4px 10px' }}>{t('linkspeed.when')}</th>
            </tr></thead>
            <tbody>
              {history.map((r) => { const v = verdict(r.up_mbps, r.down_mbps); return (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)', fontFamily: 'Consolas, monospace' }}>
                  <td style={{ padding: '5px 10px' }}>{r.target}</td>
                  <td style={{ padding: '5px 10px' }}>{r.up_mbps ?? '—'}</td>
                  <td style={{ padding: '5px 10px' }}>{r.down_mbps ?? '—'}</td>
                  <td style={{ padding: '5px 10px', color: v.color, fontWeight: 600 }}>{r.error ? r.error : v.label}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text-dim)' }}>{r.size_mb}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text-dim)' }}>{fmt(r.measured_at)}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
