import { describe, it, expect } from 'vitest';
import {
  classifyDescription, extractPartCode, computeLevelPct, colorKey,
  parseBrotherToner, parseEpsonMaint, parseEpsonInks,
} from './printer-supplies-http.js';

describe('classifyDescription', () => {
  it('maps colour cartridges', () => {
    expect(classifyDescription('Black Toner Cartridge HP CE505X')).toEqual({ key: 'K', colorant: 'black', type: 'toner' });
    expect(classifyDescription('Cyan Ink Cartridge T13W2')).toEqual({ key: 'C', colorant: 'cyan', type: 'ink' });
    expect(classifyDescription('Magenta Toner')).toMatchObject({ key: 'M', colorant: 'magenta' });
    expect(classifyDescription('Yellow Ink')).toMatchObject({ key: 'Y', type: 'ink' });
  });
  it('maps non-colour components', () => {
    expect(classifyDescription('Waste Toner Box').key).toBe('MAINT');
    expect(classifyDescription('Belt Unit').key).toBe('BELT');
    expect(classifyDescription('Drum Unit').key).toBe('DRUM');
    expect(classifyDescription('something odd').key).toBe('OTHER');
  });
});

describe('extractPartCode', () => {
  it('pulls HP / Epson / Brother order codes', () => {
    expect(extractPartCode('Black Cartridge HP CE505X')).toBe('CE505X');
    expect(extractPartCode('Black Ink Cartridge T13W1/T13X1/T14B1')).toBe('T13W1/T13X1/T14B1');
    expect(extractPartCode('Cyan Cartridge HP CE411A')).toBe('CE411A');
    expect(extractPartCode('plain description')).toBeNull();
  });
});

describe('computeLevelPct', () => {
  it('computes % from level/max', () => {
    expect(computeLevelPct(82786, 100000)).toBe(83);
    expect(computeLevelPct(99, 100)).toBe(99);
  });
  it('returns null for sentinels / bad max', () => {
    expect(computeLevelPct(-3, -2)).toBeNull(); // Brother "some remaining"
    expect(computeLevelPct(50, 0)).toBeNull();
    expect(computeLevelPct(null, 100)).toBeNull();
  });
});

describe('colorKey', () => {
  it('normalizes colour words / letters', () => {
    expect(colorKey('BK')).toMatchObject({ key: 'K' });
    expect(colorKey('Yellow')).toMatchObject({ key: 'Y' });
    expect(colorKey('odpad')).toMatchObject({ key: 'MAINT' });
    expect(colorKey('nonsense')).toBeNull();
  });
});

describe('parseBrotherToner', () => {
  it('reads tonerremain image heights (full ≈ 50px)', () => {
    const html = `<img src="../common/images/black.gif" alt="Black" class="tonerremain" height="39" />`
      + `<img src="../common/images/cyan.gif" alt="Cyan" class="tonerremain" height="50" />`;
    expect(parseBrotherToner(html)).toEqual([
      { key: 'K', colorant: 'black', type: 'toner', pct: 78 },
      { key: 'C', colorant: 'cyan', type: 'toner', pct: 100 },
    ]);
  });
});

describe('parseEpsonMaint', () => {
  it('reads the olive maintenance gradient', () => {
    expect(parseEpsonMaint(`background:linear-gradient(to right, #636311 0%, #636311 85%, #BFC2C5 86%)`)).toBe(85);
  });
  it('reads the Ink_Waste image height', () => {
    expect(parseEpsonMaint(`src='../../IMAGE/Ink_Waste.PNG' height='25'`)).toBe(50);
  });
  it('returns null when absent', () => {
    expect(parseEpsonMaint('<html>no maint here</html>')).toBeNull();
  });
});

describe('parseEpsonInks', () => {
  it('gradient variant: names + trailing maintenance box', () => {
    const html = `<div class='clrname'>BK</div>`
      + `<div class='tank_sideways' style='background:linear-gradient(to right, #000000 0%, #000000 96%, #BFC2C5 97%);'></div>`
      + `<div class='mbicn'><img src='../../IMAGE/Icn_Mb.PNG'></div>`
      + `<div class='tank_sideways' style='background:linear-gradient(to right, #636311 0%, #636311 85%, #BFC2C5 86%);'></div>`;
    expect(parseEpsonInks(html)).toEqual([
      { key: 'K', colorant: 'black', type: 'ink', pct: 96 },
      { key: 'MAINT', colorant: 'none', type: 'maintenance', pct: 85 },
    ]);
  });
  it('image-height variant', () => {
    const html = `<img class='color' src='../../IMAGE/Ink_K.PNG' height='40'><img class='color' src='../../IMAGE/Ink_Y.PNG' height='48'>`;
    expect(parseEpsonInks(html)).toEqual([
      { key: 'K', colorant: 'black', type: 'ink', pct: 80 },
      { key: 'Y', colorant: 'yellow', type: 'ink', pct: 96 },
    ]);
  });
});
