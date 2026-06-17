import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { getSetting } from '../services/settings.js';
import { runPrinterSuppliesOnce } from '../services/printer-supplies-collector.js';

// Printer supply levels (Stav tiskáren page). Returns one entry per printer with
// its supplies, joined to the live device inventory for IP / hostname / site /
// category. Read-only; the collector populates printer_supplies on its own timer.

interface SupplyRow {
  mac_address: string;
  supply_key: string;
  supply_index: number;
  description: string | null;
  colorant: string | null;
  supply_type: string | null;
  level_pct: number | null;
  part_code: string | null;
  model: string | null;
  source: string | null;
  collected_at: string;
  ip_address: string | null;
  host_name: string | null;
  operator_name: string | null;
  site: string | null;
}

export async function registerPrinterSuppliesRoutes(app: FastifyInstance) {
  app.get('/printer-supplies', async () => {
    const pool = await getPool();
    const r = await pool.request().query<SupplyRow>(`
      SELECT ps.mac_address, ps.supply_key, ps.supply_index, ps.description, ps.colorant,
             ps.supply_type, ps.level_pct, ps.part_code, ps.model, ps.source, ps.collected_at,
             l.ip_address, l.host_name, dc.name AS operator_name, l.site
      FROM printer_supplies ps
      LEFT JOIN dhcp_leases l ON l.mac_address = ps.mac_address
      LEFT JOIN device_categories dc ON dc.mac_address = ps.mac_address
      ORDER BY l.site, l.ip_address, ps.supply_index
    `);
    // Group flat rows into one object per printer (keyed by MAC).
    const byMac = new Map<string, {
      mac_address: string; ip_address: string | null; host_name: string | null;
      operator_name: string | null; site: string | null; model: string | null; collected_at: string;
      supplies: Array<{ key: string; description: string | null; colorant: string | null; type: string | null; level_pct: number | null; part_code: string | null; source: string | null }>;
    }>();
    for (const row of r.recordset) {
      let p = byMac.get(row.mac_address);
      if (!p) {
        p = {
          mac_address: row.mac_address, ip_address: row.ip_address, host_name: row.host_name,
          operator_name: row.operator_name, site: row.site, model: row.model, collected_at: row.collected_at,
          supplies: [],
        };
        byMac.set(row.mac_address, p);
      }
      if (row.collected_at > p.collected_at) p.collected_at = row.collected_at;
      p.supplies.push({
        key: row.supply_key, description: row.description, colorant: row.colorant,
        type: row.supply_type, level_pct: row.level_pct, part_code: row.part_code, source: row.source,
      });
    }
    const lowPct = Number(await getSetting('printer_supplies.low_pct', '15')) || 15;
    return { lowPct, printers: Array.from(byMac.values()) };
  });

  // Manual one-off collection — on demand from the page.
  app.post('/printer-supplies/run', async (_req, reply) => {
    try {
      const result = await runPrinterSuppliesOnce();
      if (result === null) { reply.code(409); return { error: 'Printer supplies collect already running' }; }
      return result;
    } catch (err) {
      app.log.error({ err }, 'Printer supplies collect failed');
      reply.code(500);
      return { error: String(err) };
    }
  });
}
