import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { runPortStatusProbeOnce } from '../services/port-status-collector.js';

interface PortRow {
  id: number;
  name: string;
  fqdn: string | null;
  ip_address: string | null;
  reachable: boolean | null;
  reach_checked_at: string | null;
  check_name: string | null;
  port: number | null;
  is_open: boolean | null;
  latency_ms: number | null;
  checked_at: string | null;
}

export interface PortStatusComputer {
  id: number;
  name: string;
  fqdn: string | null;
  ip_address: string | null;
  reachable: boolean | null;
  reach_checked_at: string | null;
  ports: Array<{ check_name: string; port: number; is_open: boolean; latency_ms: number | null; checked_at: string }>;
}

export async function registerPortStatusRoutes(app: FastifyInstance) {
  // Grid feed: every monitored PC with its latest per-port verdict. Ports come
  // from the standalone port-status probe (or a per-PC refresh); a PC with no
  // rows yet (never probed) returns an empty `ports` array.
  app.get('/port-status', async () => {
    const pool = await getPool();
    const r = await pool.request().query<PortRow>(`
      SELECT c.id, c.name, c.fqdn, c.ip_address, c.reachable, c.reach_checked_at,
             ps.check_name, ps.port, ps.is_open, ps.latency_ms, ps.checked_at
      FROM computers c
      LEFT JOIN port_status ps ON ps.computer_id = c.id
      WHERE c.enabled = 1 AND c.excluded = 0
      ORDER BY c.name, ps.check_name
    `);
    const byId = new Map<number, PortStatusComputer>();
    for (const row of r.recordset) {
      let pc = byId.get(row.id);
      if (!pc) {
        pc = {
          id: row.id, name: row.name, fqdn: row.fqdn, ip_address: row.ip_address,
          reachable: row.reachable, reach_checked_at: row.reach_checked_at, ports: [],
        };
        byId.set(row.id, pc);
      }
      if (row.check_name != null && row.port != null && row.is_open != null && row.checked_at != null) {
        pc.ports.push({
          check_name: row.check_name, port: row.port, is_open: row.is_open,
          latency_ms: row.latency_ms, checked_at: row.checked_at,
        });
      }
    }
    return { items: Array.from(byId.values()) };
  });

  // Manual one-off probe of every PC's ports — same code the standalone timer
  // runs, on demand from the Ports tab ("Probe now").
  app.post('/port-status/run', async (_req, reply) => {
    try {
      const result = await runPortStatusProbeOnce();
      if (result === null) {
        reply.code(409);
        return { error: 'Port status probe already running' };
      }
      return result;
    } catch (err) {
      app.log.error({ err }, 'Port status probe failed');
      reply.code(500);
      return { error: String(err) };
    }
  });
}
