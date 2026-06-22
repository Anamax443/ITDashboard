import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAllSettings, setSettings } from '../services/settings.js';
import { rescheduleChecks } from '../services/checks-runner.js';
import { encryptSecret } from '../services/secret-crypto.js';

// Settings keys holding a secret: stored encrypted (key + '_enc'), never
// returned to the client in the clear, and shown as this mask in the UI.
const SECRET_KEYS = ['mikrotik.password', 'unifi.password'] as const;
const MASK = '••••••••';

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/settings', async () => {
    const map = await getAllSettings();
    // For each secret: never expose the ciphertext; show a mask if one is set.
    for (const k of SECRET_KEYS) {
      const enc = map[`${k}_enc`];
      delete map[`${k}_enc`];
      map[k] = enc ? MASK : '';
    }
    return map;
  });

  app.put('/settings', async (req) => {
    const body = z.record(z.string(), z.string()).parse(req.body);

    // Encrypt secret fields into their *_enc counterpart; never persist the
    // plaintext key. An incoming mask (or unchanged) means "leave as is".
    for (const k of SECRET_KEYS) {
      if (k in body) {
        const v = body[k] ?? '';
        delete body[k];
        if (v === MASK) continue;            // unchanged — keep existing _enc
        body[`${k}_enc`] = v === '' ? '' : encryptSecret(v);  // empty clears it
      }
    }

    await setSettings(body);

    // Apply periodic check interval live without restarting service.
    if (body['checks.interval_sec']) {
      rescheduleChecks(Number(body['checks.interval_sec']));
    }
    return { updated: Object.keys(body).length };
  });
}
