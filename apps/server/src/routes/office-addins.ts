import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { getAllSettings } from '../services/settings.js';
import {
  getOfficeAddinStatus, isOfficeAddinScanRunning, runOfficeAddinScanOnce,
} from '../services/office-addins-collector.js';

// Zakázané doplňky Office na klientech. Detailní výpis pro drill-down + souhrn pro
// dlaždici na homepage. Souhrn počítá jen z PC, kde sken opravdu proběhl (status='ok'):
// PC bez přihlášeného uživatele nebo s chybou skenu NENÍ "čisté", jen neznámé — stejná
// tri-state logika jako computers.reachable.

interface AddinRow {
  id: number;
  computer_id: number;
  computer_name: string;
  user_account: string | null;
  user_sid: string;
  office_app: string;
  office_version: string;
  addin_path: string | null;
  addin_name: string | null;
  is_nav: boolean;
  item_kind: 'addin' | 'document' | null;
  detected_at: Date;
  scanned_at: Date | null;
}

export async function registerOfficeAddinsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/office-addins', async () => {
    const s = await getAllSettings();
    const enabled = ['1', 'true', 'yes', 'on'].includes((s['officeaddins.enabled'] ?? '').toLowerCase());
    const pool = await getPool();

    // Dashboard se ptá každých 30 s, takže při vypnuté funkci nemá smysl mlít JOIN a
    // agregaci nad prázdnými tabulkami. Nestačí ale odříznout to podle 'enabled':
    // POST /office-addins/scan jde spustit ručně i při vypnutém plánovači (přesně tak se
    // funkce ověřuje po nasazení) a jeho výsledky by pak nebylo přes co vidět. Rozhoduje
    // tedy existence dat, ne přepínač — jeden triviální dotaz místo dvou větších.
    if (!enabled) {
      const any = (await pool.request().query<{ n: number }>('SELECT TOP 1 1 AS n FROM office_addin_scans')).recordset[0];
      if (!any) {
        return { enabled: false, items: [], summary: { scannedPcs: 0, pcsWithIssues: 0, navPcs: 0, errorPcs: 0, noUserPcs: 0 } };
      }
    }

    // Vrací se doplňky i dokumenty (item_kind je odliší), ale doplňky první — dokument
    // v seznamu je jen historie jednoho pádu Office, ne tiše rozbitá aplikace.
    const items = (await pool.request().query<AddinRow>(`
      SELECT a.id, a.computer_id, a.computer_name, a.user_account, a.user_sid,
             a.office_app, a.office_version, a.addin_path, a.addin_name, a.is_nav,
             a.item_kind, a.detected_at, s.scanned_at
      FROM office_disabled_addins a
      LEFT JOIN office_addin_scans s ON s.computer_id = a.computer_id
      ORDER BY CASE WHEN a.item_kind = 'addin' THEN 0 ELSE 1 END, a.is_nav DESC, a.computer_name, a.office_app
    `)).recordset;

    const sum = (await pool.request().query<{
      scannedPcs: number; pcsWithIssues: number; navPcs: number; errorPcs: number; noUserPcs: number;
    }>(`
      SELECT
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS scannedPcs,
        SUM(CASE WHEN status = 'ok' AND disabled_count > 0 THEN 1 ELSE 0 END) AS pcsWithIssues,
        SUM(CASE WHEN status = 'ok' AND nav_disabled = 1 THEN 1 ELSE 0 END) AS navPcs,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorPcs,
        SUM(CASE WHEN status = 'no_users' THEN 1 ELSE 0 END) AS noUserPcs
      FROM office_addin_scans
    `)).recordset[0] ?? { scannedPcs: 0, pcsWithIssues: 0, navPcs: 0, errorPcs: 0, noUserPcs: 0 };

    return {
      enabled,
      items,
      summary: {
        scannedPcs: sum.scannedPcs ?? 0,
        pcsWithIssues: sum.pcsWithIssues ?? 0,
        navPcs: sum.navPcs ?? 0,
        errorPcs: sum.errorPcs ?? 0,
        noUserPcs: sum.noUserPcs ?? 0,
      },
    };
  });

  app.get('/office-addins/status', async () => {
    const s = await getAllSettings();
    const st = getOfficeAddinStatus();
    const iv = Number(s['officeaddins.interval_sec']);
    return {
      enabled: ['1', 'true', 'yes', 'on'].includes((s['officeaddins.enabled'] ?? '').toLowerCase()),
      intervalSec: Number.isFinite(iv) && iv >= 300 ? iv : 21600,
      ...st,
    };
  });

  // Ruční sken — route nikdy nečeká na dokončení (sweep přes všechna PC trvá minuty),
  // stav se pollem tahá z /office-addins/status. Stejný vzor jako link-speed batch.
  app.post('/office-addins/scan', async (_req, reply) => {
    if (isOfficeAddinScanRunning()) {
      reply.code(409);
      return { error: 'already_running' };
    }
    void runOfficeAddinScanOnce().catch((e) => app.log.error({ err: e }, 'Office add-in scan failed'));
    return { started: true };
  });
}
