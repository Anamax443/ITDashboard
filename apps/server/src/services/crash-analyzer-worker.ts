import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPool } from '../db/pool.js';
import { getAllSettings } from './settings.js';
import { logActivity } from './activity-log.js';
import { analyzeDump } from './crash-analyze.js';

// Separate worker (own timer): picks `pending` crash_dumps, materializes the blob
// from the DB to a temp file on .213, runs cdb, stores the parsed result + full
// output, then deletes the temp. Decoupled from the collector so a slow cdb never
// stalls collection. The DB row IS the queue (status pending → analyzed/failed).

let running = false;
let timer: NodeJS.Timeout | null = null;
let stopped = false;
const IDLE_RECHECK_SEC = 120;

interface PendingRow {
  id: number;
  computer_name: string | null;
  source_filename: string;
  dmp_blob: Buffer;
}

function boolSetting(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v ?? '').toLowerCase());
}

export async function runCrashAnalyzeOnce(limit = 5): Promise<{ analyzed: number; failed: number } | null> {
  if (running) return null;
  running = true;
  const tmpRoot = path.join(os.tmpdir(), 'itdash-crash');
  try {
    await fs.mkdir(tmpRoot, { recursive: true });
    const pool = await getPool();
    const pending = (await pool.request().input('lim', limit)
      .query<PendingRow>(`
        SELECT TOP (@lim) id, computer_name, source_filename, dmp_blob
        FROM crash_dumps WHERE status='pending' ORDER BY ingested_at ASC`)).recordset;

    let analyzed = 0, failed = 0;
    for (const row of pending) {
      const tmp = path.join(tmpRoot, `${row.id}-${row.source_filename}`);
      try {
        await fs.writeFile(tmp, row.dmp_blob);
        const a = await analyzeDump(tmp);
        await pool.request()
          .input('id', row.id).input('stop', a.stopCode).input('name', a.bugcheckName)
          .input('hot', a.hotFunction).input('proc', a.culpritProcess).input('mod', a.culpritModule)
          .input('txt', a.text)
          .query(`UPDATE crash_dumps SET status='analyzed', stop_code=@stop, bugcheck_name=@name,
                    hot_function=@hot, culprit_process=@proc, culprit_module=@mod,
                    analyze_text=@txt, analyze_error=NULL, analyzed_at=SYSUTCDATETIME() WHERE id=@id`);
        analyzed++;
        logActivity('info', 'crash', `Analýza ${row.computer_name}/${row.source_filename}: ${a.stopCode ?? '?'} ${a.bugcheckName ?? ''}${a.culpritProcess ? ' · ' + a.culpritProcess : ''}`);
      } catch (e) {
        failed++;
        await pool.request().input('id', row.id).input('err', String(e).split('\n')[0]?.slice(0, 500) ?? 'unknown')
          .query(`UPDATE crash_dumps SET status='failed', analyze_error=@err, analyzed_at=SYSUTCDATETIME() WHERE id=@id`)
          .catch(() => { /* keep going */ });
        logActivity('error', 'crash', `Analýza selhala ${row.source_filename}: ${String(e).split('\n')[0]}`);
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => { /* temp cleanup best-effort */ });
      }
    }
    return { analyzed, failed };
  } finally {
    running = false;
  }
}

export function isCrashAnalyzeRunning(): boolean { return running; }

export async function startCrashAnalyzerSchedule(): Promise<void> {
  stopped = false;
  if (timer) { clearTimeout(timer); timer = null; }
  const loop = async () => {
    if (stopped) return;
    let nextSec = IDLE_RECHECK_SEC;
    try {
      const s = await getAllSettings();
      if (boolSetting(s['crash.enabled'])) {
        await runCrashAnalyzeOnce();
        const iv = Number(s['crash.analyzer_interval_sec']);
        nextSec = Number.isFinite(iv) && iv >= 30 ? iv : 300;
      }
    } catch (e) {
      console.error('Crash analyzer error', e);
    }
    if (!stopped) timer = setTimeout(loop, nextSec * 1000);
  };
  loop().catch((e) => console.error('Crash analyzer error', e));
  console.log('Crash analyzer worker scheduled (DB-driven enable/interval)');
}
