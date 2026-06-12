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
  scoring: PcHealthScoring;
  items: PcHealth[];
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
  setServiceEmailMonitor: async (id: number, enabled: boolean) => {
    const r = await fetch(`${API_BASE}/computers/${id}/service-email-monitor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) throw new Error(`PATCH /computers/${id}/service-email-monitor → ${r.status}`);
    return r.json() as Promise<{ id: number; name: string; service_email_monitor: boolean }>;
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
  bulkSetFlag: async (ids: number[], flag: 'monitor_enabled' | 'disk_email_monitor' | 'service_email_monitor' | 'excluded', value: boolean) => {
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
};

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
