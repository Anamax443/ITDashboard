import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTE_DIR = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = join(ROUTE_DIR, '..', '..', '..', 'desktop', 'dist', 'renderer');

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentTypeFor(path: string): string {
  const match = path.match(/\.[^.]+$/);
  return match ? CONTENT_TYPES[match[0]!.toLowerCase()] ?? 'application/octet-stream' : 'application/octet-stream';
}

function assetPathFromWildcard(wildcard: unknown): string | null {
  if (typeof wildcard !== 'string' || wildcard.length === 0) return null;
  const normalized = normalize(wildcard).replace(/^(\.\.(\\|\/|$))+/, '');
  if (normalized.includes('..')) return null;
  return normalized;
}

export async function registerFrontendRoutes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    try {
      const html = await readFile(join(FRONTEND_DIST, 'index.html'), 'utf8');
      reply.header('Cache-Control', 'no-store');
      reply.type('text/html; charset=utf-8').send(html);
    } catch {
      reply.code(503).type('text/plain; charset=utf-8');
      return 'ITDashboard frontend build not found. Deploy must build apps/desktop first.';
    }
  });

  app.get('/assets/*', async (req, reply) => {
    const params = req.params as { '*': unknown };
    const assetPath = assetPathFromWildcard(params['*']);
    if (!assetPath) {
      reply.code(404);
      return { error: 'Not found' };
    }

    try {
      const filePath = join(FRONTEND_DIST, 'assets', assetPath);
      const body = await readFile(filePath);
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      reply.type(contentTypeFor(filePath)).send(body);
    } catch {
      reply.code(404);
      return { error: 'Not found' };
    }
  });
}
