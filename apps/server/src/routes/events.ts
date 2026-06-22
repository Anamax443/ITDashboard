import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { getSetting, getAllSettings } from '../services/settings.js';
import { getSession } from '../auth/session-store.js';
import { logActivity } from '../services/activity-log.js';
import { parseNotebookPatterns, parseSuppressionSignatures } from '../services/faulty-util.js';

// The "signature" on a snooze. Prefer the authenticated session user (the dashboard
// auth gate, cookie itd-session) so it can't be spoofed; fall back to a name typed
// in the request body when the operator browses without logging in.
function sessionUser(req: FastifyRequest): string | null {
  const cookies = (req as unknown as { cookies?: Record<string, string | undefined> }).cookies ?? {};
  const id = cookies['itd-session'];
  if (!id) return null;
  return getSession(id)?.user ?? null;
}

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

    // Per-category noise suppression: notebooks roam off-domain and routinely emit
    // logon/roaming noise (5719/1129/131/10016/Netwtw*) that is expected, not a
    // fault. We classify a machine as a notebook by AD OU/DN/name (group membership
    // isn't synced) and exclude the configured signatures from its score ONLY.
    // PCs + servers are unaffected (monitored in full).
    const nbPatterns = parseNotebookPatterns(s['faulty.notebook_ou']);
    const supEntries = parseSuppressionSignatures(s['faulty.suppress_notebook']);
    const suppressionActive = nbPatterns.length > 0 && supEntries.length > 0;

    const nbPredicate = (alias: string): string =>
      nbPatterns.length === 0 ? '1=0'
        : '(' + nbPatterns.map((_, i) => `(${alias}.ou_path LIKE @nbp${i} OR ${alias}.distinguished_name LIKE @nbp${i} OR ${alias}.name LIKE @nbp${i})`).join(' OR ') + ')';
    const supPredicate = supEntries.length === 0 ? '1=0'
      : '(' + supEntries.map((e, i) => {
          const parts: string[] = [];
          if (e.eventId !== null) parts.push(`e.event_id = @sid${i}`);
          if (e.provider !== null) parts.push(`e.provider_name LIKE @sprov${i}`);
          return '(' + parts.join(' AND ') + ')';
        }).join(' OR ') + ')';
    const supFilter = suppressionActive ? `AND NOT ( ${nbPredicate('cc')} AND ${supPredicate} )` : '';
    const supMatch = suppressionActive ? `( ${nbPredicate('cc')} AND ${supPredicate} )` : '1=0';

    const req = pool.request()
      .input('days', windowDays)
      .input('cap', cap)
      .input('wc', wc)
      .input('we', we)
      .input('ww', ww)
      .input('wb', wb)
      .input('wp', wp);
    nbPatterns.forEach((p, i) => req.input(`nbp${i}`, p));
    supEntries.forEach((e, i) => {
      if (e.eventId !== null) req.input(`sid${i}`, e.eventId);
      if (e.provider !== null) req.input(`sprov${i}`, e.provider);
    });

    const r = await req
      .query(`
        WITH sig AS (
          SELECT e.computer_id, e.level, e.event_id, e.provider_name, COUNT(*) AS cnt
          FROM events e
          JOIN computers cc ON cc.id = e.computer_id
          WHERE e.time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
            AND e.level IN (1, 2, 3)
            ${supFilter}
          GROUP BY e.computer_id, e.level, e.event_id, e.provider_name
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
          SELECT e.computer_id, COUNT(DISTINCT CAST(e.time_created AS DATE)) AS active_days
          FROM events e
          JOIN computers cc ON cc.id = e.computer_id
          WHERE e.time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
            AND e.level IN (1, 2)
            ${supFilter}
          GROUP BY e.computer_id
        ),
        sup AS (
          SELECT e.computer_id, COUNT(*) AS suppressed
          FROM events e
          JOIN computers cc ON cc.id = e.computer_id
          WHERE e.time_created >= DATEADD(DAY, -@days, SYSUTCDATETIME())
            AND e.level IN (1, 2, 3)
            AND ${supMatch}
          GROUP BY e.computer_id
        )
        SELECT c.id AS computer_id, c.name,
          a.critical, a.[error], a.warning, a.signatures,
          ISNULL(d.active_days, 0) AS active_days,
          CAST(a.weighted + a.signatures * @wb + ISNULL(d.active_days, 0) * @wp AS INT) AS score,
          sn.snoozed_until, sn.snoozed_by, sn.note AS snooze_note,
          CASE WHEN sn.snoozed_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS snoozed,
          CASE WHEN ${nbPredicate('c')} THEN 1 ELSE 0 END AS is_notebook,
          ISNULL(sup.suppressed, 0) AS suppressed
        FROM agg a
        JOIN computers c ON c.id = a.computer_id
        LEFT JOIN dys d ON d.computer_id = a.computer_id
        LEFT JOIN eventlog_snooze sn ON sn.computer_id = c.id
        LEFT JOIN sup ON sup.computer_id = c.id
        WHERE c.enabled = 1 AND c.excluded = 0
        ORDER BY score DESC
      `);

    const items = r.recordset
      .map((row) => ({
        computer_id: row.computer_id,
        name: row.name,
        critical: row.critical,
        error: row.error,
        warning: row.warning,
        signatures: row.signatures,
        active_days: row.active_days,
        score: row.score,
        level: row.score >= risk ? 'risk' : row.score >= watch ? 'watch' : 'ok',
        isNotebook: !!row.is_notebook,
        suppressed: row.suppressed ?? 0,
        snoozed: !!row.snoozed,
        snoozedUntil: row.snoozed ? row.snoozed_until : null,
        snoozedBy: row.snoozed ? row.snoozed_by : null,
        snoozeNote: row.snoozed ? (row.snooze_note ?? null) : null,
      }))
      .filter((row) => row.level !== 'ok');

    const snoozeDefaultDaysRaw = Number(s['faulty.snooze_default_days']);
    const snoozeDefaultDays = Number.isFinite(snoozeDefaultDaysRaw) && snoozeDefaultDaysRaw >= 1
      ? Math.floor(snoozeDefaultDaysRaw) : 7;

    return {
      windowDays,
      thresholdWatch: watch,
      thresholdRisk: risk,
      snoozeDefaultDays,
      scoring: { cap, weightCritical: wc, weightError: we, weightWarning: ww, weightBreadth: wb, weightPersistence: wp },
      items,
    };
  });

  // Temporary per-PC snooze of the eventlog "problem PC" tile. ALWAYS time-bounded
  // (days → snoozed_until); after expiry the PC returns to standard on its own (the
  // pc-health query treats only `snoozed_until > now` as active). The signature is
  // the authenticated user when available, else a name supplied in the body.
  const SnoozeBody = z.object({
    computer: z.string().min(1).max(256),
    days: z.coerce.number().int().min(1).max(90),
    note: z.string().max(1000).optional(),
    by: z.string().max(128).optional(),
  });

  app.post('/events/snooze', async (req, reply) => {
    const parsed = SnoozeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    const signer = sessionUser(req) ?? (parsed.data.by?.trim() || null);
    if (!signer) return reply.code(400).send({ ok: false, error: 'signature_required' });

    const pool = await getPool();
    const cr = await pool.request().input('name', parsed.data.computer)
      .query('SELECT id FROM computers WHERE name = @name');
    const computerId = cr.recordset[0]?.id as number | undefined;
    if (!computerId) return reply.code(404).send({ ok: false, error: 'computer_not_found' });

    const upd = await pool.request()
      .input('cid', computerId)
      .input('days', parsed.data.days)
      .input('by', signer)
      .input('note', parsed.data.note?.trim() || null)
      .query(`
        MERGE eventlog_snooze AS t
        USING (SELECT @cid AS computer_id) AS s ON t.computer_id = s.computer_id
        WHEN MATCHED THEN UPDATE SET
          snoozed_at = SYSUTCDATETIME(),
          snoozed_until = DATEADD(DAY, @days, SYSUTCDATETIME()),
          snoozed_by = @by, note = @note
        WHEN NOT MATCHED THEN INSERT (computer_id, snoozed_at, snoozed_until, snoozed_by, note)
          VALUES (@cid, SYSUTCDATETIME(), DATEADD(DAY, @days, SYSUTCDATETIME()), @by, @note)
        OUTPUT inserted.snoozed_until;
      `);
    const snoozedUntil = upd.recordset[0]?.snoozed_until ?? null;
    logActivity('info', 'eventlog-snooze',
      `${parsed.data.computer} uspáno na ${parsed.data.days} d (${signer})${parsed.data.note?.trim() ? ' – ' + parsed.data.note.trim() : ''}`);
    return reply.send({ ok: true, computer: parsed.data.computer, days: parsed.data.days, by: signer, snoozedUntil });
  });

  const ClearBody = z.object({ computer: z.string().min(1).max(256) });

  app.post('/events/snooze/clear', async (req, reply) => {
    const parsed = ClearBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    const signer = sessionUser(req);
    const pool = await getPool();
    const r = await pool.request().input('name', parsed.data.computer)
      .query(`
        DELETE sn FROM eventlog_snooze sn
        JOIN computers c ON c.id = sn.computer_id
        WHERE c.name = @name
      `);
    const cleared = r.rowsAffected?.[0] ?? 0;
    if (cleared > 0) {
      logActivity('info', 'eventlog-snooze',
        `${parsed.data.computer} vráceno do standardu${signer ? ' (' + signer + ')' : ''}`);
    }
    return reply.send({ ok: true, computer: parsed.data.computer, cleared });
  });
}
