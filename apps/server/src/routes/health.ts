import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/health/db', async () => {
    const pool = await getPool();
    const r = await pool.request().query<{ v: number }>('SELECT 1 AS v');
    return { ok: r.recordset[0]?.v === 1 };
  });
}
