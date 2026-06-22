import { describe, it, expect } from 'vitest';
import { parseNbtstat } from './netbios-util.js';

// Real captured `nbtstat -A` output (Brother 2802DW printer at 10.90.182.5).
const BROTHER = `
Ethernet:
Node IpAddress: [10.8.2.181] Scope Id: []

           NetBIOS Remote Machine Name Table

       Name               Type         Status
    ---------------------------------------------
    BRN94DDF8306EB0<00>  UNIQUE      Registered
    BRN94DDF8306EB0<20>  UNIQUE      Registered

    MAC Address = 94-DD-F8-30-6E-B0
`;

// Real captured output (Windows PC JIHLAVA6W11 at 10.90.183.8).
const PC = `
       Name               Type         Status
    ---------------------------------------------
    JIHLAVA6W11    <20>  UNIQUE      Registered
    JIHLAVA6W11    <00>  UNIQUE      Registered
    AXINETWORK     <00>  GROUP       Registered

    MAC Address = 2C-58-B9-34-AB-46
`;

describe('parseNbtstat', () => {
  it('extracts name (<00> entry) and normalizes MAC to colon/upper', () => {
    expect(parseNbtstat(BROTHER)).toEqual({ name: 'BRN94DDF8306EB0', mac: '94:DD:F8:30:6E:B0' });
  });
  it('picks the machine <00> name over a GROUP entry, and the MAC', () => {
    expect(parseNbtstat(PC)).toEqual({ name: 'JIHLAVA6W11', mac: '2C:58:B9:34:AB:46' });
  });
  it('accepts a colon-separated MAC unchanged', () => {
    expect(parseNbtstat('X <00> UNIQUE\nMAC Address = aa:bb:cc:dd:ee:ff').mac).toBe('AA:BB:CC:DD:EE:FF');
  });
  it('ignores the all-zero (no-MAC adapter) address', () => {
    expect(parseNbtstat('Host not found.\nMAC Address = 00-00-00-00-00-00')).toEqual({ name: null, mac: null });
  });
  it('host not found → both null', () => {
    expect(parseNbtstat('    Host not found.')).toEqual({ name: null, mac: null });
    expect(parseNbtstat('')).toEqual({ name: null, mac: null });
    expect(parseNbtstat(null)).toEqual({ name: null, mac: null });
  });
});
