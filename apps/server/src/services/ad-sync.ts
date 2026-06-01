import { spawn } from 'node:child_process';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';

export interface ADComputer {
  Name: string;
  DNSHostName: string | null;
  OperatingSystem: string | null;
  LastLogonDate: string | null;
  Enabled: boolean;
}

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
  runId: number;
  fetched: number;
  inserted: number;
  updated: number;
  removed: number;
  durationMs: number;
}

export async function syncComputersFromAD(triggerSource: 'manual' | 'scheduled' | 'startup' = 'manual'): Promise<SyncResult> {
  const t0 = Date.now();
  const pool = await getPool();

  // Create sync run record
  const runStart = await pool.request().input('src', triggerSource).query<{ id: number }>(`
    INSERT INTO ad_sync_runs (trigger_source) OUTPUT INSERTED.id VALUES (@src);
  `);
  const runId = runStart.recordset[0]?.id ?? 0;

  logActivity('info', 'ad-sync', `Starting AD sync (${triggerSource}) — runId ${runId}`);

  try {
    const adList = await fetchFromAD();
    logActivity('info', 'ad-sync', `Fetched ${adList.length} computers from AD`);

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

    const adNamesCSV = adList.map((c) => `'${c.Name.replace(/'/g, "''")}'`).join(',');
    const removeQuery = adNamesCSV.length > 0
      ? `UPDATE computers SET enabled = 0 WHERE name NOT IN (${adNamesCSV}) AND enabled = 1`
      : `UPDATE computers SET enabled = 0 WHERE enabled = 1`;
    const removeRes = await pool.request().query(removeQuery);
    const removed = removeRes.rowsAffected[0] ?? 0;

    const durationMs = Date.now() - t0;
    await pool.request()
      .input('id', runId).input('f', adList.length).input('i', inserted).input('u', updated).input('r', removed)
      .query(`
        UPDATE ad_sync_runs
        SET finished_at = SYSUTCDATETIME(),
            fetched = @f, inserted = @i, updated = @u, removed = @r
        WHERE id = @id;
      `);

    logActivity('success', 'ad-sync', `Done: ${adList.length} fetched, +${inserted} new, ${updated} updated, ${removed} disabled (${(durationMs/1000).toFixed(1)}s)`);

    return { runId, fetched: adList.length, inserted, updated, removed, durationMs };
  } catch (err) {
    const msg = String(err).slice(0, 4000);
    await pool.request().input('id', runId).input('err', msg).query(`
      UPDATE ad_sync_runs SET finished_at = SYSUTCDATETIME(), error = @err WHERE id = @id;
    `);
    logActivity('error', 'ad-sync', `Failed: ${msg.split('\n')[0]}`);
    throw err;
  }
}

export async function getSyncHistory(limit = 10) {
  const pool = await getPool();
  const r = await pool.request().input('lim', limit).query(`
    SELECT TOP (@lim) id, started_at, finished_at, fetched, inserted, updated, removed, error, trigger_source
    FROM ad_sync_runs
    ORDER BY id DESC;
  `);
  return r.recordset;
}

export async function getLastSync() {
  const history = await getSyncHistory(1);
  return history[0] ?? null;
}
