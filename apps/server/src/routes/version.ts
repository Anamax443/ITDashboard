import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface VersionInfo {
  sha: string;
  shaFull: string;
  branch: string | null;
  builtAt: string;
}

let cached: VersionInfo | null = null;

async function readVersion(): Promise<VersionInfo> {
  if (cached) return cached;
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
  cached = {
    sha: shaFull.slice(0, 7),
    shaFull,
    branch,
    builtAt: new Date().toISOString(),
  };
  return cached;
}

export async function registerVersionRoutes(app: FastifyInstance) {
  app.get('/version', async () => readVersion());
}
