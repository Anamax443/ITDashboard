import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';

export async function registerComputersRoutes(app: FastifyInstance) {
  app.get('/computers', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT id, name, fqdn, os_version, last_seen, enabled
      FROM computers
      ORDER BY name
    `);
    return { items: r.recordset };
  });
}
