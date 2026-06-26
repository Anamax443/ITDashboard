import { spawn } from 'node:child_process';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';
import { getSetting } from './settings.js';

export interface ADComputer {
  Name: string;
  DNSHostName: string | null;
  OperatingSystem: string | null;
  LastLogonDate: string | null;
  Enabled: boolean;
  DistinguishedName: string | null;
}

/**
 * Converts AD DistinguishedName to a human-readable OU path.
 * e.g. "CN=PC1,OU=Notebooks,OU=Sales,DC=corp,DC=local"
 *   →  "corp.local/Sales/Notebooks"
 * The CN (computer name) is dropped — path describes the container only.
 */
export function dnToOuPath(dn: string | null): string | null {
  if (!dn) return null;
  // Split on unescaped commas (DN escapes commas with backslash)
  const parts = dn.split(/(?<!\\),/);
  const ous: string[] = [];
  const dcs: string[] = [];
  for (const part of parts) {
    const m = part.trim().match(/^(CN|OU|DC)=(.+)$/i);
    if (!m) continue;
    const type = m[1]!.toUpperCase();
    const val = m[2]!.replace(/\\,/g, ',');
    if (type === 'OU') ous.push(val);
    else if (type === 'DC') dcs.push(val);
  }
  const domain = dcs.join('.');
  if (ous.length === 0) return domain || null;
  return [domain, ...ous.reverse()].join('/');
}

function fetchFromAD(): Promise<ADComputer[]> {
  const ps = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Import-Module ActiveDirectory
Get-ADComputer -Filter * -Properties OperatingSystem, LastLogonDate, DistinguishedName |
  Select-Object Name, DNSHostName, OperatingSystem,
    @{n='LastLogonDate';e={ if ($_.LastLogonDate) { $_.LastLogonDate.ToUniversalTime().ToString('o') } else { $null } }},
    Enabled, DistinguishedName |
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

  // Setting drives whether newly discovered PCs default to monitored.
  // Existing PCs (UPDATE path) preserve their current monitor_enabled — operator intent persists.
  const defaultMonitorRaw = await getSetting('adsync.default_monitor_enabled').catch(() => undefined);
  const defaultMonitor = (defaultMonitorRaw ?? 'true').toLowerCase() !== 'false' ? 1 : 0;
  // Per-flag defaults a NEW PC gets (existing PCs keep operator intent — only the
  // INSERT branch uses these). All default OFF except monitor.
  const readBool = (raw: string | undefined, dflt: boolean) => ((raw ?? String(dflt)).toLowerCase() === 'true' ? 1 : 0);
  const defDisk = readBool(await getSetting('adsync.default_disk_email_monitor').catch(() => undefined), false);
  const defSvc = readBool(await getSetting('adsync.default_service_monitor').catch(() => undefined), false);
  const defCritSvc = readBool(await getSetting('adsync.default_service_email_monitor').catch(() => undefined), false);
  const defExcluded = readBool(await getSetting('adsync.default_excluded').catch(() => undefined), false);

  try {
    const adList = await fetchFromAD();
    logActivity('info', 'ad-sync', `Fetched ${adList.length} computers from AD (new PCs default monitor=${defaultMonitor === 1})`);

    let inserted = 0;
    let updated = 0;

    for (const c of adList) {
      const ouPath = dnToOuPath(c.DistinguishedName);
      const r = await pool.request()
        .input('name', c.Name)
        .input('fqdn', c.DNSHostName)
        .input('os', c.OperatingSystem)
        .input('last_seen', c.LastLogonDate)
        .input('enabled', c.Enabled ? 1 : 0)
        .input('dn', c.DistinguishedName)
        .input('ou', ouPath)
        .input('mon', defaultMonitor)
        .input('disk', defDisk).input('svc', defSvc).input('csvc', defCritSvc).input('exc', defExcluded)
        .query<{ action: 'INSERT' | 'UPDATE' }>(`
          MERGE computers AS tgt
          USING (SELECT @name AS name) AS src ON tgt.name = src.name
          WHEN MATCHED THEN UPDATE SET
            fqdn = @fqdn, os_version = @os, last_seen = @last_seen, enabled = @enabled,
            distinguished_name = @dn, ou_path = @ou
          WHEN NOT MATCHED THEN INSERT (name, fqdn, os_version, last_seen, enabled, distinguished_name, ou_path,
            monitor_enabled, disk_email_monitor, service_monitor, service_email_monitor, excluded)
            VALUES (@name, @fqdn, @os, @last_seen, @enabled, @dn, @ou,
            @mon, @disk, @svc, @csvc, @exc)
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
