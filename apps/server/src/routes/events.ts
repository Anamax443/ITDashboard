import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { getSetting, getAllSettings } from '../services/settings.js';

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
    const raw = await getSetting('events.summary_window_days', '1');
    const parsed = Number(raw);
    const windowDays = Number.isFinite(parsed) && parsed >= 1 && parsed <= 90 ? Math.floor(parsed) : 1;
    const r = await pool.request()
      .input('days', windowDays)
      .query(`
        SELECT
          SUM(CASE WHEN level = 1 THEN 1 ELSE 0 END) AS critical_24h,
          SUM(CASE WHEN level = 2 THEN 1 ELSE 0 END) AS error_24h,
          SUM(CASE WHEN level = 3 THEN 1 ELSE 0 END) AS warning_24h
        FROM events
        WHERE time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
      `);
    const row = r.recordset[0] ?? { critical_24h: 0, error_24h: 0, warning_24h: 0 };
    return { ...row, window_days: windowDays };
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

  app.get('/events/timeline', async (req) => {
    const q = z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) }).parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('hours', q.hours)
      .query(`
        SELECT
          DATEADD(HOUR, DATEDIFF(HOUR, 0, time_created), 0) AS bucket,
          level,
          COUNT(*) AS cnt
        FROM events
        WHERE time_created >= DATEADD(HOUR, -@hours, SYSUTCDATETIME())
          AND level IN (1, 2, 3)
        GROUP BY DATEADD(HOUR, DATEDIFF(HOUR, 0, time_created), 0), level
        ORDER BY bucket, level
      `);
    return { items: r.recordset };
  });

  app.get('/events/top-computers', async (req) => {
    const q = z.object({ hours: z.coerce.number().int().default(24), limit: z.coerce.number().int().default(10) }).parse(req.query);
    const pool = await getPool();
    const r = await pool.request()
      .input('hours', q.hours)
      .input('lim', q.limit)
      .query(`
        SELECT TOP (@lim)
          c.name,
          COUNT(*) AS total,
          SUM(CASE WHEN e.level = 1 THEN 1 ELSE 0 END) AS critical_count,
          SUM(CASE WHEN e.level = 2 THEN 1 ELSE 0 END) AS error_count,
          SUM(CASE WHEN e.level = 3 THEN 1 ELSE 0 END) AS warning_count
        FROM events e
        JOIN computers c ON c.id = e.computer_id
        WHERE e.time_created >= DATEADD(HOUR, -@hours, SYSUTCDATETIME())
          AND e.level IN (1, 2, 3)
        GROUP BY c.name
        ORDER BY total DESC
      `);
    return { items: r.recordset };
  });

  // Per-PC "health" / reinstall-candidate ranking. Damped-blend score over a
  // configurable window: each distinct signature (provider+event_id+level)
  // contributes at most `signature_cap` occurrences, weighted by severity, plus
  // breadth (distinct error/critical signatures) and persistence (distinct days
  // with errors) bonuses — so one chatty source can't flag a healthy box. All
  // weights/thresholds come from settings (migration 033). Returns only PCs at or
  // above the "watch" threshold, classified watch/risk, worst first.
  app.get('/events/pc-health', async () => {
    const pool = await getPool();
    const s = await getAllSettings();
    const num = (key: string, fallback: number): number => {
      const n = Number(s[key]);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const windowDays = Math.min(90, Math.max(1, Math.floor(num('faulty.window_days', 14))));
    const cap = Math.max(1, Math.floor(num('faulty.signature_cap', 20)));
    const watch = num('faulty.threshold_watch', 400);
    const risk = num('faulty.threshold_risk', 600);
    const wc = num('faulty.weight_critical', 10);
    const we = num('faulty.weight_error', 3);
    const ww = num('faulty.weight_warning', 1);
    const wb = num('faulty.weight_breadth', 5);
    const wp = num('faulty.weight_persistence', 3);

    const r = await pool.request()
      .input('days', windowDays)
      .input('cap', cap)
      .input('wc', wc)
      .input('we', we)
      .input('ww', ww)
      .input('wb', wb)
      .input('wp', wp)
      .query(`
        WITH sig AS (
          SELECT computer_id, level, event_id, provider_name, COUNT(*) AS cnt
          FROM events
          WHERE time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
            AND level IN (1, 2, 3)
          GROUP BY computer_id, level, event_id, provider_name
        ),
        agg AS (
          SELECT computer_id,
            SUM((CASE WHEN cnt > @cap THEN @cap ELSE cnt END)
                * (CASE level WHEN 1 THEN @wc WHEN 2 THEN @we ELSE @ww END)) AS weighted,
            SUM(CASE WHEN level IN (1, 2) THEN 1 ELSE 0 END) AS signatures,
            SUM(CASE WHEN level = 1 THEN cnt ELSE 0 END) AS critical,
            SUM(CASE WHEN level = 2 THEN cnt ELSE 0 END) AS [error],
            SUM(CASE WHEN level = 3 THEN cnt ELSE 0 END) AS warning
          FROM sig
          GROUP BY computer_id
        ),
        dys AS (
          SELECT computer_id, COUNT(DISTINCT CAST(time_created AS DATE)) AS active_days
          FROM events
          WHERE time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
            AND level IN (1, 2)
          GROUP BY computer_id
        )
        SELECT c.id AS computer_id, c.name,
          a.critical, a.[error], a.warning, a.signatures,
          ISNULL(d.active_days, 0) AS active_days,
          CAST(a.weighted + a.signatures * @wb + ISNULL(d.active_days, 0) * @wp AS INT) AS score
        FROM agg a
        JOIN computers c ON c.id = a.computer_id
        LEFT JOIN dys d ON d.computer_id = a.computer_id
        WHERE c.enabled = 1 AND c.excluded = 0
        ORDER BY score DESC
      `);

    const items = r.recordset
      .map((row) => ({ ...row, level: row.score >= risk ? 'risk' : row.score >= watch ? 'watch' : 'ok' }))
      .filter((row) => row.level !== 'ok');

    return {
      windowDays,
      thresholdWatch: watch,
      thresholdRisk: risk,
      scoring: { cap, weightCritical: wc, weightError: we, weightWarning: ww, weightBreadth: wb, weightPersistence: wp },
      items,
    };
  });
}
