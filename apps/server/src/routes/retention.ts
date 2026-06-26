import type { FastifyInstance } from 'fastify';
import { runRetentionOnce, getLastRetentionReport, getRetentionNextRun, isRetentionRunning, type RetentionStepName } from '../services/retention-runner.js';

const VALID_STEPS: RetentionStepName[] = ['events_purge', 'activity_log_purge', 'pc_user_history_purge', 'perf_purge', 'ad_sync_runs_purge', 'events_dedup'];

export async function registerRetentionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/retention/status', async () => {
    return {
      ok: true,
      running: isRetentionRunning(),
      nextRunAt: getRetentionNextRun(),
      lastReport: getLastRetentionReport(),
    };
  });

  app.post<{ Body?: { steps?: string[] } }>('/api/retention/run', async (req, reply) => {
    if (isRetentionRunning()) {
      return reply.code(409).send({ ok: false, error: 'already_running' });
    }
    let stepsFilter: RetentionStepName[] | undefined;
    const requested = req.body?.steps;
    if (Array.isArray(requested)) {
      stepsFilter = requested.filter((s): s is RetentionStepName => (VALID_STEPS as string[]).includes(s));
      if (stepsFilter.length === 0) {
        return reply.code(400).send({ ok: false, error: 'no_valid_steps' });
      }
    }
    try {
      const report = await runRetentionOnce('manual', stepsFilter);
      return reply.send({ ok: true, report });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });
}
