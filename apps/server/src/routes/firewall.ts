import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAllowedIPs, setAllowedIPs } from '../services/firewall.js';

export async function registerFirewallRoutes(app: FastifyInstance) {
  app.get('/firewall/whitelist', async (_req, reply) => {
    try {
      const ips = await getAllowedIPs();
      return { ips };
    } catch (err) {
      reply.code(500);
      return { error: String(err) };
    }
  });

  app.put('/firewall/whitelist', async (req, reply) => {
    const body = z.object({ ips: z.array(z.string().min(1)).min(1) }).parse(req.body);
    try {
      await setAllowedIPs(body.ips);
      return { ips: body.ips };
    } catch (err) {
      app.log.error({ err }, 'Failed to update firewall whitelist');
      reply.code(500);
      return { error: String(err) };
    }
  });
}
