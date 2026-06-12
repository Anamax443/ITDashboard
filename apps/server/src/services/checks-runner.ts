import { runCollectorOnce, type CollectorRunResult } from './eventlog-collector.js';
import { runDiskCollectorOnce } from './disk-collector.js';
import { runServicesScanOnce } from './services-collector.js';
import { runPerfCollectorOnce, type PerfCollectResult } from './perf-collector.js';
import { runReachabilityProbeOnce, type ReachabilityRunResult } from './reachability-collector.js';
import { syncComputersFromAD, type SyncResult as AdSyncResult } from './ad-sync.js';
import { logActivity } from './activity-log.js';
import { getAllSettings } from './settings.js';

type CheckName = 'reachability' | 'eventlog' | 'disk' | 'services' | 'perf' | 'adsync';
type CheckSelection = Record<CheckName, boolean>;

interface CheckWindow {
  days: Set<number>;
  startMinutes: number;
  endMinutes: number;
}

export interface DiskCollectResult {
  pcs: number;
  ok: number;
  fail: number;
  drives: number;
  durationMs: number;
}

export interface ServicesScanResult {
  pcs: number;
  ok: number;
  fail: number;
  problems: number;
  durationMs: number;
}

export interface RunChecksResult {
  reachability: ReachabilityRunResult | null;
  eventlog: CollectorRunResult | null;
  disk: DiskCollectResult | null;
  services: ServicesScanResult | null;
  perf: PerfCollectResult | null;
  adsync: AdSyncResult | null;
  durationMs: number;
  selected: CheckSelection;
}

let runInFlight = false;
let timer: NodeJS.Timeout | null = null;

const CHECKS: Array<{
  name: CheckName;
  label: string;
  settingKey: string;
  defaultEnabled: boolean;
  run: (triggerSource: 'manual' | 'scheduled') => Promise<CollectorRunResult | DiskCollectResult | ServicesScanResult | PerfCollectResult | AdSyncResult | ReachabilityRunResult | null>;
}> = [
  // AD sync runs first so subsequent collectors see fresh inventory in the same run.
  {
    name: 'adsync',
    label: 'ad-sync',
    settingKey: 'checks.run_adsync',
    defaultEnabled: false,
    run: (triggerSource) => syncComputersFromAD(triggerSource),
  },
  // Reachability runs early (after inventory) so the Status column reflects who
  // is on the network now, regardless of whether the other collectors succeed.
  {
    name: 'reachability',
    label: 'reachability',
    settingKey: 'checks.run_reachability',
    defaultEnabled: true,
    run: () => runReachabilityProbeOnce(),
  },
  {
    name: 'eventlog',
    label: 'eventlog',
    settingKey: 'checks.run_eventlog',
    defaultEnabled: true,
    run: (triggerSource) => runCollectorOnce(triggerSource),
  },
  {
    name: 'disk',
    label: 'disk',
    settingKey: 'checks.run_disk',
    defaultEnabled: true,
    run: () => runDiskCollectorOnce(),
  },
  {
    name: 'services',
    label: 'services',
    settingKey: 'checks.run_services',
    defaultEnabled: true,
    run: () => runServicesScanOnce(),
  },
  {
    name: 'perf',
    label: 'perf',
    settingKey: 'checks.run_perf',
    defaultEnabled: true,
    run: () => runPerfCollectorOnce(),
  },
];

function boolSetting(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseTime(value: string | undefined, fallback: string): number {
  const raw = value ?? fallback;
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return parseTime(fallback, '00:00');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return parseTime(fallback, '00:00');
  return hours * 60 + minutes;
}

function parseDays(value: string | undefined): Set<number> {
  const raw = value ?? '1,2,3,4,5';
  const days = raw.split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6);
  return new Set(days.length > 0 ? days : [1, 2, 3, 4, 5]);
}

async function loadSelection(): Promise<CheckSelection> {
  const settings = await getAllSettings();
  return Object.fromEntries(
    CHECKS.map((check) => [check.name, boolSetting(settings[check.settingKey], check.defaultEnabled)]),
  ) as CheckSelection;
}

async function loadIntervalSec(): Promise<number> {
  const settings = await getAllSettings();
  const interval = Number(settings['checks.interval_sec'] ?? 900);
  return Number.isFinite(interval) && interval > 0 ? interval : 900;
}

async function loadWindow(): Promise<CheckWindow> {
  const settings = await getAllSettings();
  return {
    days: parseDays(settings['checks.days']),
    startMinutes: parseTime(settings['checks.window_start'], '06:00'),
    endMinutes: parseTime(settings['checks.window_end'], '18:00'),
  };
}

function isWithinWindow(now: Date, window: CheckWindow): boolean {
  if (!window.days.has(now.getDay())) return false;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  if (window.startMinutes === window.endMinutes) return true;
  if (window.startMinutes < window.endMinutes) {
    return minuteOfDay >= window.startMinutes && minuteOfDay < window.endMinutes;
  }
  return minuteOfDay >= window.startMinutes || minuteOfDay < window.endMinutes;
}

export async function runChecksOnce(
  triggerSource: 'manual' | 'scheduled',
  selection?: CheckSelection,
): Promise<RunChecksResult | null> {
  if (runInFlight) return null;
  runInFlight = true;

  const selected = selection ?? await loadSelection();
  const selectedNames = CHECKS
    .filter((check) => selected[check.name])
    .map((check) => check.label);
  const t0 = Date.now();
  logActivity('info', 'checks', `Starting ${triggerSource} checks: ${selectedNames.join(' → ') || 'none selected'}`);

  try {
    let reachability: ReachabilityRunResult | null = null;
    let eventlog: CollectorRunResult | null = null;
    let disk: DiskCollectResult | null = null;
    let services: ServicesScanResult | null = null;
    let perf: PerfCollectResult | null = null;
    let adsync: AdSyncResult | null = null;

    for (const check of CHECKS) {
      if (!selected[check.name]) continue;
      const result = await check.run(triggerSource);
      if (result === null) {
        logActivity('warn', 'checks', `${check.label} skipped: already running`);
        continue;
      }
      if (check.name === 'reachability') reachability = result as ReachabilityRunResult;
      if (check.name === 'eventlog') eventlog = result as CollectorRunResult;
      if (check.name === 'disk') disk = result as DiskCollectResult;
      if (check.name === 'services') services = result as ServicesScanResult;
      if (check.name === 'perf') perf = result as PerfCollectResult;
      if (check.name === 'adsync') adsync = result as AdSyncResult;
    }

    const durationMs = Date.now() - t0;
    logActivity('success', 'checks', `Checks done (${(durationMs / 1000).toFixed(1)}s)`);
    return { reachability, eventlog, disk, services, perf, adsync, durationMs, selected };
  } catch (err) {
    logActivity('error', 'checks', `Checks failed: ${String(err).split('\n')[0]}`);
    throw err;
  } finally {
    runInFlight = false;
  }
}

async function runScheduledChecksIfAllowed(): Promise<void> {
  const window = await loadWindow();
  if (!isWithinWindow(new Date(), window)) return;
  await runChecksOnce('scheduled');
}

export async function runAllChecksOnce(triggerSource: 'manual' | 'scheduled'): Promise<RunChecksResult | null> {
  return runChecksOnce(triggerSource, { reachability: true, eventlog: true, disk: true, services: true, perf: true, adsync: true });
}

export async function startChecksSchedule(): Promise<void> {
  const interval = await loadIntervalSec();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runScheduledChecksIfAllowed().catch((e) => console.error('Scheduled checks error', e));
  }, interval * 1000);
  console.log(`Periodic checks scheduled every ${interval}s`);
}

export function rescheduleChecks(intervalSec: number): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runScheduledChecksIfAllowed().catch((e) => console.error('Scheduled checks error', e));
  }, intervalSec * 1000);
  console.log(`Periodic checks rescheduled every ${intervalSec}s`);
}
