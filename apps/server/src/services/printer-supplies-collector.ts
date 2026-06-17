import { getPool } from '../db/pool.js';
import { getAllSettings, type SettingsMap } from './settings.js';
import { boolSetting } from './alerts-util.js';
import { logActivity } from './activity-log.js';
import { snmpGet, snmpWalk } from './snmp.js';
import { insecureGet, parseBrotherToner, parseEpsonMaint, parseEpsonInks, classifyDescription, extractPartCode, computeLevelPct, type ParsedSupply } from './printer-supplies-http.js';

// Printer supply (ink / toner / maintenance) collector — G2.
//
// Primary source is SNMP Printer-MIB `prtMarkerSupplies` (uniform across HP /
// Epson / Brother / Kyocera): description (.6), max capacity (.8), level (.9) per
// supply; % = level/max. sysDescr (.1.1.0) gives the model. Two vendor gaps are
// then filled from the printer's own web UI (verified live 2026-06-17):
//   * Brother SNMP toner = "-3 (some remaining)" only → numeric % from status.html.
//   * Epson SNMP omits the maintenance (waste) box → % from the Web Config page.
//
// Probes only devices the operator has categorized `printer` (small, safe set).
// Fully DB-driven from Settings; read-only; self-contained; never throws.

const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const OID_SUPPLY_DESC = '1.3.6.1.2.1.43.11.1.1.6';
const OID_SUPPLY_MAX = '1.3.6.1.2.1.43.11.1.1.8';
const OID_SUPPLY_LEVEL = '1.3.6.1.2.1.43.11.1.1.9';

interface PsConfig { intervalSec: number; community: string; lowPct: number; httpFallback: boolean; }

function resolveConfig(settings: SettingsMap): PsConfig | null {
  if (!boolSetting(settings['printer_supplies.enabled'])) return null;
  const n = Number(settings['printer_supplies.interval_sec']);
  const intervalSec = Number.isFinite(n) && n >= 60 ? Math.floor(n) : 900;
  const community = (settings['printer_supplies.snmp_community'] ?? '').trim() || 'public';
  const lp = Number(settings['printer_supplies.low_pct']);
  const lowPct = Number.isFinite(lp) && lp >= 0 && lp <= 100 ? Math.floor(lp) : 15;
  const httpFallback = boolSetting(settings['printer_supplies.http_fallback']);
  return { intervalSec, community, lowPct, httpFallback };
}

interface PrinterTarget { site: string; mac: string; ip: string; host: string | null; }

async function loadPrinters(): Promise<PrinterTarget[]> {
  const pool = await getPool();
  const r = await pool.request().query<{ site: string; mac_address: string; ip_address: string | null; host_name: string | null }>(`
    SELECT l.site, l.mac_address, l.ip_address, l.host_name
    FROM dhcp_leases l
    JOIN device_categories dc ON dc.mac_address = l.mac_address
    WHERE dc.category = 'printer' AND l.ip_address IS NOT NULL
  `);
  return r.recordset.map((x) => ({ site: x.site, mac: x.mac_address, ip: x.ip_address!, host: x.host_name }));
}

// --- Classification (pure, exported for tests) -------------------------------

export interface SupplyRow {
  key: string;
  index: number;
  description: string | null;
  colorant: string;
  type: string;
  levelPct: number | null;
  levelRaw: number | null;
  maxRaw: number | null;
  partCode: string | null;
  source: 'snmp' | 'http';
}

function vendorOf(sysDescr: string, host: string | null): 'hp' | 'epson' | 'brother' | 'unknown' {
  const s = `${sysDescr} ${host ?? ''}`.toLowerCase();
  if (/brother/.test(s)) return 'brother';
  if (/epson/.test(s)) return 'epson';
  if (/\bhp\b|hewlett|jetdirect|laserjet|officejet/.test(s)) return 'hp';
  return 'unknown';
}

// Suffix after a walk base = the table index ".hrDevice.supply", e.g. ".1.3".
function indexSuffix(oid: string, base: string): string {
  return oid.startsWith(base + '.') ? oid.slice(base.length + 1) : oid;
}

// Build SNMP supply rows by aligning the description / max / level walks on their
// shared table-index suffix.
function snmpSupplies(
  descVbs: Array<{ oid: string; value: string | number }>,
  maxVbs: Array<{ oid: string; value: string | number }>,
  levelVbs: Array<{ oid: string; value: string | number }>,
): SupplyRow[] {
  const maxByIdx = new Map<string, number>();
  for (const v of maxVbs) maxByIdx.set(indexSuffix(v.oid, OID_SUPPLY_MAX), Number(v.value));
  const lvlByIdx = new Map<string, number>();
  for (const v of levelVbs) lvlByIdx.set(indexSuffix(v.oid, OID_SUPPLY_LEVEL), Number(v.value));

  const rows: SupplyRow[] = [];
  const seen = new Map<string, number>();
  let i = 0;
  for (const v of descVbs) {
    const idx = indexSuffix(v.oid, OID_SUPPLY_DESC);
    const desc = String(v.value);
    if (!desc) continue;
    const { key: baseKey, colorant, type } = classifyDescription(desc);
    // Disambiguate a repeated colour/component so the PK (mac, key) stays unique.
    const dup = seen.get(baseKey) ?? 0;
    seen.set(baseKey, dup + 1);
    const key = dup === 0 ? baseKey : `${baseKey}${dup + 1}`;
    const levelRaw = lvlByIdx.has(idx) ? lvlByIdx.get(idx)! : null;
    const maxRaw = maxByIdx.has(idx) ? maxByIdx.get(idx)! : null;
    rows.push({
      key, index: i++, description: desc, colorant, type,
      levelPct: computeLevelPct(levelRaw, maxRaw), levelRaw, maxRaw,
      partCode: extractPartCode(desc), source: 'snmp',
    });
  }
  return rows;
}

function titleOf(html: string): string | null {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1]!.trim() : null;
}

// Collect one printer: SNMP first, then the per-vendor HTTP supplement. Returns
// null when nothing could be read (no SNMP, no usable web page).
async function collectOne(p: PrinterTarget, cfg: PsConfig): Promise<{ model: string | null; rows: SupplyRow[] } | null> {
  const sys = await snmpGet(p.ip, OID_SYS_DESCR, cfg.community, 2000);
  const sysDescr = sys && typeof sys.value === 'string' ? sys.value : '';

  let rows: SupplyRow[] = [];
  if (sys) {
    const [descVbs, maxVbs, levelVbs] = await Promise.all([
      snmpWalk(p.ip, OID_SUPPLY_DESC, cfg.community, 2000),
      snmpWalk(p.ip, OID_SUPPLY_MAX, cfg.community, 2000),
      snmpWalk(p.ip, OID_SUPPLY_LEVEL, cfg.community, 2000),
    ]);
    rows = snmpSupplies(descVbs, maxVbs, levelVbs);
  }

  const vendor = vendorOf(sysDescr, p.host);
  let model: string | null = null;
  const hpPid = sysDescr.match(/PID:([^,;]+)/);
  if (hpPid) model = hpPid[1]!.trim();

  // HTTP supplement for the two known SNMP gaps (+ a full read when SNMP is mute).
  if (cfg.httpFallback && (vendor === 'brother' || vendor === 'epson')) {
    if (vendor === 'brother') {
      const html = await insecureGet(`http://${p.ip}/general/status.html`, 6000);
      if (html) {
        if (!model) model = titleOf(html);
        const toners = parseBrotherToner(html);
        rows = mergeHttp(rows, toners, 'toner');
      }
    } else {
      const html = await insecureGet(`https://${p.ip}/PRESENTATION/ADVANCED/INFO_PRTINFO/TOP`, 6000);
      if (html) {
        if (!model) model = titleOf(html);
        if (rows.length === 0) {
          // No SNMP at all — read every ink from the page.
          rows = parseEpsonInks(html).map((s, i) => httpRow(s, i));
        }
        // Always try to add the maintenance box (SNMP never has it on Epson).
        if (!rows.some((r) => r.key === 'MAINT')) {
          const maint = parseEpsonMaint(html);
          if (maint != null) rows.push({ key: 'MAINT', index: rows.length, description: 'Maintenance box', colorant: 'none', type: 'maintenance', levelPct: maint, levelRaw: null, maxRaw: null, partCode: null, source: 'http' });
        }
      }
    }
  }

  if (!model) model = (sysDescr || p.host || '').slice(0, 128) || null;
  if (rows.length === 0) return null;
  return { model, rows };
}

function httpRow(s: ParsedSupply, index: number): SupplyRow {
  return { key: s.key, index, description: null, colorant: s.colorant, type: s.type, levelPct: s.pct, levelRaw: null, maxRaw: null, partCode: null, source: 'http' };
}

// Overlay HTTP-parsed numeric levels onto SNMP rows of the same key (Brother:
// SNMP knows the toner exists but not the %, the web page knows the %). Adds any
// key the SNMP walk missed.
function mergeHttp(snmpRows: SupplyRow[], http: ParsedSupply[], typeHint: string): SupplyRow[] {
  const byKey = new Map(snmpRows.map((r) => [r.key, r]));
  for (const h of http) {
    const existing = byKey.get(h.key);
    if (existing) {
      if (existing.levelPct == null && h.pct != null) { existing.levelPct = h.pct; existing.source = 'http'; }
    } else {
      const row: SupplyRow = { key: h.key, index: snmpRows.length, description: null, colorant: h.colorant, type: h.type || typeHint, levelPct: h.pct, levelRaw: null, maxRaw: null, partCode: null, source: 'http' };
      snmpRows.push(row);
      byKey.set(h.key, row);
    }
  }
  return snmpRows;
}

async function persistSupplies(mac: string, model: string | null, rows: SupplyRow[]): Promise<void> {
  const pool = await getPool();
  const keys = rows.map((r) => r.key);
  for (const r of rows) {
    await pool.request()
      .input('mac', mac).input('key', r.key).input('idx', r.index)
      .input('desc', r.description).input('col', r.colorant).input('type', r.type)
      .input('pct', r.levelPct).input('lvl', r.levelRaw).input('max', r.maxRaw)
      .input('part', r.partCode).input('model', model).input('src', r.source)
      .query(`
        MERGE printer_supplies AS t USING (SELECT @mac AS mac, @key AS [key]) AS s
          ON t.mac_address = s.mac AND t.supply_key = s.[key]
        WHEN MATCHED THEN UPDATE SET
          supply_index = @idx, description = @desc, colorant = @col, supply_type = @type,
          level_pct = @pct, level_raw = @lvl, max_raw = @max, part_code = @part,
          model = @model, source = @src, collected_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT
          (mac_address, supply_key, supply_index, description, colorant, supply_type, level_pct, level_raw, max_raw, part_code, model, source)
          VALUES (@mac, @key, @idx, @desc, @col, @type, @pct, @lvl, @max, @part, @model, @src);
      `);
  }
  // Prune supplies that disappeared from this printer (e.g. a cartridge type
  // removed) so the UI never shows stale rows.
  if (keys.length) {
    const inList = keys.map((_, i) => `@k${i}`).join(',');
    const req = pool.request().input('mac', mac);
    keys.forEach((k, i) => req.input(`k${i}`, k));
    await req.query(`DELETE FROM printer_supplies WHERE mac_address = @mac AND supply_key NOT IN (${inList})`);
  }
}

export interface PrinterSuppliesRunResult {
  printers: number;
  read: number;
  supplies: number;
  errors: string[];
  durationMs: number;
}

let runInFlight = false;

export async function runPrinterSuppliesOnce(): Promise<PrinterSuppliesRunResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  const t0 = Date.now();
  const errors: string[] = [];
  let read = 0;
  let supplies = 0;
  let printers = 0;
  try {
    const settings = await getAllSettings();
    const cfg = resolveConfig(settings);
    if (!cfg) return { printers: 0, read: 0, supplies: 0, errors: [], durationMs: Date.now() - t0 };
    const targets = await loadPrinters();
    printers = targets.length;
    // Modest concurrency — SNMP walks are several round-trips each.
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const p = targets[idx++];
        if (!p) continue;
        try {
          const res = await collectOne(p, cfg);
          if (res) { await persistSupplies(p.mac, res.model, res.rows); read++; supplies += res.rows.length; }
        } catch (e) {
          errors.push(`${p.ip}: ${String(e).split('\n')[0]}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targets.length || 1) }, worker));

    const durationMs = Date.now() - t0;
    logActivity(errors.length ? 'warn' : 'info', 'printer-supplies',
      `Printer supplies: ${read}/${printers} read, ${supplies} supplies${errors.length ? ` · errors: ${errors.join('; ')}` : ''} (${(durationMs / 1000).toFixed(1)}s)`);
    return { printers, read, supplies, errors, durationMs };
  } catch (err) {
    logActivity('error', 'printer-supplies', `Supply collect failed: ${String(err).split('\n')[0]}`);
    return { printers, read, supplies, errors: [String(err)], durationMs: Date.now() - t0 };
  } finally {
    runInFlight = false;
  }
}

let psTimer: NodeJS.Timeout | null = null;
let psStopped = false;
const IDLE_RECHECK_SEC = 60;

// Standalone scheduler — mirrors the other collectors. Re-reads enable/interval
// from Settings each cycle, idles (re-checking every IDLE_RECHECK_SEC) while
// disabled, so toggling it in the UI applies without a restart.
export async function startPrinterSuppliesSchedule(): Promise<void> {
  psStopped = false;
  if (psTimer) { clearTimeout(psTimer); psTimer = null; }
  const loop = async () => {
    if (psStopped) return;
    let nextSec = IDLE_RECHECK_SEC;
    try {
      const settings = await getAllSettings();
      const cfg = resolveConfig(settings);
      if (cfg) { await runPrinterSuppliesOnce(); nextSec = cfg.intervalSec; }
    } catch (e) {
      console.error('Printer supplies schedule error', e);
    }
    if (!psStopped) psTimer = setTimeout(loop, nextSec * 1000);
  };
  loop().catch((e) => console.error('Printer supplies schedule error', e));
  console.log('Printer supplies collector scheduled (DB-driven enable/interval)');
}
