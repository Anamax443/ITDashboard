import type { FastifyInstance } from 'fastify';
import { runCollectorOnce, getCollectorStatus, stopCollector } from '../services/eventlog-collector.js';
import { runAllChecksOnce } from '../services/checks-runner.js';
import { runReachabilityProbeOnce } from '../services/reachability-collector.js';

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

  app.post('/collector/stop', async (_req, reply) => {
    const stopped = stopCollector();
    if (!stopped) {
      reply.code(409);
      return { error: 'Collector not running' };
    }
    return { stopped: true };
  });

  app.post('/collector/run-all', async (_req, reply) => {
    try {
      const result = await runAllChecksOnce('manual');
      if (result === null) {
        reply.code(409);
        return { error: 'Checks already running' };
      }
      return result;
    } catch (err) {
      app.log.error({ err }, 'Run all checks failed');
      reply.code(500);
      return { error: String(err) };
    }
  });

  // Manual one-off reachability (Status) probe — same code the standalone timer
  // runs, on demand from the Settings page.
  app.post('/reachability/run', async (_req, reply) => {
    try {
      const result = await runReachabilityProbeOnce();
      if (result === null) {
        reply.code(409);
        return { error: 'Reachability probe already running' };
      }
      return result;
    } catch (err) {
      app.log.error({ err }, 'Reachability probe failed');
      reply.code(500);
      return { error: String(err) };
    }
  });
}
