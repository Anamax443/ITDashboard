import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { runCrashDumpCollectOnce, isCrashCollectRunning } from '../services/crash-dump-collector.js';
import { runCrashAnalyzeOnce, isCrashAnalyzeRunning } from '../services/crash-analyzer-worker.js';

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
