---
date: 2026-06-04
type: reakce
target: 2026-06-04-oponentura-services-exitcode-alert-fatigue.md
verdict: partially accepted — 4 commitments, 2 pushbacks
---

# Reakce — Services tab ExitCode + alert fatigue (2026-06-04)

## Souhrn

Critique má **významně pravdu v 1 zásadním bodě** (chybí Win32ExitCode capture) a **rozpracovává validní follow-up rizika** (crash loop, central whitelist, NIS2/ISO27001 docs). Současně několik tvrzení **přehání aktuální stav** — current implementace už dělá leccos z toho, na co critique útočí. Reakce rozděluje na to co přijímáme jako commitments a co odmítáme.

## Stav dnes — fact-check critique

Critique tvrdí: *"Pokud nástroj řve pokaždé, když se Google Updater po kontrole sám vypne, vyrábíte si obrovský šum."*

**Realita** (apps/server/src/services/services-collector.ts:43-88):
- Collector ČTE `DelayedAutoStart` + `TriggerInfo` z registry per service → `delayed_start` a `trigger_start` BIT sloupce v `service_problems`
- UI Services tabu má 4 default-ON filtry: **Hide trigger-start (default ON)**, **Hide delayed-start**, **Hide per-user (default ON)**, **Hide compliant**
- `services_policy` tabulka + `classifyAgainstPolicy()` značí každý problem jako **OK / Drift / Unclassified** podle whitelist patternu
- Default view operatora tedy NEUKAZUJE Google Updater + MapsBroker + M-Files Assistant jako "problém" — jsou skryté přes Hide trigger-start = ON

Z toho plyne: **alert fatigue ON THE DEFAULT VIEW není natolik vážný problém jak critique tvrdí**. ALE — pokud operator filtr vypne, dostane ten šum okamžitě. A bez ExitCode signálu nemůže rozlišit "trigger-start co skončil graceful" od "trigger-start co spadl" — pro tu druhou kategorii je current view slepý.

## Commitments (4)

### 1. Win32ExitCode capture — ACCEPTED, ship jako Sprint 1.7

Critique má pravdu že tohle aktuálně chybí.

**Změny:**
- Migrace nová: `026_service_exit_code.sql` přidá `exit_code INT NULL` + `service_specific_exit_code INT NULL` do tabulky `service_problems`
- `services-collector.ts` PowerShell rozšířit aby capturoval `$s.ExitCode` + `$s.ServiceSpecificExitCode` z Win32_Service
- UI Services tabu: nový sloupec ExitCode s color coding (0 = dim gray, !=0 = critical red) + nový filter chip "Show only ExitCode != 0" (default OFF — ne destruktivní pro existing workflow)
- HelpBox text rozšířit o ExitCode semantiku

Estimate: ~3 h. Žádné breaking changes, backward compatible (ExitCode = NULL pro existing rows).

### 2. Crash loop detection — ACCEPTED jako Sprint 2 (LATER, nejdřív ExitCode)

Critique #2 z meta-review: *"Pokud služba naskakuje každých 30 sekund a padá s exit code 0..."*

**Plán:**
- Sledovat per (computer_id, service_name) frekvenci state flipů v 24h okně
- Nová tabulka `service_state_history` (raw transitions) NEBO denominalizovaný counter `restart_count_24h` v `service_problems`
- Threshold (default 6 restarts / 24h) konfigurovatelný via settings
- Crash loop flag = nový badge v UI vedle Drift / OK / Unclassified

Defer do Sprint 2 protože:
- Vyžaduje persistovat state history (storage + retention pipeline implication)
- ExitCode capture (commitment #1) je víc impact pro méně práce → priority

### 3. NIS2/ISO27001 documentation — ACCEPTED, partial ship

Critique #4 z meta-review: *"U auditu se vás zeptají: 'Máte definováno, co je normální chování služeb?'"*

**Co přidám hned (Sprint 1.7 spolu s commitment #1):**
- Sekce v `docs/dashboard.html` "Services monitoring policy" (CS+EN) popisující:
  - Co je monitorováno (StartMode='Auto' AND State<>'Running')
  - Co je default skryto (trigger-start, delayed-start, per-user) a proč
  - ExitCode semantika (po commitment #1)
  - Whitelist mechanismus přes `services_policy` tabulku
  - Limitace (žádný crash loop detection — TBD Sprint 2)
- Tato sekce je audit-ready dokumentace s explicit "slepých skvrn" enumerated

**Co odmítám**: že současný stav je "nedoumětnutelný u auditu". S Hide-filtry default ON + policy classification je dokumentovatelný; jen jsme to neměli sepsané. Sepsáním tu mezeru zacelíme.

### 4. Central whitelist — ACCEPTED jako Sprint 2 candidate, ne urgent

Critique #3 z meta-review: *"White-list dělejte centrálně (GPO nebo CMDB), jinak si každý admin whitelistuje co ho otravuje."*

Současně máme `services_policy` tabulku v DB, dispatched přes settings UI. Vyhovuje pro solo-operator workflow. Pro multi-admin operations:
- Možnost importovat policy z GPO / CSV (Sprint 2 task)
- UI audit log policy changes (kdo přidal/odebral policy)
- Export current policy table → CSV pro review

Není urgent — kdyby přibyl second admin, otevřeme jako CR.

## Pushbacks (2)

### A. "Použijte SCOM management pack nebo Zabbix template místo vlastního"

**Odmítnuto.** Důvody:
- ITDashboard je nepředstavovaný interní tool, žádná SCOM licence v plánu (SCOM = Microsoft System Center, dražší licensing, vyžaduje SQL Server, agent na každém stroji)
- Zabbix vyžaduje samostatnou serverovou infrastrukturu + agent na cílech — ITDashboard explicitně cíl "agentless přes WinRM / RPC"
- Naše PowerShell collector je 80 řádků a dělá ten samý CIM query co SCOM mp; přidat `$s.ExitCode` capture je jeden řádek
- Critique #1 z meta-review připouští "pokud už musíte dělat vlastní" — uznává že custom je legitimní cesta, jen ukazuje gotchas (které my respektujeme jakmile commit #1-#4 lend)

### B. Code sample z critique má drobný bug

Code sample z meta-review:
```powershell
if ($service.State -eq 'Stopped' -and $service.StartMode -eq 'Auto' -and $service.ExitCode -eq 0) {
    # Normální chování trigger-start služby – žádný alert
}
```

Toto NESPRÁVNĚ klasifikuje **classic Auto + Stopped + exit 0** jako "normální". Service který má `StartMode=Auto` (classic, ne trigger-start) **by neměla být zastavená** (sám meta-review v bodě #1 toto říká), bez ohledu na exit code. Critique sama sobě protiřečí.

Náš collector bude logicky:
- `trigger_start = 1` AND `state=Stopped` AND `exit_code=0` → graceful (HIDE by default)
- `trigger_start = 1` AND `state=Stopped` AND `exit_code !=0` → trigger-start crashed (RED)
- `trigger_start = 0` AND `state=Stopped` → classic Auto stopped → RED bez ohledu na exit code (možný indikátor crash i s exit 0, např. Service Control Manager timeout)
- `delayed_start = 1` AND state=Stopped → check exit_code analogicky k classic

Tj. ExitCode signal je **modifikátor pro trigger-start kategorii**, ne univerzální gate pro všechny stopped services.

## Cross-references

- Memory rule [[feedback-oponentury-archive]] — archive + structured reakce, hotovo
- Memory rule [[feedback-default-workflow-docs-push]] — auto-push docs + commits
- Memory rule [[feedback-go-to-market-standard]] — commitments shippnu jako pro paying customer
- Related: [[project-itdashboard]]
- Sprint sequence: 1.6a (Windows auth, in-flight) → 1.7 (ExitCode + audit docs, this CR) → 2 (AD Users tab + crash loop + central whitelist)

## Deploy path

1. Sprint 1.7 = ExitCode capture + UI surfacing + audit docs (Sprint 1.7a, ~3 h)
2. Sprint 2 = crash loop detection (state history persistence + UI badge) + central whitelist tools
3. Memory: critique's "alert fatigue" concern stojí za quarterly review even after ExitCode landed — pokud někdy uvidíme že default view Services má >50 řádků, znamená to že naše defaults selhaly a potřebujeme tighten
