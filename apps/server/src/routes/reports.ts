import type { FastifyInstance } from 'fastify';
import { buildOverviewReport, sendOverviewReportEmail } from '../services/reports.js';

export async function registerReportsRoutes(app: FastifyInstance) {
  // Structured fleet overview for the Reporting tab (cheap, table-only).
  app.get('/reports/overview', async () => {
    return await buildOverviewReport();
  });

  // On-demand email of the same overview to the reports recipients (falls back
  // to the shared alerts.recipients when the per-agenda list is empty).
  app.post('/reports/email', async (_req, reply) => {
    try {
      const result = await sendOverviewReportEmail();
      return { ok: true, ...result };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: String(err).split('\n')[0] };
    }
  });
}
