import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface VersionInfo {
  sha: string;
  shaFull: string;
  branch: string | null;
  builtAt: string;
}

async function readVersion(): Promise<VersionInfo> {
  // dist runs from C:\Apps\ITDashboard\apps\server\dist; .git is at C:\Apps\ITDashboard\.git
  const gitDir = join(process.cwd(), '..', '..', '.git');
  let shaFull = 'unknown';
  let branch: string | null = null;
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    if (head.startsWith('ref:')) {
      const refPath = head.slice(5).trim();
      branch = refPath.replace(/^refs\/heads\//, '');
      try {
        shaFull = (await readFile(join(gitDir, refPath), 'utf8')).trim();
      } catch {
        const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8');
        const m = packed.split('\n').find((l) => l.endsWith(refPath));
        if (m) shaFull = m.split(' ')[0]?.trim() ?? 'unknown';
      }
    } else {
      shaFull = head;
    }
  } catch {
    // .git not accessible — leave as unknown
  }
  return {
    sha: shaFull.slice(0, 7),
    shaFull,
    branch,
    builtAt: new Date().toISOString(),
  };
}

async function readDocsHtml(): Promise<string> {
  // dist runs from C:\Apps\ITDashboard\apps\server\dist; docs/ is at C:\Apps\ITDashboard\docs
  const docPath = join(process.cwd(), '..', '..', 'docs', 'dashboard.html');
  try {
    return await readFile(docPath, 'utf8');
  } catch {
    return '<!doctype html><html><body><h1>Documentation file not found</h1><p>Expected at <code>docs/dashboard.html</code></p></body></html>';
  }
}

export async function registerVersionRoutes(app: FastifyInstance) {
  app.get('/version', async () => readVersion());

  app.get('/docs', async (_req, reply) => {
    const html = await readDocsHtml();
    // Docs is static read-only content. Helmet's default CSP (script-src 'self')
    // blocks the inline `onclick="window.print()"` button and any future inline
    // toggles (e.g. CS/EN language switch). Override CSP to allow inline scripts
    // for this single route — the page never accepts user input and has no
    // privileged context.
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    reply.type('text/html').send(html);
  });
}
