import { promises as fs } from 'node:fs';
import { Socket } from 'node:net';
import sql from 'mssql/msnodesqlv8.js';
import { getPool } from '../db/pool.js';
import { getAllSettings } from './settings.js';
import { logActivity } from './activity-log.js';

// Pulls kernel minidumps from monitored, reachable PCs over the C$ admin share
// (the service account is local-admin on clients via "Server Admins"). Reads each
// new .dmp straight into a buffer and stores it as a blob with status='pending';
// dedup by (computer, filename) so the same file isn't re-ingested every cycle
// (the on-client file is left for Windows to clean — DB is the durable store).
// Only the small Minidump\*.dmp files are touched, never C:\Windows\MEMORY.DMP.

const MINIDUMP_REL = 'C$\\Windows\\Minidump';
const MAX_DMP_BYTES = 64 * 1024 * 1024;   // skip anything absurd (full dumps mis-placed)

let running = false;
let timer: NodeJS.Timeout | null = null;
let stopped = false;
const IDLE_RECHECK_SEC = 120;

interface Target { id: number; name: string }

function boolSetting(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v ?? '').toLowerCase());
}

// Fail-fast SMB pre-flight so an unreachable box doesn't block on a long readdir.
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    let done = false;
    const fin = (ok: boolean) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    const t = setTimeout(() => fin(false), timeoutMs);
    s.once('connect', () => { clearTimeout(t); fin(true); });
    s.once('error', () => { clearTimeout(t); fin(false); });
    s.connect(port, host);
  });
}

export async function runCrashDumpCollectOnce(): Promise<{ pcs: number; collected: number; skipped: number } | null> {
  if (running) return null;
  running = true;
  try {
    const pool = await getPool();
    const targets = (await pool.request().query<Target>(`
      SELECT id, name FROM computers
      WHERE enabled = 1 AND monitor_enabled = 1 AND excluded = 0
        AND (reachable = 1 OR (reachable IS NULL AND consecutive_failures < 10))
    `)).recordset;

    let collected = 0, skipped = 0;
    for (const c of targets) {
      if (!(await tcpProbe(c.name, 445, 2000))) continue;        // SMB not reachable → skip
      const dir = `\\\\${c.name}\\${MINIDUMP_REL}`;
      let files: string[];
      try { files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.dmp')); }
      catch { continue; }                                        // no Minidump dir → healthy box

      for (const f of files) {
        const exists = (await pool.request().input('cid', c.id).input('fn', f)
          .query<{ n: number }>(`SELECT COUNT(*) AS n FROM crash_dumps WHERE computer_id=@cid AND source_filename=@fn`))
          .recordset[0]!.n;
        if (exists > 0) { skipped++; continue; }

        const full = `${dir}\\${f}`;
        let buf: Buffer; let mtime: Date;
        try {
          const st = await fs.stat(full);
          if (st.size > MAX_DMP_BYTES) { skipped++; continue; }
          mtime = st.mtime;
          buf = await fs.readFile(full);
        } catch { continue; }

        await pool.request()
          .input('cid', c.id).input('cn', c.name).input('fn', f)
          .input('occ', mtime).input('sz', buf.length)
          .input('blob', sql.VarBinary(sql.MAX), buf)
          .query(`INSERT INTO crash_dumps (computer_id, computer_name, source_filename, occurred_at, size_bytes, status, dmp_blob)
                  VALUES (@cid, @cn, @fn, @occ, @sz, 'pending', @blob)`);
        collected++;
        logActivity('info', 'crash', `${c.name}: nový dump ${f} (${Math.round(buf.length / 1024)} kB) uložen, čeká na analýzu`);
      }
    }
    if (collected > 0) logActivity('info', 'crash', `Sběr dumpů: ${collected} nových · ${skipped} už v DB · ${targets.length} PC`);
    return { pcs: targets.length, collected, skipped };
  } finally {
    running = false;
  }
}

export function isCrashCollectRunning(): boolean { return running; }

export async function startCrashDumpSchedule(): Promise<void> {
  stopped = false;
  if (timer) { clearTimeout(timer); timer = null; }
  const loop = async () => {
    if (stopped) return;
    let nextSec = IDLE_RECHECK_SEC;
    try {
      const s = await getAllSettings();
      if (boolSetting(s['crash.enabled'])) {
        await runCrashDumpCollectOnce();
        const iv = Number(s['crash.interval_sec']);
        nextSec = Number.isFinite(iv) && iv >= 60 ? iv : 3600;
      }
    } catch (e) {
      console.error('Crash-dump collect error', e);
    }
    if (!stopped) timer = setTimeout(loop, nextSec * 1000);
  };
  loop().catch((e) => console.error('Crash-dump collect error', e));
  console.log('Crash-dump collector scheduled (DB-driven enable/interval)');
}
