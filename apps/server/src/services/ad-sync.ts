import { spawn } from 'node:child_process';
import { getPool } from '../db/pool.js';

export interface ADComputer {
  Name: string;
  DNSHostName: string | null;
  OperatingSystem: string | null;
  LastLogonDate: string | null;
  Enabled: boolean;
}

/**
 * Calls Get-ADComputer on the API host (10.8.2.213 has RSAT-AD installed).
 * Returns parsed list of all domain computers.
 */
function fetchFromAD(): Promise<ADComputer[]> {
  const ps = `
$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory
Get-ADComputer -Filter * -Properties OperatingSystem, LastLogonDate |
  Select-Object Name, DNSHostName, OperatingSystem,
    @{n='LastLogonDate';e={ if ($_.LastLogonDate) { $_.LastLogonDate.ToUniversalTime().ToString('o') } else { $null } }},
    Enabled |
  ConvertTo-Json -Compress -Depth 4
`;

  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Get-ADComputer exit ${code}: ${stderr}`));
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return resolve([]);
        const parsed = JSON.parse(trimmed) as ADComputer | ADComputer[];
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  removed: number;
  durationMs: number;
}

/**
 * Upserts AD computers into the `computers` table. Marks PCs missing from AD
 * as enabled=0 (soft-disable) instead of deleting — preserves historical events.
 */
export async function syncComputersFromAD(): Promise<SyncResult> {
  const t0 = Date.now();
  const adList = await fetchFromAD();
  const pool = await getPool();

  let inserted = 0;
  let updated = 0;

  for (const c of adList) {
    const r = await pool.request()
      .input('name', c.Name)
      .input('fqdn', c.DNSHostName)
      .input('os', c.OperatingSystem)
      .input('last_seen', c.LastLogonDate)
      .input('enabled', c.Enabled ? 1 : 0)
      .query<{ action: 'INSERT' | 'UPDATE' }>(`
        MERGE computers AS tgt
        USING (SELECT @name AS name) AS src ON tgt.name = src.name
        WHEN MATCHED THEN UPDATE SET
          fqdn = @fqdn, os_version = @os, last_seen = @last_seen, enabled = @enabled
        WHEN NOT MATCHED THEN INSERT (name, fqdn, os_version, last_seen, enabled)
          VALUES (@name, @fqdn, @os, @last_seen, @enabled)
        OUTPUT $action AS action;
      `);
    const action = r.recordset[0]?.action;
    if (action === 'INSERT') inserted++;
    else if (action === 'UPDATE') updated++;
  }

  // Soft-disable PCs that are no longer in AD
  const adNamesCSV = adList.map((c) => `'${c.Name.replace(/'/g, "''")}'`).join(',');
  const removeQuery = adNamesCSV.length > 0
    ? `UPDATE computers SET enabled = 0 WHERE name NOT IN (${adNamesCSV}) AND enabled = 1`
    : `UPDATE computers SET enabled = 0 WHERE enabled = 1`;
  const removeRes = await pool.request().query(removeQuery);
  const removed = removeRes.rowsAffected[0] ?? 0;

  return {
    fetched: adList.length,
    inserted,
    updated,
    removed,
    durationMs: Date.now() - t0,
  };
}
