import { describe, it, expect } from 'vitest';
import { parseNetViewPrinters } from './netview-util.js';

// Real captured `net view \\10.90.183.12` output (cs locale) — a USB Brother
// HL-1110 shared from a PC.
const CS = `
Sdílené prostředky na \\10.90.183.12



Název sdílené položky   Typ   Použito jako  Komentář

-------------------------------------------------------------------------------
Brother HL-1110 series  Tisk                HL-1110 series
Příkaz byl úspěšně dokončen.
`;

// A host with a disk share AND a printer share (only the printer should be picked).
const MIXED = `
Share name   Type    Used as  Comment
-------------------------------------------------------------------------------
Data         Disk
HP LaserJet  Print            Office printer
The command completed successfully.
`;

const NO_SHARES = `
Sdílené prostředky na \\10.90.183.6

V seznamu nejsou žádné položky.
`;

describe('parseNetViewPrinters', () => {
  it('extracts a printer share with a multi-word name (cs "Tisk")', () => {
    expect(parseNetViewPrinters(CS)).toEqual([{ name: 'Brother HL-1110 series', comment: 'HL-1110 series' }]);
  });
  it('picks only the printer row, not the disk share (en "Print")', () => {
    expect(parseNetViewPrinters(MIXED)).toEqual([{ name: 'HP LaserJet', comment: 'Office printer' }]);
  });
  it('no shares → empty', () => {
    expect(parseNetViewPrinters(NO_SHARES)).toEqual([]);
    expect(parseNetViewPrinters('')).toEqual([]);
    expect(parseNetViewPrinters(null)).toEqual([]);
  });
});
