import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';

// Database footprint overview for the "Database" tab: total DB size (data + log),
// how much of the data file is actually used, and a per-table breakdown (rows +
// reserved/used/data KB) so the operator can see which tables eat the space.
// Read-only catalog queries — no app tables touched.

interface TableStat {
  table_name: string;
  row_count: number;
  reserved_kb: number;
  used_kb: number;
  data_kb: number;
}

export async function registerDatabaseRoutes(app: FastifyInstance) {
  app.get('/database', async (_req, reply) => {
    try {
      const pool = await getPool();

      // Per-table: row count (clustered/heap only) + reserved/used/data pages
      // (8 KB each) across all of the table's indexes/partitions.
      const tablesRes = await pool.request().query<TableStat>(`
        SELECT
          t.name AS table_name,
          SUM(CASE WHEN i.index_id IN (0,1) THEN p.rows ELSE 0 END) AS row_count,
          SUM(a.total_pages) * 8 AS reserved_kb,
          SUM(a.used_pages) * 8 AS used_kb,
          SUM(CASE WHEN a.type = 1 THEN a.data_pages ELSE 0 END) * 8 AS data_kb
        FROM sys.tables t
        JOIN sys.indexes i ON i.object_id = t.object_id
        JOIN sys.partitions p ON p.object_id = i.object_id AND p.index_id = i.index_id
        JOIN sys.allocation_units a ON a.container_id = p.partition_id
        WHERE t.is_ms_shipped = 0
        GROUP BY t.name
        ORDER BY SUM(a.total_pages) DESC
      `);

      // Whole-DB file sizes (data vs log) and how much of the data file is used.
      const dbRes = await pool.request().query<{
        name: string;
        data_kb: number;
        log_kb: number;
        total_kb: number;
        data_used_kb: number;
      }>(`
        SELECT
          DB_NAME() AS name,
          SUM(CASE WHEN type_desc = 'ROWS' THEN CAST(size AS BIGINT) ELSE 0 END) * 8 AS data_kb,
          SUM(CASE WHEN type_desc = 'LOG'  THEN CAST(size AS BIGINT) ELSE 0 END) * 8 AS log_kb,
          SUM(CAST(size AS BIGINT)) * 8 AS total_kb,
          SUM(CASE WHEN type_desc = 'ROWS' THEN CAST(FILEPROPERTY(name, 'SpaceUsed') AS BIGINT) ELSE 0 END) * 8 AS data_used_kb
        FROM sys.database_files
      `);

      return { db: dbRes.recordset[0], tables: tablesRes.recordset };
    } catch (err) {
      app.log.error({ err }, 'database overview failed');
      reply.code(500);
      return { error: String(err).split('\n')[0] };
    }
  });
}
