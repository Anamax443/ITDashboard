import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAllowedIPs, setAllowedIPs, getDomainProfileStatus } from '../services/firewall.js';
import { refreshIpGuard, getCurrentWhitelist, isIpAllowed, normalizeRequestIp } from '../services/ip-guard.js';

export async function registerFirewallRoutes(app: FastifyInstance) {
  // Called by the frontend on mount to decide whether to render the dashboard
  // or the "access not configured" screen. Always returns 200 — the gate is
  // expressed in the `allowed` field, not the HTTP status.
  app.get('/access-check', async (req) => {
    const ip = normalizeRequestIp(req.ip);
    return { ip, allowed: isIpAllowed(req.ip) };
  });

  app.get('/firewall/domain-profile', async () => {
    return await getDomainProfileStatus();
  });

  app.get('/firewall/whitelist', async (_req, reply) => {
    try {
      const ips = await getAllowedIPs();
      return { ips, appLayerCache: getCurrentWhitelist() };
    } catch (err) {
      reply.code(500);
      return { error: String(err) };
    }
  });

  app.put('/firewall/whitelist', async (req, reply) => {
    const body = z.object({ ips: z.array(z.string().min(1)).min(1) }).parse(req.body);
    try {
      await setAllowedIPs(body.ips);
      await refreshIpGuard('update');
      return { ips: body.ips, appLayerCache: getCurrentWhitelist() };
    } catch (err) {
      app.log.error({ err }, 'Failed to update firewall whitelist');
      reply.code(500);
      return { error: String(err) };
    }
  });
}
