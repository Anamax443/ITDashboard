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
  drive_letter: string;
  volume_label: string | null;
  total_bytes: number;
  free_bytes: number;
}

// Evaluate the disks of all disk_email_monitor PCs against the CRITICAL
// threshold + critical drive-letter scope (same rules as the dashboard).
async function loadMonitoredCriticalDisks(settings: SettingsMap): Promise<MonitoredCriticalDisk[]> {
  const pool = await getPool();
  const r = await pool.request().query<DiskRow>(`
    SELECT c.name AS computer, d.drive_letter, d.volume_label, d.total_bytes, d.free_bytes
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

  const out: MonitoredCriticalDisk[] = [];
  for (const d of r.recordset) {
    if (d.total_bytes <= 0) continue;
    const freePct = (d.free_bytes / d.total_bytes) * 100;
    const freeGb = d.free_bytes / 1024 ** 3;
    const pctCrit = freePct < critPct;
    const gbCrit = freeGb < critGb;
    const isCrit = mode === 'pct' ? pctCrit : mode === 'gb' ? gbCrit : (pctCrit || gbCrit);
    if (isCrit && inScope(driveLetterOf(d.drive_letter), critScope)) {
      out.push({
        computer: d.computer,
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

function renderDiskAlert(critical: MonitoredCriticalDisk[], isTest: boolean): { subject: string; text: string; html: string } {
  const pcs = new Set(critical.map((c) => c.computer)).size;
  const prefix = isTest ? '[TEST] ' : '';
  const subject = critical.length > 0
    ? `${prefix}ITDashboard — kritický stav disků (${critical.length} na ${pcs} PC)`
    : `${prefix}ITDashboard — test disk alertu (žádný kritický disk)`;

  const lines = critical.map((c) =>
    `  ${c.computer}  ${c.driveLetter}${c.volumeLabel ? ` (${c.volumeLabel})` : ''}  —  ${fmtGb(c.freeBytes)} volných z ${fmtGb(c.totalBytes)} (${c.freePct.toFixed(1)} %)`,
  );
  const text = (critical.length > 0
    ? `Sledované disky pod kritickým prahem:\n\n${lines.join('\n')}\n`
    : 'Žádný sledovaný disk není aktuálně v kritickém stavu.\n')
    + (isTest ? '\n(Toto je testovací zpráva spuštěná ručně z Nastavení.)\n' : '');

  const rows = critical.map((c) =>
    `<tr><td style="padding:4px 10px">${c.computer}</td><td style="padding:4px 10px">${c.driveLetter}${c.volumeLabel ? ` <span style="color:#888">(${c.volumeLabel})</span>` : ''}</td><td style="padding:4px 10px;text-align:right">${fmtGb(c.freeBytes)}</td><td style="padding:4px 10px;text-align:right">${fmtGb(c.totalBytes)}</td><td style="padding:4px 10px;text-align:right;color:#c0392b;font-weight:600">${c.freePct.toFixed(1)} %</td></tr>`,
  ).join('');
  const html = `<div style="font-family:Segoe UI,system-ui,sans-serif;font-size:14px;color:#222">
    <h2 style="margin:0 0 8px">${prefix}ITDashboard — kritický stav disků</h2>
    ${critical.length > 0
      ? `<table style="border-collapse:collapse;border:1px solid #ddd">
           <tr style="background:#f5f5f5"><th style="padding:4px 10px;text-align:left">PC</th><th style="padding:4px 10px;text-align:left">Disk</th><th style="padding:4px 10px;text-align:right">Volné</th><th style="padding:4px 10px;text-align:right">Celkem</th><th style="padding:4px 10px;text-align:right">% volných</th></tr>
           ${rows}
         </table>`
      : '<p>Žádný sledovaný disk není aktuálně v kritickém stavu.</p>'}
    ${isTest ? '<p style="color:#888;margin-top:12px">Toto je testovací zpráva spuštěná ručně z Nastavení.</p>' : ''}
  </div>`;

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
    const recipients = await sendMail(settings, renderDiskAlert(critical, false));
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
  const recipients = await sendMail(settings, renderDiskAlert(critical, true));
  const pcs = new Set(critical.map((c) => c.computer)).size;
  logActivity('info', 'alerts', `Disk alert TEST email sent to ${recipients} recipient(s) (${critical.length} critical drive(s))`);
  return { recipients, critical: critical.length, monitoredPcs: pcs };
}
