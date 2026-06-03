import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { syncComputersFromAD, getSyncHistory, getLastSync } from '../services/ad-sync.js';
import { getSetting } from '../services/settings.js';

export async function registerComputersRoutes(app: FastifyInstance) {
  app.get('/computers', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT id, name, fqdn, os_version, last_seen, enabled, monitor_enabled, excluded,
             last_collected_at, last_error, consecutive_failures, ou_path, distinguished_name,
             last_status, [current_user], current_user_seen_at, ip_address, pc_info_collected_at
      FROM computers
      ORDER BY enabled DESC, excluded, name
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

  app.get('/computers/inactive-stats', async () => {
    const pool = await getPool();
    const raw = await getSetting('inactive.threshold_days').catch(() => undefined);
    const n = Number(raw);
    const thresholdDays = Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 90;
    const r = await pool.request()
      .input('days', thresholdDays)
      .query<{
        enabledInactive: number; disabledInactive: number;
        totalEnabled: number; totalDisabled: number;
      }>(`
        SELECT
          SUM(CASE WHEN enabled = 1 AND excluded = 0 AND (last_seen IS NULL OR last_seen < DATEADD(DAY, -@days, SYSUTCDATETIME())) THEN 1 ELSE 0 END) AS enabledInactive,
          SUM(CASE WHEN enabled = 0 AND excluded = 0 AND (last_seen IS NULL OR last_seen < DATEADD(DAY, -@days, SYSUTCDATETIME())) THEN 1 ELSE 0 END) AS disabledInactive,
          SUM(CASE WHEN enabled = 1 AND excluded = 0 THEN 1 ELSE 0 END) AS totalEnabled,
          SUM(CASE WHEN enabled = 0 AND excluded = 0 THEN 1 ELSE 0 END) AS totalDisabled
        FROM computers;
      `);
    const row = r.recordset[0] ?? { enabledInactive: 0, disabledInactive: 0, totalEnabled: 0, totalDisabled: 0 };
    return { thresholdDays, ...row };
  });

  app.get('/computers/:id/user-history', async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = z.object({ days: z.coerce.number().int().min(1).max(3650).default(90) }).parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('cid', params.id)
      .input('days', q.days)
      .query<{ id: number; user_name: string; first_seen: string; last_seen: string; ip_address: string | null }>(`
        SELECT id, user_name, first_seen, last_seen, ip_address
        FROM pc_user_history
        WHERE computer_id = @cid
          AND last_seen >= DATEADD(DAY, -@days, SYSUTCDATETIME())
        ORDER BY last_seen DESC;
      `);
    reply.send({ items: r.recordset });
  });

  app.get('/computers/sync/history', async () => {
    const items = await getSyncHistory(20);
    return { items };
  });

  app.get('/computers/sync/last', async () => {
    const last = await getLastSync();
    return { last };
  });

  app.patch('/computers/:id/excluded', async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ excluded: z.boolean() }).parse(req.body);
    const pool = await getPool();
    const r = await pool.request()
      .input('id', params.id)
      .input('x', body.excluded ? 1 : 0)
      .query(`
        UPDATE computers SET excluded = @x WHERE id = @id;
        SELECT id, name, excluded FROM computers WHERE id = @id;
      `);
    const row = r.recordset[0];
    if (!row) { reply.code(404); return { error: 'Not found' }; }
    return row;
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
