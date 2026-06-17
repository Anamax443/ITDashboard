import dgram from 'node:dgram';

// Minimal self-contained SNMP v1 client (GET + GETNEXT walk) over UDP/161.
//
// Why hand-rolled instead of a dependency: the rest of the app already speaks to
// devices with zero external libraries (the MikroTik collector hand-rolls its
// REST/ARP/scan), and the only thing we need is to read the standard Printer-MIB
// `prtMarkerSupplies` table. SNMP v1 GET/GETNEXT is a small, stable BER encoding,
// so a ~150-line module avoids a third-party dep on the deploy path and lets us
// unit-test the encode/decode directly.
//
// Scope: SNMP v1, community-based, read-only GET/GETNEXT. No SET, no v3. The BER
// helpers are pure and exported for tests; the network call lives in `snmpGet`.

// --- BER encoding (pure) -----------------------------------------------------

export function encodeLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  let v = n;
  while (v > 0) { out.unshift(v & 0xff); v >>>= 8; }
  return [0x80 | out.length, ...out];
}

export function encodeTLV(tag: number, content: number[]): number[] {
  return [tag, ...encodeLength(content.length), ...content];
}

export function encodeInt(value: number): number[] {
  const bytes: number[] = [];
  if (value === 0) bytes.push(0);
  else {
    let v = value;
    while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
    if (bytes[0]! & 0x80) bytes.unshift(0); // keep it positive
  }
  return encodeTLV(0x02, bytes);
}

export function encodeOID(oid: string): number[] {
  const parts = oid.split('.').map((x) => parseInt(x, 10));
  const body: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]!;
    if (v < 0x80) { body.push(v); continue; }
    const stack: number[] = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    body.push(...stack);
  }
  return encodeTLV(0x06, body);
}

// SNMP request PDU: SEQUENCE { version(0), community, PDU{ reqId, 0, 0, varbinds{ {oid, NULL} } } }
export function buildRequest(community: string, pduTag: number, reqId: number, oid: string): Buffer {
  const varbind = encodeTLV(0x30, [...encodeOID(oid), ...encodeTLV(0x05, [])]);
  const varbindList = encodeTLV(0x30, varbind);
  const pdu = encodeTLV(pduTag, [...encodeInt(reqId), ...encodeInt(0), ...encodeInt(0), ...varbindList]);
  const comm = encodeTLV(0x04, [...Buffer.from(community, 'ascii')]);
  const msg = encodeTLV(0x30, [...encodeInt(0), ...comm, ...pdu]);
  return Buffer.from(msg);
}

// --- BER decoding (pure) -----------------------------------------------------

interface Tlv { tag: number; content: Buffer; }

export function parseTLVs(data: Buffer, start: number, end: number): Tlv[] {
  const items: Tlv[] = [];
  let i = start;
  while (i < end) {
    const tag = data[i++]!;
    let len = data[i++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | data[i++]!;
    }
    items.push({ tag, content: data.subarray(i, i + len) });
    i += len;
  }
  return items;
}

export function decodeOID(b: Buffer): string {
  const parts = [Math.floor(b[0]! / 40), b[0]! % 40];
  let i = 1;
  while (i < b.length) {
    let v = 0;
    let more = 0;
    do { v = (v << 7) | (b[i]! & 0x7f); more = b[i]! & 0x80; i++; } while (more);
    parts.push(v);
  }
  return parts.join('.');
}

export interface SnmpVarbind { oid: string; tag: number; value: string | number; }

// Decode the first varbind of a response message. Returns null on a malformed /
// error PDU (so callers can stop a walk cleanly).
export function decodeResponse(resp: Buffer): SnmpVarbind | null {
  try {
    const top = parseTLVs(resp, 0, resp.length)[0];
    if (!top) return null;
    const l1 = parseTLVs(top.content, 0, top.content.length); // version, community, pdu
    const pdu = l1[2];
    if (!pdu) return null;
    const l2 = parseTLVs(pdu.content, 0, pdu.content.length); // reqId, errStatus, errIndex, varbindList
    const vbl = l2[3];
    if (!vbl) return null;
    const vbs = parseTLVs(vbl.content, 0, vbl.content.length);
    if (!vbs[0]) return null;
    const vb = parseTLVs(vbs[0].content, 0, vbs[0].content.length);
    if (!vb[0] || !vb[1]) return null;
    const oid = decodeOID(vb[0].content);
    const vt = vb[1].tag;
    const vc = vb[1].content;
    let value: string | number;
    if (vt === 0x02) {
      // INTEGER (two's complement)
      let n = 0;
      for (const x of vc) n = n * 256 + x;
      if (vc[0]! & 0x80) n -= 2 ** (8 * vc.length);
      value = n;
    } else if (vt === 0x41 || vt === 0x42 || vt === 0x43 || vt === 0x46) {
      // Counter / Gauge / TimeTicks / Counter64 — unsigned
      let n = 0;
      for (const x of vc) n = n * 256 + x;
      value = n;
    } else if (vt === 0x06) {
      value = decodeOID(vc);
    } else if (vt === 0x05 || vt === 0x80 || vt === 0x81 || vt === 0x82) {
      // NULL / noSuchObject / noSuchInstance / endOfMibView
      value = '';
    } else {
      value = vc.toString('utf8');
    }
    return { oid, tag: vt, value };
  } catch {
    return null;
  }
}

// --- Network ----------------------------------------------------------------

const GET = 0xa0;
const GETNEXT = 0xa1;
const END_OF_MIB = 0x82;

let reqCounter = 1;

function sendOnce(ip: string, msg: Buffer, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (val: Buffer | null) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closed */ }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('message', (buf) => { clearTimeout(timer); finish(buf); });
    sock.on('error', () => { clearTimeout(timer); finish(null); });
    sock.send(msg, 161, ip, (err) => { if (err) { clearTimeout(timer); finish(null); } });
  });
}

// Single GET. Returns the decoded varbind, or null on timeout/no SNMP.
export async function snmpGet(ip: string, oid: string, community = 'public', timeoutMs = 2000): Promise<SnmpVarbind | null> {
  const msg = buildRequest(community, GET, reqCounter++, oid);
  const resp = await sendOnce(ip, msg, timeoutMs);
  return resp ? decodeResponse(resp) : null;
}

// GETNEXT walk of a subtree. Stops at endOfMibView, when the returned OID leaves
// the base subtree, on the first timeout, or at `maxRows` (a runaway guard).
export async function snmpWalk(ip: string, baseOid: string, community = 'public', timeoutMs = 2000, maxRows = 64): Promise<SnmpVarbind[]> {
  const out: SnmpVarbind[] = [];
  let cur = baseOid;
  for (let k = 0; k < maxRows; k++) {
    const msg = buildRequest(community, GETNEXT, reqCounter++, cur);
    const resp = await sendOnce(ip, msg, timeoutMs);
    if (!resp) break;
    const vb = decodeResponse(resp);
    if (!vb) break;
    if (vb.tag === END_OF_MIB || !(vb.oid === baseOid || vb.oid.startsWith(baseOid + '.'))) break;
    out.push(vb);
    cur = vb.oid;
  }
  return out;
}
