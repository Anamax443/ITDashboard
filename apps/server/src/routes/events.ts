import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';

const ListQuery = z.object({
  computer: z.string().optional(),
  level: z.enum(['critical', 'error', 'warning']).optional(),
  hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const LEVEL_MAP = { critical: 1, error: 2, warning: 3 } as const;

export async function registerEventsRoutes(app: FastifyInstance) {
  app.get('/events', async (req) => {
    const q = ListQuery.parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('hours', q.hours)
      .input('lim', q.limit)
      .input('lvl', q.level ? LEVEL_MAP[q.level] : null)
      .input('comp', q.computer ?? null)
      .query(`
        SELECT TOP (@lim)
          e.id, c.name AS computer, e.log_name, e.event_id, e.level,
          e.time_created, e.provider_name, e.message
        FROM events e
        JOIN computers c ON c.id = e.computer_id
        WHERE e.time_created >= DATEADD(HOUR, -@hours, SYSUTCDATETIME())
          AND (@lvl IS NULL OR e.level = @lvl)
          AND (@comp IS NULL OR c.name = @comp)
        ORDER BY e.time_created DESC
      `);
    return { items: r.recordset };
  });

  app.get('/events/summary', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT
        SUM(CASE WHEN level = 1 THEN 1 ELSE 0 END) AS critical_24h,
        SUM(CASE WHEN level = 2 THEN 1 ELSE 0 END) AS error_24h,
        SUM(CASE WHEN level = 3 THEN 1 ELSE 0 END) AS warning_24h
      FROM events
      WHERE time_created >= DATEADD(HOUR, -24, SYSUTCDATETIME())
    `);
    return r.recordset[0] ?? { critical_24h: 0, error_24h: 0, warning_24h: 0 };
  });

  app.get('/events/top-ids', async (req) => {
    const q = z.object({ hours: z.coerce.number().int().default(24), limit: z.coerce.number().int().default(20) }).parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('hours', q.hours)
      .input('lim', q.limit)
      .query(`
        SELECT TOP (@lim) event_id, log_name, level, COUNT(*) AS cnt
        FROM events
        WHERE time_created >= DATEADD(HOUR, -@hours, SYSUTCDATETIME())
          AND level IN (1, 2, 3)
        GROUP BY event_id, log_name, level
        ORDER BY cnt DESC
      `);
    return { items: r.recordset };
  });
}
