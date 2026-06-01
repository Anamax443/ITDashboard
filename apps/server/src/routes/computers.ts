import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { syncComputersFromAD } from '../services/ad-sync.js';

export async function registerComputersRoutes(app: FastifyInstance) {
  app.get('/computers', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT id, name, fqdn, os_version, last_seen, enabled
      FROM computers
      ORDER BY enabled DESC, name
    `);
    return { items: r.recordset };
  });

  app.post('/computers/sync', async (_req, reply) => {
    try {
      const result = await syncComputersFromAD();
      return result;
    } catch (err) {
      app.log.error({ err }, 'AD sync failed');
      reply.code(500);
      return { error: String(err) };
    }
  });
}
