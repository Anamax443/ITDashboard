import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Serves the one-time installer for URL protocol handlers. Operator downloads
// + double-clicks once per workstation; afterwards the "Launch" buttons in the
// Actions modal trigger itd-mmc:// / itd-rdp:// / itd-psexec:// / itd-explorer://
// URLs which open the corresponding tools directly against the target PC.
export async function registerActionsRoutes(app: FastifyInstance) {
  app.get('/actions/install-handlers.cmd', async (_req, reply) => {
    // Source lives next to the server source tree; dist runs from apps/server/dist
    // so we walk up two levels and into scripts/.
    const candidates = [
      join(process.cwd(), '..', '..', 'apps', 'server', 'scripts', 'install-itd-handlers.cmd'),
      join(process.cwd(), '..', 'scripts', 'install-itd-handlers.cmd'),
      join(process.cwd(), 'scripts', 'install-itd-handlers.cmd'),
    ];
    for (const p of candidates) {
      try {
        const body = await readFile(p);
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', 'attachment; filename="install-itd-handlers.cmd"');
        return reply.send(body);
      } catch { /* try next */ }
    }
    reply.code(500);
    return { error: 'installer not found on server filesystem' };
  });
}
