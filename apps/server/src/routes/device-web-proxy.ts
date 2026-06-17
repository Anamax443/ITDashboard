import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

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

function fetchUpstream(targetUrl: string, depth: number): Promise<{ res: IncomingMessage }> {
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
      resolve({ res });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function serve(res: IncomingMessage, ip: string, reply: FastifyReply): void {
  const ct = String(res.headers['content-type'] ?? 'application/octet-stream');
  reply.header('content-type', ct);
  if (/text\/html/i.test(ct)) {
    // Inject a <base> so the device's RELATIVE links route back through the proxy.
    const base = `/devices/web/${ip}/`;
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      body = /<head[^>]*>/i.test(body)
        ? body.replace(/<head[^>]*>/i, (m) => `${m}<base href="${base}">`)
        : `<base href="${base}">${body}`;
      reply.send(body);
    });
    res.on('error', () => reply.code(502).send('stream error'));
  } else {
    reply.send(res); // pipe binary/other content straight through
  }
}

export async function registerDeviceWebProxyRoutes(app: FastifyInstance) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as Record<string, string | undefined>;
    const ip = params.ip ?? '';
    if (!IP_RE.test(ip) || ip.split('.').some((o) => Number(o) > 255)) { reply.code(400).send('bad ip'); return; }
    const star = params['*'] ?? '';
    const rest = star ? `/${star}` : '/';
    try {
      // Printers usually force HTTPS; the redirect-follow covers an HTTP landing too.
      const { res } = await fetchUpstream(`https://${ip}${rest}`, 0).catch(() => fetchUpstream(`http://${ip}${rest}`, 0));
      serve(res, ip, reply);
    } catch (err) {
      reply.code(502).send(`device unreachable: ${String(err).split('\n')[0]}`);
    }
  };
  app.get('/devices/web/:ip', handler);
  app.get('/devices/web/:ip/*', handler);
}
