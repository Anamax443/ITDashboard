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
// (devices.web_proxy). Verified live across Epson / HP / Brother EWS.
//
// Scoped to IP targets only (no arbitrary hostnames) to limit SSRF surface; the
// dashboard is already access-gated to the internal network.

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

interface Upstream { status: number; location: string | null; ct: string; enc: string; body: Buffer; }

// Single GET, no redirect following, ignoring the self-signed cert. The FULL body
// is buffered (not streamed) so the Fastify handler can `return` it — streaming
// via an async reply.send in an 'end' callback let the handler resolve undefined
// first, so Fastify sent an empty 200 before the body arrived. Redirects are NOT
// followed here: we surface the Location so the handler can bounce the BROWSER to
// the proxied path, keeping the document URL (and thus relative-link resolution)
// correct — following server-side would leave the browser thinking it is still at
// the pre-redirect path, breaking `../` relative resources (Brother → 400).
function fetchOnce(targetUrl: string): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(targetUrl); } catch { reject(new Error('bad url')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('bad scheme')); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', rejectUnauthorized: false, timeout: 8000 } as https.RequestOptions, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ status, location: String(res.headers.location), ct: '', enc: '', body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status, location: null,
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

// Decompress when the device used Content-Encoding (rare on printers, but cheap).
function decodeBody(body: Buffer, enc: string): Buffer {
  try {
    if (/\bgzip\b/i.test(enc)) return zlib.gunzipSync(body);
    if (/\bdeflate\b/i.test(enc)) return zlib.inflateSync(body);
    if (/\bbr\b/i.test(enc)) return zlib.brotliDecompressSync(body);
  } catch { /* fall through to raw */ }
  return body;
}

// Correct the Content-Type from the request path extension. Printers serve assets
// with wrong/loose MIME (Brother ships .js as text/js / text/plain, .css as
// text/plain); the browser then refuses to apply/execute them. Falls back to the
// upstream value for unknown extensions (incl. extensionless EWS pages → HTML).
const EXT_CT: Record<string, string> = {
  js: 'text/javascript', mjs: 'text/javascript', jq: 'text/javascript',
  css: 'text/css', html: 'text/html', htm: 'text/html', json: 'application/json',
  gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp',
};
function correctContentType(path: string, upstreamCt: string): string {
  const clean = path.split('?')[0]!;
  const dot = clean.lastIndexOf('.');
  const ext = dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
  return EXT_CT[ext] ?? upstreamCt;
}

export async function registerDeviceWebProxyRoutes(app: FastifyInstance) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as Record<string, string | undefined>;
    const ip = params.ip ?? '';
    if (!IP_RE.test(ip) || ip.split('.').some((o) => Number(o) > 255)) { reply.code(400); return 'bad ip'; }
    const star = params['*'] ?? '';
    const rest = star ? `/${star}` : '/';
    const prefix = `/devices/web/${ip}`;
    try {
      // Printers usually force HTTPS; fall back to HTTP only on a connection error.
      const target = `https://${ip}${rest}`;
      const up = await fetchOnce(target).catch(() => fetchOnce(`http://${ip}${rest}`));

      // Bounce a redirect back to the BROWSER as a proxied path, so the document
      // URL stays correct and the page's relative `../` resources resolve right.
      if (up.status >= 300 && up.status < 400 && up.location) {
        let loc: URL;
        try { loc = new URL(up.location, target); } catch { reply.code(502); return 'bad redirect'; }
        reply.header('cache-control', 'no-store');
        reply.redirect(`${prefix}${loc.pathname}${loc.search}`);
        return reply;
      }

      reply.header('content-type', correctContentType(rest, up.ct));
      // The dashboard's global Helmet CSP (`script-src 'self'`) + `nosniff` also
      // apply to this same-origin proxied content and would block the printer EWS
      // inline scripts / mis-typed assets → blank page. Relax both for the proxied
      // device UI only (sub-resources all load from /devices/web/IP/, same origin).
      reply.header('content-security-policy',
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; "
        + "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data: blob:; frame-src 'self'");
      reply.removeHeader('x-content-type-options');
      reply.header('cache-control', 'no-store');

      const decoded = decodeBody(up.body, up.enc);
      if (/text\/html/i.test(correctContentType(rest, up.ct))) {
        let html = decoded.toString('utf8');
        // 1) Route ROOT-ABSOLUTE resources/links (href|src|action="/…") through the
        //    proxy. A <base> only fixes RELATIVE URLs; absolute ones like HP's
        //    `/hp/device/jquery.js` would hit the dashboard origin root (404 / wrong
        //    MIME → `$ is not defined`). Skip `//host` and already-proxied paths.
        html = html.replace(/\b(href|src|action)=(["'])\/(?!\/|devices\/web\/)/gi, `$1=$2${prefix}/`);
        // 2) Inject a <base> for RELATIVE links, pointing at the directory of the
        //    CURRENT document (not the proxy root) — else a relative `SCRIPT.JS` on
        //    `…/COMMON/TOP` resolves to `/devices/web/IP/SCRIPT.JS` (root) and
        //    frame-based EWS (Epson) render blank.
        const dir = rest.slice(0, rest.lastIndexOf('/') + 1); // leading + trailing slash
        const base = `${prefix}${dir}`;
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
