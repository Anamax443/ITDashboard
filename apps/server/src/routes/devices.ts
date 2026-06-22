import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { runMikrotikCollectOnce, probeDeviceNow, suggestCategory } from '../services/mikrotik-collector.js';
import { runSharedPrintersOnce } from '../services/shared-printers-collector.js';

// Device categories are operator-configurable (Settings → devices.categories),
// so any non-empty string up to 32 chars is accepted; '' clears the assignment.
const categorySchema = z.string().max(32);

interface DeviceRow {
  site: string;
  mac_address: string;
  ip_address: string | null;
  host_name: string | null;
  server: string | null;
  comment: string | null;
  status: string | null;
  dynamic: boolean | null;
  source: string | null;
  expires_after: string | null;
  router_last_seen: string | null;
  last_seen: string;
  reachable: boolean | null;
  packet_loss: number | null;
  latency_ms: number | null;
  reach_checked_at: string | null;
  category: string | null;
  operator_name: string | null;
  operator_note: string | null;
  computer_id: number | null;
  computer_name: string | null;
  computer_reachable: boolean | null;
  computer_os: string | null;
}

export async function registerDevicesRoutes(app: FastifyInstance) {
  // All DHCP-discovered devices, each paired with its AD computer (by host_name,
  // fallback IP) and its operator category. `suggested` is a UI-only hint.
  app.get('/devices', async () => {
    const pool = await getPool();
    const r = await pool.request().query<DeviceRow>(`
      SELECT l.site, l.mac_address, l.ip_address, l.host_name, l.server, l.comment,
             l.status, l.dynamic, l.source, l.expires_after, l.router_last_seen, l.last_seen,
             l.reachable, l.packet_loss, l.latency_ms, l.reach_checked_at,
             dc.category, dc.name AS operator_name, dc.note AS operator_note,
             m.id AS computer_id, m.name AS computer_name, m.reachable AS computer_reachable,
             m.os_version AS computer_os
      FROM dhcp_leases l
      LEFT JOIN device_categories dc ON dc.mac_address = l.mac_address
      OUTER APPLY (
        SELECT TOP 1 c.id, c.name, c.reachable, c.os_version
        FROM computers c
        WHERE (l.host_name IS NOT NULL AND LOWER(c.name) = LOWER(l.host_name))
           OR (l.ip_address IS NOT NULL AND c.ip_address = l.ip_address)
        ORDER BY CASE WHEN l.host_name IS NOT NULL AND LOWER(c.name) = LOWER(l.host_name) THEN 0 ELSE 1 END, c.name
      ) m
      ORDER BY l.site, l.ip_address
    `);
    // `suggested` is a UI pre-select hint: a device matched to an AD computer is
    // pre-selected pc/server from its AD os_version (we already know the type);
    // unmatched devices fall back to the OUI/hostname printer/phone heuristic.
    const items = r.recordset.map((d) => ({
      ...d,
      suggested: d.computer_id != null
        ? (/server/i.test(d.computer_os ?? '') ? 'server' : 'pc')
        : suggestCategory(d.host_name, d.mac_address),
    }));
    return { items };
  });

  // Set / clear the operator category for a MAC (persists across reloads).
  app.patch('/devices/category', async (req, reply) => {
    const body = z.object({
      mac: z.string().min(1).max(32),
      category: categorySchema,
      note: z.string().max(255).optional(),
    }).parse(req.body);
    const mac = body.mac.trim().toUpperCase();
    const pool = await getPool();
    if (body.category === '') {
      // Clear the category but keep the row if it still carries an operator name.
      await pool.request().input('mac', mac).query(`
        UPDATE device_categories SET category = NULL, updated_at = SYSUTCDATETIME() WHERE mac_address = @mac;
        DELETE FROM device_categories WHERE mac_address = @mac AND (name IS NULL OR name = '');
      `);
      return { mac, category: '' };
    }
    await pool.request().input('mac', mac).input('cat', body.category).input('note', body.note ?? null).query(`
      MERGE device_categories AS t USING (SELECT @mac AS mac) AS s ON t.mac_address = s.mac
      WHEN MATCHED THEN UPDATE SET category = @cat, note = COALESCE(@note, t.note), updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (mac_address, category, note) VALUES (@mac, @cat, @note);
    `);
    return { mac, category: body.category };
  });

  // Set / clear an operator note for a MAC (free text, persists like the name /
  // category; independent of them so a note survives a category change).
  app.patch('/devices/note', async (req) => {
    const body = z.object({ mac: z.string().min(1).max(32), note: z.string().max(255) }).parse(req.body);
    const mac = body.mac.trim().toUpperCase();
    const note = body.note.trim();
    const pool = await getPool();
    if (note === '') {
      await pool.request().input('mac', mac).query(`
        UPDATE device_categories SET note = NULL, updated_at = SYSUTCDATETIME() WHERE mac_address = @mac;
        DELETE FROM device_categories WHERE mac_address = @mac AND note IS NULL AND name IS NULL AND (category IS NULL OR category = '');
      `);
      return { mac, note: '' };
    }
    await pool.request().input('mac', mac).input('note', note).query(`
      MERGE device_categories AS t USING (SELECT @mac AS mac) AS s ON t.mac_address = s.mac
      WHEN MATCHED THEN UPDATE SET note = @note, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (mac_address, note) VALUES (@mac, @note);
    `);
    return { mac, note };
  });

  // Set / clear an operator-edited device name for a MAC (persists across reloads
  // and collector overwrites; empty clears it). Stored in device_categories.
  app.patch('/devices/name', async (req) => {
    const body = z.object({ mac: z.string().min(1).max(32), name: z.string().max(255) }).parse(req.body);
    const mac = body.mac.trim().toUpperCase();
    const name = body.name.trim();
    const pool = await getPool();
    if (name === '') {
      await pool.request().input('mac', mac).query(`
        UPDATE device_categories SET name = NULL, updated_at = SYSUTCDATETIME() WHERE mac_address = @mac;
        DELETE FROM device_categories WHERE mac_address = @mac AND name IS NULL AND (category IS NULL OR category = '');
      `);
      return { mac, name: '' };
    }
    await pool.request().input('mac', mac).input('name', name).query(`
      MERGE device_categories AS t USING (SELECT @mac AS mac) AS s ON t.mac_address = s.mac
      WHEN MATCHED THEN UPDATE SET name = @name, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (mac_address, name) VALUES (@mac, @name);
    `);
    return { mac, name };
  });

  // Manual one-off pull of every configured router — on demand from the tab.
  app.post('/devices/run', async (_req, reply) => {
    try {
      const result = await runMikrotikCollectOnce();
      if (result === null) {
        reply.code(409);
        return { error: 'DHCP collect already running' };
      }
      return result;
    } catch (err) {
      app.log.error({ err }, 'DHCP collect failed');
      reply.code(500);
      return { error: String(err) };
    }
  });

  // Manual run of the shared/USB-printer scan (net view across reachable PCs).
  app.post('/shared-printers/run', async (_req, reply) => {
    try {
      const result = await runSharedPrintersOnce();
      if (result === null) { reply.code(409); return { error: 'Shared-printers scan already running' }; }
      return result;
    } catch (err) {
      app.log.error({ err }, 'shared-printers run failed');
      reply.code(500);
      return { error: String(err) };
    }
  });

  // Live ICMP ping of one device (per-row "Ping" → console modal).
  app.post('/devices/probe', async (req, reply) => {
    const body = z.object({
      site: z.string().min(1).max(64),
      mac: z.string().min(1).max(32),
      ip: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
    }).parse(req.body);
    try {
      const result = await probeDeviceNow(body.site, body.mac.trim().toUpperCase(), body.ip);
      return result;
    } catch (err) {
      app.log.error({ err, ip: body.ip }, 'device probe failed');
      reply.code(500);
      return { error: String(err) };
    }
  });
}
