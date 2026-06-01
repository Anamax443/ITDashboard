import sql from 'mssql';

let poolPromise: Promise<sql.ConnectionPool> | null = null;

export function getPool(): Promise<sql.ConnectionPool> {
  if (poolPromise) return poolPromise;

  const trusted = (process.env.SQL_TRUSTED_CONNECTION ?? 'true') === 'true';
  const config: sql.config = {
    server: process.env.SQL_HOST ?? 'localhost',
    database: process.env.SQL_DATABASE ?? 'ITDashboard',
    options: {
      instanceName: process.env.SQL_INSTANCE,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    ...(trusted
      ? { authentication: { type: 'ntlm', options: { domain: '', userName: '', password: '' } } as never }
      : { user: process.env.SQL_USER, password: process.env.SQL_PASSWORD }),
  };

  poolPromise = new sql.ConnectionPool(config).connect();
  return poolPromise!;
}
