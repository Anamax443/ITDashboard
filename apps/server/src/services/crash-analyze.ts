import { spawn } from 'node:child_process';
import { getSetting } from './settings.js';

// Runs cdb (Debugging Tools for Windows) on a kernel minidump and parses the
// actionable bits out. We deliberately DON'T use `!analyze -v` — in the newest
// cdb build (10.0.28000) the gallery-based analyze runs async and emits nothing
// in headless mode. The sync commands below DO work and proved (live, on a real
// minidump) sufficient to extract STOP code, hot function and the offending
// process: `.bugcheck` (code) + `kc` (stack) + `!dpcwatchdog` (long DPC hot fn)
// + `.thread/!thread/!process` (owning process Image).

export interface CrashAnalysis {
  stopCode: string | null;        // e.g. 0x133
  bugcheckName: string | null;    // e.g. DPC_WATCHDOG_VIOLATION
  hotFunction: string | null;     // e.g. nt!MiDeleteSubsectionPages
  culpritProcess: string | null;  // e.g. msedgewebview2.exe
  culpritModule: string | null;   // first non-nt/hal module in the stack, if any
  text: string;                   // full cdb output
}

const DEFAULT_CDB = 'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe';
const DEFAULT_SYM = 'srv*C:\\symbols*https://msdl.microsoft.com/download/symbols';

// Common bug-check codes → names (the ones we realistically see on the fleet).
const BUGCHECK_NAMES: Record<string, string> = {
  '0xa': 'IRQL_NOT_LESS_OR_EQUAL', '0x18': 'REFERENCE_BY_POINTER', '0x19': 'BAD_POOL_HEADER',
  '0x1a': 'MEMORY_MANAGEMENT', '0x1e': 'KMODE_EXCEPTION_NOT_HANDLED', '0x3b': 'SYSTEM_SERVICE_EXCEPTION',
  '0x4a': 'IRQL_GT_ZERO_AT_SYSTEM_SERVICE', '0x50': 'PAGE_FAULT_IN_NONPAGED_AREA',
  '0x7e': 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED', '0x7f': 'UNEXPECTED_KERNEL_MODE_TRAP',
  '0x9f': 'DRIVER_POWER_STATE_FAILURE', '0xc2': 'BAD_POOL_CALLER',
  '0xc4': 'DRIVER_VERIFIER_DETECTED_VIOLATION', '0xc5': 'DRIVER_CORRUPTED_EXPOOL',
  '0xd1': 'DRIVER_IRQL_NOT_LESS_OR_EQUAL', '0xef': 'CRITICAL_PROCESS_DIED',
  '0xfc': 'ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY', '0x101': 'CLOCK_WATCHDOG_TIMEOUT',
  '0x109': 'CRITICAL_STRUCTURE_CORRUPTION', '0x119': 'VIDEO_SCHEDULER_INTERNAL_ERROR',
  '0x124': 'WHEA_UNCORRECTABLE_ERROR', '0x133': 'DPC_WATCHDOG_VIOLATION',
  '0x139': 'KERNEL_SECURITY_CHECK_FAILURE', '0x13a': 'KERNEL_MODE_HEAP_CORRUPTION',
  '0x144': 'BUGCODE_USB3_DRIVER', '0x154': 'UNEXPECTED_STORE_EXCEPTION',
};

function normStop(raw: string): string {
  const n = parseInt(raw, 16);
  return Number.isFinite(n) ? '0x' + n.toString(16) : raw;
}

export async function analyzeDump(dmpPath: string): Promise<CrashAnalysis> {
  const cdb = (await getSetting('crash.cdb_path')) || DEFAULT_CDB;
  const sym = (await getSetting('crash.symbol_path')) || DEFAULT_SYM;
  const cmd = '.bugcheck; kc 100; lm 1m; !dpcwatchdog; .thread; !thread; !process -1 0; q';
  const text = await runCdb(cdb, ['-z', dmpPath, '-y', sym, '-c', cmd]);
  return { ...parseAnalysis(text), text };
}

function runCdb(cdb: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let p;
    try { p = spawn(cdb, args, { windowsHide: true }); }
    catch (e) { reject(e); return; }
    const killer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 180_000);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('error', (e) => { clearTimeout(killer); reject(e); });
    p.on('close', () => { clearTimeout(killer); resolve(out); });
  });
}

function parseAnalysis(t: string): Omit<CrashAnalysis, 'text'> {
  let stopCode: string | null = null;
  let bugcheckName: string | null = null;
  const mbc = t.match(/Bugcheck code\s+([0-9A-Fa-f]+)/);
  if (mbc) { stopCode = normStop(mbc[1]!); bugcheckName = BUGCHECK_NAMES[stopCode] ?? null; }

  // Hot function from the !dpcwatchdog "functions that exist often" table:
  //   Module Name    Function Name              #Stack  #Of Occurrences
  //   nt             MiDeleteSubsectionPages    010     97 (of 97)
  let hotFunction: string | null = null;
  const mhot = t.match(/exist often in the Watchdog record:\s*\r?\nModule Name[^\r\n]*\r?\n\s*(\S+)\s+(\S+)\s+\d+/);
  if (mhot) hotFunction = `${mhot[1]}!${mhot[2]}`;

  // Offending process from !thread / !process "Image: xxx.exe".
  let culpritProcess: string | null = null;
  const mproc = t.match(/Image:\s+(\S+\.exe)/i);
  if (mproc) culpritProcess = mproc[1]!.trim();

  // Offending module: first module!func in the stack that isn't the kernel/HAL.
  let culpritModule: string | null = null;
  for (const m of t.matchAll(/\b([A-Za-z0-9_]+)!\w+/g)) {
    const mod = m[1]!.toLowerCase();
    if (mod !== 'nt' && mod !== 'hal' && mod !== 'cdb') { culpritModule = m[1]!; break; }
  }

  return { stopCode, bugcheckName, hotFunction, culpritProcess, culpritModule };
}
