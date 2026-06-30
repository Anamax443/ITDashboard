import { getPool } from '../db/pool.js';
import { getAllSettings } from './settings.js';
import { tcpProbeTimed } from './port-status-collector.js';

// One-off "what services do we actually run" discovery: scans a broad set of TCP
// ports on a SAMPLE of reachable devices per category (printers, VoIP phones,
// network gear, …) so the operator sees the real port profile instead of a guessed
// check list. User-triggered (it's a deliberate probe sweep of production devices).
// VoIP desk phones are split out from the generic 'phone' category by MAC OUI
// (Yealink etc.), since 'phone' otherwise holds guest-WiFi mobiles.

export interface DiscoCatProfile {
  category: string;
  sampled: { ip: string; name: string | null }[];
  ports: { port: number; open: number; of: number }[];
}
export interface DiscoResult {
  full: boolean;
  scannedPorts: number;
  durationMs: number;
  categories: DiscoCatProfile[];
  ranAt: string;
}

let running = false;
export function isDiscoveryRunning(): boolean { return running; }

const ouiOf = (mac: string | null | undefined) => (mac ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, 6);

// Broad-but-bounded port set: all well-known (1–1024) + common higher service
// ports (incl. MikroTik 8291/8728, IPP/RAW, SIP, web-admin, NAS, db, …).
const HIGH_PORTS = [
  1433, 1521, 1723, 1883, 2000, 2049, 2082, 2083, 2086, 2087, 2095, 2096, 2222, 3000,
  3128, 3260, 3306, 3389, 3478, 4443, 4444, 4567, 5000, 5001, 5060, 5061, 5222, 5269,
  5357, 5432, 5555, 5601, 5672, 5900, 5985, 5986, 6379, 7000, 7070, 7547, 8000, 8006,
  8008, 8009, 8080, 8081, 8088, 8089, 8123, 8181, 8291, 8443, 8472, 8728, 8729, 8883,
  8888, 9000, 9090, 9091, 9100, 9200, 9300, 9418, 9999, 10000, 11211, 27017, 32400,
  49152, 49153, 49154, 51820,
];
function discoveryPorts(full: boolean): number[] {
  if (full) return Array.from({ length: 65535 }, (_, i) => i + 1);
  const lows = Array.from({ length: 1024 }, (_, i) => i + 1);
  return [...lows, ...HIGH_PORTS.filter((p) => p > 1024)];
}

// Run an async mapper with a fixed concurrency cap.
async function pooled<T>(items: T[], limit: number, fn: (it: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; await fn(items[idx]!); }
  }));
}

export async function runServiceDiscovery(full: boolean): Promise<DiscoResult | null> {
  if (running) return null;
  running = true;
  const t0 = Date.now();
  try {
    const s = await getAllSettings();
    const timeout = Math.max(300, Number(s['svcdisc.timeout_ms']) || 800);
    const sampleN = full
      ? Math.max(1, Math.min(8, Number(s['svcdisc.full_sample']) || 3))
      : Math.max(1, Math.min(40, Number(s['svcdisc.sample']) || 8));
    const wantCats = (s['svcdisc.categories'] ?? 'printer,voip,phone,network,iot')
      .split(/[,;\s]+/).map((c) => c.trim().toLowerCase()).filter(Boolean);
    const voipOuis = new Set((s['svcports.voip_ouis'] ?? '805ec0,249ad8,001565')
      .split(/[,;\s]+/).map((x) => ouiOf(x)).filter((x) => x.length === 6));
    const conc = full ? 256 : 160;

    const pool = await getPool();
    const devices = (await pool.request().query<{ ip_address: string; mac_address: string | null; name: string | null; category: string | null }>(`
      SELECT l.ip_address, l.mac_address,
             COALESCE(NULLIF(LTRIM(RTRIM(c.name)), ''), l.host_name) AS name,
             c.category
      FROM dhcp_leases l
      LEFT JOIN device_categories c ON c.mac_address = l.mac_address
      WHERE l.ip_address IS NOT NULL AND (l.reachable = 1 OR l.reachable IS NULL)`)).recordset;

    // Effective category: a Yealink/VoIP OUI promotes a device to 'voip'.
    const byCat = new Map<string, { ip: string; name: string | null }[]>();
    for (const d of devices) {
      const eff = voipOuis.has(ouiOf(d.mac_address)) ? 'voip' : (d.category ?? '').toLowerCase();
      if (!eff || !wantCats.includes(eff)) continue;
      let arr = byCat.get(eff);
      if (!arr) { arr = []; byCat.set(eff, arr); }
      if (arr.length < sampleN) arr.push({ ip: d.ip_address, name: d.name });
    }

    const ports = discoveryPorts(full);
    const categories: DiscoCatProfile[] = [];
    for (const cat of wantCats) {
      const sampled = byCat.get(cat) ?? [];
      if (sampled.length === 0) continue;
      const openCount = new Map<number, number>();
      const tasks: { ip: string; port: number }[] = [];
      for (const dev of sampled) for (const port of ports) tasks.push({ ip: dev.ip, port });
      await pooled(tasks, conc, async (t) => {
        if ((await tcpProbeTimed(t.ip, t.port, timeout)) != null) openCount.set(t.port, (openCount.get(t.port) ?? 0) + 1);
      });
      const portRows = [...openCount.entries()].map(([port, open]) => ({ port, open, of: sampled.length }))
        .sort((a, b) => b.open - a.open || a.port - b.port);
      categories.push({ category: cat, sampled, ports: portRows });
    }

    return { full, scannedPorts: ports.length, durationMs: Date.now() - t0, categories, ranAt: new Date().toISOString() };
  } finally {
    running = false;
  }
}
