import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { syncComputersFromAD, getSyncHistory, getLastSync } from '../services/ad-sync.js';
import { getSetting } from '../services/settings.js';
import { refreshSinglePc } from '../services/refresh-single-pc.js';

export async function registerComputersRoutes(app: FastifyInstance) {
  app.get('/computers', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT id, name, fqdn, os_version, last_seen, enabled, monitor_enabled, excluded,
             disk_email_monitor, disk_email_drives,
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

  app.post('/computers/:id/refresh', async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    try {
      const result = await refreshSinglePc(params.id);
      if (!result) {
        reply.code(409);
        return { error: 'already in flight or computer not found' };
      }
      return result;
    } catch (err) {
      app.log.error({ err, computerId: params.id }, 'single-PC refresh failed');
      reply.code(500);
      return { error: String(err) };
    }
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

  app.patch('/computers/:id/disk-email-monitor', async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    // Both fields optional — update whichever the client sends. `drives` is the
    // per-PC drive-letter scope (e.g. 'C,F'); empty string means "all drives".
    const body = z.object({
      enabled: z.boolean().optional(),
      // Allow only letters, separators and the scope operators (<> ! * :).
      drives: z.string().max(64).regex(/^[A-Za-z0-9,;\s<>!*:]*$/).optional(),
    }).parse(req.body);
    if (body.enabled === undefined && body.drives === undefined) {
      reply.code(400);
      return { error: 'nothing to update' };
    }
    const pool = await getPool();
    const request = pool.request().input('id', params.id);
    const sets: string[] = [];
    if (body.enabled !== undefined) {
      request.input('m', body.enabled ? 1 : 0);
      sets.push('disk_email_monitor = @m');
    }
    if (body.drives !== undefined) {
      request.input('drv', body.drives.trim());
      sets.push('disk_email_drives = @drv');
    }
    const r = await request.query(`
      UPDATE computers SET ${sets.join(', ')} WHERE id = @id;
      SELECT id, name, disk_email_monitor, disk_email_drives FROM computers WHERE id = @id;
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
