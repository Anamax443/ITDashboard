import nodemailer from 'nodemailer';
import { getPool } from '../db/pool.js';
import { getAllSettings, setSetting, type SettingsMap } from './settings.js';
import { logActivity } from './activity-log.js';

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

type DriveScope =
  | { kind: 'all' }
  | { kind: 'include'; letters: Set<string> }
  | { kind: 'exclude'; letters: Set<string> };

// Mirrors apps/desktop/src/api.ts parseDriveScope so the email evaluation and
// the dashboard agree on which drives count as critical.
function parseDriveScope(raw: string | undefined, fallback: DriveScope): DriveScope {
  if (raw == null) return fallback;
  let trimmed = raw.trim();
  if (trimmed === '' || trimmed === '*') return { kind: 'all' };
  let exclude = false;
  if (trimmed.startsWith('<>')) { exclude = true; trimmed = trimmed.slice(2).trim(); }
  else if (trimmed.startsWith('!')) { exclude = true; trimmed = trimmed.slice(1).trim(); }
  const letters = trimmed
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase().replace(/:$/, '').slice(0, 1))
    .filter((s) => /^[A-Z]$/.test(s));
  if (letters.length === 0) return fallback;
  return exclude
    ? { kind: 'exclude', letters: new Set(letters) }
    : { kind: 'include', letters: new Set(letters) };
}

function driveLetterOf(drive: string): string {
  return (drive ?? '').toUpperCase().replace(/:$/, '').slice(0, 1);
}

function inScope(letter: string, scope: DriveScope): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'include') return scope.letters.has(letter);
  return !scope.letters.has(letter);
}

function boolSetting(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
}

function parseRecipients(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
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

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

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
  const prefix = isTest ? '[TEST] ' : '';
  const has = critical.length > 0;
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

async function sendMail(settings: SettingsMap, payload: { subject: string; text: string; html: string }): Promise<number> {
  const from = (settings['alerts.smtp_from'] ?? '').trim();
  const to = parseRecipients(settings['alerts.recipients']);
  if (!from) throw new Error('alerts.smtp_from not configured');
  if (to.length === 0) throw new Error('alerts.recipients is empty');
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
    const recipients = await sendMail(settings, renderDiskAlert(critical, false, (settings['alerts.dashboard_url'] ?? '').trim()));
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
  const recipients = await sendMail(settings, renderDiskAlert(critical, true, (settings['alerts.dashboard_url'] ?? '').trim()));
  const pcs = new Set(critical.map((c) => c.computer)).size;
  logActivity('info', 'alerts', `Disk alert TEST email sent to ${recipients} recipient(s) (${critical.length} critical drive(s))`);
  return { recipients, critical: critical.length, monitoredPcs: pcs };
}
