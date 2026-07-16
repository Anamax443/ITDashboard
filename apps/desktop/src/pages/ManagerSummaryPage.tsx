import React, { useEffect, useRef, useState } from 'react';
import { api, parseDiskThresholds, summarizeDisks, isStaleComputer } from '../api.js';
import type { DeviceItem, ComputerItem, PrinterDevice, DiskItem } from '../api.js';
import { useI18n } from '../i18n.js';

// Managerial summary — a "take it to the meeting" report. Rendered as a self-contained
// WHITE document (AXIMA managerial house style: Segoe UI, #1d4ed8 accent) regardless of
// the app theme, so Print/PDF and the saved standalone HTML come out clean and identical.
// Print and Save both serialize the same `.mr-wrap` node, so what you see is what prints.

const CAT_LABEL: Record<string, string> = {
  pc: 'PC / notebook', server: 'Server', printer: 'Tiskárna', phone: 'Telefon',
  network: 'Síťový prvek', iot: 'IoT / ostatní', other: 'Ostatní',
};
const catLabel = (k: string | null) => (k ? (CAT_LABEL[k] ?? k) : '—');

// House style. Scoped under .mr-wrap so injecting it globally can't bleed into the app.
const REPORT_CSS = `
.mr-wrap,.mr-wrap *{box-sizing:border-box}
.mr-wrap{font-family:'Segoe UI',Arial,sans-serif;color:#111;background:#fff;max-width:900px;margin:0 auto;padding:26px;font-size:12px}
.mr-wrap .mr-top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1d4ed8;padding-bottom:12px}
.mr-wrap h1{font-size:20px;margin:0}
.mr-wrap .mr-meta{color:#555;font-size:11px;margin:4px 0 0}
.mr-wrap h2{font-size:14px;margin:24px 0 8px;padding-bottom:5px;border-bottom:1px solid #cbd2dd}
.mr-wrap h3{font-size:12px;margin:0 0 6px}
.mr-wrap .mr-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}
.mr-wrap .mr-kpi{border:1px solid #cbd2dd;border-radius:8px;padding:12px}
.mr-wrap .mr-kl{font-size:9px;letter-spacing:.5px;text-transform:uppercase;color:#666}
.mr-wrap .mr-kv{font-size:26px;font-weight:300;line-height:1.1}
.mr-wrap .mr-kv.crit{color:#b91c1c}.mr-wrap .mr-kv.warn{color:#b45309}.mr-wrap .mr-kv.ok{color:#15803d}
.mr-wrap .mr-strip{margin:8px 0 0;color:#444}
.mr-wrap .mr-pill{display:inline-block;background:#f1f3f7;border:1px solid #cbd2dd;border-radius:20px;padding:3px 10px;margin:2px 4px 2px 0;font-size:11px}
.mr-wrap .mr-br{display:flex;align-items:center;gap:8px;margin:3px 0}
.mr-wrap .mr-bl{width:170px;flex:none;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr-wrap .mr-bt{flex:1;background:#eef1f6;border-radius:4px;height:15px;overflow:hidden}
.mr-wrap .mr-bf{height:100%;background:#1d4ed8}
.mr-wrap .mr-bv{width:130px;flex:none;text-align:right;font-size:11px;font-variant-numeric:tabular-nums}
.mr-wrap .mr-sub{color:#888}
.mr-wrap table.mr-t{border-collapse:collapse;width:100%;font-size:11px}
.mr-wrap .mr-t th,.mr-wrap .mr-t td{border:1px solid #cbd2dd;padding:4px 8px;text-align:left}
.mr-wrap .mr-t th{background:#f1f3f7;font-size:9px;text-transform:uppercase;color:#555}
.mr-wrap .mr-t .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.mr-wrap .num.crit{color:#b91c1c}.mr-wrap .num.ok{color:#15803d}
.mr-wrap .mr-note{color:#777;font-size:10px;margin-top:14px;border-top:1px solid #cbd2dd;padding-top:6px}
@media print{@page{margin:12mm}.mr-wrap h2{break-after:avoid}.mr-wrap .mr-grid,.mr-wrap .mr-kpis{break-inside:avoid}}
`;

function Kpi({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'crit' | 'warn' | 'ok' }) {
  return (
    <div className="mr-kpi">
      <div className="mr-kl">{label}</div>
      <div className={'mr-kv' + (tone ? ' ' + tone : '')}>{value}</div>
    </div>
  );
}

function BarRow({ label, value, max, sub }: { label: string; value: number; max: number; sub?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="mr-br">
      <div className="mr-bl" title={label}>{label}</div>
      <div className="mr-bt"><div className="mr-bf" style={{ width: pct + '%' }} /></div>
      <div className="mr-bv">{value}{sub != null && <span className="mr-sub"> {sub}</span>}</div>
    </div>
  );
}

export function ManagerSummaryPage({ settings = {} }: { settings?: Record<string, string> }) {
  const { t } = useI18n();
  const reportRef = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [computers, setComputers] = useState<ComputerItem[]>([]);
  const [printers, setPrinters] = useState<PrinterDevice[]>([]);
  const [disks, setDisks] = useState<DiskItem[]>([]);
  const [lowPct, setLowPct] = useState(15);
  const [riskPcs, setRiskPcs] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    api.devices().then((r) => setDevices(r.items)).catch((e) => setErr(String(e)));
    api.computers().then((r) => setComputers(r.items)).catch(() => {});
    api.printerSupplies().then((r) => { setPrinters(r.printers); setLowPct(r.lowPct); }).catch(() => {});
    api.disks().then((r) => setDisks(r.items)).catch(() => {});
    api.pcHealth().then((r) => setRiskPcs(r.items.filter((i) => i.level === 'risk' && !i.snoozed).length)).catch(() => {});
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const reachOf = (d: DeviceItem) => (d.computer_id != null ? d.computer_reachable : d.reachable);

  // Equipment by category (network devices) — exclude phones (transient/random MAC).
  const equip = devices.filter((d) => d.category && d.category !== 'phone');
  const byCat = new Map<string, number>();
  for (const d of equip) byCat.set(d.category!, (byCat.get(d.category!) ?? 0) + 1);
  const catRows = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...catRows.map(([, v]) => v));

  // By branch (site): we have only these four real branches. Everything else
  // (UniFi / unresolved "?" / VLAN labels) is rolled into "Ostatní" so the table
  // still reconciles with the totals instead of hiding devices.
  const BRANCHES: { key: string; label: string }[] = [
    { key: 'brno', label: 'Brno' }, { key: 'zastavka', label: 'Zastávka' },
    { key: 'svitavy', label: 'Svitavy' }, { key: 'jihlava', label: 'Jihlava' },
  ];
  const branchKey = (s: string | null) => (s ?? '').trim().toLowerCase();
  const mkStat = (label: string, ds: DeviceItem[]) => ({
    site: label,
    total: ds.length,
    pc: ds.filter((d) => d.category === 'pc').length,
    printer: ds.filter((d) => d.category === 'printer').length,
    online: ds.filter((d) => reachOf(d) === true).length,
    offline: ds.filter((d) => reachOf(d) === false).length,
  });
  const siteStat = BRANCHES
    .map((b) => mkStat(b.label, devices.filter((d) => branchKey(d.site) === b.key)))
    .filter((s) => s.total > 0);
  const branchCount = siteStat.length;
  const otherDevs = devices.filter((d) => !BRANCHES.some((b) => b.key === branchKey(d.site)));
  if (otherDevs.length > 0) siteStat.push(mkStat('Ostatní', otherDevs));

  // Printers + supplies.
  const printerDevices = devices.filter((d) => d.category === 'printer');
  const printersOffline = printerDevices.filter((d) => reachOf(d) === false).length;
  const suppliesLow = printers.filter((p) => p.supplies.some((s) => s.level_pct != null && s.level_pct > 0 && s.level_pct < lowPct)).length;
  const suppliesEmpty = printers.filter((p) => p.supplies.some((s) => s.level_pct != null && s.level_pct <= 0)).length;

  // PC fleet health.
  const managed = computers.filter((c) => c.enabled && !c.excluded);
  const pcActive = managed.filter((c) => c.reachable === true).length;
  const pcOffline = managed.filter((c) => c.reachable === false).length;
  const disabled = computers.filter((c) => !c.enabled).length;
  const inactiveDays = Number(settings['inactive.threshold_days'] ?? 90) || 90;
  const stale = computers.filter((c) => isStaleComputer(c, inactiveDays)).length;
  const servers = managed.filter((c) => /server/i.test(c.os_version ?? '')).length;
  const pcs = managed.length - servers;
  // Disks: PCs with a critical / warning drive — same scope-aware logic as the Dashboard
  // (disks live on their own endpoint, keyed to computer_id, not on ComputerItem).
  const diskSum = summarizeDisks(disks, parseDiskThresholds(settings));
  const diskCrit = diskSum.criticalPcs;
  const diskWarn = diskSum.warningPcs;

  // PC, kde si Office sám zakázal doplněk (tiše rozbitá aplikace — typicky export do
  // Excelu vracející prázdný sešit). Počítá se JEN ze skutečně oskenovaných strojů:
  // 'no_users' znamená, že u PC nikdo neseděl a stav neznáme — do manažerského čísla
  // nesmí spadnout jako by bylo v pořádku. Data jdou z /computers, žádný další dotaz.
  const addinPcs = managed.filter((c) => c.office_addin_status === 'ok' && (c.office_addin_count ?? 0) > 0).length;

  // OS breakdown over the managed fleet (W11 / W10 / Server / other).
  const osCount = (re: RegExp) => managed.filter((c) => re.test(c.os_version ?? '')).length;
  const osW11 = osCount(/windows 11/i);
  const osW10 = osCount(/windows 10/i);
  const osOther = managed.length - osW11 - osW10 - servers;

  const totalEquip = equip.length;
  const now = new Date().toLocaleString('cs-CZ');

  // Print and Save reuse one standalone document, so output matches the on-screen sheet
  // exactly and is theme-independent. UTF-8 meta avoids the mojibake of latin1-saved HTML.
  const buildHtml = () => {
    const body = reportRef.current ? reportRef.current.outerHTML : '';
    return '<!DOCTYPE html>\n<html lang="cs"><head><meta charset="UTF-8">'
      + '<title>' + t('summary.title') + ' — ITDashboard</title>'
      + '<style>' + REPORT_CSS + '</style></head><body>' + body + '</body></html>';
  };
  const printDoc = () => {
    const w = window.open('', '_blank', 'width=1000,height=800');
    if (!w) { window.print(); return; }
    w.document.write(buildHtml());
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 350);
  };
  const saveHtml = () => {
    const blob = new Blob([buildHtml()], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'itdashboard-souhrn-' + new Date().toISOString().slice(0, 10) + '.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const btn: React.CSSProperties = { font: 'inherit', fontSize: 12, padding: '6px 12px', border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#fff', borderRadius: 6, cursor: 'pointer' };
  const btnSec: React.CSSProperties = { ...btn, background: '#fff', color: '#1d4ed8' };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', overflow: 'auto', background: '#e9edf3' }}>
      <style>{REPORT_CSS}</style>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 16px' }}>
        <button style={btnSec} onClick={load}>↻</button>
        <button style={btn} onClick={printDoc}>🖨 {t('summary.print')}</button>
        <button style={btnSec} onClick={saveHtml}>⬇ {t('summary.saveHtml')}</button>
      </div>

      <div ref={reportRef} className="mr-wrap">
        <div className="mr-top">
          <div>
            <h1>📋 {t('summary.title')}</h1>
            <p className="mr-meta">ITDashboard · {now}</p>
          </div>
        </div>

        {err && <div style={{ color: '#b91c1c', marginTop: 10 }}>⚠ {err}</div>}

        <h2>{t('summary.equipTotal')}</h2>
        <div className="mr-kpis">
          <Kpi label={t('summary.equipCount')} value={totalEquip} />
          <Kpi label="PC / notebook" value={pcs} />
          <Kpi label="Tiskárny" value={printerDevices.length} />
          <Kpi label={t('summary.sites')} value={branchCount} />
        </div>
        <div className="mr-strip">
          <span className="mr-pill"><b>Server</b> {servers}</span>
          <span className="mr-pill"><b>Síťové prvky</b> {byCat.get('network') ?? 0}</span>
          <span className="mr-pill"><b>IoT / ostatní</b> {byCat.get('iot') ?? 0}</span>
        </div>
        <div style={{ marginTop: 10 }}>
          {catRows.map(([k, v]) => <BarRow key={k} label={catLabel(k)} value={v} max={catMax} />)}
        </div>

        <h2>{t('summary.os')}</h2>
        <div className="mr-kpis">
          <Kpi label="Windows 11" value={osW11} />
          <Kpi label="Windows 10" value={osW10} tone={osW10 ? 'warn' : undefined} />
          <Kpi label="Server" value={servers} />
          <Kpi label={t('summary.osOther')} value={osOther} tone={osOther ? 'warn' : undefined} />
        </div>

        <h2>{t('summary.bySite')}</h2>
        <table className="mr-t">
          <thead>
            <tr>
              <th>{t('summary.site')}</th><th className="num">{t('summary.count')}</th>
              <th className="num">PC</th><th className="num">Tiskárny</th>
              <th className="num">Online</th><th className="num">Offline</th>
            </tr>
          </thead>
          <tbody>
            {siteStat.map((s) => (
              <tr key={s.site}>
                <td>{s.site}</td><td className="num">{s.total}</td><td className="num">{s.pc}</td>
                <td className="num">{s.printer}</td>
                <td className="num ok">{s.online}</td>
                <td className={'num' + (s.offline ? ' crit' : '')}>{s.offline}</td>
              </tr>
            ))}
            {siteStat.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: '#999' }}>—</td></tr>}
          </tbody>
        </table>

        <h2>{t('summary.printers')}</h2>
        <div className="mr-kpis">
          <Kpi label={t('summary.printersTotal')} value={printerDevices.length} />
          <Kpi label="Offline" value={printersOffline} tone={printersOffline ? 'crit' : undefined} />
          <Kpi label={t('summary.suppliesLow')} value={suppliesLow} tone={suppliesLow ? 'warn' : undefined} />
          <Kpi label={t('summary.suppliesEmpty')} value={suppliesEmpty} tone={suppliesEmpty ? 'crit' : undefined} />
        </div>

        <h2>{t('summary.fleet')}</h2>
        <div className="mr-kpis">
          <Kpi label={t('summary.managed')} value={managed.length} />
          <Kpi label={t('summary.active')} value={pcActive} tone="ok" />
          <Kpi label="Offline" value={pcOffline} tone={pcOffline ? 'crit' : undefined} />
          <Kpi label={t('summary.problemPcs')} value={riskPcs} tone={riskPcs ? 'crit' : undefined} />
          <Kpi label={t('summary.diskCrit')} value={diskCrit} tone={diskCrit ? 'crit' : undefined} />
          <Kpi label={t('summary.diskWarn')} value={diskWarn} tone={diskWarn ? 'warn' : undefined} />
          <Kpi label={t('summary.officeAddins')} value={addinPcs} tone={addinPcs ? 'warn' : undefined} />
          <Kpi label={t('summary.inactive')} value={stale} />
          <Kpi label={t('summary.disabled')} value={disabled} />
        </div>

        <p className="mr-note">© AXIMA IT · ITDashboard — manažerský souhrn. Technika bez telefonů (randomizovaná MAC).</p>
      </div>
    </div>
  );
}
