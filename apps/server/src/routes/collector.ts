import type { FastifyInstance } from 'fastify';
import { runCollectorOnce, getCollectorStatus } from '../services/eventlog-collector.js';

export async function registerCollectorRoutes(app: FastifyInstance) {
  app.get('/collector/status', async () => getCollectorStatus());

  app.post('/collector/run', async (_req, reply) => {
    try {
      const result = await runCollectorOnce('manual');
      if (result === null) {
        reply.code(409);
        return { error: 'Collector already running' };
      }
      return result;
    } catch (err) {
      app.log.error({ err }, 'Collector run failed');
      reply.code(500);
      return { error: String(err) };
    }
  });
}
