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

export interface ComputerItem {
  id: number;
  name: string;
  fqdn: string | null;
  os_version: string | null;
  last_seen: string | null;
  enabled: boolean;
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
  computers: () => jget<{ items: ComputerItem[] }>('/computers'),
  syncComputers: () => jpost<SyncResult>('/computers/sync'),
};

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
