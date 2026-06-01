import sql from 'mssql/msnodesqlv8.js';

let poolPromise: Promise<sql.ConnectionPool> | null = null;

/**
 * Uses msnodesqlv8 driver for true Windows SSPI / Integrated Auth.
 * The API service runs under svc-itdashboard; the SQL login is mapped to that
 * Windows account, so no password is ever in config or memory.
 */
export function getPool(): Promise<sql.ConnectionPool> {
  if (poolPromise) return poolPromise;

  const host = process.env.SQL_HOST ?? 'localhost';
  const instance = process.env.SQL_INSTANCE;
  const database = process.env.SQL_DATABASE ?? 'ITDashboard';
  const server = instance ? `${host}\\${instance}` : host;

  const config: sql.config = {
    server,
    database,
    options: {
      trustedConnection: true,
      trustServerCertificate: true,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  } as sql.config;

  poolPromise = new sql.ConnectionPool(config).connect();
  return poolPromise!;
}
