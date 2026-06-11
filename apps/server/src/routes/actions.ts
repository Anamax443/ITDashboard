import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Derive the public base URL the operator's browser used to reach this server,
// so the downloaded installer points its launchers back to the same endpoint
// without any hardcoded IP. Honors reverse-proxy headers (IIS/TLS in front).
function publicBaseUrl(req: FastifyRequest): string {
  const headers = req.headers;
  const xfProto = String(headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  const proto = xfProto || req.protocol || 'http';
  const xfHost = String(headers['x-forwarded-host'] ?? '').split(',')[0]?.trim();
  const host = xfHost || String(headers['host'] ?? '').trim();
  return host ? `${proto}://${host}` : '';
}

// Rewrite the installer's default ITD_API_BASE line to the URL this request
// came in on. The script keeps honoring ITD_API_BASE_OVERRIDE (set after the
// default line), so an operator can still pin a custom endpoint at install time.
function injectApiBase(script: string, baseUrl: string): string {
  if (!baseUrl) return script;
  return script.replace(
    /^set "ITD_API_BASE=.*"$/m,
    `set "ITD_API_BASE=${baseUrl}"`,
  );
}

// Serves the one-time installer for URL protocol handlers. Operator downloads
// + double-clicks once per workstation; afterwards the "Launch" buttons in the
// Actions modal trigger itd-mmc:// / itd-rdp:// / itd-psexec:// / itd-explorer://
// URLs which open the corresponding tools directly against the target PC.
export async function registerActionsRoutes(app: FastifyInstance) {
  app.get('/actions/install-handlers.cmd', async (req, reply) => {
    // Source lives next to the server source tree; dist runs from apps/server/dist
    // so we walk up two levels and into scripts/.
    const candidates = [
      join(process.cwd(), '..', '..', 'apps', 'server', 'scripts', 'install-itd-handlers.cmd'),
      join(process.cwd(), '..', 'scripts', 'install-itd-handlers.cmd'),
      join(process.cwd(), 'scripts', 'install-itd-handlers.cmd'),
    ];
    for (const p of candidates) {
      try {
        const raw = await readFile(p, 'utf8');
        const body = injectApiBase(raw, publicBaseUrl(req));
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', 'attachment; filename="install-itd-handlers.cmd"');
        return reply.send(body);
      } catch { /* try next */ }
    }
    reply.code(500);
    return { error: 'installer not found on server filesystem' };
  });
}
