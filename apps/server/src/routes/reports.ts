import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildOverviewReport, sendOverviewReportEmail } from '../services/reports.js';

export async function registerReportsRoutes(app: FastifyInstance) {
  // Structured fleet overview for the Reporting tab (cheap, table-only).
  app.get('/reports/overview', async () => {
    return await buildOverviewReport();
  });

  // On-demand email of the overview to the reports recipients (falls back to the
  // shared alerts.recipients when the per-agenda list is empty). An optional
  // machines[] limits the email to the operator's checkbox selection.
  const EmailBody = z.object({ machines: z.array(z.string()).optional() }).optional();
  app.post('/reports/email', async (req, reply) => {
    try {
      const body = EmailBody.parse(req.body);
      const result = await sendOverviewReportEmail(body?.machines);
      return { ok: true, ...result };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: String(err).split('\n')[0] };
    }
  });
}
