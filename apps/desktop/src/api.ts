export const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? 'http://10.8.2.213:4000';

export interface Summary {
  critical_24h: number;
  error_24h: number;
  warning_24h: number;
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

export interface DiskThresholds {
  criticalPct: number;
  warningPct: number;
  criticalGb: number;
  warningGb: number;
  mode: 'pct' | 'gb' | 'either';
}

export function parseDiskThresholds(settings: Record<string, string>): DiskThresholds {
  return {
    criticalPct: Number(settings['disk.critical_pct'] ?? 5),
    warningPct: Number(settings['disk.warning_pct'] ?? 15),
    criticalGb: Number(settings['disk.critical_gb'] ?? 5),
    warningGb: Number(settings['disk.warning_gb'] ?? 20),
    mode: (settings['disk.threshold_mode'] as 'pct' | 'gb' | 'either') ?? 'pct',
  };
}

export interface DiskSummary {
  criticalDrives: number;
  warningDrives: number;
  criticalPcs: number;
  warningPcs: number;
}

export function summarizeDisks(disks: DiskItem[], t: DiskThresholds): DiskSummary {
  let criticalDrives = 0;
  let warningDrives = 0;
  const critPcs = new Set<number>();
  const warnPcs = new Set<number>();
  for (const d of disks) {
    const s = evaluateDisk(d, t);
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
  last_collected_at?: string | null;
  last_error?: string | null;
  consecutive_failures?: number;
  ou_path?: string | null;
  distinguished_name?: string | null;
  last_status?: 'online' | 'offline' | 'rpc_unavailable' | 'access_denied' | 'unknown' | null;
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

export const api = {
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
  topComputers: (hours = 24, limit = 10) => jget<{ items: TopComputer[] }>(`/events/top-computers?hours=${hours}&limit=${limit}`),
  computers: () => jget<{ items: ComputerItem[] }>('/computers'),
  syncComputers: () => jpost<SyncResult>('/computers/sync'),
  collectorStatus: () => jget<CollectorStatus>('/collector/status'),
  collectorRun: () => jpost<CollectorRunResult>('/collector/run'),
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
  setMonitor: async (id: number, monitor: boolean) => {
    const r = await fetch(`${API_BASE}/computers/${id}/monitor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor }),
    });
    if (!r.ok) throw new Error(`PATCH /computers/${id}/monitor → ${r.status}`);
    return r.json() as Promise<{ id: number; name: string; monitor_enabled: boolean }>;
  },
  disks: () => jget<{ items: DiskItem[] }>('/disks'),
  disksCollect: () => jpost<{ pcs: number; ok: number; fail: number; drives: number; durationMs: number }>('/disks/collect'),
  settings: () => jget<Record<string, string>>('/settings'),
  firewallWhitelist: () => jget<{ ips: string[] }>('/firewall/whitelist'),
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
  saveSettings: async (values: Record<string, string>) => {
    const r = await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!r.ok) throw new Error(`PUT /settings → ${r.status}`);
    return r.json() as Promise<{ updated: number }>;
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
