import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

// Best-effort reverse proxy for a device's embedded web UI (printer EWS etc.).
//
// Why: many printers force HTTPS with a self-signed cert, so a direct browser
// link hits NET::ERR_CERT_AUTHORITY_INVALID. A web app cannot make the browser
// skip cert validation — but the SERVER can fetch the device ignoring the cert
// and serve it from the dashboard's (trusted) origin. Opt-in via Settings
// (devices.web_proxy); off by default. Best-effort: interactive EWS that use
// absolute-path resources may not fully render — then use the direct link +
// accept the cert once, or deploy the printer cert via GPO.
//
// Scoped to IP targets only (no arbitrary hostnames) to limit SSRF surface; the
// dashboard is already access-gated to the internal network.

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

interface Upstream { ct: string; enc: string; body: Buffer; }

// Fetch the device page, following redirects, ignoring the self-signed cert. The
// FULL body is buffered and returned (not streamed) so the Fastify handler can
// `return` it: streaming via an async `reply.send` in an 'end' callback let the
// handler resolve with undefined first, so Fastify sent an empty 200 before the
// body arrived — the proxy looked like it "returned nothing".
function fetchUpstream(targetUrl: string, depth: number): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('too many redirects')); return; }
    let u: URL;
    try { u = new URL(targetUrl); } catch { reject(new Error('bad url')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('bad scheme')); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', rejectUnauthorized: false, timeout: 8000 } as https.RequestOptions, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        let next: string;
        try { next = new URL(res.headers.location, u).toString(); } catch { reject(new Error('bad redirect')); return; }
        resolve(fetchUpstream(next, depth + 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        ct: String(res.headers['content-type'] ?? 'application/octet-stream'),
        enc: String(res.headers['content-encoding'] ?? ''),
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Decompress when the device used Content-Encoding (rare on printers, but cheap
// to handle). Falls back to the raw bytes if decompression fails.
function decodeBody(body: Buffer, enc: string): Buffer {
  try {
    if (/\bgzip\b/i.test(enc)) return zlib.gunzipSync(body);
    if (/\bdeflate\b/i.test(enc)) return zlib.inflateSync(body);
    if (/\bbr\b/i.test(enc)) return zlib.brotliDecompressSync(body);
  } catch { /* fall through to raw */ }
  return body;
}

export async function registerDeviceWebProxyRoutes(app: FastifyInstance) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as Record<string, string | undefined>;
    const ip = params.ip ?? '';
    if (!IP_RE.test(ip) || ip.split('.').some((o) => Number(o) > 255)) { reply.code(400); return 'bad ip'; }
    const star = params['*'] ?? '';
    const rest = star ? `/${star}` : '/';
    try {
      // Printers usually force HTTPS; the redirect-follow covers an HTTP landing too.
      const up = await fetchUpstream(`https://${ip}${rest}`, 0).catch(() => fetchUpstream(`http://${ip}${rest}`, 0));
      reply.header('content-type', up.ct);
      // The dashboard's global Helmet CSP (`script-src 'self'`) also applies to
      // this same-origin proxied content and BLOCKS the printer EWS's inline
      // scripts (the Epson bootstrap meta-refresh + jQuery) → blank page. Relax
      // the CSP for the proxied device UI only: all sub-resources load from this
      // same origin under /devices/web/IP/, plus the device's own inline scripts.
      reply.header('content-security-policy',
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; "
        + "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data: blob:; frame-src 'self'");
      reply.header('cache-control', 'no-store');
      const decoded = decodeBody(up.body, up.enc);
      if (/text\/html/i.test(up.ct)) {
        // Inject a <base> so the device's RELATIVE links route back through the
        // proxy. It MUST point at the directory of the CURRENT document, not the
        // proxy root — otherwise a relative `SCRIPT.JS` on `…/COMMON/TOP` resolves
        // to `/devices/web/IP/SCRIPT.JS` (root) instead of `…/COMMON/SCRIPT.JS`,
        // so scripts / iframe targets 404 and frame-based EWS (Epson) render blank.
        const dir = rest.slice(0, rest.lastIndexOf('/') + 1); // leading + trailing slash
        const base = `/devices/web/${ip}${dir}`;
        let html = decoded.toString('utf8');
        html = /<head[^>]*>/i.test(html)
          ? html.replace(/<head[^>]*>/i, (m) => `${m}<base href="${base}">`)
          : `<base href="${base}">${html}`;
        return html;
      }
      return decoded; // binary/other content as-is
    } catch (err) {
      reply.code(502);
      return `device unreachable: ${String(err).split('\n')[0]}`;
    }
  };
  app.get('/devices/web/:ip', handler);
  app.get('/devices/web/:ip/*', handler);
}
