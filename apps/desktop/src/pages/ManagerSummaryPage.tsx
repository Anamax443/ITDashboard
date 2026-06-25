import React, { useEffect, useState } from 'react';
import { api, parseDiskThresholds, summarizeDisks, isStaleComputer } from '../api.js';
import type { DeviceItem, ComputerItem, PrinterDevice, DiskItem } from '../api.js';
import { useI18n } from '../i18n.js';

// Managerial summary — a "take it to the meeting" page: how much equipment we have,
// where (by branch), and the operational health. Client-side aggregation over the
// existing endpoints; one click prints / saves it to PDF (landscape A4 print CSS).

const CAT_LABEL: Record<string, string> = {
  pc: 'PC / notebook', server: 'Server', printer: 'Tiskárna', phone: 'Telefon',
  network: 'Síťový prvek', iot: 'IoT / ostatní', other: 'Ostatní',
};
const catLabel = (k: string | null) => (k ? (CAT_LABEL[k] ?? k) : '—');

function Card({ value, label, color }: { value: React.ReactNode; label: string; color?: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px', minWidth: 120 }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color ?? 'var(--text)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ms-section" style={{ marginTop: 22, breakInside: 'avoid' }}>
      <h3 style={{ fontSize: 15, margin: '0 0 10px', borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>{title}</h3>
      {children}
    </div>
  );
}

export function ManagerSummaryPage({ settings = {} }: { settings?: Record<string, string> }) {
  const { t } = useI18n();
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

  // By branch (site): total + per key category + online/offline.
  const sites = [...new Set(devices.map((d) => d.site).filter(Boolean))].sort() as string[];
  const siteStat = sites.map((s) => {
    const ds = devices.filter((d) => d.site === s);
    return {
      site: s,
      total: ds.length,
      pc: ds.filter((d) => d.category === 'pc').length,
      printer: ds.filter((d) => d.category === 'printer').length,
      online: ds.filter((d) => reachOf(d) === true).length,
      offline: ds.filter((d) => reachOf(d) === false).length,
    };
  });

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
  // Disks: PCs with a critical / warning drive — same scope-aware logic the Dashboard
  // uses (disks live on their own endpoint, keyed to computer_id, not on ComputerItem).
  const diskSum = summarizeDisks(disks, parseDiskThresholds(settings));
  const diskCrit = diskSum.criticalPcs;
  const diskWarn = diskSum.warningPcs;

  const totalEquip = equip.length;
  const now = new Date().toLocaleString();

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          .panel-header, .no-print { display: none !important; }
          .ms-body { padding: 0 !important; }
          body { background: #fff; }
        }
        .ms-cards { display: flex; flex-wrap: wrap; gap: 12px; }
        table.ms { border-collapse: collapse; font-size: 12px; width: 100%; max-width: 760px; }
        table.ms th, table.ms td { border: 1px solid var(--border); padding: 5px 9px; text-align: left; }
        table.ms th { background: var(--surface); }
        table.ms td.n, table.ms th.n { text-align: right; font-variant-numeric: tabular-nums; }
      `}</style>
      <div className="panel-header">
        <h2>📋 {t('summary.title')}</h2>
        <div className="panel-actions">
          <button className="refresh-btn" onClick={load}>↻</button>
          <button className="refresh-btn" onClick={() => window.print()} style={{ fontWeight: 600 }}>🖨 {t('summary.print')}</button>
        </div>
      </div>
      <div className="ms-body panel-body" style={{ padding: 16 }}>
        {err && <div style={{ color: 'var(--critical)' }}>⚠ {err}</div>}
        <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 12 }}>ITDashboard — {now}</div>

        <Section title={t('summary.equipTotal')}>
          <div className="ms-cards" style={{ marginBottom: 12 }}>
            <Card value={totalEquip} label={t('summary.equipCount')} />
            <Card value={pcs} label="PC / notebook" />
            <Card value={servers} label="Server" />
            <Card value={printerDevices.length} label="Tiskárny" color="var(--accent)" />
            <Card value={byCat.get('network') ?? 0} label="Síťové prvky" />
            <Card value={byCat.get('iot') ?? 0} label="IoT / ostatní" />
            <Card value={sites.length} label={t('summary.sites')} />
          </div>
          <table className="ms">
            <thead><tr><th>{t('summary.category')}</th><th className="n">{t('summary.count')}</th></tr></thead>
            <tbody>{catRows.map(([k, v]) => <tr key={k}><td>{catLabel(k)}</td><td className="n">{v}</td></tr>)}</tbody>
          </table>
        </Section>

        <Section title={t('summary.bySite')}>
          <table className="ms" style={{ maxWidth: 620 }}>
            <thead><tr>
              <th>{t('summary.site')}</th><th className="n">{t('summary.count')}</th>
              <th className="n">PC</th><th className="n">Tiskárny</th>
              <th className="n">Online</th><th className="n">Offline</th>
            </tr></thead>
            <tbody>{siteStat.map((s) => (
              <tr key={s.site}>
                <td>{s.site}</td><td className="n">{s.total}</td><td className="n">{s.pc}</td>
                <td className="n">{s.printer}</td>
                <td className="n" style={{ color: 'var(--ok)' }}>{s.online}</td>
                <td className="n" style={{ color: s.offline ? 'var(--critical)' : undefined }}>{s.offline}</td>
              </tr>
            ))}</tbody>
          </table>
        </Section>

        <Section title={t('summary.printers')}>
          <div className="ms-cards">
            <Card value={printerDevices.length} label={t('summary.printersTotal')} />
            <Card value={printersOffline} label="Offline" color={printersOffline ? 'var(--critical)' : undefined} />
            <Card value={suppliesLow} label={t('summary.suppliesLow')} color={suppliesLow ? 'var(--warning)' : undefined} />
            <Card value={suppliesEmpty} label={t('summary.suppliesEmpty')} color={suppliesEmpty ? 'var(--critical)' : undefined} />
          </div>
        </Section>

        <Section title={t('summary.fleet')}>
          <div className="ms-cards">
            <Card value={managed.length} label={t('summary.managed')} />
            <Card value={pcActive} label={t('summary.active')} color="var(--ok)" />
            <Card value={pcOffline} label="Offline" color={pcOffline ? 'var(--critical)' : undefined} />
            <Card value={riskPcs} label={t('summary.problemPcs')} color={riskPcs ? 'var(--critical)' : undefined} />
            <Card value={diskCrit} label={t('summary.diskCrit')} color={diskCrit ? 'var(--critical)' : undefined} />
            <Card value={diskWarn} label={t('summary.diskWarn')} color={diskWarn ? 'var(--warning)' : undefined} />
            <Card value={stale} label={t('summary.inactive')} />
            <Card value={disabled} label={t('summary.disabled')} />
          </div>
        </Section>
      </div>
    </div>
  );
}
