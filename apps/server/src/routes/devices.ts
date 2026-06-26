import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { getAllSettings } from '../services/settings.js';
import { runMikrotikCollectOnce, runFtpFetchOnce, probeDeviceNow, suggestCategory, testRouters } from '../services/mikrotik-collector.js';
import { runUnifiCollectOnce } from '../services/unifi-collector.js';
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
  ip_history_count: number;
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
             m.os_version AS computer_os,
             (SELECT COUNT(*) FROM device_ip_history h WHERE h.mac_address = l.mac_address) AS ip_history_count
      FROM dhcp_leases l
      LEFT JOIN device_categories dc ON dc.mac_address = l.mac_address
      OUTER APPLY (
        SELECT TOP 1 c.id, c.name, c.reachable, c.os_version
        FROM computers c
        -- Pair a device to its AD computer. Strong links first:
        --   1) device hostname == computer name
        --   2) shared/USB printer: the host PC name carried in the comment
        -- Weak link (IP) ONLY for NON-dynamic addresses: a dynamic IP is not a
        -- stable identity, so matching by it could attach the device to whatever
        -- previously held that lease (or to an offline AD box still claiming the
        -- IP). Static/reservation addresses keep the IP fallback.
        WHERE (l.host_name IS NOT NULL AND LOWER(c.name) = LOWER(l.host_name))
           OR (l.source = 'share' AND l.comment IS NOT NULL AND LOWER(c.name) = LOWER(l.comment))
           OR (l.dynamic = 0 AND l.ip_address IS NOT NULL AND c.ip_address = l.ip_address)
        ORDER BY CASE
                   WHEN l.host_name IS NOT NULL AND LOWER(c.name) = LOWER(l.host_name) THEN 0
                   WHEN l.source = 'share' AND LOWER(c.name) = LOWER(l.comment) THEN 0
                   ELSE 1 END, c.name
      ) m

      UNION ALL

      -- DB IDENTITIES not currently observed: a device the operator identified
      -- (confirmed category) whose live lease/scan/share row is gone. "The info is
      -- in the DB" — so we still SHOW it (offline, last-known IP/site from the IP
      -- archive) and it stays counted, instead of vanishing. Excluded: pc/server
      -- (those AD machines live in the Computers tab) and phone (Wi-Fi phones use
      -- randomized MACs — a stale random MAC is not real equipment to resurrect).
      -- Printers / IoT / network gear — the stable equipment — are surfaced here.
      SELECT COALESCE(h.site, N'?') AS site, dc.mac_address, h.ip_address,
             NULL, NULL, NULL, N'identity', NULL, N'db', NULL, NULL, h.last_seen,
             CAST(0 AS BIT), NULL, NULL, NULL,
             dc.category, dc.name, dc.note,
             NULL, NULL, NULL, NULL,
             (SELECT COUNT(*) FROM device_ip_history h2 WHERE h2.mac_address = dc.mac_address)
      FROM device_categories dc
      OUTER APPLY (
        SELECT TOP 1 ip_address, site, last_seen
        FROM device_ip_history WHERE mac_address = dc.mac_address ORDER BY last_seen DESC
      ) h
      WHERE dc.category IS NOT NULL AND dc.category NOT IN (N'', N'pc', N'server', N'phone')
        AND NOT EXISTS (SELECT 1 FROM dhcp_leases l2 WHERE l2.mac_address = dc.mac_address)

      ORDER BY site, ip_address
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

  // Per-site FTP data-freshness status: the header timestamps of the router's
  // export files, parsed counts, when the data last advanced (file_changed_at) and
  // the last fetch error. Drives the dashboard freshness indicator + the
  // availability alert. Read-only.
  app.get('/devices/site-status', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT site, lease_file_time, arp_file_time, lease_count, arp_count,
             file_changed_at, fetched_at, last_error, updated_at,
             DATEDIFF(MINUTE, file_changed_at, SYSUTCDATETIME()) AS mins_since_change
      FROM site_data_status ORDER BY site`);
    return r.recordset;
  });

  // Per-router communication view (the "Routers" page): each configured router with
  // its FTP file-source freshness (from site_data_status), whether it is an FTP /
  // muted site, and a device count by source — the round-trip "router → FTP → DB →
  // page" surfaced read-only, scaling to however many routers are configured.
  app.get('/network/routers', async () => {
    const settings = await getAllSettings();
    const routers = (settings['mikrotik.routers'] ?? '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
      .map((tok) => { const i = tok.indexOf('='); return i > 0 ? { site: tok.slice(0, i).trim(), ip: tok.slice(i + 1).trim() } : null; })
      .filter((r): r is { site: string; ip: string } => !!r && !!r.site && !!r.ip);
    // Tolerant of the "Site=IP" form — only the name before "=" is kept.
    const csv = (v: string | undefined) => new Set((v ?? '').split(/[,;\r\n]+/).map((s) => s.split('=')[0]!.trim().toLowerCase()).filter(Boolean));
    const ftpSites = csv(settings['mikrotik.ftp_sites']);
    const muted = csv(settings['alerts.freshness.muted_sites']);
    const ftpEnabled = (settings['mikrotik.ftp_enabled'] ?? '1') === '1';
    const threshold = Number(settings['alerts.freshness.threshold_minutes'] ?? 45) || 45;

    const pool = await getPool();
    const status = (await pool.request().query<{
      site: string; lease_file_time: Date | null; arp_file_time: Date | null; lease_count: number | null;
      arp_count: number | null; file_changed_at: Date | null; fetched_at: Date | null; last_error: string | null; mins_since_change: number | null;
    }>(`
      SELECT site, lease_file_time, arp_file_time, lease_count, arp_count, file_changed_at, fetched_at, last_error,
             DATEDIFF(MINUTE, file_changed_at, SYSUTCDATETIME()) AS mins_since_change
      FROM site_data_status`)).recordset;
    const statusBySite = new Map(status.map((r) => [r.site.toLowerCase(), r]));

    const counts = (await pool.request().query<{ site: string; total: number; dhcp: number; arp: number; scan: number; unifi: number }>(`
      SELECT site, COUNT(*) AS total,
             SUM(CASE WHEN source='dhcp' THEN 1 ELSE 0 END) AS dhcp,
             SUM(CASE WHEN source='arp' THEN 1 ELSE 0 END) AS arp,
             SUM(CASE WHEN source='scan' THEN 1 ELSE 0 END) AS scan,
             SUM(CASE WHEN source='unifi' THEN 1 ELSE 0 END) AS unifi
      FROM dhcp_leases GROUP BY site`)).recordset;
    const countsBySite = new Map(counts.map((r) => [r.site.toLowerCase(), r]));

    return routers.map((r) => {
      const st = statusBySite.get(r.site.toLowerCase());
      const c = countsBySite.get(r.site.toLowerCase());
      const isFtp = ftpEnabled && ftpSites.has(r.site.toLowerCase());
      const mins = st?.mins_since_change ?? null;
      const stale = isFtp ? (!!st?.last_error || st?.file_changed_at == null || (mins != null && mins > threshold)) : null;
      return {
        site: r.site, ip: r.ip,
        ftp: isFtp, muted: muted.has(r.site.toLowerCase()),
        leaseFileTime: st?.lease_file_time ?? null, arpFileTime: st?.arp_file_time ?? null,
        leaseCount: st?.lease_count ?? null, arpCount: st?.arp_count ?? null,
        fetchedAt: st?.fetched_at ?? null, lastError: st?.last_error ?? null,
        minsSinceChange: mins, stale, thresholdMinutes: threshold,
        devices: c?.total ?? 0,
        bySource: c ? { dhcp: c.dhcp, arp: c.arp, scan: c.scan, unifi: c.unifi } : null,
      };
    });
  });

  // Raw rows straight from dhcp_leases for the Routers page "database listing" —
  // physical proof the FTP → DB round-trip landed. Newest write first.
  app.get('/network/db-rows', async (req) => {
    const q = z.object({ site: z.string().max(64).optional(), limit: z.coerce.number().min(1).max(20000).optional() }).parse(req.query);
    const limit = q.limit ?? 5000;
    const pool = await getPool();
    const rows = (await pool.request().input('site', q.site ?? null).input('limit', limit).query(`
      SELECT TOP (@limit) site, ip_address, mac_address, host_name, source, status, last_seen
      FROM dhcp_leases
      WHERE (@site IS NULL OR site = @site)
      ORDER BY last_seen DESC`)).recordset;
    const total = (await pool.request().input('site', q.site ?? null)
      .query<{ n: number }>(`SELECT COUNT(*) AS n FROM dhcp_leases WHERE (@site IS NULL OR site = @site)`)).recordset[0]!.n;
    return { items: rows, total };
  });

  // Device IP/MAC/hostname history search — "what was on IP X and for how long",
  // "where has MAC Y been", "history of hostname Z". One row per (mac, ip) the
  // archive ever saw, with the first_seen→last_seen window. Empty q = newest first.
  app.get('/devices/history', async (req) => {
    const q = z.object({ q: z.string().max(64).optional(), limit: z.coerce.number().min(1).max(2000).optional() }).parse(req.query);
    const limit = q.limit ?? 500;
    const term = (q.q ?? '').trim();
    const pool = await getPool();
    const r = await pool.request().input('q', `%${term}%`).input('hasq', term ? 1 : 0).input('limit', limit).query(`
      SELECT TOP (@limit) mac_address, ip_address, host_name, site, source, first_seen, last_seen,
             DATEDIFF(MINUTE, first_seen, last_seen) AS minutes_span
      FROM device_ip_history
      WHERE @hasq = 0 OR mac_address LIKE @q OR ip_address LIKE @q OR host_name LIKE @q
      ORDER BY last_seen DESC`);
    return { items: r.recordset };
  });

  // Force an FTP pull of the configured FTP sites now and return a per-site
  // communication log (the Routers page "fetch now" + console).
  app.post('/network/ftp-fetch', async (_req, reply) => {
    try {
      return { items: await runFtpFetchOnce() };
    } catch (err) {
      reply.code(500);
      return { error: String(err) };
    }
  });

  // IP-address archive for one device (by MAC): every IP it has been seen at, with
  // its first/last-seen window — "MAC = the permanent ID, IP = the connection log".
  app.get('/devices/ip-history', async (req) => {
    const q = z.object({ mac: z.string().min(1).max(32) }).parse(req.query);
    const pool = await getPool();
    const r = await pool.request().input('mac', q.mac.trim().toUpperCase()).query(`
      SELECT ip_address, site, source, first_seen, last_seen
      FROM device_ip_history
      WHERE mac_address = @mac
      ORDER BY last_seen DESC;
    `);
    return { items: r.recordset };
  });

  // Fast per-router MikroTik API connectivity test (no scan) for Settings.
  app.post('/mikrotik/test', async () => {
    return testRouters();
  });

  // Connectivity status of the API-based collectors (MikroTik routers, UniFi
  // controller) for the Settings page: the latest activity_log entry per source
  // (level says ok/error) + the timestamp of the last NON-error entry (last ok).
  app.get('/integrations/status', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      WITH ranked AS (
        SELECT source, ts, level, message,
               ROW_NUMBER() OVER (PARTITION BY source ORDER BY ts DESC, id DESC) AS rn
        FROM activity_log
        WHERE source IN ('mikrotik', 'unifi')
      ),
      lastok AS (
        SELECT source, MAX(ts) AS last_ok
        FROM activity_log
        WHERE source IN ('mikrotik', 'unifi') AND level IN ('info', 'success')
        GROUP BY source
      )
      SELECT k.source, k.ts, k.level, k.message, o.last_ok
      FROM ranked k LEFT JOIN lastok o ON o.source = k.source
      WHERE k.rn = 1;
    `);
    const items: Record<string, { ts: string; level: string; message: string; lastOk: string | null }> = {};
    for (const row of r.recordset as Array<{ source: string; ts: string; level: string; message: string; last_ok: string | null }>) {
      items[row.source] = { ts: row.ts, level: row.level, message: row.message, lastOk: row.last_ok };
    }
    return { items };
  });

  // Manual one-off pull of the UniFi controller's connected-client list.
  app.post('/unifi/run', async (_req, reply) => {
    try {
      const result = await runUnifiCollectOnce();
      if (result === null) {
        reply.code(409);
        return { error: 'UniFi collect already running' };
      }
      return result;
    } catch (err) {
      app.log.error({ err }, 'UniFi collect failed');
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
