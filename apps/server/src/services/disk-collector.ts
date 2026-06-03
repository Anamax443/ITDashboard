import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { getPool } from '../db/pool.js';
import { logActivity } from './activity-log.js';

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => { clearTimeout(t); done(true); });
    socket.once('error', () => { clearTimeout(t); done(false); });
    socket.connect(port, host);
  });
}

interface RawDisk {
  DeviceID: string;
  VolumeName: string | null;
  FileSystem: string | null;
  Size: number;
  FreeSpace: number;
}

interface PcInfo {
  UserName: string | null;
  IPAddress: string | null;
}

interface PcScanResult {
  disks: RawDisk[];
  info: PcInfo;
}

const CONCURRENCY = 5;
let runInFlight = false;

async function fetchPcScan(name: string): Promise<PcScanResult> {
  // Pre-flight TCP probe — same as eventlog collector, fail-fast for offline PCs
  const tcpOk = await tcpProbe(name, 135, 2000);
  if (!tcpOk) throw new Error('OFFLINE: TCP/135 unreachable');

  // Single DCOM session, three cheap CIM queries: disks + current interactive
  // user + primary IPv4. Default Get-CimInstance uses WinRM which isn't
  // configured on most domain PCs — DCOM is the same transport as Get-WinEvent.
  const ps = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$opt = New-CimSessionOption -Protocol Dcom
$session = New-CimSession -ComputerName '${name}' -SessionOption $opt -ErrorAction Stop
try {
  $disks = Get-CimInstance -CimSession $session -ClassName Win32_LogicalDisk -Filter "DriveType=3" |
    Select-Object DeviceID, VolumeName, FileSystem,
      @{n='Size';e={[int64]$_.Size}},
      @{n='FreeSpace';e={[int64]$_.FreeSpace}}

  $cs = Get-CimInstance -CimSession $session -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
  $userName = if ($cs -and $cs.UserName) { $cs.UserName } else { $null }

  $ip = $null
  try {
    $adapters = Get-CimInstance -CimSession $session -ClassName Win32_NetworkAdapterConfiguration -Filter "IPEnabled=true" -ErrorAction SilentlyContinue
    foreach ($a in $adapters) {
      if ($a.IPAddress) {
        foreach ($candidate in $a.IPAddress) {
          if ($candidate -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' -and $candidate -notmatch '^(0\\.|127\\.|169\\.254\\.)') {
            $ip = $candidate
            break
          }
        }
      }
      if ($ip) { break }
    }
  } catch { }

  [pscustomobject]@{
    disks = @($disks)
    info = [pscustomobject]@{
      UserName = $userName
      IPAddress = $ip
    }
  } | ConvertTo-Json -Compress -Depth 4
} finally {
  Remove-CimSession $session
}
`;
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `exit ${code}`));
      try {
        const t = stdout.trim();
        if (!t) return resolve({ disks: [], info: { UserName: null, IPAddress: null } });
        const parsed = JSON.parse(t) as { disks: RawDisk | RawDisk[] | null; info: PcInfo };
        const disksArr = parsed.disks == null ? [] : Array.isArray(parsed.disks) ? parsed.disks : [parsed.disks];
        resolve({ disks: disksArr, info: parsed.info ?? { UserName: null, IPAddress: null } });
      } catch (e) { reject(e); }
    });
  });
}

async function upsertDisk(computerId: number, d: RawDisk): Promise<void> {
  const pool = await getPool();
  await pool.request()
    .input('cid', computerId)
    .input('drv', d.DeviceID)
    .input('lbl', d.VolumeName)
    .input('fs', d.FileSystem)
    .input('tot', d.Size)
    .input('free', d.FreeSpace)
    .query(`
      MERGE disks AS t USING (SELECT @cid AS cid, @drv AS drv) AS s ON t.computer_id = s.cid AND t.drive_letter = s.drv
      WHEN MATCHED THEN UPDATE SET volume_label = @lbl, filesystem = @fs, total_bytes = @tot, free_bytes = @free, collected_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (computer_id, drive_letter, volume_label, filesystem, total_bytes, free_bytes)
        VALUES (@cid, @drv, @lbl, @fs, @tot, @free);
    `);
}

async function upsertPcInfo(computerId: number, info: PcInfo): Promise<void> {
  const pool = await getPool();
  // IP is always overwritten (current state); current_user is only overwritten
  // when scan returns non-null so the last-seen user persists across "no one
  // logged in" gaps. current_user_seen_at tracks when that observation was.
  await pool.request()
    .input('cid', computerId)
    .input('user', info.UserName)
    .input('ip', info.IPAddress)
    .query(`
      UPDATE computers SET
        ip_address = @ip,
        [current_user] = CASE WHEN @user IS NOT NULL THEN @user ELSE [current_user] END,
        current_user_seen_at = CASE WHEN @user IS NOT NULL THEN SYSUTCDATETIME() ELSE current_user_seen_at END,
        pc_info_collected_at = SYSUTCDATETIME()
      WHERE id = @cid;
    `);

  // Per-PC interactive-login history. Skip when nobody is logged in. If the
  // most-recent row for this PC has the same user, bump last_seen — that means
  // the same person stayed logged on across our scans. Otherwise insert a new
  // row to record a new "session" (user change since the last observation).
  if (info.UserName != null && info.UserName !== '') {
    await pool.request()
      .input('cid', computerId)
      .input('user', info.UserName)
      .input('ip', info.IPAddress)
      .query(`
        DECLARE @last_id BIGINT, @last_user NVARCHAR(255);
        SELECT TOP 1 @last_id = id, @last_user = user_name
        FROM pc_user_history
        WHERE computer_id = @cid
        ORDER BY last_seen DESC;

        IF @last_id IS NOT NULL AND @last_user = @user
          UPDATE pc_user_history
          SET last_seen = SYSUTCDATETIME(),
              ip_address = COALESCE(@ip, ip_address)
          WHERE id = @last_id;
        ELSE
          INSERT INTO pc_user_history (computer_id, user_name, first_seen, last_seen, ip_address)
          VALUES (@cid, @user, SYSUTCDATETIME(), SYSUTCDATETIME(), @ip);
      `);
  }
}

interface Target { id: number; name: string; }

export async function runDiskCollectorOnce(): Promise<{ pcs: number; ok: number; fail: number; drives: number; durationMs: number } | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  try {
    const pool = await getPool();
    const r = await pool.request().query<Target>(`
      SELECT id, name FROM computers
      WHERE enabled = 1 AND monitor_enabled = 1 AND excluded = 0 AND consecutive_failures < 10
    `);
    const targets = r.recordset;
    logActivity('info', 'disk', `Starting disk scan — ${targets.length} PCs`);

    let ok = 0, fail = 0, totalDrives = 0;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (c) => {
        const scan = await fetchPcScan(c.name);
        for (const d of scan.disks) await upsertDisk(c.id, d);
        await upsertPcInfo(c.id, scan.info);
        return scan.disks.length;
      }));
      for (let j = 0; j < results.length; j++) {
        const r2 = results[j]!;
        const c = batch[j]!;
        if (r2.status === 'fulfilled') {
          ok++;
          totalDrives += r2.value;
          logActivity('info', 'disk', `${c.name} → ${r2.value} drive${r2.value === 1 ? '' : 's'}`);
        } else {
          fail++;
          const errMsg = String(r2.reason).split('\n')[0]?.slice(0, 200) ?? 'unknown';
          logActivity('warn', 'disk', `${c.name} → ${errMsg}`);
        }
      }
    }

    const durationMs = Date.now() - t0;
    logActivity('success', 'disk', `Disk scan done: ${ok} OK / ${fail} fail / ${totalDrives} drives (${(durationMs/1000).toFixed(1)}s)`);
    return { pcs: targets.length, ok, fail, drives: totalDrives, durationMs };
  } finally {
    runInFlight = false;
  }
}

let diskTimer: NodeJS.Timeout | null = null;
export async function startDiskSchedule(): Promise<void> {
  const { getSetting } = await import('./settings.js');
  const dbVal = await getSetting('disk.interval_sec').catch(() => undefined);
  const interval = Number(dbVal ?? process.env.DISK_POLL_INTERVAL_SEC ?? 1800);
  if (diskTimer) clearInterval(diskTimer);
  diskTimer = setInterval(() => {
    runDiskCollectorOnce().catch((e) => console.error('Disk scan error', e));
  }, interval * 1000);
  console.log(`Disk collector scheduled every ${interval}s`);
}

export function rescheduleDisk(intervalSec: number): void {
  if (diskTimer) clearInterval(diskTimer);
  diskTimer = setInterval(() => {
    runDiskCollectorOnce().catch((e) => console.error('Disk scan error', e));
  }, intervalSec * 1000);
  console.log(`Disk collector rescheduled every ${intervalSec}s`);
}
