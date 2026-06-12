// Pure, dependency-free helpers shared by the alerting/reporting code. Kept in a
// separate module (no db/pool, nodemailer or settings imports) so they can be
// unit-tested without loading the native MSSQL driver. alerts.ts re-exports the
// public ones for backward compatibility.

export type DriveScope =
  | { kind: 'all' }
  | { kind: 'include'; letters: Set<string> }
  | { kind: 'exclude'; letters: Set<string> };

// Mirrors apps/desktop/src/api.ts parseDriveScope so the email evaluation and
// the dashboard agree on which drives count as critical.
export function parseDriveScope(raw: string | undefined, fallback: DriveScope): DriveScope {
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

export function driveLetterOf(drive: string): string {
  return (drive ?? '').toUpperCase().replace(/:$/, '').slice(0, 1);
}

export function inScope(letter: string, scope: DriveScope): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'include') return scope.letters.has(letter);
  return !scope.letters.has(letter);
}

export function boolSetting(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
}

export function parseRecipients(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

export function parseList(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

export function globToRegExp(pattern: string): RegExp {
  const re = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(re, 'i');
}

export function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(name));
}

// True when `now` (server local time) falls inside an "HH:MM-HH:MM" maintenance
// window. Supports a window that crosses midnight (e.g. 22:00-04:00).
export function inMaintenanceWindow(raw: string | undefined, now: Date): boolean {
  const m = (raw ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

export function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

// Machine-readable subject prefix so a mail rule can auto-file reports:
//   [OK] / [CHYBA]  = does this mail carry a problem? (filter target)
//   [RUČNĚ]         = manually triggered (test / on-demand), absent = automatic
// Always leads the subject, e.g. "[OK] [RUČNĚ] ITDashboard — …".
export function subjectPrefix(hasProblems: boolean, manual: boolean): string {
  return `${hasProblems ? '[CHYBA]' : '[OK]'}${manual ? ' [RUČNĚ]' : ''} `;
}

// Should an alert fire now for a problem that started at `firstDownAt` and was
// last emailed at `lastSentAt`? Fires only after the debounce window has elapsed
// (flapping guard) and not more often than the throttle interval. `firstDownAt`
// null = just recorded → still within debounce.
export function shouldAlertNow(
  firstDownAt: Date | null,
  lastSentAt: Date | null,
  now: number,
  debounceMs: number,
  freqMs: number,
): boolean {
  if (firstDownAt == null) return false;
  if (now - firstDownAt.getTime() < debounceMs) return false; // still within debounce
  if (lastSentAt && now - lastSentAt.getTime() < freqMs) return false; // throttled
  return true;
}
