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

type SortKey = 'target' | 'hostname' | 'up' | 'down' | 'latency' | 'status' | 'size' | 'cycles' | 'when';

// Column filter expressions for numeric columns: "300..500" (range), ">300",
// ">=300", "<100", "<=100", "=300"/"300" (exact), else substring fallback.
function matchNum(val: number | null, expr: string): boolean {
  const q = expr.trim(); if (!q) return true; if (val == null) return false;
  let m = /^(-?\d+(?:[.,]\d+)?)\s*\.\.\s*(-?\d+(?:[.,]\d+)?)$/.exec(q);
  if (m) { const a = +m[1]!.replace(',', '.'), b = +m[2]!.replace(',', '.'); return val >= Math.min(a, b) && val <= Math.max(a, b); }
  m = /^(>=|<=|>|<)\s*(-?\d+(?:[.,]\d+)?)$/.exec(q);
  if (m) { const n = +m[2]!.replace(',', '.'); return m[1] === '>' ? val > n : m[1] === '<' ? val < n : m[1] === '>=' ? val >= n : val <= n; }
  m = /^=?\s*(-?\d+(?:[.,]\d+)?)$/.exec(q);
  if (m) return val === +m[1]!.replace(',', '.');
  return String(val).includes(q);
}
// Date column: "d1..d2" (range), ">=d", "<d", … on the ISO timestamp; else substring
// on the displayed local string. Accepts YYYY-MM-DD or anything Date can parse.
// Parse a user-typed threshold. Accepts the Czech compact format the column shows —
// "DD.MM.YYYY", optionally " HH:MM[:SS]" — as LOCAL time, plus anything Date can parse
// (e.g. "2026-07-01"). Returns epoch ms or null. (Plain new Date("01.07.2026") is
// invalid/ambiguous in V8, which is why >/< silently fell back to substring before.)
function parseUserDate(s: string): number | null {
  const q = (s || '').trim(); if (!q) return null;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(q);
  if (m) return new Date(+m[3]!, +m[2]! - 1, +m[1]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
  const d = new Date(q); return isNaN(d.getTime()) ? null : d.getTime();
}
function matchDate(iso: string, display: string, expr: string): boolean {
  const q = expr.trim(); if (!q) return true;
  const t = new Date(iso).getTime();
  const p = parseUserDate;
  let m = /^(.+?)\s*\.\.\s*(.+)$/.exec(q);
  if (m) { const a = p(m[1]!), b = p(m[2]!); if (a != null && b != null) return t >= Math.min(a, b) && t <= Math.max(a, b); }
  m = /^(>=|<=|>|<)\s*(.+)$/.exec(q);
  if (m) { const n = p(m[2]!); if (n != null) return m[1] === '>' ? t > n : m[1] === '<' ? t < n : m[1] === '>=' ? t >= n : t <= n; }
  return display.toLowerCase().includes(q.toLowerCase());
}

export function LinkSpeedPage({ onJumpToComputer }: { onJumpToComputer?: (q: string) => void }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState('');
  const [size, setSize] = useState('');
  const [cycles, setCycles] = useState('');   // empty = use linkspeed.cycles from settings
  const [ignoreExcl, setIgnoreExcl] = useState(false);   // manual run: measure excluded hosts too
  const [status, setStatus] = useState<LinkSpeedStatus | null>(null);
  const [history, setHistory] = useState<LinkSpeedHistoryRow[]>([]);
  const [okMbps, setOkMbps] = useState(200);
  const [devmap, setDevmap] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState<'all' | 'ok' | 'problem' | 'offline' | 'error'>('all');
  const [fAll, setFAll] = useState('');
  const [colF, setColF] = useState<Record<SortKey, string>>({ target: '', hostname: '', up: '', down: '', latency: '', status: '', size: '', cycles: '', when: '' });
  const consoleRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => { const c = consoleRef.current; if (c) c.scrollTop = c.scrollHeight; }, [status?.results.length, status?.current]);

  // Compact, fixed-width timestamp "DD.MM.YYYY HH:MM:SS" — toLocaleString() renders
  // "1. 7. 2026 7:02:16" (spaces + variable width) which wraps the KDY column onto 3 lines.
  const fmt = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const nameOf = (target: string) => devmap.get(target) || (/^\d{1,3}(\.\d{1,3}){3}$/.test(target) ? '' : target);
  // Prefer the hostname resolved+stored at measurement time; fall back to the live
  // IP→name map for older rows that predate the stored column.
  const hostOf = (r: LinkSpeedHistoryRow) => r.host_name || nameOf(r.ip_address ?? r.target);
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
  type Col = { key: SortKey; label: string; type?: 'num' | 'date'; hint?: string; val: (r: LinkSpeedHistoryRow) => string; num?: (r: LinkSpeedHistoryRow) => number | null; iso?: (r: LinkSpeedHistoryRow) => string; sort: (r: LinkSpeedHistoryRow) => string | number };
  const cols: Col[] = [
    { key: 'target', label: t('linkspeed.target'), val: (r) => r.ip_address ?? r.target, sort: (r) => r.ip_address ?? r.target },
    { key: 'hostname', label: 'Hostname', val: (r) => hostOf(r), sort: (r) => hostOf(r).toLowerCase() },
    { key: 'up', label: '↑ Mb/s', type: 'num', hint: '>300  <100  300..500', val: (r) => (r.up_mbps ?? '—').toString(), num: (r) => r.up_mbps, sort: (r) => r.up_mbps ?? -1 },
    { key: 'down', label: '↓ Mb/s', type: 'num', hint: '>300  <100  300..500', val: (r) => (r.down_mbps ?? '—').toString(), num: (r) => r.down_mbps, sort: (r) => r.down_mbps ?? -1 },
    { key: 'latency', label: t('linkspeed.latency'), type: 'num', hint: '<10  >50  10..50', val: (r) => (r.latency_ms ?? '—').toString(), num: (r) => r.latency_ms, sort: (r) => r.latency_ms ?? 99999 },
    { key: 'status', label: t('linkspeed.verdict'), val: (r) => verdict(r.up_mbps, r.down_mbps, r.error).label, sort: (r) => verdict(r.up_mbps, r.down_mbps, r.error).label.toLowerCase() },
    { key: 'size', label: 'MB', type: 'num', hint: '>50  <200  50..200', val: (r) => String(r.size_mb), num: (r) => r.size_mb, sort: (r) => r.size_mb },
    { key: 'cycles', label: t('linkspeed.cyclesCol'), type: 'num', hint: '=4  >1', val: (r) => (r.cycles ?? '—').toString(), num: (r) => r.cycles, sort: (r) => r.cycles ?? -1 },
    { key: 'when', label: t('linkspeed.when'), type: 'date', hint: '>01.07.2026 06:00   <01.07.2026   30.06.2026..01.07.2026', val: (r) => fmt(r.measured_at), iso: (r) => r.measured_at, sort: (r) => r.measured_at },
  ];

  // Short help shown on hover over each history column header.
  const headHelp: Record<SortKey, string> = {
    target: t('linkspeed.h.target'), hostname: t('linkspeed.h.hostname'),
    up: t('linkspeed.h.up'), down: t('linkspeed.h.down'), latency: t('linkspeed.h.latency'),
    status: t('linkspeed.h.status'), size: t('linkspeed.h.size'), cycles: t('linkspeed.h.cycles'),
    when: t('linkspeed.h.when'),
  };

  const view = history.filter((r) => {
    if (fStatus !== 'all' && cat(r) !== fStatus) return false;
    if (fAll.trim() && !cols.map((c) => c.val(r)).join(' ').toLowerCase().includes(fAll.toLowerCase())) return false;
    for (const c of cols) {
      const q = colF[c.key].trim(); if (!q) continue;
      if (c.type === 'num') { if (!matchNum(c.num!(r), q)) return false; }
      else if (c.type === 'date') { if (!matchDate(c.iso!(r), c.val(r), q)) return false; }
      else if (!c.val(r).toLowerCase().includes(q.toLowerCase())) return false;
    }
    return true;
  }).sort((a, b) => {
    const col = cols.find((c) => c.key === sortKey)!; const av = col.sort(a); const bv = col.sort(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
  });
  const toggleSort = (k: SortKey) => { if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1)); else { setSortKey(k); setSortDir(1); } };

  // Visual summary over the LATEST measurement per machine IDENTITY (history is
  // newest-first). Identity = the PC name (via IP→name map) or the raw target, so the
  // same machine measured by both IP and hostname is counted ONCE. Rows older than the
  // reset baseline are excluded (non-destructive reset — they stay in the history grid).
  const baselineAt = status?.baselineAt ?? null;
  const identityKey = (r: LinkSpeedHistoryRow) => (hostOf(r) || r.ip_address || r.target).toLowerCase();
  const latestPerTarget = (() => {
    const m = new Map<string, LinkSpeedHistoryRow>();
    for (const r of history) {
      if (baselineAt && r.measured_at < baselineAt) continue;
      const k = identityKey(r);
      if (!m.has(k)) m.set(k, r);
    }
    return [...m.values()];
  })();
  const counts = { ok: 0, problem: 0, offline: 0, error: 0 };
  for (const r of latestPerTarget) counts[cat(r)]++;
  const bars = latestPerTarget.filter((r) => r.up_mbps != null && r.down_mbps != null).map((r) => ({ r, mbps: Math.min(r.up_mbps!, r.down_mbps!) })).sort((a, b) => a.mbps - b.mbps).slice(0, 10);
  const barMax = Math.max(1000, ...bars.map((b) => b.mbps));

  const ipLink = (target: string) => {
    const onClick = onJumpToComputer ? () => onJumpToComputer(nameOf(target) || target) : undefined;
    return <span onClick={onClick} style={onClick ? { color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' } : undefined} title={onClick ? t('linkspeed.toComputers') : undefined}>{target}</span>;
  };

  const run = async () => {
    setError(null);
    try {
      const r = await api.linkSpeedRun(targets, Number(size) || undefined, Number(cycles) || undefined, ignoreExcl);
      if (r.error) setError(r.error === 'already_running' ? t('linkspeed.busy') : r.error);
      else { wasRunning.current = true; loadStatus(); }
    } catch (e) { setError(String(e)); }
  };

  // Non-destructive reset: records a baseline so the summary/slowest start fresh from
  // now. Nothing is deleted from SQL — the history grid below still shows everything.
  const doReset = async () => {
    if (!window.confirm(t('linkspeed.resetConfirm'))) return;
    await api.linkSpeedReset().then(loadStatus).catch(() => {});
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
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>{t('linkspeed.cyclesCol')}</div>
            <input type="number" min={1} max={20} value={cycles} onChange={(e) => setCycles(e.target.value)}
              placeholder={String(status?.defaultCycles ?? '')} title={t('linkspeed.cyclesHint')} style={{ width: 90, padding: 5 }} />
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4 }}>{t('linkspeed.cyclesDefault')}: {status?.defaultCycles ?? '—'}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="refresh-btn" onClick={run} disabled={running || !targets.trim()} style={{ fontWeight: 600 }}>{running ? `… ${t('linkspeed.running')}` : `▶ ${t('linkspeed.run')}`}</button>
              {running && <button className="refresh-btn" onClick={() => api.linkSpeedStop().then(loadStatus).catch(() => {})} style={{ color: 'var(--critical)' }}>■ {t('linkspeed.stop')}</button>}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11.5, color: 'var(--text-dim)', cursor: 'pointer' }} title={t('linkspeed.ignoreExclHint')}>
              <input type="checkbox" checked={ignoreExcl} onChange={(e) => setIgnoreExcl(e.target.checked)} />
              {t('linkspeed.ignoreExcl')}
            </label>
          </div>
        </div>
        {error && <div style={{ color: 'var(--critical)', marginBottom: 10 }}>⚠ {error}</div>}
        {running && status && <div style={{ fontSize: 12, marginBottom: 6 }}>{t('linkspeed.progress')}: <b>{status.done}/{status.total}</b>{status.current ? ` · ${status.current}${nameOf(status.current) ? ` (${nameOf(status.current)})` : ''}` : ''}{status.cycleTotal > 0 ? ` · ${t('linkspeed.cycleN')} ${status.cycleDone}/${status.cycleTotal}` : ''} <span style={{ color: 'var(--text-dim)' }}>({status.sizeMB} MB)</span></div>}
        {status && (running || status.results.length > 0) && (
          <div ref={consoleRef} style={{ background: '#05070a', fontFamily: 'Consolas, monospace', fontSize: 11.5, lineHeight: 1.5, padding: 10, borderRadius: 6, maxHeight: 220, overflow: 'auto', marginBottom: 14 }}>
            {status.results.map((r, i) => {
              const off = r.error && /offline/i.test(r.error);
              const col = r.error ? (off ? '#8899aa' : '#ff6b6b') : (r.upMbps != null && r.downMbps != null && Math.min(r.upMbps, r.downMbps) < okMbps ? '#f5a524' : '#9fe6c4');
              const host = r.hostname || nameOf(r.ip ?? r.target);
              const head = `${r.ip ?? r.target}${host ? `  ${host}` : ''}`;
              const txt = r.error
                ? `${head}  ${r.error}`
                : `${head}  ↑${r.upMbps} ↓${r.downMbps} Mb/s${r.latencyMs != null ? `  ${r.latencyMs} ms` : ''}${r.cycles ? `  ${r.cycles}× cyklů` : ''}`;
              return <div key={i} style={{ color: col, whiteSpace: 'pre-wrap' }}>{txt}</div>;
            })}
            {running && (() => {
              const curHost = status.current ? nameOf(status.current) : '';
              const cyc = status.cycleTotal > 0 ? ` · ${t('linkspeed.cycleN')} ${status.cycleDone}/${status.cycleTotal}` : '';
              return <div style={{ color: '#8899aa' }}>… {status.current ?? ''}{curHost ? `  ${curHost}` : ''}{cyc} ({status.done}/{status.total})</div>;
            })()}
          </div>
        )}

        {latestPerTarget.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 6px' }}>
              <h3 style={{ fontSize: 14, margin: 0 }}>{t('linkspeed.overview')}</h3>
              <button className="refresh-btn" onClick={doReset} title={t('linkspeed.resetHint')} style={{ fontSize: 11 }}>↺ {t('linkspeed.reset')}</button>
              {baselineAt && <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{t('linkspeed.since')}: {fmt(baselineAt)}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: bars.length ? 10 : 0 }}>
              {([['ok', 'var(--ok)', 'OK'], ['problem', 'var(--critical)', t('linkspeed.problem')], ['offline', 'var(--text-dim)', 'offline'], ['error', 'var(--warning)', t('linkspeed.f.error')]] as const).map(([k, c, lab]) => (
                <span key={k} style={{ fontSize: 12, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)' }}><b style={{ color: c }}>{counts[k as keyof typeof counts]}</b> {lab}</span>
              ))}
            </div>
            {bars.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>{t('linkspeed.slowest')}</div>}
            {bars.map((b) => { const v = verdict(b.r.up_mbps, b.r.down_mbps, b.r.error); return (
              <div key={b.r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, fontSize: 11.5 }}>
                <span style={{ width: 110, fontFamily: 'Consolas, monospace' }}>{b.r.ip_address ?? b.r.target}</span>
                <span style={{ width: 130, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hostOf(b.r)}</span>
                <div style={{ flex: 1, maxWidth: 340, background: 'rgba(120,130,150,.12)', borderRadius: 4, height: 12 }}>
                  <div style={{ width: `${Math.min(100, b.mbps / barMax * 100)}%`, background: v.color, height: '100%', borderRadius: 4 }} />
                </div>
                <span style={{ width: 72, textAlign: 'right', fontFamily: 'Consolas, monospace', color: v.color }}>{b.mbps} Mb/s</span>
              </div>
            ); })}
          </div>
        )}

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
                {cols.map((c) => <th key={c.key} style={th} title={headHelp[c.key]} onClick={() => toggleSort(c.key)}>{c.label}{sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}</th>)}
              </tr>
              <tr>
                {cols.map((c) => <th key={c.key} style={{ padding: '2px 6px' }}><input value={colF[c.key]} onChange={(e) => setColF((f) => ({ ...f, [c.key]: e.target.value }))} title={c.hint} placeholder={c.type === 'num' ? '>,<,a..b' : c.type === 'date' ? 'a..b' : ''} style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, padding: '2px 4px' }} /></th>)}
              </tr>
            </thead>
            <tbody>
              {view.map((r) => { const v = verdict(r.up_mbps, r.down_mbps, r.error); return (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)', fontFamily: 'Consolas, monospace' }}>
                  <td style={{ padding: '5px 10px' }}>{ipLink(r.ip_address ?? r.target)}</td>
                  <td style={{ padding: '5px 10px' }}>{hostOf(r) || '—'}</td>
                  <td style={{ padding: '5px 10px' }}>{r.up_mbps ?? '—'}</td>
                  <td style={{ padding: '5px 10px' }}>{r.down_mbps ?? '—'}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text-dim)' }}>{r.latency_ms ?? '—'}</td>
                  <td style={{ padding: '5px 10px', color: v.color, fontWeight: 600 }}>{v.label}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text-dim)' }}>{r.size_mb}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text-dim)' }}>{r.cycles ?? '—'}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmt(r.measured_at)}</td>
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
