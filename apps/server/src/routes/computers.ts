import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { syncComputersFromAD, getSyncHistory, getLastSync } from '../services/ad-sync.js';

export async function registerComputersRoutes(app: FastifyInstance) {
  app.get('/computers', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT id, name, fqdn, os_version, last_seen, enabled, last_collected_at, last_error, consecutive_failures
      FROM computers
      ORDER BY enabled DESC, name
    `);
    return { items: r.recordset };
  });

  app.post('/computers/sync', async (_req, reply) => {
    try {
      const result = await syncComputersFromAD('manual');
      return result;
    } catch (err) {
      app.log.error({ err }, 'AD sync failed');
      reply.code(500);
      return { error: String(err) };
    }
  });

  app.get('/computers/sync/history', async () => {
    const items = await getSyncHistory(20);
    return { items };
  });

  app.get('/computers/sync/last', async () => {
    const last = await getLastSync();
    return { last };
  });
}
