// API base resolution, in priority order:
//  1. VITE_API_BASE (baked at build time) — REQUIRED for the Electron client,
//     whose renderer loads from packaged files and has no same-origin server.
//  2. Empty string → relative URLs. When the SPA is served by the Fastify API
//     itself (the browser deployment, see apps/server/src/routes/frontend.ts),
//     fetch('/events/summary') hits the same origin = the API. This keeps the
//     repo portable: a new deployment needs no code change, just env/access.
export const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? '';

export interface Summary {
  critical_24h: number;
  error_24h: number;
  warning_24h: number;
  window_days: number;
}

export interface EventItem {
  id: number;
  computer: string;
  log_name: string;
  event_id: number;
  level: number;
  time_created: string;
  provider_name: string | null;
  message: string | null;
}

export interface TopEventId {
  event_id: number;
  log_name: string;
  level: number;
  cnt: number;
}

export interface TimelineBucket {
  bucket: string;
  level: number;
  cnt: number;
}

export interface TopComputer {
  name: string;
  total: number;
  critical_count: number;
  error_count: number;
  warning_count: number;
}

export interface PcHealth {
  computer_id: number;
  name: string;
  critical: number;
  error: number;
  warning: number;
  /** Distinct error/critical signatures (provider+event_id) — breadth of problems. */
  signatures: number;
  /** Distinct days within the window that had errors — persistence. */
  active_days: number;
  /** Damped-blend score; higher = more likely a reinstall candidate. */
  score: number;
  level: 'watch' | 'risk';
  /** Classified as a notebook by AD OU/DN/name (gets logon/roaming noise suppression). */
  isNotebook: boolean;
  /** How many events were excluded from the score by notebook suppression (0 otherwise). */
  suppressed: number;
  /** Temporarily snoozed by the operator (excluded from the risk tile count). */
  snoozed: boolean;
  /** ISO expiry of the snooze (null when not snoozed). After this it returns to standard. */
  snoozedUntil: string | null;
  /** Signature: who snoozed it (null when not snoozed). */
  snoozedBy: string | null;
  /** Operator note attached to the snooze (null when not snoozed / no note). */
  snoozeNote: string | null;
}
export interface PcHealthScoring {
  cap: number;
  weightCritical: number;
  weightError: number;
  weightWarning: number;
  weightBreadth: number;
  weightPersistence: number;
}
export interface PcHealthResult {
  windowDays: number;
  thresholdWatch: number;
  thresholdRisk: number;
  /** Default snooze length (days) offered in the UI; operator can override. */
  snoozeDefaultDays: number;
  scoring: PcHealthScoring;
  items: PcHealth[];
}

/**
 * A per-PC eventlog snooze is active only while its expiry is still in the future.
 * Pure (no clock capture beyond the passed `now`) so the dashboard self-corrects
 * an expired snooze even before the next pc-health refetch, and so it's unit
 * testable. Returns false for a missing/invalid expiry.
 */
export function isSnoozeActive(snoozedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!snoozedUntil) return false;
  const t = new Date(snoozedUntil).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * A device row whose MAC could not be resolved (alive on a remote subnet, but ARP
 * is router-local and NetBIOS is often firewalled from the app server) is stored
 * keyed by a synthetic "IP-<ip>" id. The UI shows "—" for the MAC of such rows.
 */
export function isSyntheticMac(mac: string | null | undefined): boolean {
  return !!mac && mac.startsWith('IP-');
}

export interface ServiceProblem {
  id: number;
  computer_id: number;
  computer: string;
  service_name: string;
  display_name: string | null;
  start_mode: string;
  state: string;
  delayed_start: boolean;
  trigger_start: boolean;
  per_user_start: boolean;
  is_compliant: boolean | null;
  policy_id: number | null;
  collected_at: string;
  exit_code: number | null;
  service_specific_exit_code: number | null;
}

export interface CriticalServiceStatus {
  computer_id: number;
  computer: string;
  ip_address: string | null;
  reachable: boolean | null;
  os_version: string | null;
  service_name: string;
  display_name: string | null;
  state: string;
  start_mode: string | null;
  collected_at: string;
  /** Per-PC critical-service ignore list (comma/newline, * ? wildcards). */
  exceptions?: string | null;
}

export interface ServiceAggregate {
  service_name: string;
  display_name: string | null;
  start_mode: string;
  pc_count: number;
  drift_count: number;
  ok_count: number;
  unclassified_count: number;
  trigger_start: boolean;
  delayed_start: boolean;
  per_user_start: boolean;
  policy_id: number | null;
}

export interface DiskItem {
  id: number;
  computer_id: number;
  computer: string;
  drive_letter: string;
  volume_label: string | null;
  filesystem: string | null;
  total_bytes: number;
  free_bytes: number;
  collected_at: string;
}

export type DiskStatus = 'critical' | 'warning' | 'ok';

/**
 * Drive-letter scope for one tier (critical or warning).
 *  - all       — every drive participates
 *  - include   — only drives in `letters` participate
 *  - exclude   — every drive EXCEPT those in `letters` participates
 *
 * Syntax accepted by parseDriveScope:
 *  ""  or "*"      → all
 *  "C"             → include C
 *  "C, D, E"       → include C, D, E
 *  "!C"  or "<>C"  → exclude C (= every other drive)
 *  "<>C,D"         → exclude C and D
 * Negation prefix applies to the WHOLE expression — the prefix is allowed
 * at the start of the string only. Mixing per-item include/exclude in one
 * expression is not supported (intentional — keeps semantics obvious).
 */
export type DriveLetterScope =
  | { kind: 'all' }
  | { kind: 'include'; letters: Set<string> }
  | { kind: 'exclude'; letters: Set<string> };

export interface DiskThresholds {
  criticalPct: number;
  warningPct: number;
  criticalGb: number;
  warningGb: number;
  mode: 'pct' | 'gb' | 'either';
  /** Which drives are evaluated against critical thresholds. Default include C. */
  critScope: DriveLetterScope;
  /** Which drives are evaluated against warning thresholds. Default include C. */
  warnScope: DriveLetterScope;
}

export function parseDriveScope(raw: string | undefined, fallback: DriveLetterScope): DriveLetterScope {
  if (raw == null) return fallback;
  let trimmed = raw.trim();
  if (trimmed === '' || trimmed === '*') return { kind: 'all' };
  let exclude = false;
  if (trimmed.startsWith('<>')) {
    exclude = true;
    trimmed = trimmed.slice(2).trim();
  } else if (trimmed.startsWith('!')) {
    exclude = true;
    trimmed = trimmed.slice(1).trim();
  }
  const letters = trimmed
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase().replace(/:$/, '').slice(0, 1))
    .filter((s) => /^[A-Z]$/.test(s));
  if (letters.length === 0) return fallback;
  return exclude
    ? { kind: 'exclude', letters: new Set(letters) }
    : { kind: 'include', letters: new Set(letters) };
}

export function parseDiskThresholds(settings: Record<string, string>): DiskThresholds {
  // Legacy single-tier setting still acts as default for both tiers when
  // the new per-tier settings are absent. New install default is "C".
  const legacy = parseDriveScope(settings['disk.eval_drive_letters'], { kind: 'include', letters: new Set(['C']) });
  return {
    criticalPct: Number(settings['disk.critical_pct'] ?? 5),
    warningPct: Number(settings['disk.warning_pct'] ?? 15),
    criticalGb: Number(settings['disk.critical_gb'] ?? 5),
    warningGb: Number(settings['disk.warning_gb'] ?? 20),
    mode: (settings['disk.threshold_mode'] as 'pct' | 'gb' | 'either') ?? 'pct',
    critScope: parseDriveScope(settings['disk.crit_drives'], legacy),
    warnScope: parseDriveScope(settings['disk.warn_drives'], legacy),
  };
}

export function diskLetter(d: DiskItem): string {
  return (d.drive_letter ?? '').toUpperCase().replace(/:$/, '').slice(0, 1);
}

export function diskInScope(d: DiskItem, scope: DriveLetterScope): boolean {
  const L = diskLetter(d);
  if (scope.kind === 'all') return true;
  if (scope.kind === 'include') return scope.letters.has(L);
  return !scope.letters.has(L); // exclude
}

/** Per-disk status that respects per-tier scope. critScope wins over warnScope. */
export function evaluateDiskWithScope(d: DiskItem, t: DiskThresholds): DiskStatus {
  if (d.total_bytes <= 0) return 'ok';
  const freePct = (d.free_bytes / d.total_bytes) * 100;
  const freeGb = d.free_bytes / 1024 ** 3;
  const pctCrit = freePct < t.criticalPct;
  const pctWarn = freePct < t.warningPct;
  const gbCrit = freeGb < t.criticalGb;
  const gbWarn = freeGb < t.warningGb;
  const isCritThr = t.mode === 'pct' ? pctCrit : t.mode === 'gb' ? gbCrit : (pctCrit || gbCrit);
  const isWarnThr = t.mode === 'pct' ? pctWarn : t.mode === 'gb' ? gbWarn : (pctWarn || gbWarn);
  if (isCritThr && diskInScope(d, t.critScope)) return 'critical';
  if (isWarnThr && diskInScope(d, t.warnScope)) return 'warning';
  return 'ok';
}

export interface DiskSummary {
  criticalDrives: number;
  warningDrives: number;
  criticalPcs: number;
  warningPcs: number;
}

/**
 * Disk-critical summary restricted to PCs the operator opted into email
 * monitoring (computers.disk_email_monitor). Drives the Dashboard "monitored
 * disks" tile and mirrors the server-side alert evaluation in services/alerts.ts.
 */
export function summarizeMonitoredDisks(
  disks: DiskItem[],
  computers: ComputerItem[],
  t: DiskThresholds,
): { monitoredPcs: number; criticalPcs: number; criticalDrives: number } {
  // Per-PC drive scope: explicit letters in disk_email_drives if set, else the
  // global critical scope. Mirrors services/alerts.ts on the server.
  const scopeByPc = new Map<number, DriveLetterScope>();
  for (const c of computers) {
    if (!c.disk_email_monitor) continue;
    const letters = (c.disk_email_drives ?? '').trim();
    scopeByPc.set(c.id, letters ? parseDriveScope(letters, t.critScope) : t.critScope);
  }
  let criticalDrives = 0;
  const critPcs = new Set<number>();
  for (const d of disks) {
    const scope = scopeByPc.get(d.computer_id);
    if (!scope) continue;
    if (evaluateDisk(d, t) === 'critical' && diskInScope(d, scope)) {
      criticalDrives++;
      critPcs.add(d.computer_id);
    }
  }
  return { monitoredPcs: scopeByPc.size, criticalPcs: critPcs.size, criticalDrives };
}

function svcGlob(p: string): RegExp {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}
function svcNameList(raw: string | undefined): RegExp[] {
  return (raw ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).map(svcGlob);
}

/**
 * Globally-ignored services (the alert whitelist, reused as a view filter).
 * A service whose name OR display name matches any pattern is treated as
 * benign noise — excluded from the Dashboard "stopped services" tile and the
 * Services tab counts. Empty whitelist → matches nothing.
 */
export function serviceWhitelist(settings: Record<string, string>): RegExp[] {
  return svcNameList(settings['alerts.services.whitelist']);
}
export function isServiceWhitelisted(
  name: string,
  displayName: string | null | undefined,
  whitelist: RegExp[],
): boolean {
  if (whitelist.length === 0) return false;
  const dn = displayName ?? '';
  return whitelist.some((re) => re.test(name) || (dn !== '' && re.test(dn)));
}

/**
 * Does a service match a per-PC ignore list (raw comma/newline string with
 * * ? wildcards)? Same matching as the whitelist, used for per-PC critical /
 * broad service exceptions.
 */
export function serviceMatchesExceptions(
  name: string,
  displayName: string | null | undefined,
  rawExceptions: string | null | undefined,
): boolean {
  return isServiceWhitelisted(name, displayName, svcNameList(rawExceptions ?? ''));
}

/**
 * Is a stopped service a real *crash*? Only a NON-zero exit code counts. Both
 * exit code 0 AND null mean the service stopped without reporting a failure
 * (on-demand idle, graceful stop, or benign Auto drift) — and most stopped
 * services are null/0, so null MUST be treated as graceful, not as a crash.
 * Used by the Services tab filters and the broad-alert noise model.
 */
export function isServiceCrash(exitCode: number | null | undefined): boolean {
  return exitCode != null && exitCode !== 0;
}

// ── Operating-system breakdown ──────────────────────────────────────────────
// Sentinels for buckets that need localized labels in the UI (everything else
// is an English OS name that reads the same in both languages).
export const OS_UNKNOWN = 'Unknown';
export const OS_OTHER = 'Other';

/**
 * Normalize the free-text AD `OperatingSystem` string (the only OS field we
 * have) into a small canonical bucket. The Dashboard OS chart AND the Computers
 * OS filter both call this, so the segment counts and the drill-down list stay
 * in sync. `Unknown` = no OS reported; `Other` = a string we don't bucket.
 */
export function osBucket(os: string | null | undefined): string {
  const s = (os ?? '').trim();
  if (!s) return OS_UNKNOWN;
  const server = s.match(/windows server\s+(\d{4})(\s*r2)?/i);
  if (server) return `Windows Server ${server[1]}${server[2] ? ' R2' : ''}`;
  if (/windows server/i.test(s)) return 'Windows Server';
  const client = s.match(/windows\s+(11|10|8\.1|8|7)\b/i);
  if (client) return `Windows ${client[1]}`;
  if (/windows\s+vista/i.test(s)) return 'Windows Vista';
  if (/windows\s+xp/i.test(s)) return 'Windows XP';
  return OS_OTHER;
}

/**
 * A computer is "stale" (aspires to deactivation) when it is not excluded and
 * has not been seen within the inactivity threshold — mirrors the `inactive`
 * filter / Dashboard inactive card. Disabled machines are not in the OS chart
 * scope, so this is only ever asked about enabled ones.
 */
export function isStaleComputer(c: ComputerItem, thresholdDays: number): boolean {
  if (c.excluded) return false;
  const cutoff = Date.now() - thresholdDays * 86400000;
  const seenMs = c.last_seen ? new Date(c.last_seen).getTime() : null;
  return seenMs === null || seenMs < cutoff;
}

export interface OsBucketStat { bucket: string; total: number; stale: number; live: number; }

/**
 * Per-OS counts over the live managed fleet (enabled, not excluded). `stale` is
 * the subset past the inactivity threshold; `live` = total - stale.
 */
export function summarizeOs(computers: ComputerItem[], thresholdDays: number): OsBucketStat[] {
  const map = new Map<string, { total: number; stale: number }>();
  for (const c of computers) {
    if (!c.enabled || c.excluded) continue;
    const b = osBucket(c.os_version);
    const e = map.get(b) ?? { total: 0, stale: 0 };
    e.total++;
    if (isStaleComputer(c, thresholdDays)) e.stale++;
    map.set(b, e);
  }
  return Array.from(map.entries())
    .map(([bucket, v]) => ({ bucket, total: v.total, stale: v.stale, live: v.total - v.stale }))
    .sort((a, b) => b.total - a.total || a.bucket.localeCompare(b.bucket));
}

/**
 * Critical-service outage summary restricted to PCs opted into service email
 * monitoring. service_problems already holds only Auto + non-Running services;
 * we keep those whose name/display matches the critical list and not the
 * whitelist (mirrors the server alert eval). Drives the Dashboard tile.
 */
export function summarizeMonitoredServices(
  problems: ServiceProblem[],
  computers: ComputerItem[],
  settings: Record<string, string>,
): { monitoredPcs: number; downServices: number; affectedPcs: number } {
  const monitoredIds = new Set(computers.filter((c) => c.service_email_monitor).map((c) => c.id));
  const critical = svcNameList(settings['alerts.services.critical_names']);
  const whitelist = svcNameList(settings['alerts.services.whitelist']);
  if (critical.length === 0 || monitoredIds.size === 0) {
    return { monitoredPcs: monitoredIds.size, downServices: 0, affectedPcs: 0 };
  }
  let downServices = 0;
  const pcs = new Set<number>();
  for (const p of problems) {
    if (!monitoredIds.has(p.computer_id) || p.per_user_start) continue;
    const nm = p.service_name;
    const dn = p.display_name ?? '';
    if (!critical.some((re) => re.test(nm) || (dn !== '' && re.test(dn)))) continue;
    if (whitelist.length > 0 && whitelist.some((re) => re.test(nm) || (dn !== '' && re.test(dn)))) continue;
    downServices++;
    pcs.add(p.computer_id);
  }
  return { monitoredPcs: monitoredIds.size, downServices, affectedPcs: pcs.size };
}

export function summarizeDisks(disks: DiskItem[], t: DiskThresholds): DiskSummary {
  let criticalDrives = 0;
  let warningDrives = 0;
  const critPcs = new Set<number>();
  const warnPcs = new Set<number>();
  for (const d of disks) {
    const s = evaluateDiskWithScope(d, t);
    if (s === 'critical') {
      criticalDrives++;
      critPcs.add(d.computer_id);
    } else if (s === 'warning') {
      warningDrives++;
      warnPcs.add(d.computer_id);
    }
  }
  return { criticalDrives, warningDrives, criticalPcs: critPcs.size, warningPcs: warnPcs.size };
}

export function evaluateDisk(d: DiskItem, t: DiskThresholds): DiskStatus {
  if (d.total_bytes <= 0) return 'ok';
  const freePct = (d.free_bytes / d.total_bytes) * 100;
  const freeGb = d.free_bytes / 1024 ** 3;
  const pctCrit = freePct < t.criticalPct;
  const pctWarn = freePct < t.warningPct;
  const gbCrit = freeGb < t.criticalGb;
  const gbWarn = freeGb < t.warningGb;
  if (t.mode === 'pct') return pctCrit ? 'critical' : pctWarn ? 'warning' : 'ok';
  if (t.mode === 'gb') return gbCrit ? 'critical' : gbWarn ? 'warning' : 'ok';
  // either: warn if either threshold tripped
  if (pctCrit || gbCrit) return 'critical';
  if (pctWarn || gbWarn) return 'warning';
  return 'ok';
}

export interface ComputerItem {
  id: number;
  name: string;
  fqdn: string | null;
  os_version: string | null;
  last_seen: string | null;
  enabled: boolean;
  monitor_enabled: boolean;
  disk_email_monitor?: boolean;
  /** Per-PC drive-letter scope for disk email alerts (e.g. "C,F"). Empty = all drives. */
  disk_email_drives?: string;
  service_email_monitor?: boolean;
  /** Per-PC ignore list for critical-service alerts (service names, wildcards). */
  critical_service_exceptions?: string | null;
  /** Broad "Services" level monitor toggle. */
  service_monitor?: boolean;
  /** Per-PC ignore list for the broad Services level (service names, wildcards). */
  service_exceptions?: string | null;
  excluded: boolean;
  last_collected_at?: string | null;
  last_error?: string | null;
  consecutive_failures?: number;
  ou_path?: string | null;
  distinguished_name?: string | null;
  last_status?: 'online' | 'offline' | 'rpc_unavailable' | 'access_denied' | 'unknown' | null;
  current_user?: string | null;
  current_user_seen_at?: string | null;
  ip_address?: string | null;
  pc_info_collected_at?: string | null;
  /** Live network reachability from the standalone TCP probe (null = not probed yet). */
  reachable?: boolean | null;
  last_reachable_at?: string | null;
  reach_checked_at?: string | null;
}

/** One PC's latest verdict for a single configured port (Ports tab grid). */
export interface PortStatusEntry {
  check_name: string;
  port: number;
  is_open: boolean;
  latency_ms: number | null;
  checked_at: string;
}

/** A monitored PC with its latest per-port availability (GET /port-status). */
export interface PortStatusComputer {
  id: number;
  name: string;
  fqdn: string | null;
  ip_address: string | null;
  reachable: boolean | null;
  reach_checked_at: string | null;
  ports: PortStatusEntry[];
}

/** Live result of a single port probe (per-PC on-demand probe). */
export interface PortProbeResult {
  checkName: string;
  port: number;
  open: boolean;
  latencyMs: number | null;
}

/** Response of POST /computers/:id/probe — live ICMP ping + per-port TCP. */
export interface PerPcProbeResult {
  computerId: number;
  host: string;
  ping: boolean;
  ports: PortProbeResult[];
  /** cmd-like transcript (raw ping output + per-port lines) for the console modal. */
  console: string;
}

/** A MikroTik DHCP-discovered device (Devices tab), paired with its AD computer. */
export interface DeviceItem {
  site: string;
  mac_address: string;
  ip_address: string | null;
  host_name: string | null;
  server: string | null;
  comment: string | null;
  status: string | null;
  dynamic: boolean | null;              // false = static (DHCP reservation / ARP / scan)
  source: string | null;               // 'dhcp' | 'arp' | 'scan'
  expires_after: string | null;
  router_last_seen: string | null;
  last_seen: string;
  reachable: boolean | null;            // ping verdict for UNMATCHED devices
  packet_loss: number | null;           // last measured packet loss % (0–100)
  latency_ms: number | null;            // last measured avg round-trip (ms)
  reach_checked_at: string | null;
  category: string | null;              // operator-assigned category (by MAC)
  operator_name: string | null;         // operator-edited device name (by MAC)
  operator_note: string | null;         // operator free-text note (by MAC)
  computer_id: number | null;           // matched AD computer (host_name / IP)
  computer_name: string | null;
  computer_reachable: boolean | null;   // matched computer's reachability
  suggested: string;                    // UI-only category hint ('' = none)
  ip_history_count: number;             // # of distinct IPs this MAC has used (archive)
}

/** One entry of a device's IP-address archive (GET /devices/ip-history). */
export interface DeviceIpHistory {
  ip_address: string;
  site: string | null;
  source: string | null;
  first_seen: string;
  last_seen: string;
}

/** One ink/toner/maintenance supply of a printer (Stav tiskáren page). */
export interface PrinterSupply {
  key: string;                          // K/C/M/Y/MAINT/DRUM/BELT/FUSER/OTHER
  description: string | null;           // raw device description
  colorant: string | null;              // black/cyan/magenta/yellow/none
  type: string | null;                  // ink/toner/maintenance/drum/belt/...
  level_pct: number | null;             // 0..100 (null = unknown / "some remaining")
  part_code: string | null;             // order code, when exposed
  source: string | null;                // 'snmp' | 'http'
}

/** A printer with its supplies (grouped by MAC). */
export interface PrinterDevice {
  mac_address: string;
  ip_address: string | null;
  host_name: string | null;
  operator_name: string | null;
  operator_note: string | null;
  site: string | null;
  model: string | null;
  collected_at: string;
  supplies: PrinterSupply[];
}

/** Response of GET /printer-supplies. */
export interface PrinterSuppliesResult {
  lowPct: number;                       // "running low" threshold (%) from Settings
  printers: PrinterDevice[];
}

/** Per-table footprint for the Database tab. */
export interface DbTableStat {
  table_name: string;
  row_count: number;
  reserved_kb: number;
  used_kb: number;
  data_kb: number;
}

/** Whole-DB size summary + per-table breakdown (GET /database). */
export interface DatabaseOverview {
  db: { name: string; data_kb: number; log_kb: number; total_kb: number; data_used_kb: number };
  tables: DbTableStat[];
}

/** Effective reachability of a device: matched → its AD computer's, else the lease ping. */
export function deviceReachable(d: DeviceItem): boolean | null {
  return d.computer_id != null ? d.computer_reachable : d.reachable;
}

/** Operator-tunable "problem" thresholds (Settings); defaults: any loss, >=50ms. */
export interface ProblemThresholds { lossPct: number; latencyMs: number }
export function deviceProblemThresholds(settings: Record<string, string>): ProblemThresholds {
  const lossPct = Number(settings['devices.problem_loss_pct']);
  const latencyMs = Number(settings['devices.problem_latency_ms']);
  return {
    lossPct: Number.isFinite(lossPct) && lossPct > 0 ? lossPct : 1,
    latencyMs: Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 50,
  };
}

/** A "degraded"/problematic device = online but with loss or latency at/above the thresholds. */
export function deviceDegraded(d: DeviceItem, th?: ProblemThresholds): boolean {
  const lossT = th?.lossPct ?? 1;
  const latT = th?.latencyMs ?? 50;
  return deviceReachable(d) === true && ((d.packet_loss ?? 0) >= lossT || (d.latency_ms ?? 0) >= latT);
}

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  removed: number;
  durationMs: number;
}

async function jpost<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { method: 'POST' });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${path} → ${r.status} ${text}`);
  }
  return r.json() as Promise<T>;
}

export interface AccessCheck {
  ip: string;
  allowed: boolean;
}

export interface DomainProfileStatus {
  enabled: boolean | null;
  defaultInboundAction: string | null;
  error?: string;
}

export interface InactiveStats {
  thresholdDays: number;
  enabledInactive: number;
  disabledInactive: number;
  totalEnabled: number;
  totalDisabled: number;
}

export interface SingleRefreshResult {
  computerId: number;
  computerName: string;
  ok: boolean;
  durationMs: number;
  steps: Array<{ step: string; ok: boolean; detail: string; durationMs: number }>;
}

export interface PcUserHistoryItem {
  id: number;
  user_name: string;
  first_seen: string;
  last_seen: string;
  ip_address: string | null;
}

export interface ActivityHistoryItem {
  id: number;
  ts: string;
  level: 'info' | 'warn' | 'error' | 'success';
  source: string;
  message: string;
}

export type MachineKind = 'server' | 'pc';
export type MachineStatus = 'active' | 'offline' | 'disabled';

export interface ReportMachine {
  name: string;
  ip: string | null;
  os: string | null;
  kind: MachineKind;
  status: MachineStatus;
  monitored: boolean;
  lastSeen: string | null;
  lastReachableAt: string | null;
  consecutiveFailures: number;
}

export interface OverviewReport {
  generatedAt: string;
  totals: {
    total: number;
    servers: number;
    pcs: number;
    active: number;
    offline: number;
    disabled: number;
    monitored: number;
    failing: number;
  };
  machines: ReportMachine[];
  offline: ReportMachine[];
}

export const api = {
  accessCheck: () => jget<AccessCheck>('/access-check'),
  activityHistory: (q: { level?: 'info' | 'warn' | 'error' | 'success'; source?: string; hours?: number; search?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.level) params.set('level', q.level);
    if (q.source) params.set('source', q.source);
    if (q.hours) params.set('hours', String(q.hours));
    if (q.search) params.set('search', q.search);
    if (q.limit) params.set('limit', String(q.limit));
    if (q.offset) params.set('offset', String(q.offset));
    return jget<{ items: ActivityHistoryItem[]; total: number; limit: number; offset: number }>(`/activity/history?${params}`);
  },
  activitySources: () => jget<{ items: { source: string; cnt: number }[] }>('/activity/sources'),
  summary: () => jget<Summary>('/events/summary'),
  events: (q: { computer?: string; level?: 'critical' | 'error' | 'warning'; hours?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.computer) params.set('computer', q.computer);
    if (q.level) params.set('level', q.level);
    if (q.hours) params.set('hours', String(q.hours));
    if (q.limit) params.set('limit', String(q.limit));
    return jget<{ items: EventItem[] }>(`/events?${params}`);
  },
  topIds: (hours = 24, limit = 15) => jget<{ items: TopEventId[] }>(`/events/top-ids?hours=${hours}&limit=${limit}`),
  timeline: (hours = 24) => jget<{ items: TimelineBucket[] }>(`/events/timeline?hours=${hours}`),
  pcHealth: () => jget<PcHealthResult>('/events/pc-health'),
  snoozePc: async (computer: string, days: number, note?: string, by?: string) => {
    const r = await fetch(`${API_BASE}/events/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ computer, days, note, by }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error || `POST /events/snooze → ${r.status}`);
    return j as { ok: true; computer: string; days: number; by: string; snoozedUntil: string | null };
  },
  unsnoozePc: async (computer: string) => {
    const r = await fetch(`${API_BASE}/events/snooze/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ computer }),
    });
    if (!r.ok) throw new Error(`POST /events/snooze/clear → ${r.status}`);
    return r.json() as Promise<{ ok: true; computer: string; cleared: number }>;
  },
  topComputers: (hours = 24, limit = 10) => jget<{ items: TopComputer[] }>(`/events/top-computers?hours=${hours}&limit=${limit}`),
  computers: () => jget<{ items: ComputerItem[] }>('/computers'),
  inactiveStats: () => jget<InactiveStats>('/computers/inactive-stats'),
  userHistory: (computerId: number, days = 90) =>
    jget<{ items: PcUserHistoryItem[] }>(`/computers/${computerId}/user-history?days=${days}`),
  refreshPc: (computerId: number) => jpost<SingleRefreshResult>(`/computers/${computerId}/refresh`),
  syncComputers: () => jpost<SyncResult>('/computers/sync'),
  collectorStatus: () => jget<CollectorStatus>('/collector/status'),
  collectorRun: () => jpost<CollectorRunResult>('/collector/run'),
  collectorRunAll: () => jpost<CollectorRunAllResult>('/collector/run-all'),
  reachabilityRun: () => jpost<{ pcs: number; reachable: number; unreachable: number; durationMs: number }>('/reachability/run'),
  portStatus: () => jget<{ items: PortStatusComputer[] }>('/port-status'),
  portStatusRun: () => jpost<{ pcs: number; probed: number; skippedOffline: number; openPorts: number; durationMs: number }>('/port-status/run'),
  probeComputer: (computerId: number) => jpost<PerPcProbeResult>(`/computers/${computerId}/probe`),
  devices: () => jget<{ items: DeviceItem[] }>('/devices'),
  printerSupplies: () => jget<PrinterSuppliesResult>('/printer-supplies'),
  printerSuppliesRun: () => jpost<{ printers: number; read: number; supplies: number; errors: string[]; durationMs: number }>('/printer-supplies/run'),
  database: () => jget<DatabaseOverview>('/database'),
  devicesRun: () => jpost<{ routers: number; leases: number; unmatchedPinged: number; reachable: number; scanned: number; errors: string[]; durationMs: number }>('/devices/run'),
  unifiRun: () => jpost<{ clients: number; upserted: number; errors: string[]; durationMs: number }>('/unifi/run'),
  deviceIpHistory: (mac: string) => jget<{ items: DeviceIpHistory[] }>(`/devices/ip-history?mac=${encodeURIComponent(mac)}`),
  mikrotikTest: () => jpost<{ tested: number; results: { site: string; ip: string; ok: boolean; count: number | null; ms: number; error?: string }[] }>('/mikrotik/test'),
  integrationsStatus: () => jget<{ items: Record<string, { ts: string; level: string; message: string; lastOk: string | null }> }>('/integrations/status'),
  setDeviceCategory: async (mac: string, category: string) => {
    const r = await fetch(`${API_BASE}/devices/category`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, category }),
    });
    if (!r.ok) throw new Error(`PATCH /devices/category → ${r.status}`);
    return r.json() as Promise<{ mac: string; category: string }>;
  },
  setDeviceName: async (mac: string, name: string) => {
    const r = await fetch(`${API_BASE}/devices/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, name }),
    });
    if (!r.ok) throw new Error(`PATCH /devices/name → ${r.status}`);
    return r.json() as Promise<{ mac: string; name: string }>;
  },
  setDeviceNote: async (mac: string, note: string) => {
    const r = await fetch(`${API_BASE}/devices/note`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, note }),
    });
    if (!r.ok) throw new Error(`PATCH /devices/note → ${r.status}`);
    return r.json() as Promise<{ mac: string; note: string }>;
  },
  probeDevice: async (site: string, mac: string, ip: string) => {
    const r = await fetch(`${API_BASE}/devices/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site, mac, ip }),
    });
    if (!r.ok) throw new Error(`POST /devices/probe → ${r.status}`);
    return r.json() as Promise<{ alive: boolean; console: string }>;
  },
  collectorStop: () => jpost<{ stopped: boolean }>('/collector/stop'),
  activityLog: (limit = 200, sinceSeq?: number) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (sinceSeq != null) params.set('sinceSeq', String(sinceSeq));
    return jget<{ entries: ActivityLogEntry[]; seq: number }>(`/activity/log?${params}`);
  },
  syncHistory: () => jget<{ items: AdSyncRun[] }>('/computers/sync/history'),
  lastSync: () => jget<{ last: AdSyncRun | null }>('/computers/sync/last'),
  version: () => jget<VersionInfo>('/version'),
  setExcluded: async (id: number, excluded: boolean) => {
    const r = await fetch(`${API_BASE}/computers/${id}/excluded`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded }),
    });
    if (!r.ok) throw new Error(`PATCH /computers/${id}/excluded → ${r.status}`);
    return r.json() as Promise<{ id: number; name: string; excluded: boolean }>;
  },
  setMonitor: async (id: number, monitor: boolean) => {
    const r = await fetch(`${API_BASE}/computers/${id}/monitor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor }),
    });
    if (!r.ok) throw new Error(`PATCH /computers/${id}/monitor → ${r.status}`);
    return r.json() as Promise<{ id: number; name: string; monitor_enabled: boolean }>;
  },
  setDiskEmailMonitor: async (id: number, patch: { enabled?: boolean; drives?: string }) => {
    const r = await fetch(`${API_BASE}/computers/${id}/disk-email-monitor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`PATCH /computers/${id}/disk-email-monitor → ${r.status}`);
    return r.json() as Promise<{ id: number; name: string; disk_email_monitor: boolean; disk_email_drives: string }>;
  },
  sendDiskAlertTest: async () => {
    const r = await fetch(`${API_BASE}/alerts/disk/test`, { method: 'POST' });
    const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; recipients?: number; critical?: number; monitoredPcs?: number };
    if (!r.ok || body.ok === false) throw new Error(body.error || `POST /alerts/disk/test → ${r.status}`);
    return body as { ok: true; recipients: number; critical: number; monitoredPcs: number };
  },
  setServiceMonitor: async (id: number, patch: { enabled?: boolean; exceptions?: string }) => {
    const r = await fetch(`${API_BASE}/computers/${id}/service-monitor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`PATCH /computers/${id}/service-monitor → ${r.status}`);
    return r.json() as Promise<{ id: number; name: string; service_monitor: boolean; service_exceptions: string }>;
  },
  setServiceEmailMonitor: async (id: number, patch: { enabled?: boolean; exceptions?: string }) => {
    const r = await fetch(`${API_BASE}/computers/${id}/service-email-monitor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`PATCH /computers/${id}/service-email-monitor → ${r.status}`);
    return r.json() as Promise<{ id: number; name: string; service_email_monitor: boolean; critical_service_exceptions: string }>;
  },
  sendServiceAlertTest: async () => {
    const r = await fetch(`${API_BASE}/alerts/services/test`, { method: 'POST' });
    const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; recipients?: number; down?: number; monitoredPcs?: number };
    if (!r.ok || body.ok === false) throw new Error(body.error || `POST /alerts/services/test → ${r.status}`);
    return body as { ok: true; recipients: number; down: number; monitoredPcs: number };
  },
  sendPortAlertTest: async () => {
    const r = await fetch(`${API_BASE}/alerts/ports/test`, { method: 'POST' });
    const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; recipients?: number; down?: number; monitoredPcs?: number };
    if (!r.ok || body.ok === false) throw new Error(body.error || `POST /alerts/ports/test → ${r.status}`);
    return body as { ok: true; recipients: number; down: number; monitoredPcs: number };
  },
  sendPrinterAlertTest: async () => {
    const r = await fetch(`${API_BASE}/alerts/printers/test`, { method: 'POST' });
    const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; recipients?: number; offline?: number };
    if (!r.ok || body.ok === false) throw new Error(body.error || `POST /alerts/printers/test → ${r.status}`);
    return body as { ok: true; recipients: number; offline: number };
  },
  sendFreshnessAlertTest: async () => {
    const r = await fetch(`${API_BASE}/alerts/freshness/test`, { method: 'POST' });
    const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; recipients?: number; stale?: number };
    if (!r.ok || body.ok === false) throw new Error(body.error || `POST /alerts/freshness/test → ${r.status}`);
    return body as { ok: true; recipients: number; stale: number };
  },
  routersStatus: () => jget<Array<{
    site: string; ip: string; ftp: boolean; muted: boolean;
    leaseFileTime: string | null; arpFileTime: string | null;
    leaseCount: number | null; arpCount: number | null;
    fetchedAt: string | null; lastError: string | null;
    minsSinceChange: number | null; stale: boolean | null; thresholdMinutes: number;
    devices: number; bySource: { dhcp: number; arp: number; scan: number; unifi: number } | null;
  }>>('/network/routers'),
  ftpFetchNow: async () => {
    const r = await fetch(`${API_BASE}/network/ftp-fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await r.json().catch(() => ({})) as { items?: Array<{ site: string; ip: string; ok: boolean; lines: string[] }>; error?: string };
    if (!r.ok || body.error) throw new Error(body.error || `POST /network/ftp-fetch → ${r.status}`);
    return body.items ?? [];
  },
  dbRows: (site?: string, limit = 200) => jget<{
    items: Array<{ site: string; ip_address: string | null; mac_address: string; host_name: string | null; source: string | null; status: string | null; last_seen: string }>;
    total: number;
  }>(`/network/db-rows?limit=${limit}${site ? `&site=${encodeURIComponent(site)}` : ''}`),
  deviceHistory: (q = '', limit = 500) => jget<{
    items: Array<{ mac_address: string; ip_address: string; host_name: string | null; site: string | null; source: string | null; first_seen: string; last_seen: string; minutes_span: number }>;
  }>(`/devices/history?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  reportOverview: () => jget<OverviewReport>('/reports/overview'),
  sendReportEmail: async (machines?: string[]) => {
    const r = await fetch(`${API_BASE}/reports/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(machines && machines.length ? { machines } : {}),
    });
    const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; recipients?: number; total?: number; offline?: number };
    if (!r.ok || body.ok === false) throw new Error(body.error || `POST /reports/email → ${r.status}`);
    return body as { ok: true; recipients: number; total: number; offline: number };
  },
  disks: () => jget<{ items: DiskItem[] }>('/disks'),
  disksCollect: () => jpost<{ pcs: number; ok: number; fail: number; drives: number; durationMs: number }>('/disks/collect'),
  serviceProblems: () => jget<{ items: ServiceProblem[] }>('/services/problems'),
  servicesScan: () => jpost<{ pcs: number; ok: number; fail: number; problems: number; durationMs: number }>('/services/scan'),
  servicesAggregate: () => jget<{ items: ServiceAggregate[] }>('/services/aggregate'),
  criticalServices: () => jget<{ items: CriticalServiceStatus[] }>('/services/critical'),
  servicesGpoScriptUrl: () => `${API_BASE}/services/gpo-script`,
  settings: () => jget<Record<string, string>>('/settings'),
  firewallWhitelist: () => jget<{ ips: string[] }>('/firewall/whitelist'),
  firewallDomainProfile: () => jget<DomainProfileStatus>('/firewall/domain-profile'),
  saveFirewallWhitelist: async (ips: string[]) => {
    const r = await fetch(`${API_BASE}/firewall/whitelist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ips }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`PUT /firewall/whitelist → ${r.status} ${text}`);
    }
    return r.json() as Promise<{ ips: string[] }>;
  },
  perfEvents: (q: { computer?: string; category?: PerfCategory; days?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.computer) params.set('computer', q.computer);
    if (q.category) params.set('category', q.category);
    if (q.days) params.set('days', String(q.days));
    if (q.limit) params.set('limit', String(q.limit));
    return jget<{ items: PerfEventItem[] }>(`/perf-events?${params}`);
  },
  perfSummary: (days = 7) => jget<PerfSummary>(`/perf-events/summary?days=${days}`),
  perfTopCulprits: (days = 7, limit = 15) => jget<{ items: PerfCulprit[] }>(`/perf-events/top-culprits?days=${days}&limit=${limit}`),
  perfTopPcs: (days = 7, limit = 15) => jget<{ items: PerfTopPc[] }>(`/perf-events/top-pcs?days=${days}&limit=${limit}`),
  perfScan: () => jpost<PerfScanResult | { skipped: true }>('/perf-events/scan'),
  saveSettings: async (values: Record<string, string>) => {
    const r = await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!r.ok) throw new Error(`PUT /settings → ${r.status}`);
    return r.json() as Promise<{ updated: number }>;
  },
  bulkSetFlag: async (ids: number[], flag: 'monitor_enabled' | 'disk_email_monitor' | 'service_email_monitor' | 'service_monitor' | 'excluded', value: boolean) => {
    const r = await fetch(`${API_BASE}/computers/bulk-flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, flag, value }),
    });
    if (!r.ok) throw new Error(`POST /computers/bulk-flag → ${r.status}`);
    return r.json() as Promise<{ updated: number; flag: string; value: boolean }>;
  },
  setMonitorBulk: async (ids: number[], monitor: boolean) => {
    const r = await fetch(`${API_BASE}/computers/monitor/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, monitor }),
    });
    if (!r.ok) throw new Error(`POST /computers/monitor/bulk → ${r.status}`);
    return r.json() as Promise<{ updated: number; monitor: boolean }>;
  },
  crashes: () => jget<{ items: CrashItem[]; running: boolean }>('/crashes'),
  crashDetail: (id: number) => jget<CrashDetail>(`/crashes/${id}`),
  crashRun: () => jpost<{ ok: boolean; collect: { pcs: number; collected: number; skipped: number } | null; analyze: { analyzed: number; failed: number } | null }>('/crashes/run'),
  crashDmpUrl: (id: number) => `${API_BASE}/crashes/${id}/dmp`,
};

export interface CrashItem {
  id: number;
  computer_id: number;
  computer_name: string | null;
  source_filename: string;
  occurred_at: string | null;
  size_bytes: number | null;
  status: string;            // pending | analyzed | failed
  stop_code: string | null;
  bugcheck_name: string | null;
  hot_function: string | null;
  culprit_process: string | null;
  culprit_module: string | null;
  analyze_error: string | null;
  ingested_at: string;
  analyzed_at: string | null;
}
export interface CrashDetail extends CrashItem { analyze_text: string | null; }

export interface VersionInfo {
  sha: string;
  shaFull: string;
  branch: string | null;
  builtAt: string;
}

export interface ActivityLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'success';
  source: string;
  message: string;
}

export interface AdSyncRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  fetched: number | null;
  inserted: number | null;
  updated: number | null;
  removed: number | null;
  error: string | null;
  trigger_source: string | null;
}

export interface CollectorProgress {
  startedAt: string;
  triggerSource: 'scheduled' | 'manual';
  totalPcs: number;
  processedPcs: number;
  succeededPcs: number;
  failedPcs: number;
  eventsAddedSoFar: number;
  currentlyProcessing: string[];
  recentFailures: { name: string; error: string }[];
}

export interface CollectorStatus {
  inFlight: boolean;
  progress: CollectorProgress | null;
  lastRun: {
    id: number;
    started_at: string;
    finished_at: string | null;
    pcs_total: number | null;
    pcs_succeeded: number | null;
    pcs_failed: number | null;
    events_added: number | null;
    trigger_source: string | null;
  } | null;
}

export interface CollectorRunResult {
  runId: number;
  pcsTotal: number;
  pcsSucceeded: number;
  pcsFailed: number;
  eventsAdded: number;
  durationMs: number;
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

export interface CollectorRunAllResult {
  eventlog: CollectorRunResult | null;
  disk: DiskCollectResult | null;
  services: ServicesScanResult | null;
  perf: PerfScanResult | null;
  adsync: SyncResult | null;
  durationMs: number;
  selected: {
    eventlog: boolean;
    disk: boolean;
    services: boolean;
    perf: boolean;
    adsync: boolean;
  };
}

export type PerfCategory = 'boot' | 'shutdown' | 'standby' | 'resume' | 'other';

export interface PerfEventItem {
  id: number;
  computer: string;
  time_created: string;
  event_id: number;
  level: number;
  category: PerfCategory;
  total_time_ms: number | null;
  degradation_ms: number | null;
  culprit_name: string | null;
  culprit_friendly: string | null;
  message: string | null;
}

export interface PerfSummary {
  boot_count: number;
  shutdown_count: number;
  standby_count: number;
  resume_count: number;
  affected_pcs: number;
  total_events: number;
}

export interface PerfCulprit {
  culprit: string;
  category: PerfCategory;
  event_count: number;
  pc_count: number;
  avg_total_ms: number | null;
  max_total_ms: number | null;
}

export interface PerfTopPc {
  name: string;
  event_count: number;
  boot_count: number;
  shutdown_count: number;
  avg_boot_ms: number | null;
  last_event_at: string;
}

export interface PerfScanResult {
  pcs: number;
  ok: number;
  fail: number;
  channelDisabled: number;
  events: number;
  durationMs: number;
}

export function levelName(level: number): 'crit' | 'err' | 'warn' | 'info' {
  if (level === 1) return 'crit';
  if (level === 2) return 'err';
  if (level === 3) return 'warn';
  return 'info';
}

export function levelLabel(level: number): string {
  return ({ 1: 'Critical', 2: 'Error', 3: 'Warning', 4: 'Info', 5: 'Verbose' } as Record<number, string>)[level] ?? `L${level}`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
