import { describe, it, expect } from 'vitest';
import type { DiskItem, ComputerItem } from './api.js';
import {
  isServiceCrash,
  serviceMatchesExceptions,
  serviceWhitelist,
  isServiceWhitelisted,
  parseDriveScope,
  diskInScope,
  parseDiskThresholds,
  evaluateDiskWithScope,
  osBucket,
  isStaleComputer,
  levelName,
  isSnoozeActive,
  isSyntheticMac,
  isRandomMac,
} from './api.js';

// Minimal builders — only the fields the pure functions actually read.
const disk = (drive: string, totalGb: number, freeGb: number): DiskItem =>
  ({ drive_letter: drive, total_bytes: totalGb * 1024 ** 3, free_bytes: freeGb * 1024 ** 3 } as DiskItem);

// ── isServiceCrash — the exit_code null/0 bug we fixed ──────────────────────
describe('isServiceCrash', () => {
  it('treats null and undefined as graceful (not a crash)', () => {
    expect(isServiceCrash(null)).toBe(false);
    expect(isServiceCrash(undefined)).toBe(false);
  });
  it('treats exit code 0 as graceful', () => {
    expect(isServiceCrash(0)).toBe(false);
  });
  it('treats any non-zero exit code as a crash', () => {
    expect(isServiceCrash(1)).toBe(true);
    expect(isServiceCrash(1077)).toBe(true);
    expect(isServiceCrash(-1)).toBe(true);
  });
});

// ── serviceMatchesExceptions — per-PC ignore lists (glob) ───────────────────
describe('serviceMatchesExceptions', () => {
  it('empty / null exception list matches nothing', () => {
    expect(serviceMatchesExceptions('NTDS', 'AD DS', '')).toBe(false);
    expect(serviceMatchesExceptions('NTDS', 'AD DS', null)).toBe(false);
    expect(serviceMatchesExceptions('NTDS', 'AD DS', undefined)).toBe(false);
  });
  it('matches an exact service name (case-insensitive)', () => {
    expect(serviceMatchesExceptions('NTDS', null, 'NTDS')).toBe(true);
    expect(serviceMatchesExceptions('ntds', null, 'NTDS')).toBe(true);
  });
  it('matches within a comma/semicolon/space separated list', () => {
    expect(serviceMatchesExceptions('Kdc', null, 'NTDS,Kdc,DHCPServer')).toBe(true);
    expect(serviceMatchesExceptions('Kdc', null, 'NTDS; Kdc; DHCPServer')).toBe(true);
    expect(serviceMatchesExceptions('DNS', null, 'NTDS,Kdc')).toBe(false);
  });
  it('matches against the display name too (patterns are whitespace-split, so use a wildcard, not spaces)', () => {
    expect(serviceMatchesExceptions('svc1', 'Active Directory Domain Services', '*Directory*')).toBe(true);
    // A space-separated multi-word pattern splits into separate tokens and won't
    // match a phrase — documents the parser's behaviour intentionally.
    expect(serviceMatchesExceptions('svc1', 'Active Directory Domain Services', 'Active Directory*')).toBe(false);
  });
  it('honours * and ? wildcards', () => {
    expect(serviceMatchesExceptions('GoogleUpdaterService150.0', null, 'GoogleUpdater*')).toBe(true);
    expect(serviceMatchesExceptions('svcA', null, 'svc?')).toBe(true);
    expect(serviceMatchesExceptions('svcAB', null, 'svc?')).toBe(false);
  });
});

// ── whitelist ───────────────────────────────────────────────────────────────
describe('service whitelist', () => {
  const wl = serviceWhitelist({ 'alerts.services.whitelist': 'gupdate*, edgeupdate, Google*' });
  it('matches whitelisted patterns', () => {
    expect(isServiceWhitelisted('gupdatem', null, wl)).toBe(true);
    expect(isServiceWhitelisted('GoogleUpdaterService', null, wl)).toBe(true);
    expect(isServiceWhitelisted('edgeupdate', null, wl)).toBe(true);
  });
  it('does not match non-whitelisted names', () => {
    expect(isServiceWhitelisted('NTDS', null, wl)).toBe(false);
  });
  it('empty whitelist matches nothing', () => {
    expect(isServiceWhitelisted('anything', null, [])).toBe(false);
  });
});

// ── parseDriveScope ─────────────────────────────────────────────────────────
describe('parseDriveScope', () => {
  const fallback = { kind: 'include', letters: new Set(['C']) } as const;
  it('empty / star / null → all (or fallback for null)', () => {
    expect(parseDriveScope('', fallback)).toEqual({ kind: 'all' });
    expect(parseDriveScope('*', fallback)).toEqual({ kind: 'all' });
    expect(parseDriveScope(undefined, fallback)).toBe(fallback);
  });
  it('include list, case + colon insensitive', () => {
    const s = parseDriveScope('c, D:', fallback);
    expect(s.kind).toBe('include');
    expect([...(s as { letters: Set<string> }).letters].sort()).toEqual(['C', 'D']);
  });
  it('exclude syntax <> and !', () => {
    expect(parseDriveScope('<>C', fallback)).toEqual({ kind: 'exclude', letters: new Set(['C']) });
    expect(parseDriveScope('!C,D', fallback)).toEqual({ kind: 'exclude', letters: new Set(['C', 'D']) });
  });
  it('no valid letters → fallback', () => {
    expect(parseDriveScope('123', fallback)).toBe(fallback);
  });
});

describe('diskInScope', () => {
  it('all includes every drive', () => {
    expect(diskInScope(disk('C:', 100, 50), { kind: 'all' })).toBe(true);
  });
  it('include only listed letters', () => {
    const scope = { kind: 'include', letters: new Set(['C']) } as const;
    expect(diskInScope(disk('C:', 100, 50), scope)).toBe(true);
    expect(diskInScope(disk('D:', 100, 50), scope)).toBe(false);
  });
  it('exclude everything but listed letters', () => {
    const scope = { kind: 'exclude', letters: new Set(['C']) } as const;
    expect(diskInScope(disk('C:', 100, 50), scope)).toBe(false);
    expect(diskInScope(disk('D:', 100, 50), scope)).toBe(true);
  });
});

// ── thresholds + evaluation ─────────────────────────────────────────────────
describe('parseDiskThresholds', () => {
  it('applies defaults when settings are absent', () => {
    const t = parseDiskThresholds({});
    expect(t.criticalPct).toBe(5);
    expect(t.warningPct).toBe(15);
    expect(t.criticalGb).toBe(5);
    expect(t.warningGb).toBe(20);
    expect(t.mode).toBe('pct');
    expect(t.critScope).toEqual({ kind: 'include', letters: new Set(['C']) });
  });
  it('per-tier scope overrides the legacy default', () => {
    const t = parseDiskThresholds({ 'disk.crit_drives': 'C', 'disk.warn_drives': '<>C' });
    expect(t.critScope).toEqual({ kind: 'include', letters: new Set(['C']) });
    expect(t.warnScope).toEqual({ kind: 'exclude', letters: new Set(['C']) });
  });
});

describe('evaluateDiskWithScope', () => {
  const t = parseDiskThresholds({ 'disk.crit_drives': 'C', 'disk.warn_drives': '*' });
  it('critical when C is below the critical % and in crit scope', () => {
    expect(evaluateDiskWithScope(disk('C:', 100, 3), t)).toBe('critical'); // 3% free
  });
  it('warning when below warning % but above critical', () => {
    expect(evaluateDiskWithScope(disk('C:', 100, 10), t)).toBe('warning'); // 10% free
  });
  it('ok when plenty of space', () => {
    expect(evaluateDiskWithScope(disk('C:', 100, 50), t)).toBe('ok');
  });
  it('a low non-C drive is not critical (out of crit scope) but can warn', () => {
    expect(evaluateDiskWithScope(disk('D:', 100, 3), t)).toBe('warning');
  });
  it('zero-size volume is ok (avoids divide-by-zero)', () => {
    expect(evaluateDiskWithScope(disk('C:', 0, 0), t)).toBe('ok');
  });
  it('gb mode: critical on small absolute free space regardless of %', () => {
    const gb = parseDiskThresholds({ 'disk.threshold_mode': 'gb', 'disk.crit_drives': '*' });
    expect(evaluateDiskWithScope(disk('E:', 4000, 3), gb)).toBe('critical'); // 3 GB free, huge disk
  });
});

// ── osBucket ────────────────────────────────────────────────────────────────
describe('osBucket', () => {
  it('buckets Windows Server with year and R2', () => {
    expect(osBucket('Windows Server 2019 Datacenter')).toBe('Windows Server 2019');
    expect(osBucket('Windows Server 2012 R2 Standard')).toBe('Windows Server 2012 R2');
  });
  it('buckets client OSes', () => {
    expect(osBucket('Windows 11 Pro')).toBe('Windows 11');
    expect(osBucket('Windows 10 Enterprise')).toBe('Windows 10');
  });
  it('Unknown for empty, Other for unrecognized', () => {
    expect(osBucket('')).toBe('Unknown');
    expect(osBucket(null)).toBe('Unknown');
    expect(osBucket('Ubuntu 22.04')).toBe('Other');
  });
});

// ── isStaleComputer ─────────────────────────────────────────────────────────
describe('isStaleComputer', () => {
  const mk = (lastSeenDaysAgo: number | null, excluded = false): ComputerItem =>
    ({ excluded, last_seen: lastSeenDaysAgo == null ? null : new Date(Date.now() - lastSeenDaysAgo * 86400000).toISOString() } as ComputerItem);
  it('stale when last seen older than threshold', () => {
    expect(isStaleComputer(mk(100), 90)).toBe(true);
  });
  it('fresh when seen within threshold', () => {
    expect(isStaleComputer(mk(10), 90)).toBe(false);
  });
  it('never seen counts as stale', () => {
    expect(isStaleComputer(mk(null), 90)).toBe(true);
  });
  it('excluded machines are never stale', () => {
    expect(isStaleComputer(mk(100, true), 90)).toBe(false);
  });
});

describe('isSnoozeActive', () => {
  const now = new Date('2026-06-22T12:00:00Z');
  it('future expiry → active', () => {
    expect(isSnoozeActive('2026-06-29T12:00:00Z', now)).toBe(true);
  });
  it('past expiry → returned to standard', () => {
    expect(isSnoozeActive('2026-06-20T12:00:00Z', now)).toBe(false);
  });
  it('exact now is not active (strictly future)', () => {
    expect(isSnoozeActive('2026-06-22T12:00:00Z', now)).toBe(false);
  });
  it('null / undefined / empty → not snoozed', () => {
    expect(isSnoozeActive(null, now)).toBe(false);
    expect(isSnoozeActive(undefined, now)).toBe(false);
    expect(isSnoozeActive('', now)).toBe(false);
  });
  it('invalid date string → not snoozed', () => {
    expect(isSnoozeActive('not-a-date', now)).toBe(false);
  });
});

describe('isSyntheticMac', () => {
  it('"IP-<ip>" key → synthetic', () => {
    expect(isSyntheticMac('IP-10.90.182.250')).toBe(true);
  });
  it('a real MAC → not synthetic', () => {
    expect(isSyntheticMac('94:DD:F8:30:6E:B0')).toBe(false);
  });
  it('null / empty → not synthetic', () => {
    expect(isSyntheticMac(null)).toBe(false);
    expect(isSyntheticMac(undefined)).toBe(false);
    expect(isSyntheticMac('')).toBe(false);
  });
});

describe('isRandomMac', () => {
  it('burned-in vendor MAC (U/L bit clear) → not random', () => {
    expect(isRandomMac('94:DD:F8:30:6E:B0')).toBe(false); // 0x94
    expect(isRandomMac('00:07:4D:11:22:33')).toBe(false); // Zebra OUI, 0x00
    expect(isRandomMac('AC:3F:A4:00:00:01')).toBe(false); // 0xAC (bit1 clear)
  });
  it('locally-administered MAC (U/L bit set) → random', () => {
    // Second hex digit 2 / 6 / A / E = unicast locally-administered = randomized.
    expect(isRandomMac('DA:A1:19:AA:BB:CC')).toBe(true); // 0xDA
    expect(isRandomMac('A6:12:34:56:78:9A')).toBe(true); // 0xA6
    expect(isRandomMac('02:00:00:00:00:01')).toBe(true); // 0x02
    expect(isRandomMac('7e-45-c2-10-20-30')).toBe(true); // hyphen form, 0x7E
  });
  it('synthetic / partial / empty → not random', () => {
    expect(isRandomMac('IP-10.90.182.250')).toBe(false);
    expect(isRandomMac('DA:A1:19')).toBe(false); // partial, no full octet run
    expect(isRandomMac(null)).toBe(false);
    expect(isRandomMac(undefined)).toBe(false);
    expect(isRandomMac('')).toBe(false);
  });
});

// ── levelName ───────────────────────────────────────────────────────────────
describe('levelName', () => {
  it('maps Windows event levels', () => {
    expect(levelName(1)).toBe('crit');
    expect(levelName(2)).toBe('err');
    expect(levelName(3)).toBe('warn');
    expect(levelName(4)).toBe('info');
  });
});
