// Structured fleet overview report: PC vs servers, offline machines (with
// "down since"), and collection-health counts. Drives both the desktop
// "Reporting" tab (GET /reports/overview) and an on-demand email
// (POST /reports/email) that shares this one generator so the two never drift.
//
// Everything here is sourced from the computers table — cheap, no live probing —
// so the tab can poll it and the email can be sent any time. Port-check detail
// is a later increment (kept out of v1 because per-port state is not persisted).
import { getPool } from '../db/pool.js';
import { getAllSettings } from './settings.js';
import { logActivity } from './activity-log.js';
import { sendMail, escHtml, FONT } from './alerts.js';

export type MachineKind = 'server' | 'pc';
export type MachineStatus = 'active' | 'offline' | 'disabled';

export interface ReportMachine {
  name: string;
  ip: string | null;
  os: string | null;
  kind: MachineKind;
  status: MachineStatus;
  monitored: boolean;
  lastSeen: string | null;
  lastReachableAt: string | null;
  consecutiveFailures: number;
}

export interface OverviewReport {
  generatedAt: string;
  totals: {
    total: number;       // enabled, non-excluded machines in scope
    servers: number;
    pcs: number;
    active: number;
    offline: number;
    disabled: number;    // enabled=0 (excluded from the scoped lists, counted here)
    monitored: number;
    failing: number;     // collection failing (consecutive_failures > 0)
  };
  machines: ReportMachine[];  // in-scope (enabled, non-excluded), servers first
  offline: ReportMachine[];   // subset of machines with status 'offline'
}

const isServer = (os: string | null): boolean => /server/i.test(os ?? '');

interface Row {
  name: string;
  ip_address: string | null;
  os_version: string | null;
  enabled: boolean;
  excluded: boolean;
  monitor_enabled: boolean;
  reachable: boolean | null;
  last_seen: string | null;
  last_reachable_at: string | null;
  consecutive_failures: number;
}

export async function buildOverviewReport(): Promise<OverviewReport> {
  const pool = await getPool();
  const r = await pool.request().query<Row>(`
    SELECT name, ip_address, os_version, enabled, excluded, monitor_enabled,
           reachable, last_seen, last_reachable_at, consecutive_failures
    FROM computers
    WHERE excluded = 0
    ORDER BY name
  `);

  const machines: ReportMachine[] = [];
  let disabled = 0;
  for (const row of r.recordset) {
    if (!row.enabled) { disabled++; continue; } // counted, not listed in scope
    const status: MachineStatus = row.reachable === false ? 'offline' : 'active';
    machines.push({
      name: row.name,
      ip: row.ip_address,
      os: row.os_version,
      kind: isServer(row.os_version) ? 'server' : 'pc',
      status,
      monitored: !!row.monitor_enabled,
      lastSeen: row.last_seen,
      lastReachableAt: row.last_reachable_at,
      consecutiveFailures: row.consecutive_failures ?? 0,
    });
  }
  // Servers first, then by name — most operationally interesting at the top.
  machines.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'server' ? -1 : 1);

  const offline = machines.filter((m) => m.status === 'offline');
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      total: machines.length,
      servers: machines.filter((m) => m.kind === 'server').length,
      pcs: machines.filter((m) => m.kind === 'pc').length,
      active: machines.filter((m) => m.status === 'active').length,
      offline: offline.length,
      disabled,
      monitored: machines.filter((m) => m.monitored).length,
      failing: machines.filter((m) => m.consecutiveFailures > 0).length,
    },
    machines,
    offline,
  };
}

function fmtSince(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

// Plain-text + HTML render of the overview. Test mode only adds a banner so the
// operator can tell a manual send apart from a scheduled one.
export function renderOverviewReport(rep: OverviewReport, dashboardUrl: string): { subject: string; text: string; html: string } {
  const t = rep.totals;
  const generated = new Date(rep.generatedAt).toLocaleString('cs-CZ');
  const subject = `ITDashboard — přehled: ${t.total} strojů (${t.servers} srv / ${t.pcs} PC), ${t.offline} offline`;

  // --- text ---
  const lines: string[] = [];
  lines.push(`ITDashboard — strukturovaný přehled`);
  lines.push(`Vygenerováno: ${generated}`);
  lines.push('');
  lines.push(`Stroje (aktivní evidence): ${t.total}  ·  servery ${t.servers}  ·  PC ${t.pcs}`);
  lines.push(`Online ${t.active}  ·  offline ${t.offline}  ·  zakázané ${t.disabled}  ·  monitorované ${t.monitored}  ·  sběr selhává ${t.failing}`);
  lines.push('');
  lines.push(`OFFLINE (${rep.offline.length}):`);
  if (rep.offline.length === 0) lines.push('  — žádné —');
  for (const m of rep.offline) {
    lines.push(`  ${m.name}  ·  ${m.ip ?? '—'}  ·  ${m.kind === 'server' ? 'server' : 'PC'}  ·  offline ${fmtSince(m.lastReachableAt)}`);
  }
  lines.push('');
  const servers = rep.machines.filter((m) => m.kind === 'server');
  lines.push(`SERVERY (${servers.length}):`);
  for (const m of servers) {
    lines.push(`  ${m.name}  ·  ${m.ip ?? '—'}  ·  ${m.status}  ·  ${m.os ?? '—'}`);
  }
  const text = lines.join('\n');

  // --- html ---
  const row = (cells: string[], head = false) =>
    `<tr>${cells.map((c) => `<${head ? 'th' : 'td'} style="text-align:left;padding:6px 10px;border-bottom:1px solid #eef0f2;font-size:13px;color:#374151;${head ? 'color:#6b7280;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em' : ''}">${c}</${head ? 'th' : 'td'}>`).join('')}</tr>`;

  const stat = (label: string, val: number, color = '#111827') =>
    `<td style="padding:8px 14px;text-align:center;font-family:${FONT}"><div style="font-size:22px;font-weight:700;color:${color}">${val}</div><div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em">${escHtml(label)}</div></td>`;

  const offlineRows = rep.offline.length === 0
    ? row(['<span style="color:#10b981">žádné offline stroje</span>', '', '', ''])
    : rep.offline.map((m) => row([escHtml(m.name), escHtml(m.ip ?? '—'), m.kind === 'server' ? 'server' : 'PC', `offline ${fmtSince(m.lastReachableAt)}`])).join('');

  const serverRows = servers.map((m) => row([
    escHtml(m.name),
    escHtml(m.ip ?? '—'),
    `<span style="color:${m.status === 'offline' ? '#ef4444' : '#10b981'};font-weight:600">${m.status}</span>`,
    escHtml(m.os ?? '—'),
  ])).join('');

  const cta = dashboardUrl
    ? `<div style="margin:18px 0 4px"><a href="${escHtml(dashboardUrl)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-size:13px;font-family:${FONT}">Otevřít ITDashboard →</a></div>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:20px;font-family:${FONT}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
      <tr><td style="background:#111827;border-radius:10px 10px 0 0;padding:16px 20px;color:#fff;font-size:16px;font-weight:600">📋 ITDashboard — strukturovaný přehled</td></tr>
      <tr><td style="background:#fff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:6px">
          <tr>${stat('stroje', t.total)}${stat('servery', t.servers)}${stat('PC', t.pcs)}${stat('offline', t.offline, t.offline > 0 ? '#ef4444' : '#10b981')}${stat('sběr selhává', t.failing, t.failing > 0 ? '#f59e0b' : '#111827')}</tr>
        </table>
        <p style="font-size:12px;color:#6b7280;margin:2px 0 16px">Online ${t.active} · zakázané ${t.disabled} · monitorované ${t.monitored}</p>

        <h3 style="font-size:13px;color:#111827;margin:14px 0 6px">Offline stroje (${rep.offline.length})</h3>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row(['Stroj', 'IP', 'Typ', 'Offline'], true)}${offlineRows}</table>

        <h3 style="font-size:13px;color:#111827;margin:18px 0 6px">Servery (${servers.length})</h3>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row(['Stroj', 'IP', 'Stav', 'OS'], true)}${serverRows}</table>

        ${cta}
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid #eef0f2;font-size:12px;color:#9ca3af">
          Vygenerováno ${escHtml(generated)} · ITDashboard automatický report.
        </div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { subject, text, html };
}

// On-demand send from the Reporting tab. Uses the reports recipient list,
// falling back to the shared alerts.recipients when empty.
export async function sendOverviewReportEmail(): Promise<{ recipients: number; total: number; offline: number }> {
  const settings = await getAllSettings();
  const rep = await buildOverviewReport();
  const recipients = await sendMail(settings, renderOverviewReport(rep, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.reports.recipients');
  logActivity('info', 'reports', `Overview report email sent to ${recipients} recipient(s) — ${rep.totals.total} machine(s), ${rep.totals.offline} offline`);
  return { recipients, total: rep.totals.total, offline: rep.totals.offline };
}
