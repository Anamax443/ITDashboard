import type { FastifyInstance } from 'fastify';
import { sendDiskAlertTest } from '../services/alerts.js';

export async function registerAlertsRoutes(app: FastifyInstance) {
  // Manual test from the Settings page — sends the current monitored-disk
  // state to the configured recipients regardless of the enable flag / throttle
  // so the operator can verify SMTP + recipients are wired correctly.
  app.post('/alerts/disk/test', async (_req, reply) => {
    try {
      const result = await sendDiskAlertTest();
      return { ok: true, ...result };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: String(err).split('\n')[0] };
    }
  });
}
