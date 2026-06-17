import { describe, it, expect } from 'vitest';
import { encodeLength, encodeInt, encodeOID, buildRequest, parseTLVs, decodeOID, decodeResponse } from './snmp.js';

describe('SNMP BER encoding', () => {
  it('encodeLength: short form < 128', () => {
    expect(encodeLength(0)).toEqual([0]);
    expect(encodeLength(127)).toEqual([127]);
  });
  it('encodeLength: long form >= 128', () => {
    expect(encodeLength(128)).toEqual([0x81, 128]);
    expect(encodeLength(300)).toEqual([0x82, 0x01, 0x2c]);
  });
  it('encodeInt: minimal two-complement-safe bytes', () => {
    expect(encodeInt(0)).toEqual([0x02, 0x01, 0x00]);
    expect(encodeInt(300)).toEqual([0x02, 0x02, 0x01, 0x2c]);
    // high bit set → leading 0 to stay positive
    expect(encodeInt(200)).toEqual([0x02, 0x02, 0x00, 0xc8]);
  });
  it('encodeOID: first two arcs fold into one byte', () => {
    // 1.3.6.1.2.1.1.1.0  →  tag 0x06, len 8, 0x2b 06 01 02 01 01 01 00
    expect(encodeOID('1.3.6.1.2.1.1.1.0')).toEqual([0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]);
  });
  it('encodeOID: multi-byte subidentifier (base-128)', () => {
    // arc 2435 (Brother enterprise) = 0x983 → 0x93 0x03 with continuation bit
    const enc = encodeOID('1.3.6.1.4.1.2435');
    const tlv = parseTLVs(Buffer.from(enc), 0, enc.length)[0]!;
    expect(decodeOID(tlv.content)).toBe('1.3.6.1.4.1.2435');
  });
});

describe('SNMP BER decoding', () => {
  it('decodeOID round-trips a Printer-MIB supply OID', () => {
    const oid = '1.3.6.1.2.1.43.11.1.1.9.1.1';
    const enc = encodeOID(oid);
    const tlv = parseTLVs(Buffer.from(enc), 0, enc.length)[0]!;
    expect(decodeOID(tlv.content)).toBe(oid);
  });
  it('decodeResponse parses a well-formed PDU (GET request shape) back to its varbind', () => {
    // A GET request and a response share the SEQUENCE{version,community,PDU{...}}
    // shape, so decoding our own request exercises the full parse path.
    const msg = buildRequest('public', 0xa0, 42, '1.3.6.1.2.1.1.1.0');
    const vb = decodeResponse(msg);
    expect(vb).not.toBeNull();
    expect(vb!.oid).toBe('1.3.6.1.2.1.1.1.0');
    expect(vb!.tag).toBe(0x05); // NULL placeholder value
  });
  it('decodeResponse returns null on garbage', () => {
    expect(decodeResponse(Buffer.from([0x30, 0x01, 0x00]))).toBeNull();
  });
});
