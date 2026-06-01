import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';

export async function registerScriptsRoutes(app: FastifyInstance) {
  app.get('/scripts', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT id, slug, name, language, description, enabled
      FROM scripts
      WHERE enabled = 1
      ORDER BY name
    `);
    return { items: r.recordset };
  });

  // TODO: POST /scripts/:slug/run — invoke script-runner package, persist to script_runs
}
