import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { runDiskCollectorOnce } from '../services/disk-collector.js';

export async function registerDisksRoutes(app: FastifyInstance) {
  app.get('/disks', async () => {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT d.id, d.computer_id, c.name AS computer, d.drive_letter, d.volume_label,
             d.filesystem, d.total_bytes, d.free_bytes, d.collected_at
      FROM disks d
      JOIN computers c ON c.id = d.computer_id
      WHERE c.enabled = 1
      ORDER BY c.name, d.drive_letter
    `);
    return { items: r.recordset };
  });

  app.post('/disks/collect', async (_req, reply) => {
    const result = await runDiskCollectorOnce();
    if (result === null) {
      reply.code(409);
      return { error: 'Disk collector already running' };
    }
    return result;
  });
}
