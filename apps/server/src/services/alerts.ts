import nodemailer from 'nodemailer';
import { Socket } from 'node:net';
import { getPool } from '../db/pool.js';
import { getAllSettings, setSetting, type SettingsMap } from './settings.js';
import { logActivity } from './activity-log.js';
import {
  type DriveScope, parseDriveScope, driveLetterOf, inScope, boolSetting, parseRecipients,
  parseList, globToRegExp, matchesAny, inMaintenanceWindow, fmtDuration, fmtGb,
  escHtml, FONT, subjectPrefix, shouldAlertNow,
} from './alerts-util.js';

// Re-exported so existing importers (reports.ts) keep working unchanged.
export { escHtml, FONT, subjectPrefix } from './alerts-util.js';

// Disk-critical email alerting. Operator opts a few "key" PCs into monitoring
// (computers.disk_email_monitor); when a disk scan finds an in-scope drive on
// one of them below the critical threshold, we email a report — throttled to
// at most once per alerts.disk.frequency_hours while the condition persists.
// SMTP relay, recipients and cadence all live in Settings.

export interface MonitoredCriticalDisk {
  computer: string;
  ip: string | null;
  driveLetter: string;
  volumeLabel: string | null;
  totalBytes: number;
  freeBytes: number;
  freePct: number;
  freeGb: number;
}


interface DiskRow {
  computer: string;
  ip_address: string | null;
  drive_letter: string;
  volume_label: string | null;
  total_bytes: number;
  free_bytes: number;
  disk_email_drives: string | null;
}

// Evaluate the disks of all disk_email_monitor PCs against the CRITICAL
// threshold. Drive scope is per-PC: if the PC has explicit letters in
// disk_email_drives (e.g. 'C,F') only those count; otherwise fall back to the
// global critical drive-letter scope (same rules as the dashboard).
async function loadMonitoredCriticalDisks(settings: SettingsMap): Promise<MonitoredCriticalDisk[]> {
  const pool = await getPool();
  const r = await pool.request().query<DiskRow>(`
    SELECT c.name AS computer, c.ip_address, d.drive_letter, d.volume_label, d.total_bytes, d.free_bytes,
           c.disk_email_drives
    FROM disks d
    JOIN computers c ON c.id = d.computer_id
    WHERE c.enabled = 1 AND c.disk_email_monitor = 1
    ORDER BY c.name, d.drive_letter
  `);

  const critPct = Number(settings['disk.critical_pct'] ?? 5);
  const critGb = Number(settings['disk.critical_gb'] ?? 5);
  const mode = (settings['disk.threshold_mode'] as 'pct' | 'gb' | 'either') ?? 'pct';
  const legacy = parseDriveScope(settings['disk.eval_drive_letters'], { kind: 'include', letters: new Set(['C']) });
  const critScope = parseDriveScope(settings['disk.crit_drives'], legacy);
  // Cache per-PC scope parses (same disk_email_drives string repeats per drive row).
  const scopeCache = new Map<string, DriveScope>();
  const scopeFor = (raw: string | null): DriveScope => {
    const key = (raw ?? '').trim();
    if (key === '') return critScope;
    let cached = scopeCache.get(key);
    if (!cached) { cached = parseDriveScope(key, critScope); scopeCache.set(key, cached); }
    return cached;
  };

  const out: MonitoredCriticalDisk[] = [];
  for (const d of r.recordset) {
    if (d.total_bytes <= 0) continue;
    const freePct = (d.free_bytes / d.total_bytes) * 100;
    const freeGb = d.free_bytes / 1024 ** 3;
    const pctCrit = freePct < critPct;
    const gbCrit = freeGb < critGb;
    const isCrit = mode === 'pct' ? pctCrit : mode === 'gb' ? gbCrit : (pctCrit || gbCrit);
    if (isCrit && inScope(driveLetterOf(d.drive_letter), scopeFor(d.disk_email_drives))) {
      out.push({
        computer: d.computer,
        ip: d.ip_address,
        driveLetter: d.drive_letter,
        volumeLabel: d.volume_label,
        totalBytes: d.total_bytes,
        freeBytes: d.free_bytes,
        freePct,
        freeGb,
      });
    }
  }
  return out;
}


// One white card per critical disk. Pure table + inline styles so it renders in
// Outlook / Gmail / mobile clients; cards are full-width blocks that stack
// vertically, so they stay readable on a phone. A two-cell bar visualises usage
// (red = used, light = free) — a nearly-full disk reads as a mostly-red bar.
function diskCard(c: MonitoredCriticalDisk): string {
  const usedPct = Math.max(2, Math.min(100, Math.round(100 - c.freePct)));
  const freePct = 100 - usedPct;
  const label = c.volumeLabel ? ` · ${escHtml(c.volumeLabel)}` : '';
  const ip = c.ip ? ` · ${escHtml(c.ip)}` : '';
  return `
        <tr><td style="padding:0 0 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:#ffffff;border:1px solid #e5e7eb;border-left:4px solid #dc2626;border-radius:8px">
            <tr><td style="padding:14px 16px">
              <div style="font-size:16px;font-weight:700;color:#111827;font-family:${FONT}">${escHtml(c.computer)}</div>
              <div style="font-size:13px;color:#6b7280;margin:2px 0 10px;font-family:${FONT}">Disk ${escHtml(c.driveLetter)}${label}${ip}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:5px;overflow:hidden">
                <tr>
                  <td style="height:10px;background:#dc2626;width:${usedPct}%;font-size:0;line-height:0">&nbsp;</td>
                  <td style="height:10px;background:#e5e7eb;width:${freePct}%;font-size:0;line-height:0">&nbsp;</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">
                <tr>
                  <td style="font-size:14px;color:#374151;font-family:${FONT}"><span style="color:#dc2626;font-weight:700">${fmtGb(c.freeBytes)}</span> volných <span style="color:#9ca3af">z ${fmtGb(c.totalBytes)}</span></td>
                  <td align="right" style="font-size:15px;font-weight:700;color:#dc2626;font-family:${FONT};white-space:nowrap">${c.freePct.toFixed(1)} % volných</td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>`;
}

export function renderDiskAlert(critical: MonitoredCriticalDisk[], isTest: boolean, dashboardUrl: string): { subject: string; text: string; html: string } {
  const pcs = new Set(critical.map((c) => c.computer)).size;
  const has = critical.length > 0;
  const prefix = subjectPrefix(has, isTest);
  const subject = has
    ? `${prefix}ITDashboard — kritický stav disků (${critical.length} na ${pcs} PC)`
    : `${prefix}ITDashboard — test disk alertu (žádný kritický disk)`;

  // Server-local generation timestamp (Prague time).
  const generated = new Date().toLocaleString('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  // Plaintext fallback.
  const lines = critical.map((c) =>
    `  • ${c.computer}${c.ip ? ` (${c.ip})` : ''}  ${c.driveLetter}${c.volumeLabel ? ` (${c.volumeLabel})` : ''}  —  ${fmtGb(c.freeBytes)} volných z ${fmtGb(c.totalBytes)} (${c.freePct.toFixed(1)} % volných)`,
  );
  const text = (has
    ? `ITDashboard — kritický stav disků\n${critical.length} disk(ů) na ${pcs} PC pod kritickým prahem:\n\n${lines.join('\n')}\n`
    : 'ITDashboard — test disk alertu\nŽádný sledovaný disk není aktuálně v kritickém stavu.\n')
    + (isTest ? '\n(Testovací zpráva spuštěná ručně z Nastavení.)\n' : '')
    + (dashboardUrl ? `\nOtevřít ITDashboard: ${dashboardUrl}\n` : '')
    + `Vygenerováno: ${generated}\n`;

  // Header colour: red when there are critical disks, green for the "all clear"
  // test case.
  const headerBg = has ? '#dc2626' : '#16a34a';
  const headerSub = has ? '#fde2e2' : '#dcfce7';
  const headerTitle = has ? '🔴 Kritický stav disků' : '✅ Disky v pořádku';
  const headerLine = has
    ? `${critical.length} disk(ů) na ${pcs} PC pod kritickým prahem`
    : 'Žádný sledovaný disk není aktuálně v kritickém stavu';

  const body = has
    ? critical.map(diskCard).join('')
    : `<tr><td style="padding:4px 0 12px;font-size:14px;color:#374151;font-family:${FONT}">Všechny sledované disky jsou nad kritickým prahem. 👍</td></tr>`;

  const testBanner = isTest
    ? `<tr><td style="padding:0 0 14px"><div style="background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:6px;padding:10px 14px;font-size:13px;font-family:${FONT}">ℹ️ Testovací zpráva spuštěná ručně z Nastavení.</div></td></tr>`
    : '';

  const ctaButton = dashboardUrl
    ? `<tr><td style="padding:2px 0 16px"><a href="${escHtml(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:6px;font-family:${FONT}">Otevřít ITDashboard →</a></td></tr>`
    : '';

  const footerAddr = dashboardUrl
    ? `<a href="${escHtml(dashboardUrl)}" style="color:#6b7280;text-decoration:underline">${escHtml(dashboardUrl)}</a> · `
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:collapse">
        <tr><td style="background:${headerBg};border-radius:10px 10px 0 0;padding:18px 20px">
          <div style="font-size:18px;font-weight:700;color:#ffffff;font-family:${FONT}">${prefix}${headerTitle}</div>
          <div style="font-size:13px;color:${headerSub};margin-top:3px;font-family:${FONT}">${headerLine}</div>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${testBanner}
            ${body}
            ${ctaButton}
          </table>
          <div style="margin-top:8px;padding-top:14px;border-top:1px solid #eef0f2;font-size:12px;color:#9ca3af;font-family:${FONT};line-height:1.6">
            ${footerAddr}Vygenerováno ${generated} · ITDashboard automatický report.<br>
            Sledované disky a písmena: záložka Počítače (📧 Disk); práh a četnost: Nastavení.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

function buildTransport(settings: SettingsMap): nodemailer.Transporter {
  const host = (settings['alerts.smtp_host'] ?? '').trim();
  if (!host) throw new Error('alerts.smtp_host not configured');
  const port = Number(settings['alerts.smtp_port'] ?? 25) || 25;
  // Internal relay: STARTTLS opportunistic, no client auth assumed. Certificate
  // is not validated because internal relays commonly use self-signed certs.
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    tls: { rejectUnauthorized: false },
  });
}

// recipientsKey selects a per-agenda override list (alerts.disk/services/ports
// .recipients); when that key is empty we fall back to the shared
// alerts.recipients so a single global list keeps working unchanged.
export async function sendMail(
  settings: SettingsMap,
  payload: { subject: string; text: string; html: string },
  recipientsKey?: string,
): Promise<number> {
  const from = (settings['alerts.smtp_from'] ?? '').trim();
  const override = recipientsKey ? parseRecipients(settings[recipientsKey]) : [];
  const to = override.length > 0 ? override : parseRecipients(settings['alerts.recipients']);
  if (!from) throw new Error('alerts.smtp_from not configured');
  if (to.length === 0) {
    const where = recipientsKey ? `${recipientsKey} and alerts.recipients are both empty` : 'alerts.recipients is empty';
    throw new Error(where);
  }
  const transport = buildTransport(settings);
  await transport.sendMail({ from, to, subject: payload.subject, text: payload.text, html: payload.html });
  return to.length;
}

// Called after every disk scan. Sends a disk-critical report when monitored
// drives breach the critical threshold, throttled by alerts.disk.frequency_hours.
// Edge + reminder model: first detection sends immediately; while still
// critical, resends at the configured cadence; clearing resets the throttle so
// the next incident alerts promptly.
export async function evaluateAndSendDiskAlerts(): Promise<void> {
  const settings = await getAllSettings();
  if (!boolSetting(settings['alerts.disk.enabled'])) return;

  const critical = await loadMonitoredCriticalDisks(settings);

  if (critical.length === 0) {
    if (settings['alerts.disk.last_sent_at']) await setSetting('alerts.disk.last_sent_at', '');
    return;
  }

  const freqHours = Number(settings['alerts.disk.frequency_hours'] ?? 24) || 24;
  const lastSentRaw = settings['alerts.disk.last_sent_at'];
  const lastSent = lastSentRaw ? Date.parse(lastSentRaw) : NaN;
  const now = Date.now();
  if (Number.isFinite(lastSent) && now - lastSent < freqHours * 3600_000) return; // throttled

  try {
    const recipients = await sendMail(settings, renderDiskAlert(critical, false, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.disk.recipients');
    await setSetting('alerts.disk.last_sent_at', new Date(now).toISOString());
    const pcs = new Set(critical.map((c) => c.computer)).size;
    logActivity('warn', 'alerts', `Disk alert email sent to ${recipients} recipient(s) — ${critical.length} critical drive(s) on ${pcs} monitored PC(s)`);
  } catch (err) {
    logActivity('error', 'alerts', `Disk alert email failed: ${String(err).split('\n')[0]}`);
  }
}

// Manual test from Settings: sends the current monitored-disk state regardless
// of the enabled flag / throttle, so the operator can verify SMTP + recipients.
export async function sendDiskAlertTest(): Promise<{ recipients: number; critical: number; monitoredPcs: number }> {
  const settings = await getAllSettings();
  const critical = await loadMonitoredCriticalDisks(settings);
  const recipients = await sendMail(settings, renderDiskAlert(critical, true, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.disk.recipients');
  const pcs = new Set(critical.map((c) => c.computer)).size;
  logActivity('info', 'alerts', `Disk alert TEST email sent to ${recipients} recipient(s) (${critical.length} critical drive(s))`);
  return { recipients, critical: critical.length, monitoredPcs: pcs };
}

// =====================================================================
// Critical-service email alerting
// =====================================================================


export interface DownCriticalService {
  computerId: number;
  computer: string;
  ip: string | null;
  serviceName: string;
  displayName: string | null;
  firstDownAt: Date | null;
  lastSentAt: Date | null;
  critical: boolean; // true = key/critical level, false = broad "Services" level
}

interface ServiceProblemRow {
  computer_id: number;
  computer: string;
  ip_address: string | null;
  service_name: string;
  display_name: string | null;
  exceptions: string | null;
  first_down_at: Date | null;
  last_sent_at: Date | null;
}

// Shared loader for both service-monitoring levels. `gate` is the per-PC opt-in
// column; `exceptionsCol` is its per-PC ignore list; `critical` selects which
// names to report: the critical level reports ONLY critical_names matches, the
// broad level reports everything EXCEPT critical_names (so a critical service is
// never reported by both). Both honour the global whitelist and the per-PC
// ignore list. (gate/exceptionsCol come from a fixed union — safe to inline.)
async function loadDownServices(
  settings: SettingsMap,
  opts: {
    gate: 'service_email_monitor' | 'service_monitor';
    exceptionsCol: 'critical_service_exceptions' | 'service_exceptions';
    critical: boolean;
  },
): Promise<DownCriticalService[]> {
  const criticalPatterns = parseList(settings['alerts.services.critical_names']).map(globToRegExp);
  // The critical level is meaningless without a critical list; the broad level
  // still needs it to know what to exclude.
  if (opts.critical && criticalPatterns.length === 0) return [];
  const whitelist = parseList(settings['alerts.services.whitelist']).map(globToRegExp);

  const pool = await getPool();
  const r = await pool.request().query<ServiceProblemRow>(`
    SELECT c.id AS computer_id, c.name AS computer, c.ip_address,
           sp.service_name, sp.display_name,
           c.${opts.exceptionsCol} AS exceptions,
           st.first_down_at, st.last_sent_at
    FROM service_problems sp
    JOIN computers c ON c.id = sp.computer_id
    LEFT JOIN service_alert_state st ON st.computer_id = sp.computer_id AND st.service_name = sp.service_name
    WHERE c.enabled = 1 AND c.excluded = 0 AND c.${opts.gate} = 1
      -- Only alert on machines that are reachable NOW. service_problems is a
      -- snapshot from the last successful scan; an offline PC holds stale "down"
      -- rows (the box is just powered off, not a real service failure). Skip
      -- confirmed-offline (reachable = 0); keep online and not-yet-probed.
      AND (c.reachable = 1 OR c.reachable IS NULL)
      AND sp.state <> 'Running' AND sp.per_user_start = 0
      ${opts.critical ? '' : `
      -- Broad level = the collector's "real" set: an Auto service that should be
      -- running but is Stopped (drift). Exit code is NOT a discriminator — most
      -- stopped services report exit 0 (413 of 454 real problems fleet-wide), so
      -- filtering on exit <> 0 would miss the vast majority of genuine drift.
      -- Instead we drop the on-demand noise: trigger-start and delayed-start
      -- services (legitimately idle), matching the Services tab's "real" count.
      AND sp.trigger_start = 0 AND sp.delayed_start = 0`}
    ORDER BY c.name, sp.service_name
  `);

  const out: DownCriticalService[] = [];
  const perPcExceptions = new Map<number, RegExp[]>();
  for (const row of r.recordset) {
    const nm = row.service_name;
    const dn = row.display_name;
    const isCrit = matchesAny(nm, criticalPatterns) || (dn != null && matchesAny(dn, criticalPatterns));
    if (opts.critical ? !isCrit : isCrit) continue; // critical→only critical; broad→skip critical
    if (whitelist.length > 0 && (matchesAny(nm, whitelist) || (dn != null && matchesAny(dn, whitelist)))) continue;
    let pcEx = perPcExceptions.get(row.computer_id);
    if (!pcEx) { pcEx = parseList(row.exceptions ?? undefined).map(globToRegExp); perPcExceptions.set(row.computer_id, pcEx); }
    if (pcEx.length > 0 && (matchesAny(nm, pcEx) || (dn != null && matchesAny(dn, pcEx)))) continue; // per-PC ignore
    out.push({
      computerId: row.computer_id,
      computer: row.computer,
      ip: row.ip_address,
      serviceName: nm,
      displayName: dn,
      firstDownAt: row.first_down_at,
      lastSentAt: row.last_sent_at,
      critical: opts.critical,
    });
  }
  return out;
}

// Critical (key-service) level: gated by service_email_monitor, only critical
// names, minus per-PC critical_service_exceptions.
function loadMonitoredDownCriticalServices(settings: SettingsMap): Promise<DownCriticalService[]> {
  return loadDownServices(settings, { gate: 'service_email_monitor', exceptionsCol: 'critical_service_exceptions', critical: true });
}

// Broad "Services" level: gated by service_monitor, every down Auto service that
// is NOT critical, minus per-PC service_exceptions.
function loadMonitoredDownBroadServices(settings: SettingsMap): Promise<DownCriticalService[]> {
  return loadDownServices(settings, { gate: 'service_monitor', exceptionsCol: 'service_exceptions', critical: false });
}

const svcKey = (cid: number, name: string) => `${cid}${name.toLowerCase()}`;

// Called after every services scan. Alerts on critical services that have been
// down at least alerts.services.debounce_minutes (flapping guard), suppressed
// during the optional maintenance window, throttled by frequency_hours.
export async function evaluateAndSendServiceAlerts(): Promise<void> {
  const settings = await getAllSettings();
  if (!boolSetting(settings['alerts.services.enabled'])) return;

  const pool = await getPool();
  const candidates = [
    ...(await loadMonitoredDownCriticalServices(settings)),
    ...(await loadMonitoredDownBroadServices(settings)),
  ];
  const candKeys = new Set(candidates.map((c) => svcKey(c.computerId, c.serviceName)));

  // Recovery: drop state for services no longer in the down-critical set so the
  // next outage starts a fresh debounce window.
  const existing = await pool.request().query<{ computer_id: number; service_name: string }>(
    `SELECT computer_id, service_name FROM service_alert_state`);
  for (const s of existing.recordset) {
    if (!candKeys.has(svcKey(s.computer_id, s.service_name))) {
      await pool.request().input('cid', s.computer_id).input('nm', s.service_name)
        .query(`DELETE FROM service_alert_state WHERE computer_id=@cid AND service_name=@nm`);
    }
  }

  const nowDate = new Date();
  const now = nowDate.getTime();

  // Start tracking newly-down services (debounce clock begins now).
  for (const c of candidates) {
    if (c.firstDownAt == null) {
      await pool.request().input('cid', c.computerId).input('nm', c.serviceName).input('t', nowDate)
        .query(`IF NOT EXISTS (SELECT 1 FROM service_alert_state WHERE computer_id=@cid AND service_name=@nm)
                INSERT INTO service_alert_state (computer_id, service_name, first_down_at) VALUES (@cid,@nm,@t)`);
      c.firstDownAt = nowDate;
    }
  }

  if (inMaintenanceWindow(settings['alerts.services.maintenance_window'], nowDate)) return; // suppressed

  const debounceMs = (Number(settings['alerts.services.debounce_minutes'] ?? 10) || 10) * 60_000;
  const freqMs = (Number(settings['alerts.services.frequency_hours'] ?? 24) || 24) * 3_600_000;

  const toAlert = candidates.filter((c) => shouldAlertNow(c.firstDownAt, c.lastSentAt, now, debounceMs, freqMs));
  if (toAlert.length === 0) return;

  try {
    const recipients = await sendMail(settings, renderServiceAlert(toAlert, now, false, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.services.recipients');
    for (const a of toAlert) {
      await pool.request().input('cid', a.computerId).input('nm', a.serviceName).input('t', nowDate)
        .query(`UPDATE service_alert_state SET last_sent_at=@t WHERE computer_id=@cid AND service_name=@nm`);
    }
    const pcs = new Set(toAlert.map((a) => a.computer)).size;
    const crit = toAlert.filter((a) => a.critical).length;
    logActivity('warn', 'alerts', `Service alert email sent to ${recipients} recipient(s) — ${toAlert.length} service(s) down (${crit} critical) on ${pcs} PC(s)`);
  } catch (err) {
    logActivity('error', 'alerts', `Service alert email failed: ${String(err).split('\n')[0]}`);
  }
}

// Manual test from Settings — sends the current down-critical services regardless
// of enable/debounce/maintenance/throttle.
export async function sendServiceAlertTest(): Promise<{ recipients: number; down: number; monitoredPcs: number }> {
  const settings = await getAllSettings();
  const candidates = [
    ...(await loadMonitoredDownCriticalServices(settings)),
    ...(await loadMonitoredDownBroadServices(settings)),
  ];
  const recipients = await sendMail(settings, renderServiceAlert(candidates, Date.now(), true, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.services.recipients');
  const pcs = new Set(candidates.map((c) => c.computer)).size;
  logActivity('info', 'alerts', `Service alert TEST email sent to ${recipients} recipient(s) (${candidates.length} service(s) down)`);
  return { recipients, down: candidates.length, monitoredPcs: pcs };
}

function serviceCard(c: DownCriticalService): string {
  const dn = c.displayName && c.displayName !== c.serviceName ? ` · ${escHtml(c.displayName)}` : '';
  const ip = c.ip ? ` · ${escHtml(c.ip)}` : '';
  const accent = c.critical ? '#dc2626' : '#d97706'; // critical = red, broad service = amber
  const badge = c.critical ? '🛡 kritická služba' : 'služba';
  return `
        <tr><td style="padding:0 0 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:#ffffff;border:1px solid #e5e7eb;border-left:4px solid ${accent};border-radius:8px">
            <tr><td style="padding:14px 16px">
              <div style="font-size:11px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:.04em;font-family:${FONT}">${badge}</div>
              <div style="font-size:16px;font-weight:700;color:#111827;font-family:${FONT}">${escHtml(c.computer)}</div>
              <div style="font-size:13px;color:#6b7280;margin:2px 0 6px;font-family:${FONT}">${escHtml(c.serviceName)}${dn}${ip}</div>
              <div style="font-size:14px;color:${accent};font-weight:700;font-family:${FONT}">⛔ mimo provoz</div>
            </td></tr>
          </table>
        </td></tr>`;
}

export function renderServiceAlert(downIn: DownCriticalService[], now: number, isTest: boolean, dashboardUrl: string): { subject: string; text: string; html: string } {
  // Critical first, then broad — most operationally important at the top.
  const down = [...downIn].sort((a, b) => Number(b.critical) - Number(a.critical));
  const pcs = new Set(down.map((c) => c.computer)).size;
  const critN = down.filter((c) => c.critical).length;
  const has = down.length > 0;
  const prefix = subjectPrefix(has, isTest);
  const subject = has
    ? `${prefix}ITDashboard — služby mimo provoz (${down.length} na ${pcs} PC${critN > 0 ? `, z toho ${critN} kritických` : ''})`
    : `${prefix}ITDashboard — test service alertu (žádná služba mimo provoz)`;

  const generated = new Date().toLocaleString('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const lines = down.map((c) =>
    `  • ${c.computer}${c.ip ? ` (${c.ip})` : ''}  ${c.serviceName}${c.displayName && c.displayName !== c.serviceName ? ` (${c.displayName})` : ''}`,
  );
  const text = (has
    ? `ITDashboard — služby mimo provoz\n${down.length} služba(služby) na ${pcs} PC${critN > 0 ? ` (${critN} kritických)` : ''}:\n\n${lines.join('\n')}\n`
    : 'ITDashboard — test service alertu\nŽádná sledovaná služba není aktuálně mimo provoz.\n')
    + (isTest ? '\n(Testovací zpráva spuštěná ručně z Nastavení.)\n' : '')
    + (dashboardUrl ? `\nOtevřít ITDashboard: ${dashboardUrl}\n` : '')
    + `Vygenerováno: ${generated}\n`;

  const headerBg = has ? '#dc2626' : '#16a34a';
  const headerSub = has ? '#fde2e2' : '#dcfce7';
  const headerTitle = has ? '⛔ Služby mimo provoz' : '✅ Služby v pořádku';
  const headerLine = has
    ? `${down.length} služba(služby) na ${pcs} PC mimo Running${critN > 0 ? ` · ${critN} kritických` : ''}`
    : 'Žádná sledovaná služba není mimo provoz';

  const body = has
    ? down.map((c) => serviceCard(c)).join('')
    : `<tr><td style="padding:4px 0 12px;font-size:14px;color:#374151;font-family:${FONT}">Všechny sledované služby běží. 👍</td></tr>`;

  const testBanner = isTest
    ? `<tr><td style="padding:0 0 14px"><div style="background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:6px;padding:10px 14px;font-size:13px;font-family:${FONT}">ℹ️ Testovací zpráva spuštěná ručně z Nastavení.</div></td></tr>`
    : '';
  const ctaButton = dashboardUrl
    ? `<tr><td style="padding:2px 0 16px"><a href="${escHtml(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:6px;font-family:${FONT}">Otevřít ITDashboard →</a></td></tr>`
    : '';
  const footerAddr = dashboardUrl
    ? `<a href="${escHtml(dashboardUrl)}" style="color:#6b7280;text-decoration:underline">${escHtml(dashboardUrl)}</a> · `
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:collapse">
        <tr><td style="background:${headerBg};border-radius:10px 10px 0 0;padding:18px 20px">
          <div style="font-size:18px;font-weight:700;color:#ffffff;font-family:${FONT}">${prefix}${headerTitle}</div>
          <div style="font-size:13px;color:${headerSub};margin-top:3px;font-family:${FONT}">${headerLine}</div>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${testBanner}
            ${body}
            ${ctaButton}
          </table>
          <div style="margin-top:8px;padding-top:14px;border-top:1px solid #eef0f2;font-size:12px;color:#9ca3af;font-family:${FONT};line-height:1.6">
            ${footerAddr}Vygenerováno ${generated} · ITDashboard automatický report.<br>
            Karty „🛡 kritická služba" = klíčové služby ze seznamu kritických; „služba" = ostatní sledované (jen pády, exit ≠ 0).<br>
            Sledování zapínáš v záložce Počítače (🔧 Služby / 🛡 Krit. služby). Per‑PC výjimky, seznam kritických služeb, debounce a okno údržby: Nastavení.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

// =====================================================================
// Phase 2 — outside-in port reachability checks
// =====================================================================

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => { clearTimeout(t); done(true); });
    socket.once('error', () => { clearTimeout(t); done(false); });
    socket.connect(port, host);
  });
}

interface PortCheck { name: string; port: number; }
function parsePortChecks(raw: string | undefined): PortCheck[] {
  const out: PortCheck[] = [];
  for (const tok of (raw ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = tok.match(/^(.+):(\d{1,5})$/);
    if (!m) continue;
    const port = Number(m[2]);
    if (port >= 1 && port <= 65535) out.push({ name: m[1]!.trim(), port });
  }
  return out;
}

export interface PortDown {
  computerId: number;
  computer: string;
  ip: string | null;
  checkName: string;
  port: number;
  firstDownAt: Date | null;
}

const PROBE_CONCURRENCY = 5;

// Called after every services scan (when port checks are enabled). TCP-probes
// each monitored PC's key ports from the API host, learns a per-(PC,port)
// baseline, and alerts on ports that were reachable and went down — with the
// same debounce / maintenance-window / throttle as service-state alerts.
export async function evaluateAndSendPortAlerts(): Promise<void> {
  const settings = await getAllSettings();
  if (!boolSetting(settings['alerts.services.port_checks_enabled'])) return;
  const checks = parsePortChecks(settings['alerts.services.port_checks']);
  if (checks.length === 0) return;
  const timeoutMs = Number(settings['alerts.services.port_timeout_ms'] ?? 2000) || 2000;

  const pool = await getPool();
  const pcs = (await pool.request().query<{ id: number; name: string }>(`
    SELECT id, name FROM computers
    WHERE enabled = 1 AND service_email_monitor = 1 AND excluded = 0
  `)).recordset;

  const nowDate = new Date();
  const now = nowDate.getTime();

  for (let i = 0; i < pcs.length; i += PROBE_CONCURRENCY) {
    const batch = pcs.slice(i, i + PROBE_CONCURRENCY);
    await Promise.all(batch.map(async (pc) => {
      // Skip a powered-off box entirely — don't start per-port outages for it.
      if (!(await tcpProbe(pc.name, 135, timeoutMs))) return;
      for (const chk of checks) {
        const ok = await tcpProbe(pc.name, chk.port, timeoutMs);
        const req = pool.request().input('cid', pc.id).input('nm', chk.name).input('port', chk.port).input('t', nowDate);
        if (ok) {
          await req.query(`
            MERGE port_check_state AS t USING (SELECT @cid AS cid, @nm AS nm) AS s
              ON t.computer_id = s.cid AND t.check_name = s.nm
            WHEN MATCHED THEN UPDATE SET last_ok_at = @t, first_down_at = NULL, port = @port
            WHEN NOT MATCHED THEN INSERT (computer_id, check_name, port, last_ok_at) VALUES (@cid, @nm, @port, @t);
          `);
        } else {
          // Only start tracking an outage if the port was EVER up (baseline) and
          // isn't already being tracked. Never-up ports are left untracked.
          await req.query(`
            UPDATE port_check_state SET first_down_at = @t, port = @port
            WHERE computer_id = @cid AND check_name = @nm AND last_ok_at IS NOT NULL AND first_down_at IS NULL;
          `);
        }
      }
    }));
  }

  if (inMaintenanceWindow(settings['alerts.services.maintenance_window'], nowDate)) return;

  const debounceMs = (Number(settings['alerts.services.debounce_minutes'] ?? 10) || 10) * 60_000;
  const freqMs = (Number(settings['alerts.services.frequency_hours'] ?? 24) || 24) * 3_600_000;

  const downRows = (await pool.request().query<{
    computer_id: number; computer: string; ip_address: string | null;
    check_name: string; port: number; first_down_at: Date; last_sent_at: Date | null;
  }>(`
    SELECT s.computer_id, c.name AS computer, c.ip_address, s.check_name, s.port, s.first_down_at, s.last_sent_at
    FROM port_check_state s
    JOIN computers c ON c.id = s.computer_id
    WHERE s.first_down_at IS NOT NULL AND c.enabled = 1 AND c.service_email_monitor = 1
    ORDER BY c.name, s.check_name
  `)).recordset;

  const eligible: PortDown[] = [];
  for (const r of downRows) {
    const downMs = now - new Date(r.first_down_at).getTime();
    if (downMs < debounceMs) continue;
    if (r.last_sent_at && now - new Date(r.last_sent_at).getTime() < freqMs) continue;
    eligible.push({ computerId: r.computer_id, computer: r.computer, ip: r.ip_address, checkName: r.check_name, port: r.port, firstDownAt: r.first_down_at });
  }
  if (eligible.length === 0) return;

  try {
    const recipients = await sendMail(settings, renderPortAlert(eligible, now, false, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.ports.recipients');
    for (const a of eligible) {
      await pool.request().input('cid', a.computerId).input('nm', a.checkName).input('t', nowDate)
        .query(`UPDATE port_check_state SET last_sent_at = @t WHERE computer_id = @cid AND check_name = @nm`);
    }
    const pcsN = new Set(eligible.map((e) => e.computer)).size;
    logActivity('warn', 'alerts', `Port alert email sent to ${recipients} recipient(s) — ${eligible.length} unreachable port(s) on ${pcsN} PC(s)`);
  } catch (err) {
    logActivity('error', 'alerts', `Port alert email failed: ${String(err).split('\n')[0]}`);
  }
}

// Manual test — live-probes all monitored PCs' ports and reports the currently
// unreachable ones (ignoring baseline/debounce/throttle/maintenance).
export async function sendPortAlertTest(): Promise<{ recipients: number; down: number; monitoredPcs: number }> {
  const settings = await getAllSettings();
  const checks = parsePortChecks(settings['alerts.services.port_checks']);
  const timeoutMs = Number(settings['alerts.services.port_timeout_ms'] ?? 2000) || 2000;
  const pool = await getPool();
  const pcs = (await pool.request().query<{ id: number; name: string; ip_address: string | null }>(`
    SELECT id, name, ip_address FROM computers
    WHERE enabled = 1 AND service_email_monitor = 1 AND excluded = 0
  `)).recordset;

  const down: PortDown[] = [];
  for (let i = 0; i < pcs.length; i += PROBE_CONCURRENCY) {
    const batch = pcs.slice(i, i + PROBE_CONCURRENCY);
    await Promise.all(batch.map(async (pc) => {
      if (!(await tcpProbe(pc.name, 135, timeoutMs))) return; // skip offline
      for (const chk of checks) {
        if (!(await tcpProbe(pc.name, chk.port, timeoutMs))) {
          down.push({ computerId: pc.id, computer: pc.name, ip: pc.ip_address, checkName: chk.name, port: chk.port, firstDownAt: null });
        }
      }
    }));
  }

  const recipients = await sendMail(settings, renderPortAlert(down, Date.now(), true, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.ports.recipients');
  const monitoredPcs = pcs.length;
  logActivity('info', 'alerts', `Port alert TEST email sent to ${recipients} recipient(s) (${down.length} unreachable port(s))`);
  return { recipients, down: down.length, monitoredPcs };
}

function portCard(c: PortDown, now: number): string {
  const ip = c.ip ? ` · ${escHtml(c.ip)}` : '';
  const since = c.firstDownAt ? `nedostupný ${fmtDuration(now - new Date(c.firstDownAt).getTime())}` : 'aktuálně nedostupný';
  return `
        <tr><td style="padding:0 0 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:#ffffff;border:1px solid #e5e7eb;border-left:4px solid #dc2626;border-radius:8px">
            <tr><td style="padding:14px 16px">
              <div style="font-size:16px;font-weight:700;color:#111827;font-family:${FONT}">${escHtml(c.computer)}</div>
              <div style="font-size:13px;color:#6b7280;margin:2px 0 6px;font-family:${FONT}">${escHtml(c.checkName)} · TCP ${c.port}${ip}</div>
              <div style="font-size:14px;color:#dc2626;font-weight:700;font-family:${FONT}">🔌 ${since}</div>
            </td></tr>
          </table>
        </td></tr>`;
}

export function renderPortAlert(down: PortDown[], now: number, isTest: boolean, dashboardUrl: string): { subject: string; text: string; html: string } {
  const pcs = new Set(down.map((c) => c.computer)).size;
  const has = down.length > 0;
  const prefix = subjectPrefix(has, isTest);
  const subject = has
    ? `${prefix}ITDashboard — port služby nedostupný (${down.length} na ${pcs} PC)`
    : `${prefix}ITDashboard — test port checku (vše dostupné)`;

  const generated = new Date().toLocaleString('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const lines = down.map((c) =>
    `  • ${c.computer}${c.ip ? ` (${c.ip})` : ''}  ${c.checkName} TCP ${c.port}  —  ${c.firstDownAt ? `nedostupný ${fmtDuration(now - new Date(c.firstDownAt).getTime())}` : 'nedostupný'}`,
  );
  const text = (has
    ? `ITDashboard — port služby nedostupný\n${down.length} port(ů) na ${pcs} PC:\n\n${lines.join('\n')}\n`
    : 'ITDashboard — test port checku\nVšechny sledované porty jsou dostupné.\n')
    + (isTest ? '\n(Testovací zpráva spuštěná ručně z Nastavení.)\n' : '')
    + (dashboardUrl ? `\nOtevřít ITDashboard: ${dashboardUrl}\n` : '')
    + `Vygenerováno: ${generated}\n`;

  const headerBg = has ? '#dc2626' : '#16a34a';
  const headerSub = has ? '#fde2e2' : '#dcfce7';
  const headerTitle = has ? '🔌 Port služby nedostupný' : '✅ Porty dostupné';
  const headerLine = has
    ? `${down.length} port(ů) na ${pcs} PC nelze z dashboardu dosáhnout`
    : 'Všechny sledované porty jsou dostupné';

  const body = has
    ? down.map((c) => portCard(c, now)).join('')
    : `<tr><td style="padding:4px 0 12px;font-size:14px;color:#374151;font-family:${FONT}">Všechny sledované porty odpovídají. 👍</td></tr>`;

  const testBanner = isTest
    ? `<tr><td style="padding:0 0 14px"><div style="background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:6px;padding:10px 14px;font-size:13px;font-family:${FONT}">ℹ️ Testovací zpráva spuštěná ručně z Nastavení.</div></td></tr>`
    : '';
  const ctaButton = dashboardUrl
    ? `<tr><td style="padding:2px 0 16px"><a href="${escHtml(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:6px;font-family:${FONT}">Otevřít ITDashboard →</a></td></tr>`
    : '';
  const footerAddr = dashboardUrl
    ? `<a href="${escHtml(dashboardUrl)}" style="color:#6b7280;text-decoration:underline">${escHtml(dashboardUrl)}</a> · `
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:collapse">
        <tr><td style="background:${headerBg};border-radius:10px 10px 0 0;padding:18px 20px">
          <div style="font-size:18px;font-weight:700;color:#ffffff;font-family:${FONT}">${prefix}${headerTitle}</div>
          <div style="font-size:13px;color:${headerSub};margin-top:3px;font-family:${FONT}">${headerLine}</div>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${testBanner}
            ${body}
            ${ctaButton}
          </table>
          <div style="margin-top:8px;padding-top:14px;border-top:1px solid #eef0f2;font-size:12px;color:#9ca3af;font-family:${FONT};line-height:1.6">
            ${footerAddr}Vygenerováno ${generated} · ITDashboard automatický report.<br>
            Port-checky testují cestu síť→firewall→OS→služba. Sledovaná PC + porty: Nastavení (🔔 Služby).
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

// =====================================================================
// Printer-offline email alerting
// =====================================================================
//
// Operator-categorized printers (device_categories.category = 'printer') that go
// offline. "Offline" reuses the same online/offline the Devices tab shows: a
// printer paired with an AD computer follows computers.reachable; an unmatched
// printer follows its own DHCP-lease ping. reachable = NULL (never probed) is
// NOT treated as down, so we don't alert on a printer we've never seen up.
//
// Runs on the MikroTik collector's own cadence (evaluateAndSendPrinterAlerts is
// called at the end of each collect), with the same debounce / maintenance /
// throttle model as the service alerts. Per-(printer) outage state lives in
// printer_alert_state, keyed by MAC (the category persists by MAC too).

export interface DownPrinter {
  mac: string;
  site: string;
  ip: string | null;
  name: string;        // host_name or matched AD computer name or the MAC
  firstDownAt: Date | null;
  lastSentAt: Date | null;
}

interface PrinterRow {
  site: string;
  mac_address: string;
  ip_address: string | null;
  host_name: string | null;
  computer_id: number | null;
  computer_name: string | null;
  computer_reachable: boolean | null;
  lease_reachable: boolean | null;
  first_down_at: Date | null;
  last_sent_at: Date | null;
}

// All categorized printers that are offline RIGHT NOW (effective reachability =
// false). Matched printers use the AD computer's reachable; unmatched use the
// lease ping. Joins the per-printer alert state for debounce/throttle.
async function loadDownPrinters(): Promise<DownPrinter[]> {
  const pool = await getPool();
  const r = await pool.request().query<PrinterRow>(`
    SELECT l.site, l.mac_address, l.ip_address, l.host_name,
           m.id AS computer_id, m.name AS computer_name, m.reachable AS computer_reachable,
           l.reachable AS lease_reachable,
           st.first_down_at, st.last_sent_at
    FROM dhcp_leases l
    JOIN device_categories dc ON dc.mac_address = l.mac_address AND dc.category = 'printer'
    LEFT JOIN printer_alert_state st ON st.mac_address = l.mac_address
    OUTER APPLY (
      SELECT TOP 1 c.id, c.name, c.reachable
      FROM computers c
      WHERE (l.host_name IS NOT NULL AND LOWER(c.name) = LOWER(l.host_name))
         OR (l.ip_address IS NOT NULL AND c.ip_address = l.ip_address)
      ORDER BY CASE WHEN l.host_name IS NOT NULL AND LOWER(c.name) = LOWER(l.host_name) THEN 0 ELSE 1 END, c.name
    ) m
    ORDER BY l.site, l.ip_address
  `);

  const out: DownPrinter[] = [];
  for (const row of r.recordset) {
    const effective = row.computer_id != null ? row.computer_reachable : row.lease_reachable;
    if (effective !== false) continue; // NULL (unknown) or true (online) → not down
    out.push({
      mac: row.mac_address,
      site: row.site,
      ip: row.ip_address,
      name: row.host_name || row.computer_name || row.mac_address,
      firstDownAt: row.first_down_at,
      lastSentAt: row.last_sent_at,
    });
  }
  return out;
}

// Called at the end of each MikroTik collect. Alerts on categorized printers
// that have been offline at least alerts.printers.debounce_minutes (flapping
// guard), suppressed during the optional maintenance window, throttled by
// frequency_hours. Self-contained; never throws (caller wraps it too).
export async function evaluateAndSendPrinterAlerts(): Promise<void> {
  const settings = await getAllSettings();
  if (!boolSetting(settings['alerts.printers.enabled'])) return;

  const pool = await getPool();
  const candidates = await loadDownPrinters();
  const candMacs = new Set(candidates.map((c) => c.mac));

  // Recovery: drop state for printers no longer down so the next outage starts a
  // fresh debounce window.
  const existing = await pool.request().query<{ mac_address: string }>(`SELECT mac_address FROM printer_alert_state`);
  for (const s of existing.recordset) {
    if (!candMacs.has(s.mac_address)) {
      await pool.request().input('mac', s.mac_address).query(`DELETE FROM printer_alert_state WHERE mac_address = @mac`);
    }
  }

  const nowDate = new Date();
  const now = nowDate.getTime();

  // Start the debounce clock for newly-down printers.
  for (const c of candidates) {
    if (c.firstDownAt == null) {
      await pool.request().input('mac', c.mac).input('t', nowDate)
        .query(`IF NOT EXISTS (SELECT 1 FROM printer_alert_state WHERE mac_address=@mac)
                INSERT INTO printer_alert_state (mac_address, first_down_at) VALUES (@mac,@t)`);
      c.firstDownAt = nowDate;
    }
  }

  if (inMaintenanceWindow(settings['alerts.printers.maintenance_window'], nowDate)) return;

  const debounceMs = (Number(settings['alerts.printers.debounce_minutes'] ?? 10) || 10) * 60_000;
  const freqMs = (Number(settings['alerts.printers.frequency_hours'] ?? 24) || 24) * 3_600_000;

  const toAlert = candidates.filter((c) => shouldAlertNow(c.firstDownAt, c.lastSentAt, now, debounceMs, freqMs));
  if (toAlert.length === 0) return;

  try {
    const recipients = await sendMail(settings, renderPrinterAlert(toAlert, now, false, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.printers.recipients');
    for (const a of toAlert) {
      await pool.request().input('mac', a.mac).input('t', nowDate)
        .query(`UPDATE printer_alert_state SET last_sent_at=@t WHERE mac_address=@mac`);
    }
    logActivity('warn', 'alerts', `Printer alert email sent to ${recipients} recipient(s) — ${toAlert.length} printer(s) offline`);
  } catch (err) {
    logActivity('error', 'alerts', `Printer alert email failed: ${String(err).split('\n')[0]}`);
  }
}

// Manual test from Settings — sends the current offline-printer state regardless
// of enable/debounce/maintenance/throttle.
export async function sendPrinterAlertTest(): Promise<{ recipients: number; offline: number }> {
  const settings = await getAllSettings();
  const candidates = await loadDownPrinters();
  const recipients = await sendMail(settings, renderPrinterAlert(candidates, Date.now(), true, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.printers.recipients');
  logActivity('info', 'alerts', `Printer alert TEST email sent to ${recipients} recipient(s) (${candidates.length} printer(s) offline)`);
  return { recipients, offline: candidates.length };
}

function printerCard(c: DownPrinter, now: number): string {
  const ip = c.ip ? ` · ${escHtml(c.ip)}` : '';
  const since = c.firstDownAt ? `offline ${fmtDuration(now - new Date(c.firstDownAt).getTime())}` : 'aktuálně offline';
  return `
        <tr><td style="padding:0 0 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:#ffffff;border:1px solid #e5e7eb;border-left:4px solid #dc2626;border-radius:8px">
            <tr><td style="padding:14px 16px">
              <div style="font-size:11px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:.04em;font-family:${FONT}">🖨 tiskárna</div>
              <div style="font-size:16px;font-weight:700;color:#111827;font-family:${FONT}">${escHtml(c.name)}</div>
              <div style="font-size:13px;color:#6b7280;margin:2px 0 6px;font-family:${FONT}">${escHtml(c.site)}${ip} · ${escHtml(c.mac)}</div>
              <div style="font-size:14px;color:#dc2626;font-weight:700;font-family:${FONT}">○ ${since}</div>
            </td></tr>
          </table>
        </td></tr>`;
}

export function renderPrinterAlert(down: DownPrinter[], now: number, isTest: boolean, dashboardUrl: string): { subject: string; text: string; html: string } {
  const has = down.length > 0;
  const prefix = subjectPrefix(has, isTest);
  const subject = has
    ? `${prefix}ITDashboard — tiskárny offline (${down.length})`
    : `${prefix}ITDashboard — test tiskárna alertu (žádná tiskárna offline)`;

  const generated = new Date().toLocaleString('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const lines = down.map((c) =>
    `  • ${c.name}${c.ip ? ` (${c.ip})` : ''}  ${c.site} · ${c.mac}  —  ${c.firstDownAt ? `offline ${fmtDuration(now - new Date(c.firstDownAt).getTime())}` : 'offline'}`,
  );
  const text = (has
    ? `ITDashboard — tiskárny offline\n${down.length} tiskárna(tiskáren) je offline:\n\n${lines.join('\n')}\n`
    : 'ITDashboard — test tiskárna alertu\nŽádná sledovaná tiskárna není aktuálně offline.\n')
    + (isTest ? '\n(Testovací zpráva spuštěná ručně z Nastavení.)\n' : '')
    + (dashboardUrl ? `\nOtevřít ITDashboard: ${dashboardUrl}\n` : '')
    + `Vygenerováno: ${generated}\n`;

  const headerBg = has ? '#dc2626' : '#16a34a';
  const headerSub = has ? '#fde2e2' : '#dcfce7';
  const headerTitle = has ? '🖨 Tiskárny offline' : '✅ Tiskárny v pořádku';
  const headerLine = has
    ? `${down.length} tiskárna(tiskáren) je offline`
    : 'Žádná sledovaná tiskárna není offline';

  const body = has
    ? down.map((c) => printerCard(c, now)).join('')
    : `<tr><td style="padding:4px 0 12px;font-size:14px;color:#374151;font-family:${FONT}">Všechny sledované tiskárny jsou online. 👍</td></tr>`;

  const testBanner = isTest
    ? `<tr><td style="padding:0 0 14px"><div style="background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:6px;padding:10px 14px;font-size:13px;font-family:${FONT}">ℹ️ Testovací zpráva spuštěná ručně z Nastavení.</div></td></tr>`
    : '';
  const ctaButton = dashboardUrl
    ? `<tr><td style="padding:2px 0 16px"><a href="${escHtml(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:6px;font-family:${FONT}">Otevřít ITDashboard →</a></td></tr>`
    : '';
  const footerAddr = dashboardUrl
    ? `<a href="${escHtml(dashboardUrl)}" style="color:#6b7280;text-decoration:underline">${escHtml(dashboardUrl)}</a> · `
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:collapse">
        <tr><td style="background:${headerBg};border-radius:10px 10px 0 0;padding:18px 20px">
          <div style="font-size:18px;font-weight:700;color:#ffffff;font-family:${FONT}">${prefix}${headerTitle}</div>
          <div style="font-size:13px;color:${headerSub};margin-top:3px;font-family:${FONT}">${headerLine}</div>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${testBanner}
            ${body}
            ${ctaButton}
          </table>
          <div style="margin-top:8px;padding-top:14px;border-top:1px solid #eef0f2;font-size:12px;color:#9ca3af;font-family:${FONT};line-height:1.6">
            ${footerAddr}Vygenerováno ${generated} · ITDashboard automatický report.<br>
            Sledují se zařízení s kategorií „Tiskárna" (záložka Zařízení). Stav, debounce a okno údržby: Nastavení.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

// =====================================================================
// Data-freshness / per-site availability alerting
// =====================================================================
//
// Watches the MikroTik FTP file source. A monitored site (listed in
// mikrotik.ftp_sites, NOT in alerts.freshness.muted_sites) is "stale" when its
// export files stop advancing past alerts.freshness.threshold_minutes, can't be
// fetched at all (last_error), or has never produced data. Timezone-safe — it
// reads file_changed_at (real UTC, moved only when the newest file timestamp
// actually increases), never the router's local file clock. Same debounce /
// throttle / maintenance model as the other agendas; state in
// data_freshness_alert_state. Runs at the end of each MikroTik collect.

export interface StaleSite {
  site: string;
  reason: 'no_data' | 'fetch_error' | 'not_advancing';
  detail: string;
  minutesStale: number | null;
  lastFileTime: Date | null;
  firstStaleAt: Date | null;
  lastSentAt: Date | null;
}

interface SiteStatusRow {
  site: string; file_changed_at: Date | null; lease_file_time: Date | null; arp_file_time: Date | null;
  last_error: string | null; fetched_at: Date | null; mins_since_change: number | null;
  first_stale_at: Date | null; last_sent_at: Date | null;
}

// Monitored = FTP sites minus muted sites. Returns the ones currently stale.
async function loadStaleSites(settings: SettingsMap): Promise<StaleSite[]> {
  const ftpSites = parseList(settings['mikrotik.ftp_sites']).map((s) => s.split('=')[0]!.trim()).filter(Boolean);
  const muted = new Set(parseList(settings['alerts.freshness.muted_sites']).map((s) => s.toLowerCase()));
  const monitored = ftpSites.filter((s) => !muted.has(s.toLowerCase()));
  if (monitored.length === 0) return [];
  const threshold = Number(settings['alerts.freshness.threshold_minutes'] ?? 45) || 45;

  const pool = await getPool();
  const rows = (await pool.request().query<SiteStatusRow>(`
    SELECT s.site, s.file_changed_at, s.lease_file_time, s.arp_file_time, s.last_error, s.fetched_at,
           DATEDIFF(MINUTE, s.file_changed_at, SYSUTCDATETIME()) AS mins_since_change,
           st.first_stale_at, st.last_sent_at
    FROM site_data_status s
    LEFT JOIN data_freshness_alert_state st ON st.site = s.site
  `)).recordset;
  const bySite = new Map(rows.map((r) => [r.site.toLowerCase(), r]));
  const stateOnly = (await pool.request().query<{ site: string; first_stale_at: Date | null; last_sent_at: Date | null }>(
    `SELECT site, first_stale_at, last_sent_at FROM data_freshness_alert_state`)).recordset;
  const stateBySite = new Map(stateOnly.map((r) => [r.site.toLowerCase(), r]));

  const out: StaleSite[] = [];
  for (const site of monitored) {
    const r = bySite.get(site.toLowerCase());
    const st = stateBySite.get(site.toLowerCase());
    if (!r) {
      out.push({ site, reason: 'no_data', detail: 'žádná data z FTP (zatím nestaženo)', minutesStale: null,
        lastFileTime: null, firstStaleAt: st?.first_stale_at ?? null, lastSentAt: st?.last_sent_at ?? null });
      continue;
    }
    const lastFileTime = r.lease_file_time && r.arp_file_time
      ? (r.lease_file_time > r.arp_file_time ? r.lease_file_time : r.arp_file_time)
      : (r.lease_file_time ?? r.arp_file_time ?? null);
    if (r.last_error) {
      out.push({ site, reason: 'fetch_error', detail: `nelze stáhnout soubory: ${r.last_error}`, minutesStale: r.mins_since_change,
        lastFileTime, firstStaleAt: r.first_stale_at, lastSentAt: r.last_sent_at });
    } else if (r.file_changed_at == null || (r.mins_since_change != null && r.mins_since_change > threshold)) {
      out.push({ site, reason: 'not_advancing', detail: `data se neaktualizují${r.mins_since_change != null ? ` ${r.mins_since_change} min` : ''}`,
        minutesStale: r.mins_since_change, lastFileTime, firstStaleAt: r.first_stale_at, lastSentAt: r.last_sent_at });
    }
  }
  return out;
}

// Called at the end of each MikroTik collect. Alerts on sites stale at least
// alerts.freshness.debounce_minutes, suppressed during the maintenance window,
// throttled by frequency_hours. Self-contained; never throws.
export async function evaluateAndSendDataFreshnessAlerts(): Promise<void> {
  const settings = await getAllSettings();
  if (!boolSetting(settings['alerts.freshness.enabled'])) return;

  const pool = await getPool();
  const candidates = await loadStaleSites(settings);
  const candSites = new Set(candidates.map((c) => c.site.toLowerCase()));

  // Recovery: drop state for sites no longer stale so the next outage debounces fresh.
  const existing = await pool.request().query<{ site: string }>(`SELECT site FROM data_freshness_alert_state`);
  for (const s of existing.recordset) {
    if (!candSites.has(s.site.toLowerCase())) {
      await pool.request().input('site', s.site).query(`DELETE FROM data_freshness_alert_state WHERE site = @site`);
    }
  }

  const nowDate = new Date();
  const now = nowDate.getTime();

  // Start the debounce clock for newly-stale sites.
  for (const c of candidates) {
    if (c.firstStaleAt == null) {
      await pool.request().input('site', c.site).input('t', nowDate)
        .query(`IF NOT EXISTS (SELECT 1 FROM data_freshness_alert_state WHERE site=@site)
                INSERT INTO data_freshness_alert_state (site, first_stale_at) VALUES (@site,@t)`);
      c.firstStaleAt = nowDate;
    }
  }

  if (inMaintenanceWindow(settings['alerts.freshness.maintenance_window'], nowDate)) return;

  const debounceMs = (Number(settings['alerts.freshness.debounce_minutes'] ?? 10) || 10) * 60_000;
  const freqMs = (Number(settings['alerts.freshness.frequency_hours'] ?? 24) || 24) * 3_600_000;

  const toAlert = candidates.filter((c) => shouldAlertNow(c.firstStaleAt, c.lastSentAt, now, debounceMs, freqMs));
  if (toAlert.length === 0) return;

  try {
    const recipients = await sendMail(settings, renderFreshnessAlert(toAlert, now, false, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.freshness.recipients');
    for (const a of toAlert) {
      await pool.request().input('site', a.site).input('t', nowDate)
        .query(`UPDATE data_freshness_alert_state SET last_sent_at=@t WHERE site=@site`);
    }
    logActivity('warn', 'alerts', `Data-freshness alert email sent to ${recipients} recipient(s) — ${toAlert.length} site(s) stale`);
  } catch (err) {
    logActivity('error', 'alerts', `Data-freshness alert email failed: ${String(err).split('\n')[0]}`);
  }
}

// Manual test from Settings — sends the current stale-site state regardless of
// enable/debounce/maintenance/throttle.
export async function sendDataFreshnessAlertTest(): Promise<{ recipients: number; stale: number }> {
  const settings = await getAllSettings();
  const candidates = await loadStaleSites(settings);
  const recipients = await sendMail(settings, renderFreshnessAlert(candidates, Date.now(), true, (settings['alerts.dashboard_url'] ?? '').trim()), 'alerts.freshness.recipients');
  logActivity('info', 'alerts', `Data-freshness alert TEST email sent to ${recipients} recipient(s) (${candidates.length} site(s) stale)`);
  return { recipients, stale: candidates.length };
}

function freshnessCard(c: StaleSite): string {
  const badge = c.reason === 'fetch_error' ? '📡 nedostupný' : c.reason === 'no_data' ? '❓ bez dat' : '⏳ stará data';
  const last = c.lastFileTime
    ? `poslední data: ${new Date(c.lastFileTime).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : 'dosud žádná data';
  return `
        <tr><td style="padding:0 0 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:#ffffff;border:1px solid #e5e7eb;border-left:4px solid #dc2626;border-radius:8px">
            <tr><td style="padding:14px 16px">
              <div style="font-size:11px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:.04em;font-family:${FONT}">${badge}</div>
              <div style="font-size:16px;font-weight:700;color:#111827;font-family:${FONT}">${escHtml(c.site)}</div>
              <div style="font-size:13px;color:#6b7280;margin:2px 0 6px;font-family:${FONT}">${escHtml(c.detail)} · ${escHtml(last)}</div>
            </td></tr>
          </table>
        </td></tr>`;
}

export function renderFreshnessAlert(stale: StaleSite[], _now: number, isTest: boolean, dashboardUrl: string): { subject: string; text: string; html: string } {
  const has = stale.length > 0;
  const prefix = subjectPrefix(has, isTest);
  const subject = has
    ? `${prefix}ITDashboard — stará data / nedostupná lokalita (${stale.length})`
    : `${prefix}ITDashboard — test alertu aktuálnosti dat (vše čerstvé)`;

  const generated = new Date().toLocaleString('cs-CZ', {
    timeZone: 'Europe/Prague', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const lines = stale.map((c) => `  • ${c.site} — ${c.detail}`);
  const text = (has
    ? `ITDashboard — stará data / nedostupná lokalita\n${stale.length} lokalit(a) se neaktualizuje:\n\n${lines.join('\n')}\n`
    : 'ITDashboard — test alertu aktuálnosti dat\nVšechny sledované lokality mají čerstvá data.\n')
    + (isTest ? '\n(Testovací zpráva spuštěná ručně z Nastavení.)\n' : '')
    + (dashboardUrl ? `\nOtevřít ITDashboard: ${dashboardUrl}\n` : '')
    + `Vygenerováno: ${generated}\n`;

  const headerBg = has ? '#dc2626' : '#16a34a';
  const headerSub = has ? '#fde2e2' : '#dcfce7';
  const headerTitle = has ? '📡 Stará data / nedostupná lokalita' : '✅ Data jsou čerstvá';
  const headerLine = has ? `${stale.length} sledovaná lokalita(y) se neaktualizuje` : 'Všechny sledované lokality mají čerstvá data';

  const body = has
    ? stale.map(freshnessCard).join('')
    : `<tr><td style="padding:4px 0 12px;font-size:14px;color:#374151;font-family:${FONT}">Všechny sledované lokality dodávají čerstvá data. 👍</td></tr>`;

  const testBanner = isTest
    ? `<tr><td style="padding:0 0 14px"><div style="background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:6px;padding:10px 14px;font-size:13px;font-family:${FONT}">ℹ️ Testovací zpráva spuštěná ručně z Nastavení.</div></td></tr>`
    : '';
  const ctaButton = dashboardUrl
    ? `<tr><td style="padding:2px 0 16px"><a href="${escHtml(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:6px;font-family:${FONT}">Otevřít ITDashboard →</a></td></tr>`
    : '';
  const footerAddr = dashboardUrl
    ? `<a href="${escHtml(dashboardUrl)}" style="color:#6b7280;text-decoration:underline">${escHtml(dashboardUrl)}</a> · `
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:collapse">
        <tr><td style="background:${headerBg};border-radius:10px 10px 0 0;padding:18px 20px">
          <div style="font-size:18px;font-weight:700;color:#ffffff;font-family:${FONT}">${prefix}${headerTitle}</div>
          <div style="font-size:13px;color:${headerSub};margin-top:3px;font-family:${FONT}">${headerLine}</div>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${testBanner}
            ${body}
            ${ctaButton}
          </table>
          <div style="margin-top:8px;padding-top:14px;border-top:1px solid #eef0f2;font-size:12px;color:#9ca3af;font-family:${FONT};line-height:1.6">
            ${footerAddr}Vygenerováno ${generated} · ITDashboard automatický report.<br>
            Sleduje aktuálnost souborů z routerů (FTP). Lokality, práh a výjimky (mute): Nastavení → Notifikace.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
