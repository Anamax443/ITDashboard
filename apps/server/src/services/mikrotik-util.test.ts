import { describe, it, expect } from 'vitest';
import { parseScanRanges, siteForIp, hostsOf, parseCidrOrWildcard } from './mikrotik-util.js';

describe('parseScanRanges', () => {
  it('keeps the Site= label when present', () => {
    const r = parseScanRanges('Zastavka=10.181.3.*');
    expect(r).toHaveLength(1);
    expect(r[0]!.site).toBe('Zastavka');
    expect(r[0]!.prefix).toBe(24);
    expect(r[0]!.exclude).toBe(false);
  });

  it('derives the label from the network when Site= is omitted (the bug source)', () => {
    const r = parseScanRanges('10.181.3.*');
    expect(r[0]!.site).toBe('10.181.3'); // bare range → netLabel, what we now reconcile away
  });

  it('marks "!" and "<>" lines as excludes', () => {
    const r = parseScanRanges('!Zastavka=10.150.181.*\n<>Brno=10.8.9.*');
    expect(r.map((x) => x.exclude)).toEqual([true, true]);
    expect(r[0]!.site).toBe('Zastavka');
  });

  it('splits on commas, semicolons and newlines and skips junk', () => {
    const r = parseScanRanges('Brno=10.8.3.*, Jihlava=10.180.94.*; nonsense\n10.8.*.*');
    expect(r.map((x) => x.site)).toEqual(['Brno', 'Jihlava', '10.8']);
    expect(r[2]!.prefix).toBe(16); // 10.8.*.* = /16
  });
});

describe('siteForIp', () => {
  const ranges = parseScanRanges('Zastavka=10.181.3.*\nBrno=10.8.3.*\n!Zastavka=10.181.3.200/30');

  it('returns the configured label for an IP inside an include range', () => {
    expect(siteForIp('10.181.3.50', ranges)).toBe('Zastavka');
    expect(siteForIp('10.8.3.114', ranges)).toBe('Brno');
  });

  it('reconciles a row stored under the bare netLabel to the real site', () => {
    // the .181.3 row currently stored as site "10.181.3" should become "Zastavka"
    expect(siteForIp('10.181.3.1', ranges)).toBe('Zastavka');
    expect(siteForIp('10.181.3.141', ranges)).not.toBe('10.181.3');
  });

  it('ignores exclude ranges and returns null when no include covers the IP', () => {
    expect(siteForIp('10.99.99.99', ranges)).toBeNull();
    // .203 falls in the /30 EXCLUDE but ALSO in the /24 include → first include wins
    expect(siteForIp('10.181.3.203', ranges)).toBe('Zastavka');
  });

  it('returns null for a non-IP string', () => {
    expect(siteForIp('IP-not-an-ip', ranges)).toBeNull();
  });
});

describe('hostsOf / parseCidrOrWildcard', () => {
  it('enumerates usable hosts of a /24 (skips network + broadcast)', () => {
    const r = parseCidrOrWildcard('10.8.2.*')!;
    const hosts = [...hostsOf({ site: 'x', ...r, exclude: false })];
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('10.8.2.1');
    expect(hosts[253]).toBe('10.8.2.254');
  });

  it('rejects a prefix wider than /16 (typo guard)', () => {
    expect(parseCidrOrWildcard('10.*.*.*')).toBeNull();
    expect(parseCidrOrWildcard('1.2.3.4/8')).toBeNull();
  });
});
