import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { BUILD_SHA_SHORT, BUILT_AT } from '../build-info.js';

interface HealthStatus {
  status: 'ok' | 'db_down';
  ts: string;
  buildSha: string;
  builtAt: string;
  db: { ok: boolean; latencyMs: number | null; error?: string };
}

// /health is the canonical liveness + readiness probe. Returns 200 if
// API process is up; reflects DB reachability in body so Centreon (or any
// HTTP probe) can alert specifically on db_down without false-positives
// when the API itself is fine but the DB is degraded. 503 only when DB is
// fully down — we still want the body parseable to surface diagnostics.
export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    const t0 = Date.now();
    let dbOk = false;
    let dbError: string | undefined;
    try {
      const pool = await getPool();
      const r = await pool.request().query<{ v: number }>('SELECT 1 AS v');
      dbOk = r.recordset[0]?.v === 1;
    } catch (err) {
      dbError = String(err).split('\n')[0]?.slice(0, 200);
    }
    const latencyMs = Date.now() - t0;
    const body: HealthStatus = {
      status: dbOk ? 'ok' : 'db_down',
      ts: new Date().toISOString(),
      buildSha: BUILD_SHA_SHORT,
      builtAt: BUILT_AT,
      db: { ok: dbOk, latencyMs: dbOk ? latencyMs : null, ...(dbError ? { error: dbError } : {}) },
    };
    if (!dbOk) reply.code(503);
    return body;
  });

  // Legacy DB-only probe kept for backwards compat — existing scripts may poll it.
  app.get('/health/db', async () => {
    const pool = await getPool();
    const r = await pool.request().query<{ v: number }>('SELECT 1 AS v');
    return { ok: r.recordset[0]?.v === 1 };
  });
}
