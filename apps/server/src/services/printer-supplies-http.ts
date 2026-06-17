import http from 'node:http';
import https from 'node:https';

// HTTP fallback for the two supply gaps SNMP Printer-MIB leaves on this fleet
// (verified live 2026-06-17):
//   * Brother reports toner only as "some remaining" over SNMP (no %), but its
//     web status page encodes a numeric bar — `/general/status.html`.
//   * Epson exposes the 4 inks over SNMP but NOT the maintenance (waste) box; the
//     Web Config product page shows it — `/PRESENTATION/ADVANCED/INFO_PRTINFO/TOP`.
// Both pages are server-rendered HTML (levels baked into the markup), so a plain
// GET + regex is enough — no JS engine. Printers force self-signed HTTPS, so the
// GET ignores cert validation (same as the device web proxy). Best-effort: any
// parse miss just leaves the SNMP data as-is.

export interface ParsedSupply { key: string; colorant: string; type: string; pct: number | null; }

// Map a colour word / single letter to our normalized supply key.
export function colorKey(name: string): { key: string; colorant: string } | null {
  const n = name.trim().toLowerCase();
  if (/^(bk|k|black|schwarz|černá|cerna)$/.test(n) || /black/.test(n)) return { key: 'K', colorant: 'black' };
  if (/^(c|cyan|azurová|azurova)$/.test(n) || /cyan/.test(n)) return { key: 'C', colorant: 'cyan' };
  if (/^(m|magenta|purpurová|purpurova)$/.test(n) || /magenta/.test(n)) return { key: 'M', colorant: 'magenta' };
  if (/^(y|yellow|žlutá|zluta)$/.test(n) || /yellow/.test(n)) return { key: 'Y', colorant: 'yellow' };
  if (/waste|maint|odpad/.test(n)) return { key: 'MAINT', colorant: 'none' };
  return null;
}

function clampPct(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }

// --- Supply classification (pure; shared with the SNMP path) -----------------

// Map a raw SNMP/web supply description to our normalized key / colorant / type.
export function classifyDescription(desc: string): { key: string; colorant: string; type: string } {
  const d = desc.toLowerCase();
  if (/waste|maintenance|odpad/.test(d)) return { key: 'MAINT', colorant: 'none', type: 'maintenance' };
  if (/belt|transfer/.test(d)) return { key: 'BELT', colorant: 'none', type: 'belt' };
  if (/drum|imaging/.test(d)) return { key: 'DRUM', colorant: 'none', type: 'drum' };
  if (/fuser/.test(d)) return { key: 'FUSER', colorant: 'none', type: 'fuser' };
  const t = /ink/.test(d) ? 'ink' : 'toner';
  if (/black|schwarz|\bbk\b/.test(d)) return { key: 'K', colorant: 'black', type: t };
  if (/cyan/.test(d)) return { key: 'C', colorant: 'cyan', type: t };
  if (/magenta/.test(d)) return { key: 'M', colorant: 'magenta', type: t };
  if (/yellow/.test(d)) return { key: 'Y', colorant: 'yellow', type: t };
  return { key: 'OTHER', colorant: 'none', type: 'other' };
}

// Best-effort order code from a supply description (handy for re-ordering).
export function extractPartCode(desc: string): string | null {
  let m = desc.match(/\bHP\s+([A-Z]{1,3}\d{3}[A-Z]?)\b/);
  if (m) return m[1]!;
  m = desc.match(/\b(T\d[0-9A-Z]+(?:\/[0-9A-Z]+)*)\b/); // Epson T13W1/T13X1/...
  if (m) return m[1]!;
  m = desc.match(/\b(CE\d{3}[A-Z]?|CF\d{3}[A-Z]?|TN-?\d+\w*)\b/i);
  if (m) return m[1]!;
  return null;
}

// % from raw SNMP level + max capacity. Null for the negative sentinels
// (-1 other / -2 unknown|unrestricted / -3 some-remaining) or a non-positive max.
export function computeLevelPct(level: number | null, max: number | null): number | null {
  if (level == null || max == null) return null;
  if (level < 0 || max <= 0) return null;
  return clampPct((level * 100) / max);
}

// Brother MFC/HL web status page: each toner is an <img class="tonerremain"
// alt="Black|Cyan|Magenta|Yellow" height="NN">, a full tank ≈ 50px.
export function parseBrotherToner(html: string): ParsedSupply[] {
  const out: ParsedSupply[] = [];
  const re = /alt="([^"]+)"[^>]*class="tonerremain"[^>]*height="(\d+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const ck = colorKey(m[1]!);
    if (!ck) continue;
    out.push({ key: ck.key, colorant: ck.colorant, type: 'toner', pct: clampPct((Number(m[2]) / 50) * 100) });
  }
  return out;
}

// Epson Web Config maintenance (waste) box. Two markups seen across models:
//   * gradient bar — the olive maintenance colour `#636311 0%, #636311 NN%`
//   * image height — `Ink_Waste.PNG' height='NN'` (full ≈ 50px)
export function parseEpsonMaint(html: string): number | null {
  const grad = html.match(/#636311 0%, ?#636311 (\d+)%/i);
  if (grad) return clampPct(Number(grad[1]));
  const img = html.match(/Ink_Waste\.PNG'\s*height='(\d+)'/i);
  if (img) return clampPct((Number(img[1]) / 50) * 100);
  return null;
}

// Full Epson ink parse — last resort when a printer doesn't answer SNMP at all.
// Handles the three markups observed on this fleet:
//   A) EM-C series — horizontal gradient `tank_sideways ... to right, <colour> 0%, <colour> NN%`
//   B) WF-C57xx/65xx — image height `Ink_X.PNG' height='NN'` (full ≈ 50px)
//   C) WF-C5890 — vertical gradient `tank ... to top, <colour> 0%, <colour> NN%`
export function parseEpsonInks(html: string): ParsedSupply[] {
  // B) image-height variant — unambiguous, try first.
  const imgRe = /Ink_([A-Za-z]+)\.PNG'\s*height='(\d+)'/gi;
  const imgOut: ParsedSupply[] = [];
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(html))) {
    const ck = colorKey(im[1]!);
    if (!ck) continue;
    imgOut.push({ key: ck.key, colorant: ck.colorant, type: ck.key === 'MAINT' ? 'maintenance' : 'ink', pct: clampPct((Number(im[2]) / 50) * 100) });
  }
  if (imgOut.length) return imgOut;

  // A) + C) gradient variants — colour names appear as <div class='clrname'>X</div>
  // in order; the maintenance box has an Icn_Mb icon instead of a clrname. We read
  // the gradient stop % in document order and pair with the names, appending MAINT
  // for any trailing gradient past the last named colour.
  const names: string[] = [];
  const nameRe = /clrname'>([^<]+)</gi;
  let nm: RegExpExecArray | null;
  while ((nm = nameRe.exec(html))) names.push(nm[1]!.trim());

  const levels: number[] = [];
  const gradRe = /linear-gradient\((?:to right|to top), #[0-9A-Fa-f]{6} 0%, #[0-9A-Fa-f]{6} (\d+)%/gi;
  let gm: RegExpExecArray | null;
  while ((gm = gradRe.exec(html))) levels.push(Number(gm[1]));
  if (!levels.length) return [];

  const out: ParsedSupply[] = [];
  for (let i = 0; i < levels.length; i++) {
    const ck = i < names.length ? colorKey(names[i]!) : { key: 'MAINT', colorant: 'none' };
    const key = ck?.key ?? 'MAINT';
    out.push({
      key,
      colorant: ck?.colorant ?? 'none',
      type: key === 'MAINT' ? 'maintenance' : 'ink',
      pct: clampPct(levels[i]!),
    });
  }
  return out;
}

// Insecure GET (ignores self-signed printer certs). Follows redirects (printers
// often bounce HTTP→HTTPS). Returns the body text, or null on any failure.
export function insecureGet(url: string, timeoutMs = 6000, depth = 0): Promise<string | null> {
  return new Promise((resolve) => {
    if (depth > 5) { resolve(null); return; }
    let u: URL;
    try { u = new URL(url); } catch { resolve(null); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs } as https.RequestOptions, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        let next: string;
        try { next = new URL(res.headers.location, u).toString(); } catch { resolve(null); return; }
        insecureGet(next, timeoutMs, depth + 1).then(resolve);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}
