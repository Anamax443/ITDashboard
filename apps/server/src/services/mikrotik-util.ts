// Pure IP / scan-range helpers for the MikroTik device collector. Kept free of
// any DB / native-driver imports so they can be unit-tested in isolation (the
// collector itself pulls in the mssql pool + mailer and can't load under Vitest).

export interface ScanRange { site: string; base: number; prefix: number; exclude: boolean; }

export function maskOf(prefix: number): number { return prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0; }

export function ipToInt(ip: string): number | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((x) => x > 255)) return null;
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}
export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// Accepts CIDR ("10.8.2.0/24") OR wildcard ("10.8.2.*" = /24, "10.8.*.*" = /16).
// Returns the masked network base, the prefix, and a short network label.
// Capped to /16../30 so a typo can't launch a /8 (16M-host) sweep.
export function parseCidrOrWildcard(s: string): { base: number; prefix: number; netLabel: string } | null {
  const str = s.trim();
  if (str.includes('*')) {
    const parts = str.split('.');
    if (parts.length !== 4) return null;
    const octs: number[] = [];
    let fixed = 0;
    let seenStar = false;
    for (const p of parts) {
      if (p === '*') { seenStar = true; octs.push(0); continue; }
      if (seenStar) return null;            // a number after a '*' is invalid
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      octs.push(n); fixed++;
    }
    const prefix = fixed * 8;
    if (prefix < 16 || prefix > 24) return null;
    const base = (((octs[0]! << 24) >>> 0) + (octs[1]! << 16) + (octs[2]! << 8) + octs[3]!) >>> 0;
    return { base, prefix, netLabel: octs.slice(0, fixed).join('.') };
  }
  const m = str.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const ip = ipToInt(m[1]!);
  const prefix = Number(m[2]);
  if (ip == null || prefix < 16 || prefix > 30) return null;
  const base = (ip & ((~0 << (32 - prefix)) >>> 0)) >>> 0;
  return { base, prefix, netLabel: intToIp(base).replace(/(\.0)+$/, '') };
}

// "Site=range" per line/comma; the "Site=" is OPTIONAL (label derived from the
// network when omitted). range = CIDR or wildcard. A leading "!" or "<>" on the
// line marks an EXCLUDE range — IPs inside it are skipped even if another range
// covers them (same convention as the disk-scope syntax elsewhere in the app).
export function parseScanRanges(raw: string | undefined): ScanRange[] {
  const out: ScanRange[] = [];
  for (const raw0 of (raw ?? '').split(/[,;\r\n]+/).map((s) => s.trim()).filter(Boolean)) {
    let tok = raw0;
    let exclude = false;
    if (tok.startsWith('!')) { exclude = true; tok = tok.slice(1).trim(); }
    else if (tok.startsWith('<>')) { exclude = true; tok = tok.slice(2).trim(); }
    const eq = tok.indexOf('=');
    const site = eq > 0 ? tok.slice(0, eq).trim() : '';
    const rangeStr = eq > 0 ? tok.slice(eq + 1).trim() : tok;
    const p = parseCidrOrWildcard(rangeStr);
    if (!p) continue;
    out.push({ site: site || p.netLabel, base: p.base, prefix: p.prefix, exclude });
  }
  return out;
}

// The Site= label an IP SHOULD carry, given the configured scan ranges: the
// first include range that contains it. Used to reconcile stale scan rows whose
// site was derived from a bare range (netLabel, e.g. "10.181.3") before the
// operator added a "Site=" label (e.g. "Zastavka=10.181.3.*"). Returns null when
// no include range covers the IP (leave the stored site untouched).
export function siteForIp(ip: string, ranges: ScanRange[]): string | null {
  const n = ipToInt(ip);
  if (n == null) return null;
  for (const r of ranges) {
    if (r.exclude) continue;
    if (((n & maskOf(r.prefix)) >>> 0) === r.base) return r.site;
  }
  return null;
}

// Usable host IPs of a range (skip network + broadcast).
export function* hostsOf(r: ScanRange): Generator<string> {
  const size = 2 ** (32 - r.prefix);
  if (size <= 2) { yield intToIp(r.base); return; }
  for (let i = 1; i < size - 1; i++) yield intToIp((r.base + i) >>> 0);
}
