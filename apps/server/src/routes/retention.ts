import type { FastifyInstance } from 'fastify';
import { runRetentionOnce, getLastRetentionReport, getRetentionNextRun, isRetentionRunning } from '../services/retention-runner.js';

export async function registerRetentionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/retention/status', async () => {
    return {
      ok: true,
      running: isRetentionRunning(),
      nextRunAt: getRetentionNextRun(),
      lastReport: getLastRetentionReport(),
    };
  });

  app.post('/api/retention/run', async (_req, reply) => {
    if (isRetentionRunning()) {
      return reply.code(409).send({ ok: false, error: 'already_running' });
    }
    try {
      const report = await runRetentionOnce('manual');
      return reply.send({ ok: true, report });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });
}
