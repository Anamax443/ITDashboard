import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import type { LinkSpeedStatus, LinkSpeedHistoryRow } from '../api.js';
import { useI18n } from '../i18n.js';

// "Měření linky": enter targets (IP list / 10.8.2.* / 10.8.2.180-182 / all), the
// server writes a file to each PC's C$ over SMB and reads it back, computing up/down
// Mb/s. Verdict by the WORSE direction vs the OK threshold (catches 100-Mb ports /
// bad cables on a 1 Gb network). Results are archived to DB; recent history shown
// below, with an IP→Computers link, a hostname column, and CSV/HTML/print export.
const REPORT_CSS = `.ls-rep{font-family:'Segoe UI',Arial,sans-serif;color:#111;max-width:920px;margin:0 auto;padding:24px}
.ls-rep h1{font-size:18px;margin:0 0 4px}.ls-rep .meta{color:#555;font-size:12px;margin-bottom:14px}
.ls-rep table{border-collapse:collapse;width:100%;font-size:12px}
.ls-rep th,.ls-rep td{border:1px solid #ddd;padding:5px 8px;text-align:left}
.ls-rep th{background:#f3f4f6}
.ls-rep .bad{color:#b91c1c;font-weight:700}.ls-rep .ok{color:#157347;font-weight:700}
@media print{@page{margin:12mm}}`;

export function LinkSpeedPage({ onJumpToComputer }: { onJumpToComputer?: (q: string) => void }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState('');
  const [size, setSize] = useState('');
  const [status, setStatus] = useState<LinkSpeedStatus | null>(null);
  const [history, setHistory] = useState<LinkSpeedHistoryRow[]>([]);
  const [okMbps, setOkMbps] = useState(200);
  const [devmap, setDevmap] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const loadStatus = () => api.linkSpeedStatus().then((s) => {
    setStatus(s); setOkMbps(s.okMbps);
    if (size === '') setSize(String(s.defaultSizeMB));
    if (wasRunning.current && !s.running) loadHistory();
    wasRunning.current = s.running;
  }).catch(() => {});
  const loadHistory = () => api.linkSpeedHistory(500).then((r) => { setHistory(r.items); setOkMbps(r.okMbps); }).catch(() => {});

  useEffect(() => {
    loadStatus(); loadHistory();
    api.devices().then((r) => {
      const m = new Map<string, string>();
      for (const d of r.items) if (d.ip_address) m.set(d.ip_address, d.computer_name || d.operator_name || d.host_name || '');
      setDevmap(m);
    }).catch(() => {});
    const tmr = setInterval(loadStatus, 2000); return () => clearInterval(tmr);
  }, []);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
  const nameOf = (target: string) => devmap.get(target) || (/^\d{1,3}(\.\d{1,3}){3}$/.test(target) ? '' : target);
  const verdict = (up: number | null, down: number | null, err?: string | null) => {
    if (err) { const off = /offline/i.test(err); return { label: err, cls: off ? '' : 'bad', color: off ? 'var(--text-dim)' : 'var(--critical)' }; }
    if (up == null || down == null) return { label: '—', cls: '', color: 'var(--text-dim)' };
    return Math.min(up, down) >= okMbps
      ? { label: 'OK', cls: 'ok', color: 'var(--ok)' }
      : { label: t('linkspeed.problem'), cls: 'bad', color: 'var(--critical)' };
  };
  const running = status?.running ?? false;

  const ipLink = (target: string) => {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(target);
    const onClick = onJumpToComputer ? () => onJumpToComputer(nameOf(target) || target) : undefined;
    return <span onClick={onClick} style={onClick ? { color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' } : undefined} title={onClick ? t('linkspeed.toComputers') : undefined}>{target}</span>;
  };

  const run = async () => {
    setError(null);
    try {
      const r = await api.linkSpeedRun(targets, Number(size) || undefined);
      if (r.error) setError(r.error === 'already_running' ? t('linkspeed.busy') : r.error);
      else { wasRunning.current = true; loadStatus(); }
    } catch (e) { setError(String(e)); }
  };

  // --- exports (history) ---
  const rowVals = (r: LinkSpeedHistoryRow) => [
    r.target, nameOf(r.target), r.up_mbps ?? '', r.down_mbps ?? '',
    r.error ? r.error : (r.up_mbps != null && r.down_mbps != null && Math.min(r.up_mbps, r.down_mbps) >= okMbps ? 'OK' : t('linkspeed.problem')),
    r.size_mb, fmt(r.measured_at),
  ];
  const headers = () => [t('linkspeed.target'), 'Hostname', '↑ Mb/s', '↓ Mb/s', t('linkspeed.verdict'), 'MB', t('linkspeed.when')];
  const exportCsv = () => {
    const lines = [headers().join(';'), ...history.map((r) => rowVals(r).map((v) => String(v)).join(';'))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, `mereni-linky-${Date.now()}.csv`);
  };
  const reportHtml = () => {
    const esc = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    const rows = history.map((r) => {
      const v = verdict(r.up_mbps, r.down_mbps, r.error);
      return `<tr><td>${esc(r.target)}</td><td>${esc(nameOf(r.target))}</td><td>${r.up_mbps ?? '—'}</td><td>${r.down_mbps ?? '—'}</td><td class="${v.cls}">${esc(v.label)}</td><td>${r.size_mb}</td><td>${esc(fmt(r.measured_at))}</td></tr>`;
    }).join('');
    return '﻿<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><title>' + t('linkspeed.title') + '</title><style>' + REPORT_CSS + '</style></head><body><div class="ls-rep">'
      + `<h1>⚡ ${t('linkspeed.title')}</h1><div class="meta">ITDashboard · ${t('linkspeed.okAt')} ≥ ${okMbps} Mb/s · ${new Date().toLocaleString()}</div>`
      + `<table><thead><tr>${headers().map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></body></html>`;
  };
  const saveHtml = () => triggerDownload(new Blob([reportHtml()], { type: 'text/html;charset=utf-8' }), `mereni-linky-${Date.now()}.html`);
  const printPdf = () => {
    const w = window.open('', '_blank', 'width=1000,height=800');
    if (!w) return;
    w.document.write(reportHtml()); w.document.close(); w.focus(); setTimeout(() => w.print(), 350);
  };
  const triggerDownload = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <div className="panel-header">
        <h2>⚡ {t('linkspeed.title')}</h2>
        <div className="panel-actions">
          <button className="refresh-btn" onClick={exportCsv} disabled={!history.length} title="CSV">⬇ CSV</button>
          <button className="refresh-btn" onClick={saveHtml} disabled={!history.length} title="HTML">⬇ HTML</button>
          <button className="refresh-btn" onClick={printPdf} disabled={!history.length} title="PDF / tisk">🖨 PDF</button>
          <button className="refresh-btn" onClick={() => { loadStatus(); loadHistory(); }}>↻</button>
        </div>
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
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="refresh-btn" onClick={run} disabled={running || !targets.trim()} style={{ fontWeight: 600 }}>
                {running ? `… ${t('linkspeed.running')}` : `▶ ${t('linkspeed.run')}`}
              </button>
              {running && <button className="refresh-btn" onClick={() => api.linkSpeedStop().then(loadStatus).catch(() => {})} style={{ color: 'var(--critical)' }}>■ {t('linkspeed.stop')}</button>}
            </div>
          </div>
        </div>
        {error && <div style={{ color: 'var(--critical)', marginBottom: 10 }}>⚠ {error}</div>}

        {running && status && <div style={{ fontSize: 12, marginBottom: 10 }}>{t('linkspeed.progress')}: <b>{status.done}/{status.total}</b>{status.current ? ` · ${status.current}` : ''} <span style={{ color: 'var(--text-dim)' }}>({status.sizeMB} MB)</span></div>}

        <h3 style={{ fontSize: 14, margin: '6px 0 8px' }}>{t('linkspeed.history')}</h3>
        {history.length === 0 ? <div style={{ color: 'var(--text-dim)' }}>{t('linkspeed.noHistory')}</div> : (
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%', maxWidth: 920 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--text-dim)' }}>
              <th style={{ padding: '4px 10px' }}>{t('linkspeed.target')}</th><th style={{ padding: '4px 10px' }}>Hostname</th><th style={{ padding: '4px 10px' }}>↑</th><th style={{ padding: '4px 10px' }}>↓</th><th style={{ padding: '4px 10px' }}>{t('linkspeed.verdict')}</th><th style={{ padding: '4px 10px' }}>MB</th><th style={{ padding: '4px 10px' }}>{t('linkspeed.when')}</th>
            </tr></thead>
            <tbody>
              {history.map((r) => { const v = verdict(r.up_mbps, r.down_mbps, r.error); return (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)', fontFamily: 'Consolas, monospace' }}>
                  <td style={{ padding: '5px 10px' }}>{ipLink(r.target)}</td>
                  <td style={{ padding: '5px 10px' }}>{nameOf(r.target) || '—'}</td>
                  <td style={{ padding: '5px 10px' }}>{r.up_mbps ?? '—'}</td>
                  <td style={{ padding: '5px 10px' }}>{r.down_mbps ?? '—'}</td>
                  <td style={{ padding: '5px 10px', color: v.color, fontWeight: 600 }}>{v.label}</td>
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
