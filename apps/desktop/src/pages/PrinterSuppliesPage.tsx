import React, { useEffect, useState } from 'react';
import type { PrinterDevice, PrinterSupply, DeviceItem } from '../api.js';
import { api, timeAgo, API_BASE } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { useI18n } from '../i18n.js';

// Stav tiskáren — graphical supply (ink / toner / maintenance) levels read by the
// printer-supplies collector (SNMP Printer-MIB + HTTP fallback). One card per
// printer, mirroring the look of the printers' own web UIs: a colour bar per
// colorant filled to its remaining %, plus maintenance box / drum / belt. Click a
// card to open the printer's own web interface.

// Bar colour per supply key (matches the approved mockup). Black toner uses a
// dark zinc so it stays visible on the dark track.
const SUPPLY_COLOR: Record<string, string> = {
  K: '#3f3f46', C: '#00AEEF', M: '#ED008C', Y: '#F5C400',
  MAINT: '#7d7d36', WASTE: '#7d7d36', DRUM: '#a9772e', BELT: '#5a86a8', FUSER: '#9a3412', OTHER: '#94a3b8',
};

function supplyLabel(s: PrinterSupply, t: ReturnType<typeof useI18n>['t']): string {
  switch (s.key) {
    case 'K': return 'BK';
    case 'C': return 'C';
    case 'M': return 'M';
    case 'Y': return 'Y';
    case 'MAINT': case 'WASTE': return t('supplies.maint');
    case 'DRUM': return t('supplies.drum');
    case 'BELT': return t('supplies.belt');
    case 'FUSER': return t('supplies.fuser');
    default: return s.colorant && s.colorant !== 'none' ? s.colorant : s.key;
  }
}

type Status = 'crit' | 'low' | 'ok';

function statusOf(p: PrinterDevice, lowPct: number): Status {
  let crit = false; let low = false;
  for (const s of p.supplies) {
    if (s.level_pct == null) continue;
    if (s.level_pct <= 0) crit = true;
    else if (s.level_pct < lowPct) low = true;
  }
  return crit ? 'crit' : low ? 'low' : 'ok';
}

export function PrinterSuppliesPage({ settings = {}, initialOnlyProblem, onOnlyProblemConsumed }: {
  settings?: Record<string, string>;
  initialOnlyProblem?: boolean;
  onOnlyProblemConsumed?: () => void;
} = {}) {
  const { t } = useI18n();
  const webProxy = ['1', 'true', 'yes', 'on'].includes((settings['devices.web_proxy'] ?? '1').toLowerCase());
  const deviceWebUrl = (ip: string) => webProxy ? `${API_BASE}/devices/web/${ip}` : `http://${ip}`;

  const [printers, setPrinters] = useState<PrinterDevice[]>([]);
  const [shared, setShared] = useState<DeviceItem[]>([]);
  const [lowPct, setLowPct] = useState(15);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [onlyProblem, setOnlyProblem] = useState(false);
  const [search, setSearch] = useState('');
  const [site, setSite] = useState('');
  const [running, setRunning] = useState(false);

  const refresh = () => {
    api.printerSupplies().then((r) => { setPrinters(r.printers); setLowPct(r.lowPct); }).catch((e) => setError(String(e)));
    api.devices().then((r) => setShared(r.items.filter((d) => d.source === 'share'))).catch(() => {});
  };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  // One-shot: arriving via the dashboard "Náplně" tile pre-checks "only problematic".
  useEffect(() => {
    if (initialOnlyProblem) { setOnlyProblem(true); onOnlyProblemConsumed?.(); }
  }, [initialOnlyProblem, onOnlyProblemConsumed]);

  const runAll = async () => {
    if (running) return;
    setRunning(true); setError(null); setNotice(null);
    try {
      await api.printerSuppliesRun();
      refresh();
    } catch (e) {
      const msg = String(e);
      if (/\b409\b/.test(msg) || /already running/i.test(msg)) setNotice(t('supplies.alreadyRunning'));
      else setError(msg);
    } finally {
      setRunning(false);
    }
  };

  // Distinct sites for the location dropdown (printers carry the host/device site).
  const sites = Array.from(new Set(printers.map((p) => p.site).filter((s): s is string => !!s))).sort();

  // Free-text match across every visible identifier of a printer card.
  const q = search.trim().toLowerCase();
  const matchesSearch = (p: PrinterDevice): boolean => {
    if (!q) return true;
    const hay = [
      p.operator_name, p.model, p.host_name, p.ip_address, p.mac_address, p.site,
      ...p.supplies.map((s) => s.part_code),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };

  const withStatus = printers
    .filter((p) => (site ? p.site === site : true) && matchesSearch(p))
    .map((p) => ({ p, st: statusOf(p, lowPct) }));
  const shown = onlyProblem ? withStatus.filter((x) => x.st !== 'ok') : withStatus;
  const nCrit = withStatus.filter((x) => x.st === 'crit').length;
  const nLow = withStatus.filter((x) => x.st === 'low').length;
  const nOk = withStatus.filter((x) => x.st === 'ok').length;

  const badge = (st: Status) => {
    const map: Record<Status, { c: string; bg: string; label: string }> = {
      crit: { c: 'var(--critical)', bg: 'rgba(239,68,68,.15)', label: t('supplies.empty') },
      low: { c: 'var(--warning)', bg: 'rgba(234,179,8,.18)', label: t('supplies.low') },
      ok: { c: 'var(--ok)', bg: 'rgba(34,197,94,.15)', label: 'OK' },
    };
    const b = map[st];
    return <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, color: b.c, background: b.bg, whiteSpace: 'nowrap' }}>{b.label}</span>;
  };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('supplies.title')}>
          <p>{t('supplies.help')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>
          🖨 {t('supplies.title')}{' '}
          <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
            ({withStatus.length !== printers.length ? `${withStatus.length} / ` : ''}{printers.length} · <span style={{ color: nCrit ? 'var(--critical)' : undefined }}>{nCrit} {t('supplies.empty')}</span> · <span style={{ color: nLow ? 'var(--warning)' : undefined }}>{nLow} {t('supplies.low')}</span> · {nOk} OK)
          </span>
        </h2>
        <div className="panel-actions filters">
          <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />
          {sites.length > 1 && (
            <select value={site} onChange={(e) => setSite(e.target.value)} style={{ fontSize: 12 }}>
              <option value="">{t('devices.allSites')}</option>
              {sites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={onlyProblem} onChange={(e) => setOnlyProblem(e.target.checked)} />
            {t('supplies.onlyProblem')}
          </label>
          <button className="refresh-btn" onClick={runAll} disabled={running} style={{ fontWeight: 600 }}>
            {running ? t('supplies.running') : `🔄 ${t('supplies.refreshNow')}`}
          </button>
          <button className="refresh-btn" onClick={refresh}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {notice && <div style={{ color: 'var(--accent)', padding: 8, fontSize: 12 }}>ℹ {notice}</div>}
        {shown.length === 0 ? (
          <div className="empty">{printers.length === 0 ? t('supplies.empty.none') : t('supplies.noMatch')}</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14, padding: 12 }}>
            {shown.map(({ p, st }) => {
              const name = p.operator_name || p.model || p.host_name || p.mac_address;
              const ip = p.ip_address;
              return (
                <div
                  key={p.mac_address}
                  onClick={() => ip && window.open(deviceWebUrl(ip), '_blank')}
                  title={ip ? `${t('supplies.openWeb')} — ${ip}` : undefined}
                  style={{
                    background: 'var(--surface)', border: `1px solid ${st === 'crit' ? 'var(--critical)' : 'var(--border)'}`,
                    borderRadius: 10, padding: '12px 14px', cursor: ip ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                      <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>
                        {ip ?? '—'}{p.host_name && p.host_name !== name ? ` · ${p.host_name}` : ''}{p.site ? ` · ${p.site}` : ''}
                      </div>
                      {ip && <div style={{ color: 'var(--accent)', fontSize: 11, marginTop: 2 }}>{t('supplies.openProxy')} ↗</div>}
                    </div>
                    {badge(st)}
                  </div>
                  {p.supplies.map((s) => {
                    const color = SUPPLY_COLOR[s.key] ?? SUPPLY_COLOR.OTHER!;
                    const pct = s.level_pct;
                    const isLow = pct != null && pct < lowPct;
                    return (
                      <div key={s.key} style={{ display: 'grid', gridTemplateColumns: '78px 1fr 52px', alignItems: 'center', gap: 10, margin: '7px 0' }}>
                        <div style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ width: 11, height: 11, borderRadius: 3, background: color, flex: '0 0 auto', border: '1px solid rgba(128,128,128,.35)' }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.description ?? undefined}>{supplyLabel(s, t)}</span>
                        </div>
                        <div style={{ height: 14, background: 'var(--bg)', borderRadius: 7, overflow: 'hidden', border: '1px solid var(--border)' }}>
                          {pct != null && <div style={{ width: `${Math.max(pct, 0)}%`, height: '100%', background: color, borderRadius: '7px 0 0 7px' }} />}
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, textAlign: 'right', color: isLow ? 'var(--critical)' : 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                          {pct == null ? t('supplies.unknown') : `${pct}%`}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.supplies.map((s) => s.part_code).filter(Boolean).join(' · ') || `${t('supplies.collected')} ${timeAgo(p.collected_at)}`}
                    </span>
                    <span style={{ flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 6, padding: '1px 6px', fontSize: 10 }}>
                      {Array.from(new Set(p.supplies.map((s) => s.source))).join('+')}
                    </span>
                  </div>
                  {ip && (
                    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)', fontSize: 11, textAlign: 'center' }}>
                      <a
                        href={`http://${ip}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title={t('supplies.openDirectTip')}
                        style={{ color: 'var(--accent)', textDecoration: 'none' }}
                      >{t('supplies.openDirect')} — {ip} ↗</a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {shared.length > 0 && (
          <div style={{ padding: '4px 12px 16px' }}>
            <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>🖨 {t('supplies.sharedTitle')} <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 12 }}>({shared.length})</span></h3>
            <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 10px' }}>{t('supplies.sharedHelp')}</p>
            <table>
              <thead><tr>
                <th>{t('supplies.sharedName')}</th>
                <th style={{ width: 240 }}>{t('supplies.sharedHost')}</th>
                <th style={{ width: 100 }}>{t('devices.status')}</th>
              </tr></thead>
              <tbody>
                {shared.map((d) => {
                  const r = d.computer_reachable ?? d.reachable;
                  return (
                    <tr key={d.mac_address}>
                      <td style={{ fontWeight: 600 }}>{d.host_name ?? d.operator_name ?? '—'}</td>
                      <td>
                        <span style={{ color: 'var(--accent)' }}>{d.comment ?? d.computer_name ?? '—'}</span>
                        {d.ip_address && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}> · {d.ip_address}</span>}
                      </td>
                      <td>{r == null ? <span style={{ color: 'var(--text-dim)' }}>—</span> : r ? <span style={{ color: 'var(--ok)', fontWeight: 700 }}>● online</span> : <span style={{ color: 'var(--critical)', fontWeight: 700 }}>○ offline</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
