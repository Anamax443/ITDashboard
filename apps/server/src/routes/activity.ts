import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRecent } from '../services/activity-log.js';

export async function registerActivityRoutes(app: FastifyInstance) {
  app.get('/activity/log', async (req) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(200),
      sinceSeq: z.coerce.number().int().optional(),
    }).parse(req.query);
    return getRecent(q.limit, q.sinceSeq);
  });
}
