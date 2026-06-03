# Oponentura ITDashboard – detailní recenze

> Archivováno: 2026-06-03
> Zdroj: paste-nuto do session, neuvedený autor (interní AI/lidský reviewer)
> Reakce: [2026-06-03-reakce-1.md](2026-06-03-reakce-1.md)
> Komentovaná verze podkladu: [itdashboard-podklad-2026-06-03.md](../../C:/Users/trnkam/Downloads/itdashboard-podklad-2026-06-03.md)

---

## 0. Executive Summary (pro ředitele / architekta)

ITDashboard je **funkční, pragmatický nástroj**, který řeší reálný problém – fleet observability bez agentů. Projekt je v **produkci** (live od 2026-06-01) a pokrývá 225 strojů. To je chvályhodné.

**Zásadní problémy, které vyžadují okamžitou pozornost:**

1. **Deployment pipeline lže o stavu** – topbar SHA není svázán s běžícím procesem, migrace selže a restart neproběhne → diagnostické peklo.
2. **Žádná autentizace API** – doména jako trust boundary v roce 2026 nestačí (BYOD, VPN dodavatelů).
3. **Retention scheduler neexistuje** – data rostou neomezeně, žádná automatická očista.
4. **Windows Firewall Domain profile vypnut** – OS-level gate je inertní, spoléháme jen na frontend UX gate (triviální bypass).
5. **Žádný end-to-end test** – regex chyby (`\d` vs `\\d`) a reserved words (`current_user`) prošly do produkce.

**Silné stránky:** observer-only princip, reachability klasifikace, TCP probe fail-fast, services drift detection, activity log s live/history mode, AD sync idempotence.

**Celkové hodnocení:** Projekt splňuje svůj účel pro solo operátora, ale **není připraven na týmovou správu, růst nebo bezpečnostní audit**. Následující body jsou řazeny od kritických po kosmetické.

---

## 1. Architektura a principy

### 1.1 Observer-not-executor – správné, ale s varováním

**Souhlas.** Oddělení pozorování od akce je zdravý princip pro nástroj tohoto typu. Nicméně:

- **Riziko:** Tlak na "stiskni a oprav" bude narůstat. Už nyní existuje export GPO skriptu – ten je hraničně akční (jen export, ne spuštění). Doporučuji definovat explicitní policy: *žádné tlačítko, které mění stav vzdáleného PC, pokud není chráněno dvěma kliknutími a auditem*.
- **Otázka:** Když bude operátor chtít hromadně restartovat službu na 80 PC, vytvoříte nový nástroj (např. ITDashboard-Executor) nebo přidáte do tohoto? Moje rada: **samostatný nástroj** s vlastním threat modelem.

### 1.2 Polling vs push – polling je OK, ale s optimalizací

Současný 15min interval s 5 paralelními PS spawny je pro 99 PC v pohodě. Problém:

- **Disk critical:** 15min okno může být dlouhé (disk se zaplní za 5 minut). Doporučuji **speciální krátký interval** pro critical/warning stavy – např. pokud disk < 5% free, kolektor se spouští každých 5 minut na tom konkrétním PC.
- **Push (agent) odmítám z principu** – přidal bys údržbu a bezpečnostní riziko. Souhlas.

### 1.3 Single point of failure – akceptovatelné, ale dokumentovat

`10.8.2.213` je jediný bod selhání. Pro solo operátora OK. **Doporučuji:** alespoň jednoduchý healthcheck endpoint (`/health`) a monitoring z Centronu – aby bylo jasné, když dashboard sám spadne.

### 1.4 Per-feature plugin vs flat routes

Flat routes jsou pro 20 endpointů v pohodě. **Nedoporučuji** přechod na pluginy – přidaná komplexita nestojí za benefit.

---

## 2. Bezpečnost

### 2.1 Kritické: API bez autentizace

> "Doménový uživatel jiný než IT má dnes přístup k JSON API, pokud najde URL. Frontend ho rozpozná podle IP a ukáže AccessDenied. API endpointy ale nelže."

**To je nepřijatelné pro produkci v roce 2026.** Důvody:

- BYOD endpointy (až 25) → stačí jeden kompromitovaný laptop, útočník čte celý inventář, eventy, current_user.
- Site-to-site VPN dodavatelů → jejich doménové účty mají přístup.
- Firewall Domain profile je vypnutý → OS-level ochrana neexistuje.

**Doporučení (minimálně):**

```ts
// jednoduchý pre-shared token v headeru
const TOKEN = process.env.API_TOKEN || crypto.randomBytes(32).toString('hex');
app.addHook('preHandler', async (req, reply) => {
  if (req.headers['x-itdashboard-token'] !== TOKEN && req.ip !== '127.0.0.1') {
    reply.code(401).send({ error: 'unauthorized' });
  }
});
```

A token vypsat operátorovi a nastavit jako environment variable. Náročnost: 30 minut. **Udělej to hned.**

### 2.2 Firewall Domain profile vypnutý – critical

`Set-NetFirewallProfile -Profile Domain -Enabled True` by mělo být součástí bootstrap skriptu. Pokud to nejde (GPO override), alespoň **detekce** v UI – warning banner "OS-level firewall disabled".

### 2.3 Žádný audit log uživatelských akcí

Dnes `activity_log` obsahuje jen akce dashboardu (collector runs, settings save). Chybí:

- Kdo si zobrazil Computers tab (kdy, z jaké IP)
- Kdo stáhl GPO script
- Kdo spustil "Run all"

Pro solo operátora OK, ale pokud tým → **bez audit logu nelze**. Doporučuji přidat `user_activity` tabulku s IP, User-Agent, akcí, timestamp.

### 2.4 DPAPI credentials vault – recovery chybí

Pokud `svc-itdashboard` password vyprší nebo se změní, všechny credentials v `credentials` tabulce jsou ztraceny. **Žádný recovery flow.** Doporučuji:
- Pravidelný export encrypted blob do souboru (offline backup)
- Nebo přejít na Azure Key Vault / HashiCorp Vault (overkill)

### 2.5 Loopback vždy allowed – risk?

`127.0.0.1` je vždy allowed, což znamená, že jakýkoliv proces na MIKOS serveru (i neprivilegovaný) může volat API. Pokud by došlo k RCE na serveru přes jinou službu, útočník má plný přístup k API. To je akceptovatelné – server hardening je mimo scope. Ale dokumentovat.

---

## 3. Databáze a migrace

### 3.1 Kritické: Žádný retention scheduler

`sp_purge_old_events` a `sp_purge_old_activity` existují, ale **nikdo je nevolá**. Data rostou neomezeně.

- `events` – 2M řádků za 3 měsíce, za rok 8M, za 2 roky 16M → výkon půjde dolů.
- `activity_log` – 30k řádků/den, za rok 11M → tabulka obrovská.

**Doporučení:** Přidat do `checks-runner.ts` daily cron (např. v 2:00 ráno):
```ts
setInterval(async () => {
  const retentionDays = await getSetting('activity.retention_days', 30);
  await pool.request().query(`EXEC sp_purge_old_activity @retention_days = ${retentionDays}`);
}, 24 * 60 * 60 * 1000);
```

A totéž pro events (90 dní).

### 3.2 msnodesqlv8 a GO separator – známá past, ale vyřešená

Migrace 020 použila `EXEC('CREATE PROCEDURE …')` – to je správně. Ale proč nepoužít prostě samostatné `.query()` volání pro každý statement? Současný pattern je křehký.

**Doporučení:** Napsat helper `runSqlFile(pool, filePath)`, který rozdělí na jednotlivé příkazy podle `;` (dávat pozor na string literály). Nebo přejít na `sqlcmd` (ale to vyžaduje další tool).

### 3.3 Clustered index na `events` – netradiční, ale OK

PK `(id, time_created)` NONCLUSTERED + clustered na `(time_created DESC, level)` – to je dobré pro časové range dotazy. Ale:

- `INSERT` bude o něco pomalejší (nonclustered PK + clustered index). Pro 2000 INSERTů za cyklus v pohodě.
- **Doporučuji monitorovat fragmentaci** – časem vznikne, potřebuje rebuild.

### 3.4 Reserved word incident – systémová chyba

`CURRENT_USER` je SQL Server funkce, ALTER TABLE bez bracketů selže. Že to prošlo do produkce je selhání **lokálního testování**.

**Doporučení:** Před každou migrací spustit `npm run migrate:dryrun` lokálně (vyžaduje lokální MSSQL Developer Edition – free, 10GB limit, stačí). Bez toho se deployment fragility nevyřeší.

---

## 4. Deployment a CI/CD

### 4.1 Kritické: Topbar SHA lže o stavu Node procesu

Topbar čte `.git/refs/heads/main` – to je **build-time info**, ne runtime. Pokud migrace selže a restart neproběhne, topbar ukazuje nový SHA, ale Node běží starý kód. **Tohle je největší diagnostická past.**

**Řešení (jednoduché):**

V build stepu:
```json
// package.json script
"build:version": "node -p \"'export const GIT_SHA = \\\"' + require('child_process').execSync('git rev-parse HEAD').toString().trim() + '\\\";'\" > apps/server/dist/version.js"
```

V kódu:
```ts
import { GIT_SHA } from './version.js';
app.get('/version', () => ({ sha: GIT_SHA, builtAt: Date.now() }));
```

### 4.2 Deploy pipeline – exit code před restartem

Pokud `npm run migrate` selže, `sc start` se nespustí → Node běží dál. **To je návrhová chyba.**

**Řešení:** Každý krok musí být idempotentní, nebo musí následovat rollback. Lepší:

```yaml
- name: Stop service
  run: sc stop ITDashboardAPI
- name: Wait for stop
  run: timeout /t 5
- name: Copy files
  run: robocopy ...
- name: Migrate (if fails, keep service stopped)
  run: npm run migrate || (echo "Migration failed, service remains stopped" && exit 1)
- name: Start service
  run: sc start ITDashboardAPI
- name: Smoke test
  run: |
    timeout /t 3
    curl http://localhost:4000/version | findstr "%GITHUB_SHA%"
    if errorlevel 1 exit 1
```

### 4.3 Self-hosted runner single point of failure

Runner běží na stejném serveru jako API. Pokud runner service padne, deploys neprojdou. **Doporučuji:** mít fallback – ruční deploy script na MIKOS, který si stáhne zip z GitHubu a restartuje service. Náročnost 1 hodina.

### 4.4 `shell: cmd` – obejití GPO AllSigned

Tohle je **red flag** z hlediska audit trail. Obcházíte firemní GPO policy. Pokud je AllSigned vyžadováno, měl byste podepsat skripty, ne je obejít.

**Doporučení:** Podepsat PowerShell skripty pomocí code signing certificate (k dispozici v doméně). Nebo přejít na `shell: pwsh` s `-ExecutionPolicy Bypass` (ale to je stejné obejití).

---

## 5. Frontend

### 5.1 Žádný Error Boundary – kritické pro UX

Jeden komponent hodí chybu (např. hooks order bug) → celá App je bílá obrazovka. Uživatel neví, co se stalo.

**Doporučení:** Obalit App do `<ErrorBoundary>` s fallback UI "Something went wrong, check console / activity log".

### 5.2 Frontend gate je pouze UX – vědomé, ale nebezpečné

Souhlasím s argumentem "bundle se servíruje všem, ale access denied se zobrazí". Ale:

- Pokud máš API bez auth (bod 2.1), tak útočník stejně data získá.
- **Řešení:** Auth token na API (bod 2.1) + frontend gate jako UX vylepšení.

### 5.3 Žádné loading stavy – nízká priorita, ale otravné

První load Perf tabu je prázdný, pak po 2s naskočí data. Uživatel si myslí, že je něco rozbité.

**Doporučení:** `isLoading` stav + skeleton loadery.

### 5.4 Inline styly – proti údržbě

`style={{ ... }}` je všude. Pro malý projekt OK, ale pokud přidáš tým, bude to peklo. **Doporučení:** Přesunout do CSS modules nebo styled-components postupně, až to začne bolet.

### 5.5 CSP override pro `/docs` – security riziko

Helmet CSP default `script-src 'self'` – ale `/docs` potřebuje inline JS (print button). Řešíte to override:

```ts
directives: { 'script-src': ["'self'", "'unsafe-inline'"] }
```

To otevírá XSS. **Lepší řešení:** Refaktorovat `/docs` page – přesunout JS do samostatného souboru a použít `script-src 'self'` + nonce.

---

## 6. Backend a collectory

### 6.1 PowerShell embedded v TS template literals – velmi křehké

`\d` bug ukázal zranitelnost. Každý escape sequence je potenciální chyba.

**Doporučení:** Extrahovat PS skripty do `.ps1` souborů a použít parametrizaci:

```ts
const script = fs.readFileSync('scripts/get-events.ps1', 'utf8');
const args = [`-ComputerName ${name}`, `-StartTime ${sinceIso}`];
spawn('powershell', ['-File', script, ...args]);
```

Bonus: PS skripty mohou být podepsané.

### 6.2 per-event INSERT – performance issue při větším fleetu

Pro 99 PC a 30 events/PC = 3000 INSERTů za cyklus, MSSQL to zvládne. Ale při 500 PC (budoucnost) to bude 15k INSERTů – začne to bolet.

**Doporučení:** Implementovat table-valued parameter:

```ts
const table = new mssql.Table('events');
table.columns.add('computer_id', mssql.Int);
table.columns.add('time_created', mssql.DateTime2);
// ...
events.forEach(e => table.rows.add(e.computerId, e.timeCreated, ...));
await pool.request().input('events', table).execute('sp_insert_events_bulk');
```

### 6.3 `runInFlight` global state – reset chybí při crashu

Pokud Node spadne mid-cycle (vzácné), `runInFlight` zůstane `true` v paměti – ale to je jedno, protože Node restartuje. Problém je, pokud crashne jen collector (vyjímka) – pak `finally` resetuje. OK.

### 6.4 Fire-and-forget activity log – data loss při DB výpadku

`void persistEntry(entry)` – pokud DB spadne na 5 minut, ztratíte všechny logy. Pro audit to může být problém.

**Doporučení:** Implementovat memory queue (např. `p-queue` s retry) – pokud DB write selže, zkusit znovu po 1s, po 3 selhání zahodit a logovat do souboru.

### 6.5 Žádný backoff při consecutive failures

PC s 10 failures je permanently skipped až do ručního resetu. To je příliš tvrdé.

**Doporučení:** Implementovat exponenciální backoff – po 5 failures zkusit za 1 hodinu, pak za 6 hodin, pak za 24 hodin. A reset po úspěchu.

### 6.6 Perf collector – server SKU klasifikace je správná

`channel-disabled` je validní stav. Ale UI by mělo umožnit "enable channel" tlačítko (export GPO script). Dnes chybí.

---

## 7. Provoz a observabilita

### 7.1 Žádné automatické retry na DB connection

`msnodesqlv8` pool se sám reconnectuje, ale pokud SQL Server spadne na 10 minut, API endpointy vrací 500. To je OK, ale **žádný healthcheck endpoint neindikuje DB stav**.

**Doporučení:** `/health` by mělo vracet stav DB:

```ts
app.get('/health', async () => {
  const dbOk = await pool.request().query('SELECT 1').catch(() => false);
  return { status: dbOk ? 'ok' : 'db_down', timestamp: Date.now() };
});
```

### 7.2 Žádný monitoring monitora – Centron probe

Doporučuji v Centronu nastavit HTTP probe na `http://10.8.2.213:4000/health` každých 5 minut. Pokud selže, alert.

### 7.3 Backup strategie nedokumentována

Kde jsou zálohy DB? Recovery test nebyl proveden. **Doporučuji:** Jednoduchý `.ps1` script, který každou noc exportuje `events` posledních 7 dní + `computers`, `settings`, `service_policy` do souboru a kopíruje na file share.

### 7.4 `activity_log` retention – znovu

Kritické, opakuji. Implementuj daily cron.

---

## 8. Testování

### 8.1 Žádný end-to-end test – největší systematická chyba

`\d` bug a reserved word prošly do produkce, protože neexistuje:

- Lokální DB pro migrace
- Integration test, který spustí collector na testovacím PC a ověří výsledky
- Smoke test po deployi

**Doporučení (minimálně):**

1. **Pre-commit hook** – spustí migrace na lokální MSSQL (Developer Edition) a ověří, že projdou.
2. **Integration test** – jeden testovací PC (např. `TEST-PC-01`), script, který spustí collectory a porovná výstup s očekáváním.
3. **Smoke test v deployi** – po restartu zavolat `/version` a `/health` a `/computers?limit=1`.

### 8.2 Žádné lint – nízká priorita, ale pomůže

ESLint by chytil některé problémy (např. nepoužité proměnné, potenciální null dereference). Doporučuji `@typescript-eslint/recommended`.

---

## 9. Dokumentace a kód

### 9.1 Dokumentace je excelentní

`itdashboard-podklad-2026-06-03.md` je vynikající – detailní, poctivé přiznání slabin, strukturované. To oceňuji.

### 9.2 Kód – chybí JSDoc

Většina funkcí nemá dokumentaci. Pro solo operátora OK, pro tým špatně. Doporučuji alespoň klíčové funkce okomentovat.

---

## 10. Prioritní akce (co opravit hned)

### P0 (tento týden)

1. **Auth token na API** – 30 minut práce, odstraní kritickou bezpečnostní díru.
2. **Topbar SHA svázat s buildem** – 1 hodina, odstraní diagnostické peklo.
3. **Retention scheduler** – 2 hodiny (daily cron pro events + activity_log).
4. **Smoke test po deployi** – 1 hodina (`/version` shoda).

### P1 (příští týden)

5. **Extrahovat PS skripty do `.ps1` souborů** – 4 hodiny, odstraní křehkost.
6. **Error Boundary v Reactu** – 1 hodina.
7. **Firewall Domain profile check + warning v UI** – 1 hodina.
8. **Backoff mechanismus pro failed PCs** – 2 hodiny.

### P2 (do měsíce)

9. **Table-valued parameter pro events** – 4 hodiny (performance).
10. **Lokální MSSQL pro pre-commit migrace** – 2 hodiny.
11. **Audit log uživatelských akcí** – 4 hodiny.
12. **Per-PC detail page** – 8 hodin (user-facing).

---

## 11. Závěrečné hodnocení

**Silné stránky:**
- Pragmatické řešení reálného problému
- Observer-only princip je správný
- Kvalitní dokumentace
- Rychlé iterace (12 commitů za den)

**Slabé stránky:**
- Bezpečnost (auth, firewall) je podceněná
- Deployment pipeline je křehká a lživá
- Žádné testování => regression bugs jdou do produkce
- Retention scheduler chybí => data rostou donekonečna

**Celkově:** Projekt je **funkční MVP**, ale ne **produkčně robustní systém**. Pro solo operátora v interní síti může být přijatelný, ale pokud se má používat týmem nebo v prostředí s BYOD/VPN, **musí být výše uvedené P0 položky implementovány**.

**Doporučení pro další směřování:**
1. Zafixovat P0 – bez toho nebrat další feature.
2. Přidat jednoduché E2E testy (alespoň smoke).
3. Rozhodnout, zda chceme zůstat solo-operator nástroj nebo se posunout k týmu – to ovlivní investice do auth, audit logu, RBAC.

**Otázka na závěr:** Plánuješ, že na ITDashboardu bude pracovat více než jeden operátor? Pokud ano, tak auth a audit log jsou **mandatory**. Pokud ne, pak můžeš riskovat, ale dokumentuj to v threat modelu.
