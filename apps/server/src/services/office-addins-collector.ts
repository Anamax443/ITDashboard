import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import sql from 'mssql/msnodesqlv8.js';
import { getPool } from '../db/pool.js';
import { getAllSettings } from './settings.js';
import { logActivity } from './activity-log.js';
import { tryWithHostLock, keyForComputerId } from './host-lock.js';

// Zjišťuje, které doplňky Office si klientská aplikace sama zakázala.
//
// Office po pádu doplňku (nebo po násilném ukončení aplikace) doplněk deaktivuje a
// zapíše ho do Resiliency\DisabledItems. Navenek je aplikace zdravá — jen tiše nedělá,
// co má, a v Event Logu o tom není nic. Původní případ: zakázaný NAV Excel Add-in =>
// export z NAVu do Excelu se otevře prázdný (NAV posílá jen .xltx s připojením, data
// dotahuje doplněk přes OData).
//
// Transport: DisabledItems je v HKEY_CURRENT_USER, takže se čte přes HKEY_USERS
// (hDefKey 2147483651) vzdáleným registrem přes WMI StdRegProv v DCOM CIM session —
// stejně jako services-collector. Obyčejný Get-CimInstance jede přes WinRM, které na
// doménových PC není nakonfigurované.
//
// Omezení, které je součástí návrhu: HKU obsahuje jen hive PŘIHLÁŠENÝCH uživatelů.
// NTUSER.DAT je za běhu exkluzivně zamčený, takže offline cesta přes C$ (jako u crash
// dumpů) nefunguje. U PC, kde nikdo nesedí, skončí sken se status='no_users' a poslední
// známý stav v DB zůstane — UI to musí odlišit, ne tvářit se, že je čisto.

const HKU = 2147483651;                       // HKEY_USERS
const OFFICE_APPS = ['Excel', 'Word', 'Outlook', 'PowerPoint'] as const;
const PS_TIMEOUT_MS = 45_000;

let running = false;
let timer: NodeJS.Timeout | null = null;
let stopped = false;
const IDLE_RECHECK_SEC = 120;

let lastRunAt: Date | null = null;
let nextRunAt: Date | null = null;
let lastResult: { pcs: number; scanned: number; withIssues: number; navDisabled: number } | null = null;

export function getOfficeAddinStatus(): {
  running: boolean; lastRunAt: Date | null; nextRunAt: Date | null;
  lastResult: { pcs: number; scanned: number; withIssues: number; navDisabled: number } | null;
} {
  return { running, lastRunAt, nextRunAt, lastResult };
}

export function isOfficeAddinScanRunning(): boolean { return running; }

interface Target { id: number; name: string }

export interface DisabledAddin {
  sid: string;
  account: string | null;
  app: string;
  version: string;
  valueName: string;
  path: string | null;
  name: string | null;
  /**
   * DisabledItems drží i dokumenty, na kterých Office spadl (reálně nalezeno .pdf/.doc),
   * ne jen doplňky. Do provozních počtů patří jen 'addin' — zakázaný dokument je jen
   * historie jednoho pádu, ne tiše rozbitá aplikace.
   */
  kind: 'addin' | 'document';
  rawType: number;
  isNav: boolean;
}

export const isAddin = (i: DisabledAddin): boolean => i.kind === 'addin';

interface ScanOutput { users: number; items: DisabledAddin[] }

function boolSetting(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v ?? '').toLowerCase());
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    let done = false;
    const fin = (ok: boolean) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    const t = setTimeout(() => fin(false), timeoutMs);
    s.once('connect', () => { clearTimeout(t); fin(true); });
    s.once('error', () => { clearTimeout(t); fin(false); });
    s.connect(port, host);
  });
}

// Sestaví PS skript pro jedno PC. Vytažené zvlášť, aby šlo v testu ověřit escapování:
// tohle je TS template literal -> každé '\\' zde je JEDNO '\' v PS zdroji, takže regexy,
// které potřebují literál backslash, mají '\\\\'. Splést se tu je tiché a snadné —
// PowerShell backslash needchytá jako escape, takže špatná cesta nespadne, jen nic nenajde.
export function buildScanScript(name: string): string {
  return `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$HKU = [uint32]${HKU}
$opt = New-CimSessionOption -Protocol Dcom
$session = New-CimSession -ComputerName '${name}' -SessionOption $opt -ErrorAction Stop
try {
  function EnumKeys($path) {
    $r = Invoke-CimMethod -CimSession $session -Namespace root\\default -ClassName StdRegProv -MethodName EnumKey \`
         -Arguments @{ hDefKey = $HKU; sSubKeyName = $path } -ErrorAction SilentlyContinue
    if ($r -and $r.ReturnValue -eq 0 -and $r.sNames) { return @($r.sNames) }
    return @()
  }
  function EnumVals($path) {
    $r = Invoke-CimMethod -CimSession $session -Namespace root\\default -ClassName StdRegProv -MethodName EnumValues \`
         -Arguments @{ hDefKey = $HKU; sSubKeyName = $path } -ErrorAction SilentlyContinue
    if ($r -and $r.ReturnValue -eq 0 -and $r.sNames) { return @($r.sNames) }
    return @()
  }
  function GetBin($path, $vn) {
    $r = Invoke-CimMethod -CimSession $session -Namespace root\\default -ClassName StdRegProv -MethodName GetBinaryValue \`
         -Arguments @{ hDefKey = $HKU; sSubKeyName = $path; sValueName = $vn } -ErrorAction SilentlyContinue
    if ($r -and $r.ReturnValue -eq 0 -and $r.uValue) { return $r.uValue }
    return $null
  }

  $apps = @('${OFFICE_APPS.join("','")}')
  $items = @()
  $userCount = 0

  foreach ($sid in (EnumKeys '')) {
    if ($sid -notlike 'S-1-5-21-*') { continue }      # jen reální uživatelé, ne SYSTEM/SERVICE
    if ($sid -like '*_Classes') { continue }          # doprovodný hive, ne samostatný uživatel
    $userCount++
    $account = $null
    try {
      $account = (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate([System.Security.Principal.NTAccount]).Value
    } catch { }

    foreach ($ver in (EnumKeys "$sid\\SOFTWARE\\Microsoft\\Office")) {
      if ($ver -notmatch '^\\d+\\.\\d+$') { continue }  # jen verze (16.0), ne Common/Excel/...
      foreach ($app in $apps) {
        $key = "$sid\\SOFTWARE\\Microsoft\\Office\\$ver\\$app\\Resiliency\\DisabledItems"
        foreach ($vn in (EnumVals $key)) {
          $bytes = [byte[]](GetBin $key $vn)
          if (-not $bytes -or $bytes.Count -lt 12) { continue }

          # REG_BINARY má pevnou strukturu (ověřeno na reálné hodnotě, sedí na byte):
          #   0x00 DWORD typ, 0x04 DWORD cbPath, 0x08 DWORD cbName,
          #   0x0C UTF-16LE cesta (cbPath B vč. NUL), pak UTF-16LE jméno (cbName B vč. NUL).
          #   12 + cbPath + cbName == celková délka hodnoty.
          # Dřív se z toho tahaly "čitelné běhy znaků" regexem, což na jména lepilo smetí
          # z hlavičky (dekódovalo se jako CJK) — délkové prefixy to řeší přesně.
          $type   = [System.BitConverter]::ToUInt32($bytes, 0)
          $cbPath = [System.BitConverter]::ToUInt32($bytes, 4)
          $cbName = [System.BitConverter]::ToUInt32($bytes, 8)
          if ((12 + $cbPath + $cbName) -gt $bytes.Count) { continue }   # neznámá varianta → radši nic než smetí

          $path = ''
          if ($cbPath -gt 0) { $path = [System.Text.Encoding]::Unicode.GetString($bytes, 12, $cbPath).Trim([char]0) }
          $nm = ''
          if ($cbName -gt 0) { $nm = [System.Text.Encoding]::Unicode.GetString($bytes, 12 + $cbPath, $cbName).Trim([char]0) }

          # DisabledItems nedrží jen doplňky — Office sem zapisuje i DOKUMENTY, na kterých
          # spadl (typicky .pdf/.doc, co rozhodil Word). Pro tuhle agendu je to šum, ale
          # mazat ho zahodí informaci, tak se jen odliší. Rozhoduje přípona cesty, ne
          # hlavičkový typ — přípona je ověřitelná, význam typu ne.
          $kind = 'document'
          if ($path -match '\\.(dll|xll|xlam|xla|xll|ocx|vsto|wll|exe|olb|tlb)$') { $kind = 'addin' }

          $isNav = (($path + ' ' + $nm) -match 'dynamics\\.nav') -or (($path + ' ' + $nm) -match 'exceladdin')
          $items += [pscustomobject]@{
            sid = $sid; account = $account; app = $app; version = $ver
            valueName = $vn; path = $path; name = $nm; kind = $kind
            rawType = [int]$type; isNav = [bool]$isNav
          }
        }
      }
    }
  }

  [pscustomobject]@{ users = $userCount; items = @($items) } | ConvertTo-Json -Compress -Depth 5
} finally {
  Remove-CimSession $session -ErrorAction SilentlyContinue
}
`;
}

// Pozn.: pre-flight probe si dělá volající PŘED převzetím host-locku (viz sweep) — tady
// by byl druhý zbytečný round-trip navíc, a to už uvnitř zámku, takže by o svoji dobu
// blokoval ostatní práci na tomtéž stroji.
export async function fetchDisabledAddins(name: string): Promise<ScanOutput> {
  const ps = buildScanScript(name);

  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, timeout: PS_TIMEOUT_MS,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim().split('\n')[0] || `exit ${code}`));
      try {
        const t = stdout.trim();
        if (!t) return resolve({ users: 0, items: [] });
        const parsed = JSON.parse(t) as { users: number; items: DisabledAddin | DisabledAddin[] | null };
        // PS vrací jeden objekt místo pole, když je prvek jediný.
        const items = parsed.items == null ? [] : Array.isArray(parsed.items) ? parsed.items : [parsed.items];
        resolve({ users: Number(parsed.users) || 0, items });
      } catch (e) { reject(e); }
    });
  });
}

// Vrátí, jestli PC už při minulém skenu mělo zakázaný NAV doplněk. Slouží k tomu, aby se
// do activity logu psal jen PŘECHOD (nový výskyt), ne existence — tohle je stav, ne
// událost, a bez toho by se stejné varování opakovalo každých 6 h donekonečna.
async function previouslyNavDisabled(computerId: number): Promise<boolean> {
  const pool = await getPool();
  const r = (await pool.request().input('cid', computerId)
    .query<{ nav_disabled: boolean }>('SELECT nav_disabled FROM office_addin_scans WHERE computer_id=@cid')).recordset[0];
  return r?.nav_disabled === true;
}

// Zapíše výsledek skenu jednoho PC. Detailní řádky se přepisují (současný stav, ne
// historie) — doplněk se dá povolit zpátky a pak musí z výpisu zmizet.
//
// Celé v jedné transakci: mezi DELETE a posledním INSERT by souběžné GET /office-addins
// (dashboard se ptá po 30 s) vidělo PC jako čisté, i když čisté není. A kdyby proces
// spadl uprostřed, zůstaly by smazané detaily proti řádku skenu, který pořád tvrdí
// disabled_count>0 — sloupec by hlásil "⚠ 2" a drill-down by byl prázdný.
async function persist(c: Target, out: ScanOutput, status: string, error: string | null): Promise<void> {
  const pool = await getPool();
  // Do počtů jdou JEN doplňky. Zakázaný dokument se uloží (je to informace), ale nesmí
  // nafouknout číslo, podle kterého se někdo rozhoduje — první živý sken ukázal, že jinak
  // se mezi "tiše rozbité Office" započítá i PDF, co kdysi rozhodilo Word.
  const addinCount = out.items.filter(isAddin).length;
  const navCount = out.items.filter((i) => isAddin(i) && i.isNav).length;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    if (status === 'ok') {
      await new sql.Request(tx).input('cid', c.id).query('DELETE FROM office_disabled_addins WHERE computer_id=@cid');
      for (const i of out.items) {
        await new sql.Request(tx)
          .input('cid', c.id).input('cn', c.name)
          .input('sid', i.sid).input('acct', i.account ?? null)
          .input('app', i.app).input('ver', i.version).input('vn', i.valueName)
          .input('path', i.path ?? null).input('nm', i.name ?? null)
          .input('nav', i.isNav ? 1 : 0)
          .input('kind', i.kind).input('rt', i.rawType)
          .query(`INSERT INTO office_disabled_addins
                    (computer_id, computer_name, user_sid, user_account, office_app, office_version, value_name, addin_path, addin_name, is_nav, item_kind, raw_type)
                  VALUES (@cid, @cn, @sid, @acct, @app, @ver, @vn, @path, @nm, @nav, @kind, @rt)`);
      }
    }

    // Počty se přepisují JEN při úspěšném skenu. U 'no_users'/'error' se detailní řádky
    // nemažou (je to poslední známý stav), takže vynulovat počty by je rozešlo s detailem.
    // Výsledné pravidlo řádku: status + scanned_at = poslední POKUS, počty = poslední
    // ÚSPĚŠNÝ sken. Proto users_seen dostává stejný CASE jako zbytek — jinak by v jednom
    // řádku byly promíchané dvě různé časové roviny.
    await new sql.Request(tx)
      .input('cid', c.id).input('cn', c.name).input('st', status).input('err', error)
      .input('us', out.users).input('dc', addinCount).input('nav', navCount > 0 ? 1 : 0)
      .query(`
        MERGE office_addin_scans AS t
        USING (SELECT @cid AS computer_id) AS s ON t.computer_id = s.computer_id
        WHEN MATCHED THEN UPDATE SET
          computer_name=@cn, scanned_at=SYSUTCDATETIME(), status=@st, error=@err,
          users_seen     = CASE WHEN @st = 'ok' THEN @us  ELSE t.users_seen END,
          disabled_count = CASE WHEN @st = 'ok' THEN @dc  ELSE t.disabled_count END,
          nav_disabled   = CASE WHEN @st = 'ok' THEN @nav ELSE t.nav_disabled END
        WHEN NOT MATCHED THEN INSERT (computer_id, computer_name, status, error, users_seen, disabled_count, nav_disabled)
          VALUES (@cid, @cn, @st, @err, @us, @dc, @nav);
      `);
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

export async function runOfficeAddinScanOnce(): Promise<{ pcs: number; scanned: number; withIssues: number; navDisabled: number } | null> {
  if (running) return null;
  running = true;
  try {
    const pool = await getPool();
    const targets = (await pool.request().query<Target>(`
      SELECT id, name FROM computers
      WHERE enabled = 1 AND monitor_enabled = 1 AND excluded = 0
        AND (reachable = 1 OR (reachable IS NULL AND consecutive_failures < 10))
    `)).recordset;

    let scanned = 0, withIssues = 0, navDisabled = 0, busy = 0;
    for (const c of targets) {
      if (!(await tcpProbe(c.name, 135, 2000))) continue;         // DCOM nedostupné → levný skip bez zámku

      // Selhání JEDNOHO PC (nedostupné DCOM, chyba zápisu) nesmí shodit celý sweep —
      // proto se chyba skenu a chyba zápisu ošetřují zvlášť a ani jedna neopustí callback.
      // (Kdyby persist v catch větvi hodil znovu — typicky když je SQL dole a padá kvůli
      // tomu úplně všechno — vyletěla by výjimka až ze smyčky a zbytek PC by se přeskočil
      // až do dalšího cyklu, tedy o 6 h později.)
      const outcome = await tryWithHostLock(keyForComputerId(c.id), async () => {
        let out: ScanOutput;
        try {
          out = await fetchDisabledAddins(c.name);
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
          await persist(c, { users: 0, items: [] }, 'error', msg)
            .catch((err) => console.error(`Office add-in scan: zápis chyby pro ${c.name} selhal`, err));
          return;
        }

        // Nikdo přihlášen => HKU nemá co nabídnout. Není to chyba ani zdravý stav —
        // poslední známý detail v DB necháváme být a jen posuneme stav skenu.
        const status = out.users === 0 ? 'no_users' : 'ok';
        const wasNav = await previouslyNavDisabled(c.id).catch(() => false);   // číst PŘED přepsáním
        try {
          await persist(c, out, status, null);
        } catch (e) {
          console.error(`Office add-in scan: zápis výsledku pro ${c.name} selhal`, e);
          return;
        }

        if (status === 'ok') {
          scanned++;
          if (out.items.some(isAddin)) withIssues++;          // dokumenty se nepočítají
          const navs = out.items.filter((i) => isAddin(i) && i.isNav);
          if (navs.length > 0) {
            navDisabled++;
            // Jen nový výskyt. Bez téhle podmínky by se u neopraveného PC psalo totéž
            // varování každý cyklus (4× denně) donekonečna a activity log by zaplavilo.
            if (!wasNav) {
              logActivity('warn', 'office',
                `${c.name}: zakázaný NAV doplněk Excelu (${navs[0]!.account ?? navs[0]!.sid}) — export z NAVu vrátí prázdný sešit`);
            }
          }
        }
      });
      if (!outcome.ran) busy++;
    }

    if (busy > 0) logActivity('info', 'office', `Sken doplňků Office: ${busy} PC přeskočeno (zaneprázdněno), zkusí se příště`);
    if (withIssues > 0) logActivity('info', 'office', `Sken doplňků Office: ${withIssues} PC se zakázaným doplňkem · ${scanned} oskenováno · ${targets.length} PC celkem`);
    lastResult = { pcs: targets.length, scanned, withIssues, navDisabled };
    return lastResult;
  } finally {
    running = false;
    lastRunAt = new Date();
  }
}

export async function startOfficeAddinSchedule(): Promise<void> {
  stopped = false;
  if (timer) { clearTimeout(timer); timer = null; }
  const loop = async () => {
    if (stopped) return;
    let nextSec = IDLE_RECHECK_SEC;
    try {
      const s = await getAllSettings();
      if (boolSetting(s['officeaddins.enabled'])) {
        await runOfficeAddinScanOnce();
        const iv = Number(s['officeaddins.interval_sec']);
        nextSec = Number.isFinite(iv) && iv >= 300 ? iv : 21600;
      }
    } catch (e) {
      console.error('Office add-in scan error', e);
    }
    if (!stopped) {
      timer = setTimeout(loop, nextSec * 1000);
      nextRunAt = new Date(Date.now() + nextSec * 1000);
    }
  };
  loop().catch((e) => console.error('Office add-in scan error', e));
  console.log('Office add-in collector scheduled (DB-driven enable/interval)');
}
