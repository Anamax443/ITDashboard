import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { runCrashDumpCollectOnce, isCrashCollectRunning, getCrashCollectStatus } from '../services/crash-dump-collector.js';
import { runCrashAnalyzeOnce, isCrashAnalyzeRunning } from '../services/crash-analyzer-worker.js';
import { getAllSettings } from '../services/settings.js';

export async function registerCrashRoutes(app: FastifyInstance): Promise<void> {
  // List (no blob / no full text — light).
  app.get('/crashes', async () => {
    const pool = await getPool();
    const items = (await pool.request().query(`
      SELECT TOP 500 id, computer_id, computer_name, source_filename, occurred_at, size_bytes,
             status, stop_code, bugcheck_name, hot_function, culprit_process, culprit_module,
             analyze_error, ingested_at, analyzed_at
      FROM crash_dumps ORDER BY occurred_at DESC, id DESC`)).recordset;
    return { items, running: isCrashCollectRunning() || isCrashAnalyzeRunning() };
  });

  // Collection status for the Pády page: when dumps were last pulled, the last
  // write to SQL (MAX ingested_at), and the next scheduled pull (derived live from
  // crash.interval_sec). Read-only.
  app.get('/crashes/status', async () => {
    const pool = await getPool();
    const agg = (await pool.request().query<{ last_write: Date | null; last_analyzed: Date | null; total: number; pending: number }>(`
      SELECT MAX(ingested_at) AS last_write, MAX(analyzed_at) AS last_analyzed,
             COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
      FROM crash_dumps`)).recordset[0]!;
    const s = await getAllSettings();
    const enabled = ['1', 'true', 'yes', 'on'].includes((s['crash.enabled'] ?? '').toLowerCase());
    const iv = Number(s['crash.interval_sec']);
    const intervalSec = Number.isFinite(iv) && iv >= 60 ? iv : 3600;
    const cs = getCrashCollectStatus();
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      enabled, intervalSec,
      running: cs.running || isCrashAnalyzeRunning(),
      lastRunAt: iso(cs.lastRunAt),
      nextRunAt: enabled ? iso(cs.nextRunAt) : null,
      lastResult: cs.lastResult,
      lastSqlWriteAt: iso(agg.last_write),
      lastAnalyzedAt: iso(agg.last_analyzed),
      total: agg.total ?? 0,
      pending: agg.pending ?? 0,
    };
  });

  // Detail (incl. full cdb output for the report).
  app.get<{ Params: { id: string } }>('/crashes/:id', async (req, reply) => {
    const pool = await getPool();
    const r = (await pool.request().input('id', Number(req.params.id))
      .query(`SELECT id, computer_id, computer_name, source_filename, occurred_at, size_bytes, status,
                stop_code, bugcheck_name, hot_function, culprit_process, culprit_module,
                analyze_text, analyze_error, ingested_at, analyzed_at
              FROM crash_dumps WHERE id=@id`)).recordset[0];
    if (!r) { reply.code(404); return { error: 'not_found' }; }
    return r;
  });

  // Download the raw .dmp (blob → file).
  app.get<{ Params: { id: string } }>('/crashes/:id/dmp', async (req, reply) => {
    const pool = await getPool();
    const r = (await pool.request().input('id', Number(req.params.id))
      .query<{ source_filename: string; dmp_blob: Buffer | null }>(
        `SELECT source_filename, dmp_blob FROM crash_dumps WHERE id=@id`)).recordset[0];
    if (!r || !r.dmp_blob) { reply.code(404); return { error: 'not_found' }; }
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${r.source_filename}"`);
    return reply.send(r.dmp_blob);
  });

  // Manual run: collect new dumps then analyze the pending ones.
  app.post('/crashes/run', async () => {
    const collect = await runCrashDumpCollectOnce();
    const analyze = await runCrashAnalyzeOnce(20);
    return { ok: true, collect, analyze };
  });
}
