import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { runPerfCollectorOnce } from '../services/perf-collector.js';

const ListQuery = z.object({
  computer: z.string().optional(),
  category: z.enum(['boot', 'shutdown', 'standby', 'resume', 'other']).optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

export async function registerPerfEventsRoutes(app: FastifyInstance) {
  app.get('/perf-events', async (req) => {
    const q = ListQuery.parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('days', q.days)
      .input('lim', q.limit)
      .input('cat', q.category ?? null)
      .input('comp', q.computer ?? null)
      .query(`
        SELECT TOP (@lim)
          p.id, c.name AS computer, p.time_created, p.event_id, p.level,
          p.category, p.total_time_ms, p.degradation_ms,
          p.culprit_name, p.culprit_friendly, p.message
        FROM perf_events p
        JOIN computers c ON c.id = p.computer_id
        WHERE p.time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
          AND (@cat IS NULL OR p.category = @cat)
          AND (@comp IS NULL OR c.name = @comp)
        ORDER BY p.time_created DESC
      `);
    return { items: r.recordset };
  });

  app.get('/perf-events/summary', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('days', q.days)
      .query(`
        SELECT
          SUM(CASE WHEN category = 'boot' THEN 1 ELSE 0 END) AS boot_count,
          SUM(CASE WHEN category = 'shutdown' THEN 1 ELSE 0 END) AS shutdown_count,
          SUM(CASE WHEN category = 'standby' THEN 1 ELSE 0 END) AS standby_count,
          SUM(CASE WHEN category = 'resume' THEN 1 ELSE 0 END) AS resume_count,
          COUNT(DISTINCT computer_id) AS affected_pcs,
          COUNT(*) AS total_events
        FROM perf_events
        WHERE time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
      `);
    return r.recordset[0] ?? {
      boot_count: 0, shutdown_count: 0, standby_count: 0, resume_count: 0,
      affected_pcs: 0, total_events: 0,
    };
  });

  app.get('/perf-events/top-culprits', async (req) => {
    const q = z.object({
      days: z.coerce.number().int().min(1).max(90).default(7),
      limit: z.coerce.number().int().min(1).max(100).default(15),
    }).parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('days', q.days)
      .input('lim', q.limit)
      .query(`
        SELECT TOP (@lim)
          ISNULL(culprit_friendly, culprit_name) AS culprit,
          category,
          COUNT(*) AS event_count,
          COUNT(DISTINCT computer_id) AS pc_count,
          AVG(CAST(total_time_ms AS BIGINT)) AS avg_total_ms,
          MAX(total_time_ms) AS max_total_ms
        FROM perf_events
        WHERE time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
          AND (culprit_name IS NOT NULL OR culprit_friendly IS NOT NULL)
        GROUP BY ISNULL(culprit_friendly, culprit_name), category
        ORDER BY event_count DESC
      `);
    return { items: r.recordset };
  });

  app.get('/perf-events/top-pcs', async (req) => {
    const q = z.object({
      days: z.coerce.number().int().min(1).max(90).default(7),
      limit: z.coerce.number().int().min(1).max(100).default(15),
    }).parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('days', q.days)
      .input('lim', q.limit)
      .query(`
        SELECT TOP (@lim)
          c.name,
          COUNT(*) AS event_count,
          SUM(CASE WHEN p.category = 'boot' THEN 1 ELSE 0 END) AS boot_count,
          SUM(CASE WHEN p.category = 'shutdown' THEN 1 ELSE 0 END) AS shutdown_count,
          AVG(CASE WHEN p.category = 'boot' THEN CAST(p.total_time_ms AS BIGINT) END) AS avg_boot_ms,
          MAX(p.time_created) AS last_event_at
        FROM perf_events p
        JOIN computers c ON c.id = p.computer_id
        WHERE p.time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
        GROUP BY c.name
        ORDER BY event_count DESC
      `);
    return { items: r.recordset };
  });

  app.post('/perf-events/scan', async () => {
    const r = await runPerfCollectorOnce();
    if (!r) return { skipped: true };
    return r;
  });
}
