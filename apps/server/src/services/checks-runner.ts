import { runCollectorOnce, type CollectorRunResult } from './eventlog-collector.js';
import { runDiskCollectorOnce } from './disk-collector.js';
import { runServicesScanOnce } from './services-collector.js';
import { logActivity } from './activity-log.js';
import { getAllSettings } from './settings.js';

type CheckName = 'eventlog' | 'disk' | 'services';
type CheckSelection = Record<CheckName, boolean>;

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
  eventlog: CollectorRunResult | null;
  disk: DiskCollectResult | null;
  services: ServicesScanResult | null;
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
  run: (triggerSource: 'manual' | 'scheduled') => Promise<CollectorRunResult | DiskCollectResult | ServicesScanResult | null>;
}> = [
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
];

function boolSetting(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
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
    let eventlog: CollectorRunResult | null = null;
    let disk: DiskCollectResult | null = null;
    let services: ServicesScanResult | null = null;

    for (const check of CHECKS) {
      if (!selected[check.name]) continue;
      const result = await check.run(triggerSource);
      if (result === null) {
        logActivity('warn', 'checks', `${check.label} skipped: already running`);
        continue;
      }
      if (check.name === 'eventlog') eventlog = result as CollectorRunResult;
      if (check.name === 'disk') disk = result as DiskCollectResult;
      if (check.name === 'services') services = result as ServicesScanResult;
    }

    const durationMs = Date.now() - t0;
    logActivity('success', 'checks', `Checks done (${(durationMs / 1000).toFixed(1)}s)`);
    return { eventlog, disk, services, durationMs, selected };
  } catch (err) {
    logActivity('error', 'checks', `Checks failed: ${String(err).split('\n')[0]}`);
    throw err;
  } finally {
    runInFlight = false;
  }
}

export async function runAllChecksOnce(triggerSource: 'manual' | 'scheduled'): Promise<RunChecksResult | null> {
  return runChecksOnce(triggerSource, { eventlog: true, disk: true, services: true });
}

export async function startChecksSchedule(): Promise<void> {
  const interval = await loadIntervalSec();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runChecksOnce('scheduled').catch((e) => console.error('Scheduled checks error', e));
  }, interval * 1000);
  console.log(`Periodic checks scheduled every ${interval}s`);
}

export function rescheduleChecks(intervalSec: number): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runChecksOnce('scheduled').catch((e) => console.error('Scheduled checks error', e));
  }, intervalSec * 1000);
  console.log(`Periodic checks rescheduled every ${intervalSec}s`);
}
