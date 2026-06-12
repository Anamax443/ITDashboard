import { describe, it, expect } from 'vitest';
import {
  subjectPrefix,
  parseRecipients,
  parseList,
  globToRegExp,
  matchesAny,
  inMaintenanceWindow,
  shouldAlertNow,
  parseDriveScope,
  inScope,
  driveLetterOf,
  boolSetting,
  fmtDuration,
  type DriveScope,
} from './alerts-util.js';

// ── subjectPrefix — the machine-readable [OK]/[CHYBA]/[RUČNĚ] markers ────────
describe('subjectPrefix', () => {
  it('automatic, no problem → [OK]', () => {
    expect(subjectPrefix(false, false)).toBe('[OK] ');
  });
  it('automatic, problem → [CHYBA]', () => {
    expect(subjectPrefix(true, false)).toBe('[CHYBA] ');
  });
  it('manual adds [RUČNĚ]', () => {
    expect(subjectPrefix(false, true)).toBe('[OK] [RUČNĚ] ');
    expect(subjectPrefix(true, true)).toBe('[CHYBA] [RUČNĚ] ');
  });
});

// ── recipient / list parsing ────────────────────────────────────────────────
describe('parseRecipients / parseList', () => {
  it('splits on commas, semicolons, whitespace and newlines', () => {
    expect(parseRecipients('a@x.cz, b@x.cz;c@x.cz\n d@x.cz')).toEqual(['a@x.cz', 'b@x.cz', 'c@x.cz', 'd@x.cz']);
  });
  it('empty / null → empty array', () => {
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseList('  ')).toEqual([]);
  });
});

// ── glob matching ───────────────────────────────────────────────────────────
describe('globToRegExp / matchesAny', () => {
  it('* and ? wildcards, case-insensitive, anchored', () => {
    expect(globToRegExp('NTDS').test('ntds')).toBe(true);
    expect(globToRegExp('Google*').test('GoogleUpdaterService')).toBe(true);
    expect(globToRegExp('svc?').test('svcA')).toBe(true);
    expect(globToRegExp('svc?').test('svcAB')).toBe(false);
    expect(globToRegExp('DNS').test('DNSCache')).toBe(false); // anchored, no partial
  });
  it('matchesAny across a pattern list', () => {
    const pats = parseList('NTDS,Kdc,Google*').map(globToRegExp);
    expect(matchesAny('Kdc', pats)).toBe(true);
    expect(matchesAny('GoogleUpdater', pats)).toBe(true);
    expect(matchesAny('DNS', pats)).toBe(false);
  });
});

// ── maintenance window ──────────────────────────────────────────────────────
describe('inMaintenanceWindow', () => {
  const at = (h: number, m = 0) => { const d = new Date(2026, 0, 1, h, m); return d; };
  it('inside a normal daytime window', () => {
    expect(inMaintenanceWindow('09:00-17:00', at(12))).toBe(true);
    expect(inMaintenanceWindow('09:00-17:00', at(8))).toBe(false);
    expect(inMaintenanceWindow('09:00-17:00', at(17))).toBe(false); // end exclusive
  });
  it('window crossing midnight', () => {
    expect(inMaintenanceWindow('22:00-04:00', at(23))).toBe(true);
    expect(inMaintenanceWindow('22:00-04:00', at(2))).toBe(true);
    expect(inMaintenanceWindow('22:00-04:00', at(12))).toBe(false);
  });
  it('empty / malformed / zero-length → never suppressed', () => {
    expect(inMaintenanceWindow('', at(12))).toBe(false);
    expect(inMaintenanceWindow('nonsense', at(12))).toBe(false);
    expect(inMaintenanceWindow('10:00-10:00', at(10))).toBe(false);
  });
});

// ── debounce / throttle decision ────────────────────────────────────────────
describe('shouldAlertNow', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const ago = (ms: number) => new Date(now - ms);
  const DEB = 10 * 60_000;   // 10 min debounce
  const FRQ = 24 * 3_600_000; // 24 h throttle

  it('does not fire while still inside debounce', () => {
    expect(shouldAlertNow(ago(5 * 60_000), null, now, DEB, FRQ)).toBe(false);
  });
  it('fires once debounce elapsed and never sent', () => {
    expect(shouldAlertNow(ago(15 * 60_000), null, now, DEB, FRQ)).toBe(true);
  });
  it('throttled when last sent within the frequency window', () => {
    expect(shouldAlertNow(ago(60 * 60_000), ago(60_000), now, DEB, FRQ)).toBe(false);
  });
  it('fires again once the throttle window has passed', () => {
    expect(shouldAlertNow(ago(48 * 3_600_000), ago(25 * 3_600_000), now, DEB, FRQ)).toBe(true);
  });
  it('null firstDownAt (just recorded) does not fire', () => {
    expect(shouldAlertNow(null, null, now, DEB, FRQ)).toBe(false);
  });
});

// ── drive scope (server copy, mirrors desktop) ──────────────────────────────
describe('parseDriveScope / inScope (server)', () => {
  const fb: DriveScope = { kind: 'include', letters: new Set(['C']) };
  it('all / include / exclude', () => {
    expect(parseDriveScope('', fb)).toEqual({ kind: 'all' });
    expect(parseDriveScope('C,D', fb)).toEqual({ kind: 'include', letters: new Set(['C', 'D']) });
    expect(parseDriveScope('<>C', fb)).toEqual({ kind: 'exclude', letters: new Set(['C']) });
  });
  it('inScope honours include and exclude', () => {
    expect(inScope('C', { kind: 'include', letters: new Set(['C']) })).toBe(true);
    expect(inScope('D', { kind: 'include', letters: new Set(['C']) })).toBe(false);
    expect(inScope('D', { kind: 'exclude', letters: new Set(['C']) })).toBe(true);
    expect(inScope('X', { kind: 'all' })).toBe(true);
  });
  it('driveLetterOf normalizes', () => {
    expect(driveLetterOf('c:')).toBe('C');
    expect(driveLetterOf('D:\\')).toBe('D');
  });
});

// ── misc ────────────────────────────────────────────────────────────────────
describe('boolSetting / fmtDuration', () => {
  it('boolSetting accepts common truthy strings', () => {
    for (const v of ['1', 'true', 'YES', 'on']) expect(boolSetting(v)).toBe(true);
    for (const v of ['0', 'false', '', undefined]) expect(boolSetting(v)).toBe(false);
  });
  it('fmtDuration formats minutes and hours', () => {
    expect(fmtDuration(5 * 60_000)).toBe('5 min');
    expect(fmtDuration(60 * 60_000)).toBe('1 h');
    expect(fmtDuration(90 * 60_000)).toBe('1 h 30 min');
    expect(fmtDuration(-100)).toBe('0 min');
  });
});
