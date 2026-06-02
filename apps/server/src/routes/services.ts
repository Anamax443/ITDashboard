import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { runServicesScanOnce } from '../services/services-collector.js';

export async function registerServicesRoutes(app: FastifyInstance) {
  app.get('/services/problems', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT sp.id, sp.computer_id, c.name AS computer, sp.service_name, sp.display_name,
             sp.start_mode, sp.state, sp.delayed_start, sp.trigger_start, sp.collected_at
      FROM service_problems sp
      JOIN computers c ON c.id = sp.computer_id
      WHERE c.enabled = 1 AND c.monitor_enabled = 1
      ORDER BY c.name, sp.service_name
    `);
    return { items: r.recordset };
  });

  app.post('/services/scan', async (_req, reply) => {
    const result = await runServicesScanOnce();
    if (result === null) {
      reply.code(409);
      return { error: 'Services scan already running' };
    }
    return result;
  });
}
