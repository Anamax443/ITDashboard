import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRecent } from '../services/activity-log.js';
import { getPool } from '../db/pool.js';

export async function registerActivityRoutes(app: FastifyInstance) {
  app.get('/activity/log', async (req) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(200),
      sinceSeq: z.coerce.number().int().optional(),
    }).parse(req.query);
    return getRecent(q.limit, q.sinceSeq);
  });

  // Persistent history with filters. Backed by the activity_log table — survives
  // service restarts, retained per `activity.retention_days` setting.
  app.get('/activity/history', async (req) => {
    const q = z.object({
      level: z.enum(['info', 'warn', 'error', 'success']).optional(),
      source: z.string().max(64).optional(),
      hours: z.coerce.number().int().min(1).max(24 * 365).default(24),
      search: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(2000).default(500),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const pool = await getPool();
    const req2 = pool.request()
      .input('hours', q.hours)
      .input('lim', q.limit)
      .input('off', q.offset)
      .input('lvl', q.level ?? null)
      .input('src', q.source ?? null)
      .input('q', q.search ?? null);

    const rows = await req2.query(`
      SELECT id, ts, level, source, message
      FROM activity_log
      WHERE ts >= DATEADD(HOUR, -@hours, SYSUTCDATETIME())
        AND (@lvl IS NULL OR level = @lvl)
        AND (@src IS NULL OR source = @src)
        AND (@q IS NULL OR message LIKE '%' + @q + '%')
      ORDER BY ts DESC, id DESC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY;
    `);

    const total = await req2.query(`
      SELECT COUNT_BIG(*) AS total
      FROM activity_log
      WHERE ts >= DATEADD(HOUR, -@hours, SYSUTCDATETIME())
        AND (@lvl IS NULL OR level = @lvl)
        AND (@src IS NULL OR source = @src)
        AND (@q IS NULL OR message LIKE '%' + @q + '%');
    `);

    return {
      items: rows.recordset,
      total: Number(total.recordset[0]?.total ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get('/activity/sources', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT source, COUNT_BIG(*) AS cnt
      FROM activity_log
      WHERE ts >= DATEADD(DAY, -30, SYSUTCDATETIME())
      GROUP BY source
      ORDER BY source;
    `);
    return { items: r.recordset };
  });
}
