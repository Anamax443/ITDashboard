import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import type { LinkSpeedStatus, LinkSpeedHistoryRow } from '../api.js';
import { useI18n } from '../i18n.js';

// "Měření linky": enter targets (IP list / 10.8.2.* / 10.8.2.180-182 / all), the
// server writes a file to each PC's C$ over SMB and reads it back, computing up/down
// Mb/s. Verdict by the WORSE direction vs the OK threshold (catches 100-Mb ports /
// bad cables on a 1 Gb network). Results archived to DB; history is a sortable,
// per-column + global filterable grid with IP→Computers link and CSV/HTML/print.
const REPORT_CSS = `.ls-rep{font-family:'Segoe UI',Arial,sans-serif;color:#111;max-width:920px;margin:0 auto;padding:24px}
.ls-rep h1{font-size:18px;margin:0 0 4px}.ls-rep .meta{color:#555;font-size:12px;margin-bottom:14px}
.ls-rep table{border-collapse:collapse;width:100%;font-size:12px}
.ls-rep th,.ls-rep td{border:1px solid #ddd;padding:5px 8px;text-align:left}
.ls-rep th{background:#f3f4f6}
.ls-rep .bad{color:#b91c1c;font-weight:700}.ls-rep .ok{color:#157347;font-weight:700}
@media print{@page{margin:12mm}}`;

type SortKey = 'target' | 'hostname' | 'up' | 'down' | 'status' | 'size' | 'when';

export function LinkSpeedPage({ onJumpToComputer }: { onJumpToComputer?: (q: string) => void }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState('');
  const [size, setSize] = useState('');
  const [status, setStatus] = useState<LinkSpeedStatus | null>(null);
  const [history, setHistory] = useState<LinkSpeedHistoryRow[]>([]);
  const [okMbps, setOkMbps] = useState(200);
  const [devmap, setDevmap] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState<'all' | 'ok' | 'problem' | 'offline' | 'error'>('all');
  const [fAll, setFAll] = useState('');
  const [colF, setColF] = useState<Record<SortKey, string>>({ target: '', hostname: '', up: '', down: '', status: '', size: '', when: '' });
  const [sortKey, setSortKey] = useState<SortKey>('when');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const wasRunning = useRef(false);

  const loadStatus = () => api.linkSpeedStatus().then((s) => {
    setStatus(s); setOkMbps(s.okMbps);
    if (size === '') setSize(String(s.defaultSizeMB));
    if (wasRunning.current && !s.running) loadHistory();
    wasRunning.current = s.running;
  }).catch(() => {});
  const loadHistory = () => api.linkSpeedHistory(2000).then((r) => { setHistory(r.items); setOkMbps(r.okMbps); }).catch(() => {});

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
    return Math.min(up, down) >= okMbps ? { label: 'OK', cls: 'ok', color: 'var(--ok)' } : { label: t('linkspeed.problem'), cls: 'bad', color: 'var(--critical)' };
  };
  const cat = (r: LinkSpeedHistoryRow): 'ok' | 'problem' | 'offline' | 'error' => {
    if (r.error) return /offline/i.test(r.error) ? 'offline' : 'error';
    if (r.up_mbps == null || r.down_mbps == null) return 'error';
    return Math.min(r.up_mbps, r.down_mbps) >= okMbps ? 'ok' : 'problem';
  };
  const running = status?.running ?? false;

  // One column definition drives the header, per-column filter, sort and exports.
  const cols: { key: SortKey; label: string; val: (r: LinkSpeedHistoryRow) => string; sort: (r: LinkSpeedHistoryRow) => string | number }[] = [
    { key: 'target', label: t('linkspeed.target'), val: (r) => r.target, sort: (r) => r.target },
    { key: 'hostname', label: 'Hostname', val: (r) => nameOf(r.target), sort: (r) => nameOf(r.target).toLowerCase() },
    { key: 'up', label: '↑ Mb/s', val: (r) => (r.up_mbps ?? '—').toString(), sort: (r) => r.up_mbps ?? -1 },
    { key: 'down', label: '↓ Mb/s', val: (r) => (r.down_mbps ?? '—').toString(), sort: (r) => r.down_mbps ?? -1 },
    { key: 'status', label: t('linkspeed.verdict'), val: (r) => verdict(r.up_mbps, r.down_mbps, r.error).label, sort: (r) => verdict(r.up_mbps, r.down_mbps, r.error).label.toLowerCase() },
    { key: 'size', label: 'MB', val: (r) => String(r.size_mb), sort: (r) => r.size_mb },
    { key: 'when', label: t('linkspeed.when'), val: (r) => fmt(r.measured_at), sort: (r) => r.measured_at },
  ];

  const view = history.filter((r) => {
    if (fStatus !== 'all' && cat(r) !== fStatus) return false;
    if (fAll.trim() && !cols.map((c) => c.val(r)).join(' ').toLowerCase().includes(fAll.toLowerCase())) return false;
    for (const c of cols) { const q = colF[c.key].trim().toLowerCase(); if (q && !c.val(r).toLowerCase().includes(q)) return false; }
    return true;
  }).sort((a, b) => {
    const col = cols.find((c) => c.key === sortKey)!; const av = col.sort(a); const bv = col.sort(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
  });
  const toggleSort = (k: SortKey) => { if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1)); else { setSortKey(k); setSortDir(1); } };

  const ipLink = (target: string) => {
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

  // --- exports (the filtered+sorted view) ---
  const exportCsv = () => {
    const lines = [cols.map((c) => c.label).join(';'), ...view.map((r) => cols.map((c) => c.val(r)).join(';'))];
    triggerDownload(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `mereni-linky-${Date.now()}.csv`);
  };
  const reportHtml = () => {
    const esc = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    const rows = view.map((r) => `<tr>${cols.map((c) => c.key === 'status' ? `<td class="${verdict(r.up_mbps, r.down_mbps, r.error).cls}">${esc(c.val(r))}</td>` : `<td>${esc(c.val(r))}</td>`).join('')}</tr>`).join('');
    return '﻿<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><title>' + t('linkspeed.title') + '</title><style>' + REPORT_CSS + '</style></head><body><div class="ls-rep">'
      + `<h1>⚡ ${t('linkspeed.title')}</h1><div class="meta">ITDashboard · ${t('linkspeed.okAt')} ≥ ${okMbps} Mb/s · ${new Date().toLocaleString()}</div>`
      + `<table><thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></body></html>`;
  };
  const saveHtml = () => triggerDownload(new Blob([reportHtml()], { type: 'text/html;charset=utf-8' }), `mereni-linky-${Date.now()}.html`);
  const printPdf = () => { const w = window.open('', '_blank', 'width=1000,height=800'); if (!w) return; w.document.write(reportHtml()); w.document.close(); w.focus(); setTimeout(() => w.print(), 350); };
  const triggerDownload = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); };

  const th = { padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' as const, userSelect: 'none' as const };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <div className="panel-header">
        <h2>⚡ {t('linkspeed.title')}</h2>
        <div className="panel-actions">
          <button className="refresh-btn" onClick={exportCsv} disabled={!view.length} title="CSV">⬇ CSV</button>
          <button className="refresh-btn" onClick={saveHtml} disabled={!view.length} title="HTML">⬇ HTML</button>
          <button className="refresh-btn" onClick={printPdf} disabled={!view.length} title="PDF / tisk">🖨 PDF</button>
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
              <button className="refresh-btn" onClick={run} disabled={running || !targets.trim()} style={{ fontWeight: 600 }}>{running ? `… ${t('linkspeed.running')}` : `▶ ${t('linkspeed.run')}`}</button>
              {running && <button className="refresh-btn" onClick={() => api.linkSpeedStop().then(loadStatus).catch(() => {})} style={{ color: 'var(--critical)' }}>■ {t('linkspeed.stop')}</button>}
            </div>
          </div>
        </div>
        {error && <div style={{ color: 'var(--critical)', marginBottom: 10 }}>⚠ {error}</div>}
        {running && status && <div style={{ fontSize: 12, marginBottom: 10 }}>{t('linkspeed.progress')}: <b>{status.done}/{status.total}</b>{status.current ? ` · ${status.current}` : ''} <span style={{ color: 'var(--text-dim)' }}>({status.sizeMB} MB)</span></div>}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 8px' }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>{t('linkspeed.history')}</h3>
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)} style={{ fontSize: 12, padding: '3px 6px' }}>
            <option value="all">{t('linkspeed.f.all')}</option>
            <option value="problem">{t('linkspeed.problem')}</option>
            <option value="ok">OK</option>
            <option value="offline">offline</option>
            <option value="error">{t('linkspeed.f.error')}</option>
          </select>
          <input value={fAll} onChange={(e) => setFAll(e.target.value)} placeholder={t('linkspeed.f.searchAll')} style={{ fontSize: 12, padding: '3px 6px', width: 220 }} />
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{view.length}/{history.length}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="refresh-btn" onClick={exportCsv} disabled={!view.length}>⬇ CSV</button>
            <button className="refresh-btn" onClick={saveHtml} disabled={!view.length}>⬇ HTML</button>
            <button className="refresh-btn" onClick={printPdf} disabled={!view.length}>🖨 PDF</button>
          </span>
        </div>

        {history.length === 0 ? <div style={{ color: 'var(--text-dim)' }}>{t('linkspeed.noHistory')}</div> : (
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%', maxWidth: 940 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-dim)' }}>
                {cols.map((c) => <th key={c.key} style={th} onClick={() => toggleSort(c.key)}>{c.label}{sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}</th>)}
              </tr>
              <tr>
                {cols.map((c) => <th key={c.key} style={{ padding: '2px 6px' }}><input value={colF[c.key]} onChange={(e) => setColF((f) => ({ ...f, [c.key]: e.target.value }))} style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, padding: '2px 4px' }} /></th>)}
              </tr>
            </thead>
            <tbody>
              {view.map((r) => { const v = verdict(r.up_mbps, r.down_mbps, r.error); return (
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
        {history.length > 0 && view.length === 0 && <div style={{ color: 'var(--text-dim)', marginTop: 8 }}>{t('linkspeed.f.none')}</div>}
      </div>
    </div>
  );
}
