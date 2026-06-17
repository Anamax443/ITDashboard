import React, { useEffect, useState } from 'react';
import type { DeviceItem } from '../api.js';
import { api, timeAgo, deviceDegraded, deviceProblemThresholds, API_BASE } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { useI18n } from '../i18n.js';

// MikroTik DHCP device inventory. Each lease is paired with an AD computer (by
// host_name / IP); matched devices reuse the computer's reachability, unmatched
// ones (printers, phones, IoT) are pinged here and categorized by the operator.

// Built-in category keys (their labels come from i18n). The operator can override
// the whole list in Settings (devices.categories, "key=Label" per line).
const BUILTIN_CATS = ['printer', 'phone', 'pc', 'server', 'network', 'iot', 'other'];

// Per-category colour so an assigned category pops in the grid (Electron =
// Chromium, so <option> colours render in the dropdown too). Custom keys → grey.
const CAT_COLOR: Record<string, string> = {
  printer: '#3b9eff', // blue — the focus category
  server: '#c084fc',  // violet
  pc: '#46c882',      // green
  phone: '#2dd4bf',   // teal
  network: '#f59e0b', // amber
  iot: '#f472b6',     // pink
  other: '#9ca3af',   // grey
};

interface Cat { key: string; label: string }

// Parse the operator's "key=Label" lines; a bare line becomes both key (slugged)
// and label. Empty config → built-in list (labels from i18n, filled in below).
function parseCats(raw: string | undefined): Cat[] {
  const out: Cat[] = [];
  for (const line of (raw ?? '').split(/[,\r\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const eq = line.indexOf('=');
    if (eq > 0) out.push({ key: line.slice(0, eq).trim(), label: line.slice(eq + 1).trim() });
    else out.push({ key: line.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label: line });
  }
  return out.filter((c) => c.key);
}

function effectiveReachable(d: DeviceItem): boolean | null {
  return d.computer_id != null ? d.computer_reachable : d.reachable;
}

export function DevicesPage({ onJumpToComputer, initialOnlyPrinters, onOnlyPrintersConsumed, initialOnlyLossy, onOnlyLossyConsumed, settings = {} }: {
  onJumpToComputer?: (name: string) => void;
  initialOnlyPrinters?: boolean;
  onOnlyPrintersConsumed?: () => void;
  initialOnlyLossy?: boolean;
  onOnlyLossyConsumed?: () => void;
  settings?: Record<string, string>;
} = {}) {
  const { t } = useI18n();
  // Categories: operator-configured list, or the built-in keys (labels from i18n).
  const custom = parseCats(settings['devices.categories']);
  const cats: Cat[] = custom.length
    ? custom
    : BUILTIN_CATS.map((k) => ({ key: k, label: t(`cat.${k}` as Parameters<typeof t>[0]) }));
  const catKeys = ['', ...cats.map((c) => c.key)];
  const catLabel = (k: string) => cats.find((c) => c.key === k)?.label
    ?? (BUILTIN_CATS.includes(k) ? t(`cat.${k}` as Parameters<typeof t>[0]) : k);
  // Web link: route through the cert-bypassing server proxy when enabled.
  const problemTh = deviceProblemThresholds(settings);
  const webProxy = ['1', 'true', 'yes', 'on'].includes((settings['devices.web_proxy'] ?? '').toLowerCase());
  const deviceWebUrl = (ip: string) => webProxy ? `${API_BASE}/devices/web/${ip}` : `http://${ip}`;
  const [items, setItems] = useState<DeviceItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [site, setSite] = useState('');
  const [onlyUnmanaged, setOnlyUnmanaged] = useState(false);
  const [onlyPrinters, setOnlyPrinters] = useState(false);
  const [catFilter, setCatFilter] = useState('');
  const [onlyLossy, setOnlyLossy] = useState(false);
  const [editName, setEditName] = useState<{ mac: string; value: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [consoleOut, setConsoleOut] = useState<{ name: string; text: string | null; error?: boolean } | null>(null);

  const refresh = () => { api.devices().then((r) => setItems(r.items)).catch((e) => setError(String(e))); };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  // One-shot: arriving via the dashboard "Printers" tile pre-checks "only printers".
  useEffect(() => {
    if (initialOnlyPrinters) { setOnlyPrinters(true); onOnlyPrintersConsumed?.(); }
  }, [initialOnlyPrinters, onOnlyPrintersConsumed]);

  // One-shot: arriving via the dashboard "loss/latency" tile pre-checks "issues only".
  useEffect(() => {
    if (initialOnlyLossy) { setOnlyLossy(true); onOnlyLossyConsumed?.(); }
  }, [initialOnlyLossy, onOnlyLossyConsumed]);

  const runAll = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      await api.devicesRun();
      refresh();
    } catch (e) {
      // A 409 just means a collect is already in progress — that's normal, not an
      // error. Show a soft info notice; surface everything else as a real error.
      const msg = String(e);
      if (/\b409\b/.test(msg) || /already running/i.test(msg)) {
        setNotice(t('devices.alreadyRunning'));
      } else {
        setError(msg);
      }
    } finally {
      setRunning(false);
    }
  };

  const saveName = async (d: DeviceItem) => {
    const v = (editName?.value ?? '').trim();
    setEditName(null);
    if (v === (d.operator_name ?? '')) return; // unchanged
    setItems((arr) => arr.map((x) => x.mac_address === d.mac_address ? { ...x, operator_name: v || null } : x));
    try { await api.setDeviceName(d.mac_address, v); }
    catch (e) { setError(String(e)); refresh(); }
  };

  const setCategory = async (d: DeviceItem, category: string) => {
    // Optimistic update by MAC (category persists by MAC across sites).
    setItems((arr) => arr.map((x) => x.mac_address === d.mac_address ? { ...x, category: category || null } : x));
    try { await api.setDeviceCategory(d.mac_address, category); }
    catch (e) { setError(String(e)); refresh(); }
  };

  const pingOne = async (d: DeviceItem) => {
    if (!d.ip_address || rowBusy[d.mac_address]) return;
    setRowBusy((m) => ({ ...m, [d.mac_address]: true }));
    setConsoleOut({ name: d.host_name || d.ip_address, text: null });
    try {
      const r = await api.probeDevice(d.site, d.mac_address, d.ip_address);
      setConsoleOut({ name: d.host_name || d.ip_address!, text: r.console });
      refresh();
    } catch (e) {
      setConsoleOut({ name: d.host_name || d.ip_address!, text: String(e), error: true });
    } finally {
      setRowBusy((m) => ({ ...m, [d.mac_address]: false }));
    }
  };

  const sites = Array.from(new Set(items.map((d) => d.site))).sort();
  // Confirmed printer = operator-assigned category 'printer' (counts/tile use this).
  const isConfirmedPrinter = (d: DeviceItem) => d.category === 'printer';
  // Printer-ish = confirmed OR (uncategorized but heuristic suggests printer) —
  // used only by the "only printers" filter so the operator can find candidates.
  const isPrinterish = (d: DeviceItem) => d.category === 'printer' || (!d.category && d.suggested === 'printer');

  const filtered = items.filter((d) => {
    if (site && d.site !== site) return false;
    if (onlyUnmanaged && d.computer_id != null) return false;
    if (onlyPrinters && !isPrinterish(d)) return false;
    if (catFilter) {
      if (catFilter === '__none') { if (d.category) return false; }
      else if ((d.category ?? '') !== catFilter) return false;
    }
    if (onlyLossy && !deviceDegraded(d, problemTh)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (d.ip_address ?? '').toLowerCase().includes(q)
        || (d.host_name ?? '').toLowerCase().includes(q)
        || (d.operator_name ?? '').toLowerCase().includes(q)
        || d.mac_address.toLowerCase().includes(q)
        || (d.comment ?? '').toLowerCase().includes(q);
    }
    return true;
  });

  const total = items.length;
  const unmanaged = items.filter((d) => d.computer_id == null).length;
  const printers = items.filter(isConfirmedPrinter).length;

  const statusCell = (d: DeviceItem) => {
    const r = effectiveReachable(d);
    if (r == null) return <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>—</span>;
    return <span style={{ color: r ? 'var(--ok)' : 'var(--critical)', fontSize: 11, fontWeight: 700 }}>{r ? '● online' : '○ offline'}</span>;
  };

  // Compact latency/loss cell, e.g. "<5/0" = <5 ms / 0% loss, "120/25" = 120 ms /
  // 25% loss. Only meaningful while online.
  const qualityCell = (d: DeviceItem) => {
    if (effectiveReachable(d) !== true) return <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>—</span>;
    const lat = d.latency_ms;
    const loss = d.packet_loss ?? 0;
    const latStr = lat == null ? '?' : lat < 5 ? '<5' : String(lat);
    const latColor = lat != null && lat >= 50 ? 'var(--warning, #d97706)' : 'var(--text-dim)';
    const lossColor = loss >= 50 ? 'var(--critical)' : loss > 0 ? 'var(--warning, #d97706)' : 'var(--text-dim)';
    return (
      <span style={{ fontSize: 11, fontFamily: 'Consolas, monospace' }} title={`${t('devices.latencyTip')} · ${t('devices.lossTip')}`}>
        <span style={{ color: latColor }}>{latStr}</span>
        <span style={{ color: 'var(--text-dim)' }}>/</span>
        <span style={{ color: lossColor, fontWeight: loss > 0 ? 700 : 400 }}>{loss}</span>
      </span>
    );
  };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('devices.help')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>
          🖧 {t('devices.title')}{' '}
          <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
            ({total} {t('devices.count')} · {unmanaged} {t('devices.unmanaged')} · {printers} {t('devices.printers')})
          </span>
        </h2>
        <div className="panel-actions filters">
          <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
          {sites.length > 1 && (
            <select value={site} onChange={(e) => setSite(e.target.value)} style={{ fontSize: 12 }}>
              <option value="">{t('devices.allSites')}</option>
              {sites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={{ fontSize: 12 }} title={t('devices.category')}>
            <option value="">{t('devices.allCats')}</option>
            <option value="__none">{t('devices.noCat')}</option>
            {cats.map((c) => (
              <option key={c.key} value={c.key} style={{ color: CAT_COLOR[c.key] ?? 'var(--text)' }}>{c.label}</option>
            ))}
          </select>
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={onlyUnmanaged} onChange={(e) => setOnlyUnmanaged(e.target.checked)} />
            {t('devices.onlyUnmanaged')}
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={onlyPrinters} onChange={(e) => setOnlyPrinters(e.target.checked)} />
            {t('devices.onlyPrinters')}
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }} title={t('devices.lossTip')}>
            <input type="checkbox" checked={onlyLossy} onChange={(e) => setOnlyLossy(e.target.checked)} />
            {t('devices.onlyLossy')}
          </label>
          <button className="refresh-btn" onClick={runAll} disabled={running} style={{ fontWeight: 600 }}>
            {running ? t('devices.running') : `🔄 ${t('devices.refreshNow')}`}
          </button>
          <button className="refresh-btn" onClick={refresh}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {notice && <div style={{ color: 'var(--accent)', padding: 8, fontSize: 12 }}>ℹ {notice}</div>}
        {filtered.length === 0 ? (
          <div className="empty">{items.length === 0 ? t('devices.empty') : t('devices.noMatch')}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 80 }}>{t('devices.site')}</th>
                <th style={{ width: 120 }}>IP</th>
                <th style={{ width: 190 }}>{t('devices.hostname')}</th>
                <th style={{ width: 150 }}>MAC</th>
                <th style={{ width: 95 }}>{t('devices.type')}</th>
                <th style={{ width: 170 }}>{t('devices.category')}</th>
                <th style={{ width: 90 }}>{t('devices.status')}</th>
                <th style={{ width: 80 }} title={t('devices.qualityTip')}>{t('devices.quality')}</th>
                <th style={{ width: 130 }}>AD</th>
                <th style={{ width: 100 }}>{t('devices.lastSeen')}</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={`${d.site}-${d.mac_address}`}>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{d.site}</td>
                  <td style={{ fontFamily: 'Consolas, monospace', fontSize: 11 }}>
                    {d.ip_address
                      ? (isPrinterish(d)
                          ? <a href={deviceWebUrl(d.ip_address)} target="_blank" rel="noreferrer" title={t('devices.openWeb')} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{d.ip_address}</a>
                          : d.ip_address)
                      : '—'}
                  </td>
                  <td style={{ fontWeight: 600, fontSize: 12 }}>
                    {editName?.mac === d.mac_address ? (
                      <input
                        autoFocus
                        value={editName.value}
                        onChange={(e) => setEditName({ mac: d.mac_address, value: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveName(d); else if (e.key === 'Escape') setEditName(null); }}
                        onBlur={() => saveName(d)}
                        placeholder={d.host_name ?? ''}
                        style={{ width: '100%', fontSize: 12, padding: '2px 4px' }}
                      />
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {(d.operator_name ?? d.host_name)
                          ? <span style={{ color: d.operator_name ? 'var(--accent)' : undefined }} title={d.operator_name ? `${t('devices.editName')} · ${d.host_name ?? ''}`.trim() : undefined}>{d.operator_name ?? d.host_name}</span>
                          : <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>—</span>}
                        <span onClick={() => setEditName({ mac: d.mac_address, value: d.operator_name ?? '' })} title={t('devices.editName')} style={{ cursor: 'pointer', opacity: 0.4, fontSize: 10, fontWeight: 400 }}>✎</span>
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 10, fontFamily: 'Consolas, monospace' }}>{d.mac_address}</td>
                  <td style={{ fontSize: 11 }}>
                    {d.dynamic === false
                      ? <span style={{ color: 'var(--warning, #d97706)', fontWeight: 600 }}>{t('devices.static')}</span>
                      : d.dynamic === true
                        ? <span style={{ color: 'var(--text-dim)' }}>{t('devices.dynamic')}</span>
                        : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                    {d.source && d.source !== 'dhcp' && (
                      <span style={{ color: 'var(--text-dim)', fontSize: 9, marginLeft: 4 }} title={t('devices.sourceTip')}>· {d.source}</span>
                    )}
                  </td>
                  <td>
                    {/* Pre-select: an uncategorized device shows its AD-derived
                        (pc/server) or heuristic (printer/phone) suggestion already
                        selected, in readable text. It's only saved once the operator
                        confirms (✓ chip) or picks another option; a confirmed
                        category shows no chip. */}
                    {(() => {
                      const unconfirmed = !d.category && !!d.suggested;
                      const shown = d.category ?? d.suggested ?? '';
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <select
                            value={shown}
                            onChange={(e) => setCategory(d, e.target.value)}
                            style={{
                              fontSize: 12, flex: 1, minWidth: 0,
                              fontWeight: d.category ? 700 : 400,
                              fontStyle: unconfirmed ? 'italic' : 'normal',
                              color: d.category ? (CAT_COLOR[d.category] ?? 'var(--text)') : 'var(--text-dim)',
                            }}
                          >
                            {catKeys.map((k) => (
                              <option key={k || 'none'} value={k} style={{ color: k && CAT_COLOR[k] ? CAT_COLOR[k] : 'var(--text)', fontWeight: k ? 600 : 400 }}>
                                {k === '' ? '—' : catLabel(k)}
                              </option>
                            ))}
                          </select>
                          {unconfirmed && (
                            <button
                              onClick={() => setCategory(d, d.suggested)}
                              title={`${t('devices.confirmSuggest')}: ${catLabel(d.suggested)}`}
                              style={{ flex: '0 0 auto', fontSize: 10, lineHeight: 1, padding: '3px 7px', cursor: 'pointer', color: 'var(--accent)', background: 'transparent', border: '1px solid var(--accent)', borderRadius: 4 }}
                            >
                              ✓ {t('devices.confirmSuggest')}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td>{statusCell(d)}</td>
                  <td>{qualityCell(d)}</td>
                  <td style={{ fontSize: 11 }}>
                    {d.computer_id != null ? (
                      onJumpToComputer ? (
                        <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(d.computer_name!); }} style={{ color: 'var(--accent)', textDecoration: 'none' }} title={t('devices.inAd')}>✓ {d.computer_name}</a>
                      ) : <span style={{ color: 'var(--accent)' }}>✓ {d.computer_name}</span>
                    ) : <span style={{ color: 'var(--text-dim)' }}>{t('devices.notInAd')}</span>}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }} title={d.reach_checked_at ? `checked ${timeAgo(d.reach_checked_at)}` : ''}>{timeAgo(d.last_seen)}</td>
                  <td style={{ fontSize: 11 }}>
                    <button className="refresh-btn" onClick={() => pingOne(d)} disabled={!d.ip_address || rowBusy[d.mac_address]} style={{ padding: '2px 8px', fontSize: 11 }}>
                      {rowBusy[d.mac_address] ? t('ports.pinging') : `📡 ${t('ports.ping')}`}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {consoleOut && (
        <div onClick={() => setConsoleOut(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#0c0c0c', border: '1px solid #333', borderRadius: 6, width: 760, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #333', background: '#1a1a1a' }}>
              <span style={{ color: '#ccc', fontFamily: 'Consolas, monospace', fontSize: 12 }}>📡 ping — {consoleOut.name}</span>
              <button onClick={() => setConsoleOut(null)} style={{ background: 'transparent', border: 'none', color: '#ccc', fontSize: 16, cursor: 'pointer' }}>×</button>
            </div>
            <pre style={{ margin: 0, padding: 14, overflow: 'auto', color: consoleOut.error ? '#ff6b6b' : '#d4d4d4', fontFamily: 'Consolas, monospace', fontSize: 12, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {consoleOut.text ?? `${t('ports.pinging')} ${consoleOut.name} ▌`}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
