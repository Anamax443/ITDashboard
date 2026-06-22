import { describe, it, expect } from 'vitest';
import { parseNotebookPatterns, parseSuppressionSignatures } from './faulty-util.js';

describe('parseNotebookPatterns', () => {
  it('wraps a plain fragment as a substring LIKE', () => {
    expect(parseNotebookPatterns('Notebooky')).toEqual(['%Notebooky%']);
  });
  it('splits on commas and newlines, trims, drops empty', () => {
    expect(parseNotebookPatterns(' Notebooky, OU=NTB \n\n')).toEqual(['%Notebooky%', '%OU=NTB%']);
  });
  it('converts * to % and keeps explicit wildcards as-is', () => {
    expect(parseNotebookPatterns('OU=NB*')).toEqual(['OU=NB%']);
  });
  it('empty / null → no patterns (feature inert)', () => {
    expect(parseNotebookPatterns('')).toEqual([]);
    expect(parseNotebookPatterns(null)).toEqual([]);
    expect(parseNotebookPatterns(undefined)).toEqual([]);
  });
});

describe('parseSuppressionSignatures', () => {
  it('provider/eventid', () => {
    expect(parseSuppressionSignatures('NETLOGON/5719')).toEqual([{ provider: 'NETLOGON', eventId: 5719 }]);
  });
  it('eventid only → any provider', () => {
    expect(parseSuppressionSignatures('5719')).toEqual([{ provider: null, eventId: 5719 }]);
  });
  it('provider only → any event id', () => {
    expect(parseSuppressionSignatures('Netwtw*')).toEqual([{ provider: 'Netwtw%', eventId: null }]);
  });
  it('provider/* → provider, any id', () => {
    expect(parseSuppressionSignatures('Netwtw*/*')).toEqual([{ provider: 'Netwtw%', eventId: null }]);
  });
  it('mixed comma/newline list', () => {
    expect(parseSuppressionSignatures('NETLOGON/5719, 1129\nNetwtw*/*')).toEqual([
      { provider: 'NETLOGON', eventId: 5719 },
      { provider: null, eventId: 1129 },
      { provider: 'Netwtw%', eventId: null },
    ]);
  });
  it('drops a non-integer event id', () => {
    expect(parseSuppressionSignatures('Foo/notanumber')).toEqual([]);
  });
  it('drops an all-wildcard token (would suppress everything)', () => {
    expect(parseSuppressionSignatures('*/*')).toEqual([]);
    expect(parseSuppressionSignatures('*')).toEqual([]);
  });
  it('empty / null → no signatures', () => {
    expect(parseSuppressionSignatures('')).toEqual([]);
    expect(parseSuppressionSignatures(null)).toEqual([]);
  });
});
