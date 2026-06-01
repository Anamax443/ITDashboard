import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { syncComputersFromAD, getSyncHistory, getLastSync } from '../services/ad-sync.js';

export async function registerComputersRoutes(app: FastifyInstance) {
  app.get('/computers', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT id, name, fqdn, os_version, last_seen, enabled, monitor_enabled,
             last_collected_at, last_error, consecutive_failures, ou_path, distinguished_name
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

  app.patch('/computers/:id/monitor', async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ monitor: z.boolean() }).parse(req.body);
    const pool = await getPool();
    const r = await pool.request()
      .input('id', params.id)
      .input('m', body.monitor ? 1 : 0)
      .query(`
        UPDATE computers SET monitor_enabled = @m WHERE id = @id;
        SELECT id, name, monitor_enabled FROM computers WHERE id = @id;
      `);
    const row = r.recordset[0];
    if (!row) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return row;
  });

  app.post('/computers/monitor/bulk', async (req) => {
    const body = z.object({
      ids: z.array(z.number().int()).min(1),
      monitor: z.boolean(),
    }).parse(req.body);
    const pool = await getPool();
    // Use table-valued parameter would be cleaner, but for simplicity build IN list.
    const idsCSV = body.ids.join(',');
    const r = await pool.request()
      .input('m', body.monitor ? 1 : 0)
      .query(`UPDATE computers SET monitor_enabled = @m WHERE id IN (${idsCSV})`);
    return { updated: r.rowsAffected[0] ?? 0, monitor: body.monitor };
  });
}
