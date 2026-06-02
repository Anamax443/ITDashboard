import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAllSettings, setSettings } from '../services/settings.js';
import { rescheduleCollector } from '../services/eventlog-collector.js';
import { rescheduleDisk } from '../services/disk-collector.js';
import { rescheduleServices } from '../services/services-collector.js';

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/settings', async () => {
    const map = await getAllSettings();
    return map;
  });

  app.put('/settings', async (req) => {
    const body = z.record(z.string(), z.string()).parse(req.body);
    await setSettings(body);

    // Apply interval changes live without restarting service
    if (body['collector.interval_sec']) {
      rescheduleCollector(Number(body['collector.interval_sec']));
    }
    if (body['disk.interval_sec']) {
      rescheduleDisk(Number(body['disk.interval_sec']));
    }
    if (body['services.interval_sec']) {
      rescheduleServices(Number(body['services.interval_sec']));
    }
    return { updated: Object.keys(body).length };
  });
}
