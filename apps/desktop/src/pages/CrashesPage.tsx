import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import type { CrashItem, CrashDetail } from '../api.js';
import { useI18n } from '../i18n.js';

// White, theme-independent printable report for one crash — same approach as the
// Manager Summary / Presentation (scoped CSS, print to a new window, save as
// standalone HTML).
const REPORT_CSS = `
.cr-wrap,.cr-wrap *{box-sizing:border-box}
.cr-wrap{font-family:'Segoe UI',Arial,sans-serif;color:#111;background:#fff;max-width:900px;margin:0 auto;padding:26px;font-size:12.5px;line-height:1.5}
.cr-wrap .cr-top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #b91c1c;padding-bottom:12px;margin-bottom:16px}
.cr-wrap h1{font-size:20px;margin:0;color:#111}
.cr-wrap .cr-host{font-family:Consolas,monospace;font-weight:700;font-size:22px;color:#b91c1c}
.cr-wrap .cr-meta{font-family:Consolas,monospace;font-size:11px;color:#555}
.cr-wrap .cr-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}
.cr-wrap .cr-kpi{border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;background:#fafafa}
.cr-wrap .cr-kpi .v{font-family:Consolas,monospace;font-weight:700;font-size:15px;color:#111;word-break:break-word}
.cr-wrap .cr-kpi .l{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#777;margin-top:4px}
.cr-wrap h2{font-size:14px;margin:18px 0 8px;color:#b91c1c;border-bottom:1px solid #eee;padding-bottom:4px}
.cr-wrap pre{background:#0b0f14;color:#d6e9d6;font-family:Consolas,monospace;font-size:11px;line-height:1.5;padding:14px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.cr-wrap .cr-note{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 14px;font-size:12px}
.cr-wrap ul{margin:8px 0;padding-left:20px}
.cr-wrap .foot{margin-top:24px;border-top:1px solid #eee;padding-top:8px;font-size:10px;color:#999}
@media print{@page{margin:12mm}.cr-wrap h2{break-after:avoid}.cr-wrap .cr-kpis,.cr-wrap pre{break-inside:avoid}}
`;

// Short per-bugcheck hint (honest, generic) for the report's "co dál".
const BUGCHECK_HINT: Record<string, string> = {
  '0x133': 'Dlouho běžící DPC / práce na DISPATCH_LEVEL. Viz vinící proces/modul — typicky ovladač, nebo aplikace zavírající velkou paměťovou sekci. Aktualizovat ovladače (storage/NIC/GPU) a Windows.',
  '0xd1': 'Ovladač přistoupil na špatnou paměť na vysokém IRQL. Vinící modul je obvykle přímo ve stacku — aktualizovat/odinstalovat ten ovladač.',
  '0x1a': 'Poškození správy paměti — typicky vadný ovladač, méně často fyzická RAM (test mdsched).',
  '0x50': 'Přístup na neplatnou stránku paměti — vadný ovladač nebo HW (RAM/disk).',
  '0x7e': 'Neošetřená výjimka ve vlákně jádra — viz vinící modul; aktualizovat ovladač/SW.',
  '0x3b': 'Výjimka v systémové službě — často ovladač GPU/AV.',
  '0xc2': 'Špatné použití pool paměti ovladačem — viz vinící modul.',
  '0x139': 'Kernel security check — poškození struktur, často ovladač/HW.',
  '0x124': 'Hardwarová chyba (WHEA) — CPU/RAM/sběrnice/teploty. Zkontrolovat HW.',
};

export function CrashesPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<CrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<CrashDetail | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const load = () => {
    setLoading(true);
    api.crashes().then((r) => { setItems(r.items); setError(null); })
      .catch((e) => setError(String(e))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const run = async () => {
    setRunning(true); setError(null);
    try { await api.crashRun(); load(); }
    catch (e) { setError(String(e)); }
    finally { setRunning(false); }
  };
  const open = async (id: number) => {
    try { setSel(await api.crashDetail(id)); }
    catch (e) { setError(String(e)); }
  };

  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—';
  const culprit = (c: CrashItem) => c.culprit_process || c.culprit_module || (c.hot_function ?? '—');

  // --- aggregations ---
  const analyzed = items.filter((c) => c.status === 'analyzed');
  const byStop = new Map<string, number>();
  for (const c of analyzed) { const k = `${c.stop_code ?? '?'} ${c.bugcheck_name ?? ''}`.trim(); byStop.set(k, (byStop.get(k) ?? 0) + 1); }
  const byCulprit = new Map<string, number>();
  for (const c of analyzed) { const k = c.culprit_process || c.culprit_module; if (k) byCulprit.set(k, (byCulprit.get(k) ?? 0) + 1); }
  const byPc = new Map<string, number>();
  for (const c of items) { const k = c.computer_name ?? '?'; byPc.set(k, (byPc.get(k) ?? 0) + 1); }
  const top = (m: Map<string, number>, n = 4) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const repeat = top(byPc).filter(([, n]) => n > 1);

  // --- white report (print / save) ---
  const buildReportHtml = () => {
    const body = reportRef.current ? reportRef.current.outerHTML : '';
    return '<!DOCTYPE html>\n<html lang="cs"><head><meta charset="UTF-8">'
      + `<title>${t('crash.report.title')} — ${sel?.computer_name ?? ''}</title>`
      + '<style>' + REPORT_CSS + '</style></head><body>' + body + '</body></html>';
  };
  const printReport = () => {
    const w = window.open('', '_blank', 'width=1000,height=800');
    if (!w) { window.print(); return; }
    w.document.write(buildReportHtml()); w.document.close(); w.focus();
    setTimeout(() => w.print(), 350);
  };
  const saveReport = () => {
    const blob = new Blob([buildReportHtml()], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analyza-padu-${sel?.computer_name ?? 'pc'}-${(sel?.source_filename ?? '').replace(/\.dmp$/i, '')}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const badge = (status: string) => {
    const m: Record<string, { bg: string; c: string }> = {
      analyzed: { bg: 'rgba(63,214,140,.15)', c: 'var(--ok)' },
      pending: { bg: 'rgba(245,165,36,.15)', c: 'var(--warning)' },
      failed: { bg: 'rgba(255,77,77,.15)', c: 'var(--critical)' },
    };
    const s = m[status] ?? { bg: 'rgba(120,130,150,.15)', c: 'var(--text-dim)' };
    const label = status === 'analyzed' ? t('crash.status.analyzed') : status === 'pending' ? t('crash.status.pending') : status === 'failed' ? t('crash.status.failed') : status;
    return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 5, background: s.bg, color: s.c }}>{label}</span>;
  };

  const agg = (title: string, rows: [string, number][]) => (
    <div style={{ flex: 1, minWidth: 200, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-dim)', marginBottom: 6 }}>{title}</div>
      {rows.length === 0 ? <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>—</div> :
        rows.map(([k, n]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '2px 0', fontFamily: 'Consolas, monospace' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
            <b style={{ color: 'var(--accent)' }}>{n}×</b>
          </div>
        ))}
    </div>
  );

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <div className="panel-header">
        <h2>💥 {t('crash.title')} <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 12 }}>({items.length})</span></h2>
        <div className="panel-actions">
          <button className="refresh-btn" onClick={load} disabled={loading}>↻</button>
          <button className="refresh-btn" onClick={run} disabled={running} style={{ fontWeight: 600 }}>
            {running ? `… ${t('crash.running')}` : `▶ ${t('crash.run')}`}
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ flex: 'none' }}>
        {error && <div style={{ color: 'var(--critical)', marginBottom: 10 }}>⚠ {error}</div>}

        {/* agregace */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {agg(t('crash.agg.stop'), top(byStop))}
          {agg(t('crash.agg.culprit'), top(byCulprit))}
          {agg(t('crash.agg.repeat'), repeat)}
        </div>

        {/* tabulka */}
        {items.length === 0 ? (
          <div style={{ color: 'var(--text-dim)', padding: 20 }}>{loading ? '…' : t('crash.none')}</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase' }}>
              <th style={{ padding: '6px 8px' }}>{t('crash.col.pc')}</th>
              <th style={{ padding: '6px 8px' }}>{t('crash.col.time')}</th>
              <th style={{ padding: '6px 8px' }}>{t('crash.col.stop')}</th>
              <th style={{ padding: '6px 8px' }}>{t('crash.col.bugcheck')}</th>
              <th style={{ padding: '6px 8px' }}>{t('crash.col.culprit')}</th>
              <th style={{ padding: '6px 8px' }}>{t('crash.col.status')}</th>
            </tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} onClick={() => open(c.id)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: sel?.id === c.id ? 'rgba(120,130,150,.08)' : undefined }}>
                  <td style={{ padding: '6px 8px', fontFamily: 'Consolas, monospace' }}>{c.computer_name}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--text-dim)' }}>{fmt(c.occurred_at)}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'Consolas, monospace', color: 'var(--critical)' }}>{c.stop_code ?? '—'}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'Consolas, monospace', fontSize: 12 }}>{c.bugcheck_name ?? '—'}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'Consolas, monospace', fontSize: 12 }}>{culprit(c)}</td>
                  <td style={{ padding: '6px 8px' }}>{badge(c.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* detail */}
        {sel && (
          <div style={{ marginTop: 16, border: '1px solid var(--accent)', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
              <strong style={{ fontFamily: 'Consolas, monospace', fontSize: 15 }}>{sel.computer_name} · {sel.source_filename}</strong>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <a className="refresh-btn" href={api.crashDmpUrl(sel.id)} style={{ textDecoration: 'none' }}>⬇ .dmp</a>
                <button className="refresh-btn" onClick={printReport}>🖨 {t('crash.detail.report')}</button>
                <button className="refresh-btn" onClick={saveReport}>⬇ HTML</button>
                <button className="refresh-btn" onClick={() => setSel(null)}>✕</button>
              </span>
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontFamily: 'Consolas, monospace', fontSize: 12.5, marginBottom: 10 }}>
              <span><span style={{ color: 'var(--text-dim)' }}>STOP </span><b style={{ color: 'var(--critical)' }}>{sel.stop_code ?? '—'}</b> {sel.bugcheck_name ?? ''}</span>
              <span><span style={{ color: 'var(--text-dim)' }}>proces </span>{sel.culprit_process ?? '—'}</span>
              <span><span style={{ color: 'var(--text-dim)' }}>modul </span>{sel.culprit_module ?? '—'}</span>
              <span><span style={{ color: 'var(--text-dim)' }}>hot </span>{sel.hot_function ?? '—'}</span>
            </div>
            {sel.analyze_error && <div style={{ color: 'var(--critical)', fontSize: 12, marginBottom: 8 }}>⚠ {sel.analyze_error}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>{t('crash.detail.stack')}</div>
            <pre style={{ background: '#05070a', color: '#9fe6c4', fontFamily: 'Consolas, monospace', fontSize: 11.5, lineHeight: 1.5, padding: 12, borderRadius: 6, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{sel.analyze_text ?? '—'}</pre>
          </div>
        )}
      </div>

      {/* hidden white report for print/save */}
      {sel && (
        <div style={{ position: 'absolute', left: -99999, top: 0 }} aria-hidden>
          <div ref={reportRef} className="cr-wrap">
            <div className="cr-top">
              <div>
                <h1>{t('crash.report.title')}</h1>
                <div className="cr-meta">ITDashboard · dump z databáze · {new Date().toLocaleString()}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="cr-host">{sel.computer_name}</div>
                <div className="cr-meta">{fmt(sel.occurred_at)}</div>
              </div>
            </div>
            <div className="cr-kpis">
              <div className="cr-kpi"><div className="v">{sel.stop_code ?? '—'}</div><div className="l">STOP code</div></div>
              <div className="cr-kpi"><div className="v">{sel.bugcheck_name ?? '—'}</div><div className="l">Bugcheck</div></div>
              <div className="cr-kpi"><div className="v">{sel.culprit_process ?? '—'}</div><div className="l">Proces</div></div>
              <div className="cr-kpi"><div className="v">{sel.culprit_module ?? sel.hot_function ?? '—'}</div><div className="l">Modul / hot</div></div>
            </div>
            <h2>Doporučení</h2>
            <div className="cr-note">
              {(sel.stop_code && BUGCHECK_HINT[sel.stop_code]) || 'Z dumpu vytaženy STOP kód, stack a kontext. Pro hlubší rozbor watchdog-typů spusť plný !analyze (starší Debugging Tools). Aktualizovat ovladače a Windows; sledovat opakování napříč flotilou.'}
              <ul>
                <li>Soubor: <b>{sel.source_filename}</b> ({sel.size_bytes ? Math.round(sel.size_bytes / 1024) + ' kB' : '—'})</li>
                <li>Vinící proces: <b>{sel.culprit_process ?? '—'}</b> · modul: <b>{sel.culprit_module ?? '—'}</b> · hot: <b>{sel.hot_function ?? '—'}</b></li>
              </ul>
            </div>
            <h2>Výstup ladění (cdb)</h2>
            <pre>{sel.analyze_text ?? '—'}</pre>
            <div className="foot">Generováno z ITDashboard · {sel.computer_name} · {sel.source_filename}</div>
          </div>
        </div>
      )}
    </div>
  );
}
