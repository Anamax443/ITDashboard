import React, { useEffect, useState } from 'react';
import type { OverviewReport, ReportMachine } from '../api.js';
import { api, timeAgo } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { ExportMenu, type ExportColumn } from '../components/ExportMenu.js';
import { useI18n, type TKey } from '../i18n.js';

function sinceText(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export function ReportingPage({ onJumpToComputer }: { onJumpToComputer?: (name: string) => void } = {}) {
  const { t } = useI18n();
  const [rep, setRep] = useState<OverviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => { api.reportOverview().then(setRep).catch((e) => setError(String(e))); };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  const servers = rep?.machines.filter((m) => m.kind === 'server') ?? [];
  const pcMachines = rep?.machines.filter((m) => m.kind === 'pc') ?? [];

  const exportColumns: ExportColumn<ReportMachine>[] = [
    { key: 'name', label: 'Machine', get: (r) => r.name },
    { key: 'ip', label: 'IP', get: (r) => r.ip ?? '' },
    { key: 'kind', label: 'Type', get: (r) => r.kind },
    { key: 'status', label: 'Status', get: (r) => r.status },
    { key: 'os', label: 'OS', get: (r) => r.os ?? '' },
    { key: 'monitored', label: 'Monitored', get: (r) => (r.monitored ? 'yes' : 'no') },
    { key: 'lastSeen', label: 'Last seen', get: (r) => r.lastSeen ?? '' },
    { key: 'lastReachableAt', label: 'Last reachable', get: (r) => r.lastReachableAt ?? '' },
    { key: 'consecutiveFailures', label: 'Collect failures', get: (r) => r.consecutiveFailures },
  ];

  const t0 = rep?.totals;

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('reporting.help')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>
          📋 {t('reporting.title')}{' '}
          {t0 && (
            <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
              ({t0.total} {t('reporting.machines')} · {t0.servers} {t('reporting.servers')} · {t0.pcs} PC · <span style={{ color: t0.offline > 0 ? 'var(--critical)' : 'var(--ok)', fontWeight: 700 }}>{t0.offline} offline</span>)
            </span>
          )}
        </h2>
        <div className="panel-actions filters">
          <SendReportButton />
          <ExportMenu
            rows={rep?.machines ?? []}
            columns={exportColumns}
            title="ITDashboard — Reporting"
            filterSummary=""
            filenameBase="fleet-overview"
          />
          <button className="refresh-btn" onClick={refresh}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {!rep ? (
          <div className="empty">…</div>
        ) : (
          <div style={{ padding: 12 }}>
            <StatRow totals={rep.totals} />

            <Section title={`${t('reporting.section.offline')} (${rep.offline.length})`}>
              {rep.offline.length === 0 ? (
                <div style={{ color: 'var(--ok)', fontSize: 12, padding: '6px 2px' }}>● {t('reporting.noOffline')}</div>
              ) : (
                <MachineTable rows={rep.offline} onJumpToComputer={onJumpToComputer} offlineMode />
              )}
            </Section>

            <Section title={`${t('reporting.section.servers')} (${servers.length})`}>
              <MachineTable rows={servers} onJumpToComputer={onJumpToComputer} />
            </Section>

            <Section title={`${t('reporting.section.pcs')} (${pcMachines.length})`}>
              <MachineTable rows={pcMachines} onJumpToComputer={onJumpToComputer} />
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function StatRow({ totals }: { totals: OverviewReport['totals'] }) {
  const { t } = useI18n();
  const cell = (label: string, val: number, color?: string) => (
    <div style={{ textAlign: 'center', minWidth: 78 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? 'var(--text)' }}>{val}</div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
    </div>
  );
  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', padding: '4px 2px 16px', alignItems: 'flex-end' }}>
      {cell(t('reporting.stat.total'), totals.total)}
      {cell(t('reporting.stat.servers'), totals.servers)}
      {cell(t('reporting.stat.pcs'), totals.pcs)}
      {cell(t('reporting.stat.active'), totals.active, 'var(--ok)')}
      {cell(t('reporting.stat.offline'), totals.offline, totals.offline > 0 ? 'var(--critical)' : 'var(--ok)')}
      {cell(t('reporting.stat.disabled'), totals.disabled, 'var(--text-dim)')}
      {cell(t('reporting.stat.monitored'), totals.monitored)}
      {cell(t('reporting.stat.failing'), totals.failing, totals.failing > 0 ? 'var(--warning)' : 'var(--text)')}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 13, margin: '0 0 6px', color: 'var(--text)' }}>{title}</h3>
      {children}
    </div>
  );
}

function MachineTable({ rows, onJumpToComputer, offlineMode }: {
  rows: ReportMachine[]; onJumpToComputer?: (name: string) => void; offlineMode?: boolean;
}) {
  const { t } = useI18n();
  if (rows.length === 0) return <div className="empty" style={{ padding: 8 }}>—</div>;
  return (
    <table>
      <thead>
        <tr>
          <th style={{ textAlign: 'left', width: 180 }}>{t('reporting.col.machine')}</th>
          <th style={{ textAlign: 'left', width: 120 }}>{t('reporting.col.ip')}</th>
          <th style={{ textAlign: 'left', width: 100 }}>{t('reporting.col.status')}</th>
          <th style={{ textAlign: 'left' }}>{offlineMode ? t('reporting.col.offlineFor') : t('reporting.col.os')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.name}>
            <td style={{ fontWeight: 600 }}>
              {onJumpToComputer ? (
                <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(m.name); }} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{m.name}</a>
              ) : m.name}
            </td>
            <td style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'Consolas, monospace' }}>{m.ip ?? '—'}</td>
            <td>
              <span style={{ color: m.status === 'offline' ? 'var(--critical)' : 'var(--ok)', fontSize: 11, fontWeight: 700 }}>
                {m.status === 'offline' ? '○ ' : '● '}{t(`reporting.status.${m.status}` as TKey)}
              </span>
            </td>
            <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              {offlineMode ? `${sinceText(m.lastReachableAt)}${m.lastSeen ? ` · ${t('reporting.lastSeen')} ${timeAgo(m.lastSeen)}` : ''}` : (m.os ?? '—')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SendReportButton() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await api.sendReportEmail();
      setMsg(t('reporting.sendOk', { recipients: r.recipients, total: r.total, offline: r.offline }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button onClick={send} disabled={busy} style={{ cursor: busy ? 'default' : 'pointer' }}>
        {busy ? t('reporting.sending') : `✉ ${t('reporting.sendEmail')}`}
      </button>
      {msg && <span style={{ color: 'var(--ok)', fontSize: 11 }}>{msg}</span>}
      {err && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {err}</span>}
    </span>
  );
}
