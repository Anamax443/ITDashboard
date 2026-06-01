import { getPool } from '../db/pool.js';

export type SettingsMap = Record<string, string>;

export async function getAllSettings(): Promise<SettingsMap> {
  const pool = await getPool();
  const r = await pool.request().query<{ key: string; value: string }>(`SELECT [key], [value] FROM settings`);
  const map: SettingsMap = {};
  for (const row of r.recordset) map[row.key] = row.value;
  return map;
}

export async function getSetting(key: string, fallback?: string): Promise<string | undefined> {
  const pool = await getPool();
  const r = await pool.request().input('k', key).query<{ value: string }>(`SELECT [value] FROM settings WHERE [key] = @k`);
  return r.recordset[0]?.value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const pool = await getPool();
  await pool.request().input('k', key).input('v', value).query(`
    MERGE settings AS t USING (SELECT @k AS [key]) AS s ON t.[key] = s.[key]
    WHEN MATCHED THEN UPDATE SET [value] = @v, updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (@k, @v);
  `);
}

export async function setSettings(values: SettingsMap): Promise<void> {
  for (const [k, v] of Object.entries(values)) await setSetting(k, v);
}
