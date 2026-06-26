import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.js';

// "Routers" page — the round-trip "router → FTP files → DB → page" surfaced
// read-only, one card per configured router, scaling to however many are set up.
// Shows the FTP file-source freshness (last file time, minutes since the data last
// advanced, parsed lease/ARP counts, last error) plus a device count by source.

type Row = Awaited<ReturnType<typeof api.routersStatus>>[number];

function fmtAgoMin(mins: number | null): string {
  if (mins == null) return '—';
  if (mins < 1) return 'teď';
  if (mins < 60) return `před ${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `před ${h} h` : `před ${Math.floor(h / 24)} dny`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function Badge({ text, color, bg }: { text: string; color: string; bg: string }) {
  return <span style={{ fontSize: 11, fontWeight: 700, color, background: bg, borderRadius: 999, padding: '2px 9px' }}>{text}</span>;
}

function RouterCard({ r }: { r: Row }) {
  const { t } = useI18n();
  // State colour: error/stale = red, fresh FTP = green, REST-only = neutral.
  const bad = r.stale === true || !!r.lastError;
  const good = r.ftp && r.stale === false;
  const accent = bad ? 'var(--critical)' : good ? 'var(--ok)' : 'var(--text-dim)';
  return (
    <div style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderLeft: `4px solid ${accent}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 17, fontWeight: 700 }}>{r.site}</span>
        <span style={{ color: 'var(--text-dim)', fontFamily: 'Consolas, monospace', fontSize: 13 }}>{r.ip}</span>
        <span style={{ flex: 1 }} />
        {r.ftp
          ? <Badge text="FTP" color="#fff" bg="var(--ok)" />
          : <Badge text={t('net.restOnly')} color="var(--text-dim)" bg="var(--surface-hover)" />}
        {r.muted && <Badge text={t('net.muted')} color="#92400e" bg="#fef3c7" />}
        {bad
          ? <Badge text={t('net.stale')} color="#fff" bg="var(--critical)" />
          : r.ftp && <Badge text={t('net.fresh')} color="#fff" bg="var(--ok)" />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('net.lastData')}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: accent }}>{fmtAgoMin(r.minsSinceChange)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{fmtTime(r.leaseFileTime)}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('net.parsed')}</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{r.ftp ? `${r.leaseCount ?? '—'} / ${r.arpCount ?? '—'}` : '—'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('net.leasesArp')}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('net.devices')}</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{r.devices}</div>
          {r.bySource && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>dhcp {r.bySource.dhcp} · arp {r.bySource.arp} · scan {r.bySource.scan}{r.bySource.unifi ? ` · unifi ${r.bySource.unifi}` : ''}</div>}
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('net.fetched')}</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{fmtTime(r.fetchedAt)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{r.ftp ? t('net.viaFtp') : t('net.viaRest')}</div>
        </div>
      </div>

      {r.lastError && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--critical)', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 10px' }}>
          ⚠ {r.lastError}
        </div>
      )}
    </div>
  );
}

type FetchLog = Awaited<ReturnType<typeof api.ftpFetchNow>>[number];
type DbRow = Awaited<ReturnType<typeof api.dbRows>>['items'][number];
type HistRow = Awaited<ReturnType<typeof api.deviceHistory>>['items'][number];

function fmtSpan(mins: number): string {
  if (mins < 1) return '<1 min';
  if (mins < 60) return mins + ' min';
  const h = Math.floor(mins / 60);
  if (h < 48) return h + ' h';
  return Math.floor(h / 24) + ' d';
}

export function NetworkPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [log, setLog] = useState<FetchLog[] | null>(null);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [dbRows, setDbRows] = useState<DbRow[]>([]);
  const [dbTotal, setDbTotal] = useState(0);
  const [dbSite, setDbSite] = useState('');
  const [dbFilter, setDbFilter] = useState('');
  const [dbSort, setDbSort] = useState<{ col: keyof DbRow; dir: 'asc' | 'desc' }>({ col: 'last_seen', dir: 'desc' });
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(0);
  const [histRows, setHistRows] = useState<HistRow[]>([]);
  const [histQuery, setHistQuery] = useState('');

  const loadDb = (site = dbSite) => {
    api.dbRows(site || undefined, 5000)
      .then((r) => { setDbRows(r.items); setDbTotal(r.total); })
      .catch(() => { /* keep last */ });
  };
  const loadHist = (q = histQuery) => {
    api.deviceHistory(q.trim(), 1000)
      .then((r) => setHistRows(r.items))
      .catch(() => { /* keep last */ });
  };
  const load = () => {
    setLoading(true);
    api.routersStatus()
      .then((r) => { setRows(r); setErr(null); })
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
    loadDb();
  };
  useEffect(() => { load(); loadHist(''); /* eslint-disable-next-line */ }, []);

  // Force an FTP pull NOW; show the per-site communication log in the console box,
  // then reload the cards so fresh file times appear.
  const fetchNow = async () => {
    if (fetching) return;
    setFetching(true);
    setLog([{ site: '', ip: '', ok: true, lines: ['⏳ Stahuji soubory přes FTP…'] }]);
    try {
      const items = await api.ftpFetchNow();
      setLog(items);
      load();
    } catch (e) {
      setLog([{ site: '', ip: '', ok: false, lines: [`⚠ ${e instanceof Error ? e.message : String(e)}`] }]);
    } finally {
      setFetching(false);
    }
  };

  const consoleBtnStyle: CSSProperties = {
    background: 'transparent', color: '#cbd5e1', border: '1px solid #334155', borderRadius: 4,
    width: 26, height: 22, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
  };
  const dbTh: CSSProperties = { textAlign: 'left', padding: '7px 10px', color: 'var(--text-dim)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' };
  const dbTd: CSSProperties = { padding: '6px 10px', whiteSpace: 'nowrap' };

  // Client-side filter (all columns) + sort + pagination over the loaded rows.
  const ipToNum = (ip: string | null) => (ip ?? '').split('.').reduce((a, o) => a * 256 + (Number(o) || 0), 0);
  const fq = dbFilter.trim().toLowerCase();
  const dbView = (fq
    ? dbRows.filter((d) => [d.site, d.ip_address, d.mac_address, d.host_name, d.source, d.status].some((v) => (v ?? '').toLowerCase().includes(fq)))
    : dbRows
  ).slice().sort((a, b) => {
    const c = dbSort.col;
    let r: number;
    if (c === 'ip_address') r = ipToNum(a.ip_address) - ipToNum(b.ip_address);
    else if (c === 'last_seen') r = new Date(a.last_seen).getTime() - new Date(b.last_seen).getTime();
    else r = String(a[c] ?? '').localeCompare(String(b[c] ?? ''), 'cs');
    return dbSort.dir === 'asc' ? r : -r;
  });
  const allPage = pageSize === 0;
  const pageCount = allPage ? 1 : Math.max(1, Math.ceil(dbView.length / pageSize));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = allPage ? dbView : dbView.slice(curPage * pageSize, curPage * pageSize + pageSize);

  const toggleSort = (col: keyof DbRow) => { setDbSort((s) => ({ col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' })); setPage(0); };
  const sortTh = (col: keyof DbRow, label: string) => (
    <th key={String(col)} onClick={() => toggleSort(col)} title={t('net.dbSortHint')} style={{ ...dbTh, cursor: 'pointer', userSelect: 'none' }}>
      {label}{dbSort.col === col ? (dbSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const exportCsv = () => {
    const cols: Array<[keyof DbRow, string]> = [['site', t('net.dbSite')], ['ip_address', 'IP'], ['mac_address', 'MAC'], ['host_name', 'Hostname'], ['source', t('net.dbSource')], ['status', 'Status'], ['last_seen', t('net.dbLastSeen')]];
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.map((c) => c[1]).join(';'), ...dbView.map((d) => cols.map((c) => esc(d[c[0]])).join(';'))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dhcp_leases${dbSite ? '_' + dbSite : ''}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div style={{ padding: 20, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('net.title')}</h2>
        <button className="refresh-btn" onClick={load} disabled={loading} title={t('net.refreshHint')}>{loading ? '…' : `🔄 ${t('net.refresh')}`}</button>
        <button className="refresh-btn" onClick={fetchNow} disabled={fetching} style={{ fontWeight: 600 }} title={t('net.fetchNowHint')}>
          {fetching ? '⏳ …' : `⬇ ${t('net.fetchNow')}`}
        </button>
      </div>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '0 0 16px' }}>{t('net.subtitle')}</p>

      {log && (
        <div style={{ background: '#0b1220', border: '1px solid #1e293b', borderRadius: 8, marginBottom: 16, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 12px', background: '#111827', borderBottom: logCollapsed ? 'none' : '1px solid #1e293b' }}>
            <span style={{ color: '#94a3b8', fontSize: 12, fontFamily: 'Consolas, monospace', flex: 1 }}>▌ {t('net.console')}</span>
            <button onClick={() => setLogCollapsed((c) => !c)} title={logCollapsed ? t('net.consoleExpand') : t('net.consoleMin')}
              style={consoleBtnStyle}>{logCollapsed ? '▢' : '—'}</button>
            <button onClick={() => { setLog(null); setLogCollapsed(false); }} title={t('net.consoleClose')} style={consoleBtnStyle}>×</button>
          </div>
          {!logCollapsed && (
            <div style={{ padding: '12px 14px', fontFamily: 'Consolas, monospace', fontSize: 12.5, lineHeight: 1.5, color: '#cbd5e1', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>
              {log.map((s, i) => (
                <div key={i} style={{ marginBottom: s.site ? 10 : 0 }}>
                  {s.site && <div style={{ color: s.ok ? '#4ade80' : '#f87171', fontWeight: 700 }}>{s.ok ? '●' : '○'} {s.site} {s.ip}</div>}
                  {s.lines.map((ln, j) => (
                    <div key={j} style={{ color: ln.includes('✗') || ln.includes('⚠') ? '#f87171' : (ln.includes('✓') || ln.includes('→')) ? '#86efac' : '#94a3b8' }}>{ln}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {err && <div style={{ color: 'var(--critical)', marginBottom: 12 }}>⚠ {err}</div>}
      {!loading && rows.length === 0 && !err && <div style={{ color: 'var(--text-dim)' }}>{t('net.none')}</div>}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {rows.map((r) => <RouterCard key={r.site} r={r} />)}
      </div>

      <div style={{ marginTop: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>{t('net.dbTitle')}</h3>
          <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{t('net.dbCount').replace('{shown}', String(dbView.length)).replace('{total}', String(dbTotal))}</span>
          <span style={{ flex: 1 }} />
          <input type="search" value={dbFilter} onChange={(e) => { setDbFilter(e.target.value); setPage(0); }}
            placeholder={t('net.dbSearch')} title={t('net.dbSearchHint')}
            style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px', minWidth: 200 }} />
          <select value={dbSite} onChange={(e) => { setDbSite(e.target.value); setPage(0); loadDb(e.target.value); }} title={t('net.dbSiteHint')}
            style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px' }}>
            <option value="">{t('net.dbAllSites')}</option>
            {rows.map((r) => <option key={r.site} value={r.site}>{r.site}</option>)}
          </select>
          <button className="refresh-btn" onClick={exportCsv} disabled={dbView.length === 0} title={t('net.dbExportHint')}>⬇ {t('net.dbExport')}</button>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', maxHeight: 520 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
                {sortTh('site', t('net.dbSite'))}{sortTh('ip_address', 'IP')}{sortTh('mac_address', 'MAC')}
                {sortTh('host_name', 'Hostname')}{sortTh('source', t('net.dbSource'))}{sortTh('status', 'Status')}{sortTh('last_seen', t('net.dbLastSeen'))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((d, i) => (
                <tr key={`${d.site}-${d.mac_address}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={dbTd}>{d.site}</td>
                  <td style={{ ...dbTd, fontFamily: 'Consolas, monospace' }}>{d.ip_address ?? '—'}</td>
                  <td style={{ ...dbTd, fontFamily: 'Consolas, monospace', color: 'var(--text-dim)' }}>{d.mac_address}</td>
                  <td style={dbTd}>{d.host_name ?? '—'}</td>
                  <td style={dbTd}>{d.source ?? '—'}</td>
                  <td style={dbTd}>{d.status ?? '—'}</td>
                  <td style={{ ...dbTd, color: 'var(--text-dim)' }}>{fmtTime(d.last_seen)}</td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr><td style={{ ...dbTd, color: 'var(--text-dim)' }} colSpan={7}>—</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-dim)' }}>
          <span>{t('net.dbPerPage')}</span>
          <select value={String(pageSize)} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
            style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px' }}>
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            <option value={0}>{t('net.dbAll')}</option>
          </select>
          <span style={{ flex: 1 }} />
          {!allPage && (
            <>
              <button className="refresh-btn" onClick={() => setPage(0)} disabled={curPage === 0} title="« první">«</button>
              <button className="refresh-btn" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={curPage === 0} title="‹ předchozí">‹</button>
              <span>{t('net.dbPage').replace('{page}', String(curPage + 1)).replace('{pages}', String(pageCount))}</span>
              <button className="refresh-btn" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={curPage >= pageCount - 1} title="› další">›</button>
              <button className="refresh-btn" onClick={() => setPage(pageCount - 1)} disabled={curPage >= pageCount - 1} title="» poslední">»</button>
            </>
          )}
        </div>
      </div>

      <div style={{ marginTop: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>{t('net.histTitle')}</h3>
          <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{t('net.histCount').replace('{n}', String(histRows.length))}</span>
          <span style={{ flex: 1 }} />
          <input type="search" value={histQuery}
            onChange={(e) => setHistQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') loadHist(); }}
            placeholder={t('net.histSearch')} title={t('net.histSearchHint')}
            style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px', minWidth: 240 }} />
          <button className="refresh-btn" onClick={() => loadHist()} title={t('net.histSearchHint')}>🔎 {t('net.histSearchBtn')}</button>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0 0 8px' }}>{t('net.histHelp')}</p>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', maxHeight: 440 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
              <th style={dbTh}>IP</th><th style={dbTh}>MAC</th><th style={dbTh}>Hostname</th>
              <th style={dbTh}>{t('net.dbSite')}</th><th style={dbTh}>{t('net.dbSource')}</th>
              <th style={dbTh}>{t('net.histFrom')}</th><th style={dbTh}>{t('net.histTo')}</th><th style={dbTh}>{t('net.histSpan')}</th>
            </tr></thead>
            <tbody>
              {histRows.map((h, i) => (
                <tr key={`${h.mac_address}-${h.ip_address}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...dbTd, fontFamily: 'Consolas, monospace' }}>{h.ip_address}</td>
                  <td style={{ ...dbTd, fontFamily: 'Consolas, monospace', color: 'var(--text-dim)' }}>{h.mac_address}</td>
                  <td style={dbTd}>{h.host_name ?? '—'}</td>
                  <td style={dbTd}>{h.site ?? '—'}</td>
                  <td style={dbTd}>{h.source ?? '—'}</td>
                  <td style={{ ...dbTd, color: 'var(--text-dim)' }}>{fmtTime(h.first_seen)}</td>
                  <td style={{ ...dbTd, color: 'var(--text-dim)' }}>{fmtTime(h.last_seen)}</td>
                  <td style={dbTd}>{fmtSpan(h.minutes_span)}</td>
                </tr>
              ))}
              {histRows.length === 0 && <tr><td style={{ ...dbTd, color: 'var(--text-dim)' }} colSpan={8}>—</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
