import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { getAllSettings } from '../services/settings.js';
import { getWanSnapshot, getWanNextRun } from '../services/wan-monitor.js';
import { getSvcMatrix, getSvcNextRun } from '../services/service-port-matrix.js';
import { runServiceDiscovery } from '../services/service-discovery.js';
import { runLinkSpeedTest, runLinkSpeedBatch, getLinkSpeedStatus, parseTargets } from '../services/link-speed.js';

// One communication channel's health (API pulls, FTP downloads, SQL, e-mail …).
interface CommChannel {
  key: string;
  enabled: boolean;
  ok: boolean;
  detail: string;
  lastOk: string | null;
  lastError: string | null;
  ts: string | null;
}
interface CommsResult {
  overall: 'ok' | 'degraded' | 'down';
  okCount: number;
  total: number;
  channels: CommChannel[];
  checkedAt: string;
}

const boolOn = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());

export async function registerSystemRoutes(app: FastifyInstance) {
  // Aggregate "is all communication working" view for the dashboard: SQL, the
  // MikroTik REST API, FTP downloads (per-site freshness), the EventLog collector
  // (DCOM to client PCs), e-mail (SMTP/M365) and UniFi. Each channel is derived
  // from data that already exists — activity_log (latest entry + last non-error),
  // site_data_status (FTP freshness) and a live SELECT 1. Read-only. A channel is
  // "ok" unless its LAST attempt failed (level='error'); FTP also fails on stale.
  app.get('/system/comms', async (): Promise<CommsResult> => {
    const settings = await getAllSettings();
    const channels: CommChannel[] = [];

    // 1) SQL database — live probe.
    let dbOk = false;
    let dbErr: string | null = null;
    const t0 = Date.now();
    try {
      const pool = await getPool();
      const r = await pool.request().query<{ v: number }>('SELECT 1 AS v');
      dbOk = r.recordset[0]?.v === 1;
    } catch (e) {
      dbErr = String(e).split('\n')[0]!.slice(0, 200);
    }
    channels.push({
      key: 'database', enabled: true, ok: dbOk,
      detail: dbOk ? `odezva ${Date.now() - t0} ms` : 'nedostupná',
      lastOk: null, lastError: dbErr, ts: null,
    });
    // Without the DB we can't read the rest — report it as down and stop.
    if (!dbOk) {
      return { overall: 'down', okCount: 0, total: channels.length, channels, checkedAt: new Date().toISOString() };
    }
    const pool = await getPool();

    // Latest activity_log row + last NON-error timestamp per source, with age.
    const act = (await pool.request().query<{
      source: string; ts: Date; level: string; message: string; last_ok: Date | null; mins_since: number | null;
    }>(`
      WITH ranked AS (
        SELECT source, ts, level, message,
               ROW_NUMBER() OVER (PARTITION BY source ORDER BY ts DESC, id DESC) AS rn
        FROM activity_log WHERE source IN ('mikrotik','unifi','collector','alerts')
      ), lastok AS (
        SELECT source, MAX(ts) AS last_ok FROM activity_log
        WHERE source IN ('mikrotik','unifi','collector','alerts') AND level <> 'error'
        GROUP BY source
      )
      SELECT k.source, k.ts, k.level, k.message, o.last_ok,
             DATEDIFF(MINUTE, k.ts, SYSUTCDATETIME()) AS mins_since
      FROM ranked k LEFT JOIN lastok o ON o.source = k.source WHERE k.rn = 1;
    `)).recordset;
    const bySource = new Map(act.map((r) => [r.source, r]));
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    const ago = (m: number | null | undefined) =>
      m == null ? '' : m < 1 ? 'právě teď' : m < 60 ? `před ${m} min` : m < 1440 ? `před ${Math.round(m / 60)} h` : `před ${Math.round(m / 1440)} d`;

    // A channel whose health comes from the activity_log of one source.
    const actChannel = (key: string, source: string, enabled: boolean): CommChannel => {
      if (!enabled) return { key, enabled: false, ok: true, detail: 'vypnuto', lastOk: null, lastError: null, ts: null };
      const r = bySource.get(source);
      if (!r) return { key, enabled: true, ok: true, detail: 'zatím bez aktivity', lastOk: null, lastError: null, ts: null };
      const ok = r.level !== 'error';
      return {
        key, enabled: true, ok,
        detail: ok ? `poslední ${ago(r.mins_since)}` : `chyba ${ago(r.mins_since)}: ${r.message}`.slice(0, 160),
        lastOk: iso(r.last_ok),
        lastError: ok ? null : r.message.slice(0, 200),
        ts: iso(r.ts),
      };
    };

    // 2) MikroTik REST API.
    const mtRouters = (settings['mikrotik.routers'] ?? '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    channels.push(actChannel('mikrotik_rest', 'mikrotik', boolOn(settings['mikrotik.enabled']) && mtRouters.length > 0));

    // 3) FTP downloads — per-site file freshness (the strongest signal).
    const ftpEnabled = (settings['mikrotik.ftp_enabled'] ?? '1') === '1';
    const ftpSites = new Set((settings['mikrotik.ftp_sites'] ?? '').split(/[,;\r\n]+/).map((s) => s.split('=')[0]!.trim().toLowerCase()).filter(Boolean));
    const threshold = Number(settings['alerts.freshness.threshold_minutes'] ?? 45) || 45;
    if (ftpEnabled && ftpSites.size > 0) {
      const st = (await pool.request().query<{ site: string; last_error: string | null; file_changed_at: Date | null; mins_since_change: number | null }>(`
        SELECT site, last_error, file_changed_at,
               DATEDIFF(MINUTE, file_changed_at, SYSUTCDATETIME()) AS mins_since_change
        FROM site_data_status`)).recordset.filter((s) => ftpSites.has(s.site.toLowerCase()));
      const seen = new Set(st.map((s) => s.site.toLowerCase()));
      const missing = [...ftpSites].filter((s) => !seen.has(s));
      const stale = st.filter((s) => !!s.last_error || s.file_changed_at == null || (s.mins_since_change != null && s.mins_since_change > threshold));
      const errored = st.find((s) => !!s.last_error);
      const total = ftpSites.size;
      const bad = stale.length + missing.length;
      const ok = bad === 0;
      const firstErr = errored?.last_error
        ?? (missing[0] ? `${missing[0]}: zatím nestaženo` : null)
        ?? (stale[0] ? `${stale[0].site}: data nestárnou (${ago(stale[0].mins_since_change)})` : null);
      channels.push({
        key: 'ftp', enabled: true, ok,
        detail: ok ? `${total}/${total} lokalit aktuální` : `${total - bad}/${total} aktuální · ${bad} problém`,
        lastOk: null, lastError: ok ? null : firstErr, ts: null,
      });
    } else {
      channels.push({ key: 'ftp', enabled: false, ok: true, detail: 'vypnuto', lastOk: null, lastError: null, ts: null });
    }

    // 4) EventLog collector (DCOM → client PCs). Per-PC failures (offline) are
    // normal and log as 'warn', so they don't flip the channel; only a hard
    // 'error' does. Detail shows the last run's success ratio.
    const lastRun = (await pool.request().query<{ pcs_total: number; pcs_succeeded: number; pcs_failed: number; finished_at: Date | null }>(`
      SELECT TOP 1 pcs_total, pcs_succeeded, pcs_failed, finished_at FROM collector_runs ORDER BY id DESC`)).recordset[0];
    {
      const r = bySource.get('collector');
      const ok = !r || r.level !== 'error';
      const detail = !lastRun ? 'zatím neproběhl'
        : lastRun.finished_at == null ? 'běží…'
          : `posl. běh ${lastRun.pcs_succeeded}/${lastRun.pcs_total} OK${lastRun.pcs_failed ? `, ${lastRun.pcs_failed} fail` : ''}${r ? ` · ${ago(r.mins_since)}` : ''}`;
      channels.push({ key: 'collector', enabled: true, ok, detail, lastOk: iso(r?.last_ok), lastError: ok ? null : (r?.message.slice(0, 200) ?? null), ts: iso(r?.ts) });
    }

    // 5) E-mail (SMTP/M365) — alert sends log under 'alerts' (sent=warn, fail=error).
    channels.push(actChannel('email', 'alerts', !!(settings['alerts.smtp_host'] ?? '').trim()));

    // 6) UniFi controller.
    channels.push(actChannel('unifi', 'unifi', boolOn(settings['unifi.enabled'])));

    const considered = channels.filter((c) => c.enabled);
    const okCount = considered.filter((c) => c.ok).length;
    return {
      overall: okCount === considered.length ? 'ok' : 'degraded',
      okCount, total: considered.length, channels,
      checkedAt: new Date().toISOString(),
    };
  });

  // Live WAN-link health to each branch + the internet (current snapshot only).
  app.get('/system/wan', async () => {
    const s = await getAllSettings();
    const enabled = boolOn(s['wan.enabled'] ?? '1');
    const iv = Number(s['wan.interval_sec']);
    const snap = getWanSnapshot();
    return {
      enabled,
      intervalSec: Number.isFinite(iv) && iv >= 30 ? iv : 60,
      latencyWarnMs: Number(s['wan.latency_warn_ms']) || 80,
      lossWarnPct: Number(s['wan.loss_warn_pct']) || 5,
      nextRunAt: enabled ? (getWanNextRun()?.toISOString() ?? null) : null,
      branches: snap?.branches ?? [],
      internet: snap?.internet ?? null,
      speedtestEnabled: boolOn(s['wan.speedtest_enabled']),
      speed: snap?.speed ?? null,
      checkedAt: snap?.checkedAt ?? null,
    };
  });

  // Per-branch service-port consistency matrix (printers/phones/… ports reachable
  // the same way on every site). Curated ports only. Read-only.
  app.get('/system/service-ports', async () => {
    const s = await getAllSettings();
    const enabled = boolOn(s['svcports.enabled'] ?? '1');
    const iv = Number(s['svcports.interval_sec']);
    const m = getSvcMatrix();
    return {
      enabled,
      intervalSec: Number.isFinite(iv) && iv >= 120 ? iv : 900,
      nextRunAt: enabled ? (getSvcNextRun()?.toISOString() ?? null) : null,
      sites: m?.sites ?? [],
      checks: m?.checks ?? [],
      cells: m?.cells ?? {},
      checkedAt: m?.checkedAt ?? null,
    };
  });

  // One-off service discovery: scan a broad TCP port set on a sample of devices per
  // category to learn the real port profile. User-triggered (deliberate probe sweep).
  // `full` = the whole 1–65535 range (slow); otherwise well-known + common highs.
  app.post<{ Body: { full?: boolean } }>('/system/service-discovery', async (req, reply) => {
    const r = await runServiceDiscovery(!!req.body?.full);
    if (r === null) { reply.code(409); return { error: 'discovery_already_running' }; }
    return r;
  });

  // Real link-speed test to one live PC: write an N-MB file to its C$ over SMB and
  // read it back, computing up/down Mb/s from the wall time. Deliberate transfer of
  // real data over the branch link — invoked on demand. VERIFY-CORE prototype.
  app.post<{ Body: { pc?: string; sizeMB?: number } }>('/system/linkspeed/test', async (req, reply) => {
    const pc = (req.body?.pc ?? '').trim();
    if (!pc) { reply.code(400); return { error: 'pc required' }; }
    const s = await getAllSettings();
    const sizeMB = Math.max(1, Math.min(1024, Number(req.body?.sizeMB) || Number(s['linkspeed.size_mb']) || 100));
    return runLinkSpeedTest(pc, sizeMB);
  });

  // Batch link-speed test (the "Měření linky" page) — targets = IP list / range
  // "10.8.2.*" / "10.8.2.180-182" / "all" (active PCs). Runs in the background;
  // poll /system/linkspeed/status. Each target is SMB-prechecked, so dead IPs are
  // skipped fast.
  app.post<{ Body: { targets?: string; sizeMB?: number } }>('/system/linkspeed/run', async (req, reply) => {
    if (getLinkSpeedStatus().running) { reply.code(409); return { error: 'already_running' }; }
    const s = await getAllSettings();
    const sizeMB = Math.max(1, Math.min(1024, Number(req.body?.sizeMB) || Number(s['linkspeed.size_mb']) || 100));
    const raw = String(req.body?.targets ?? '');
    let allNames: string[] = [];
    if (/\ball\b/i.test(raw)) {
      const pool = await getPool();
      allNames = (await pool.request().query<{ name: string }>(
        `SELECT name FROM computers WHERE enabled=1 AND excluded=0 AND (reachable=1 OR reachable IS NULL)`)).recordset.map((r) => r.name);
    }
    const targets = parseTargets(raw, allNames);
    if (targets.length === 0) { reply.code(400); return { error: 'no targets' }; }
    void runLinkSpeedBatch(targets, sizeMB);
    return { started: true, count: targets.length };
  });

  app.get('/system/linkspeed/status', async () => {
    const s = await getAllSettings();
    return { okMbps: Number(s['linkspeed.ok_mbps']) || 200, defaultSizeMB: Number(s['linkspeed.size_mb']) || 100, ...getLinkSpeedStatus() };
  });

  app.get<{ Querystring: { limit?: string } }>('/system/linkspeed/history', async (req) => {
    const limit = Math.max(1, Math.min(2000, Number(req.query?.limit) || 300));
    const pool = await getPool();
    const rows = (await pool.request().input('lim', limit).query(`
      SELECT TOP (@lim) id, target, up_mbps, down_mbps, up_ms, down_ms, size_mb, error, measured_at
      FROM link_speed_results ORDER BY id DESC`)).recordset;
    const s = await getAllSettings();
    return { okMbps: Number(s['linkspeed.ok_mbps']) || 200, items: rows };
  });
}
