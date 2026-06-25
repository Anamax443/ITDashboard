import { describe, it, expect } from 'vitest';
import { parseLeaseDetail, parseArpDetail, parseFileTime } from './mikrotik-ftp.js';

const LEASE = `# 2026-06-25 16:19:04 by RouterOS 7.21.4
# software id =
#
Flags: X - disabled, R - radius, D - dynamic, B - blocked
 0   ;;; kudapw11
     address=10.8.2.174 mac-address=74:56:3C:6E:2B:B6 status=bound
     expires-after=6d16h31m15s last-seen=7h38m45s active-server=dhcp1
     host-name="kudapw11" class-id="MSFT 5.0"

 1 D ;;; phone
     address=10.8.2.50 mac-address=AA:BB:CC:DD:EE:FF status=bound host-name="iphone"
`;

// ARP detail wraps long lines at ~72 chars — status/vrf land on a second line.
const ARP = `# 2026-06-25 16:19:04 by RouterOS 7.21.4
#
Flags: X - disabled, I - invalid, H - dhcp, D - dynamic, P - published; C - complete
 0 D  address=10.8.2.162 mac-address=B4:2E:99:B7:1A:12 interface=ether1
      published=no status="failed" vrf=main
 1 DC address=10.8.2.119 mac-address=9C:AE:D3:B1:F6:D8 interface=ether1
      published=no status="stale" vrf=main
 2 DC address=10.8.2.84 mac-address=D8:BB:C1:CD:26:5F interface=ether1
      published=no status="reachable" vrf=main
`;

describe('parseFileTime', () => {
  it('reads the header timestamp', () => {
    expect(parseFileTime(LEASE)?.toISOString()).toBe('2026-06-25T16:19:04.000Z');
    expect(parseFileTime('no header here')).toBeNull();
  });
});

describe('parseLeaseDetail', () => {
  const out = parseLeaseDetail(LEASE);
  it('parses every lease with its MAC + name', () => {
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ mac: '74:56:3C:6E:2B:B6', ip: '10.8.2.174', host: 'kudapw11', status: 'bound' });
  });
  it('reads the D flag as dynamic', () => {
    expect(out[0]!.dynamic).toBe(false);   // no flag → static reservation
    expect(out[1]!.dynamic).toBe(true);    // "1 D" → dynamic
  });
});

describe('parseArpDetail', () => {
  const out = parseArpDetail(ARP);
  it('keeps only complete (C) entries and joins wrapped lines for status', () => {
    expect(out.map((d) => d.ip)).toEqual(['10.8.2.119', '10.8.2.84']); // 10.8.2.162 (failed, no C) dropped
    expect(out[0]).toMatchObject({ mac: '9C:AE:D3:B1:F6:D8', status: 'stale' }); // status from the wrapped line
    expect(out[1]!.status).toBe('reachable');
  });
});
