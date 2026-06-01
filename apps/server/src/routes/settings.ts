import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAllSettings, setSettings } from '../services/settings.js';

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/settings', async () => {
    const map = await getAllSettings();
    return map;
  });

  app.put('/settings', async (req) => {
    const body = z.record(z.string(), z.string()).parse(req.body);
    await setSettings(body);
    return { updated: Object.keys(body).length };
  });
}
