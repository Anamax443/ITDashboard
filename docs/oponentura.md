# ITDashboard — Bezagentní monitorovací a inventarizační systém pro doménové prostředí Windows

**Technicko‑odborná dokumentace pro oponenturu**

---

| | |
|---|---|
| **Název projektu** | ITDashboard |
| **Typ systému** | Webová/desktopová aplikace pro monitoring IT infrastruktury |
| **Cílové prostředí** | Doména Active Directory (Windows), cca 225 spravovaných stanic a serverů |
| **Architektura** | Monorepo, třívrstvá (sběr → API/DB → klient) |
| **Technologie** | Node.js 20, Fastify, TypeScript, MSSQL, Electron, React, Vite |
| **Způsob nasazení** | Kontinuální nasazení (CI/CD) přes self‑hosted GitHub Actions runner |
| **Stav** | Produkční provoz, kontinuálně rozvíjeno |
| **Verze dokumentu** | 1.0 |

---

## Abstrakt

ITDashboard je monitorovací, inventarizační a diagnostický systém určený pro správu počítačů a serverů v doménovém prostředí Microsoft Active Directory. Hlavním přínosem řešení je **bezagentní (agentless) sběr dat** — systém nevyžaduje instalaci žádného klienta na cílových stanicích a veškerá telemetrie (události systémových protokolů, stav diskového prostoru, stav služeb, výkonové události startu/vypnutí, síťová dosažitelnost, přihlášení uživatelé) se získává standardními protokoly Windows (RPC/DCOM, SMB, ICMP) pod identitou doménového servisního účtu. 

Práce popisuje motivaci vzniku systému jako odpovědi na potřebu přehledné, centralizované a auditovatelné správy heterogenního parku Windows stanic v kontextu požadavků na kybernetickou bezpečnost (NIS2, ISO/IEC 27001), analýzu funkčních i nefunkčních požadavků, návrh třívrstvé architektury, relační datový model (40 evolučních migrací schématu), implementaci backendu (Fastify + TypeScript) i klienta (Electron + React), bezpečnostní model s vícevrstvým řízením přístupu a model kontinuálního nasazení s ověřováním shody nasazené binárky s revizí zdrojového kódu.

Systém zavádí několik vlastních konceptů: **tlumené skóre problémovosti stanic** (damped‑blend skóre pro identifikaci kandidátů na reinstalaci), dvouúrovňové monitorování služeb (široké vs. kritické) s per‑stanicovými výjimkami, **strukturované e‑mailové reporty se strojově čitelným označením stavu** pro automatizované třídění, a filozofii „pozorovatel, nikoli vykonavatel" (observer, not executor), kde systém zásadně neprovádí automatické zásahy do cílových systémů.

**Klíčová slova:** monitoring, bezagentní sběr, Active Directory, Windows, event log, MSSQL, Fastify, React, Electron, kybernetická bezpečnost, NIS2, CI/CD.

## Abstract (EN)

ITDashboard is a monitoring, inventory and diagnostic system for managing workstations and servers in a Microsoft Active Directory domain. Its principal contribution is **agentless data collection** — the system requires no client software on target machines; all telemetry (event logs, disk space, service state, boot/shutdown performance events, network reachability, logged‑on users) is obtained through standard Windows protocols (RPC/DCOM, SMB, ICMP) under a domain service account identity.

The document covers the motivation, a requirements analysis, the design of a three‑tier architecture, the relational data model (40 evolutionary schema migrations), the implementation of the backend (Fastify + TypeScript) and the client (Electron + React), a layered security model, and a continuous‑deployment model that verifies the running binary matches the source revision. The system introduces a damped‑blend health score for identifying reinstallation candidates, a two‑level service‑monitoring model with per‑machine exceptions, structured e‑mail reports with machine‑readable status markers, and an "observer, not executor" philosophy.

**Keywords:** monitoring, agentless, Active Directory, Windows, event log, MSSQL, Fastify, React, Electron, cyber security, NIS2, CI/CD.

---

## Obsah

**Část I — Úvod a analýza**
1. Úvod
2. Analýza problému a požadavků

**Část II — Architektura a datový model**
3. Architektura systému
4. Datový model

**Část III — Implementace serverové části**
5. Backend: API a sběrné služby
6. Alerting a notifikace
7. Detekce problémových stanic

**Část IV — Klientská část**
8. Desktopová a webová aplikace

**Část V — Provoz, bezpečnost, nasazení**
9. Bezpečnostní model
10. Nasazení a CI/CD
11. Testování a ověřování kvality
12. Výkon a škálování
13. Provoz a údržba

**Část VI — Zhodnocení**
14. Diskuse, omezení a budoucí práce
15. Závěr

**Přílohy**
- A. Referenční přehled REST API
- B. Datový slovník
- C. Referenční přehled konfiguračních klíčů
- D. Seznam migrací schématu
- E. Glosář pojmů
- F. Instalační a konfigurační runbook
- G. Referenční konfigurace prostředí (.env)
- H. Příklady API
- I. Evoluce návrhu a poučení
- J. Související normy a protokoly
- K. Referenční hodnoty nasazení
- L. Přehled technologií a verzí

---

# Část I — Úvod a analýza

# 1. Úvod

## 1.1 Motivace

Správa parku několika set počítačů a serverů v podnikové doméně Active Directory naráží v praxi na sérii opakujících se problémů, které jednotlivě řeší řada specializovaných nástrojů, ale jejichž průnik a centralizace bývají náročné a nákladné. Správce typicky potřebuje současně odpovídat na otázky velmi odlišné povahy:

- **Inventář:** Které stanice doména obsahuje, které jsou aktivní, které dlouhodobě mlčí, jaký mají operační systém a kde v organizační struktuře (OU) se nacházejí?
- **Zdraví a chyby:** Které stanice generují podezřele mnoho chyb v protokolech událostí? Které jsou kandidáty na reinstalaci, protože se „rozsýpají"?
- **Kapacita:** Kterým strojům dochází místo na disku dříve, než to způsobí výpadek?
- **Dostupnost služeb:** Běží na klíčových serverech kritické služby (řadiče domény — NTDS, DNS, Kerberos; zálohování — Veeam; antivirus)? Pokud spadnou, ví o tom někdo včas?
- **Síťová dosažitelnost:** Které stroje jsou právě teď online a které ne?
- **Výkon:** Které stanice startují pomalu a co je příčinou?
- **Audit a bezpečnost:** Kdo se kdy na který stroj přihlašoval? Je k dispozici auditovatelný záznam činnosti monitorovacího systému samotného?

Komerční řešení (Microsoft System Center Configuration Manager / Intune, Zabbix, PRTG, Nagios, ManageEngine a další) tyto potřeby pokrývají, avšak za cenu některých nevýhod, které byly pro daný kontext zásadní:

1. **Nutnost agentů.** Většina nástrojů vyžaduje instalaci a údržbu agenta na každé stanici. To znamená správu životního cyklu agenta, jeho aktualizace, řešení jeho selhání a bezpečnostní povrch navíc.
2. **Složitost a cena.** Plnohodnotné nasazení SCCM nebo Zabbixu je samo o sobě infrastrukturní projekt.
3. **Přílišná obecnost.** Univerzální nástroje neznají specifika konkrétní domény — co je „kritická služba", jak vypadá „problémová stanice", které disky se mají hlídat.
4. **Aktivní zásahy.** Mnoho nástrojů je navrženo i k provádění změn (remediace), což zvyšuje riziko a rozšiřuje plochu pro chybu nebo zneužití.

ITDashboard vznikl jako cílená odpověď: **lehký, bezagentní, doménově specifický pozorovací systém**, který využívá toho, že doménově připojené stroje Windows již ve výchozím stavu poskytují vše potřebné prostřednictvím standardních protokolů (vzdálené čtení protokolu událostí přes RPC, WMI/CIM přes DCOM, SMB, ICMP). Stačí mít doménový servisní účet s odpovídajícími oprávněními a systém dokáže sbírat telemetrii bez jakéhokoli softwaru na koncových stanicích.

## 1.2 Problém a kontext

Cílovým prostředím je podniková doména s přibližně **225 spravovanými počítači a servery** (stanice Windows 10/11, serverové operační systémy, řadiče domény, zálohovací a souborové servery). Prostředí je heterogenní co do verzí operačních systémů, rolí strojů i jejich dostupnosti (část je trvale zapnutá, část jsou notebooky s proměnlivou přítomností v síti).

Kontext kybernetické bezpečnosti je dán rostoucími regulatorními požadavky. Směrnice **NIS2** a norma **ISO/IEC 27001** kladou důraz mimo jiné na:

- přehled o aktivech (asset management) — organizace musí vědět, jaká zařízení provozuje;
- detekci a reakci na incidenty — schopnost zaznamenat a včas reagovat na anomálie;
- auditovatelnost — průkazný záznam o tom, co systém dělal;
- řízení přístupu — kdo a jak smí se systémem pracovat.

ITDashboard k těmto požadavkům přispívá jako **monitorovací a evidenční vrstva**: poskytuje aktuální inventář, detekci anomálií v protokolech událostí, přehled o kritických službách a dostupnosti, a vede vlastní auditní záznam (activity log).

## 1.3 Cíle práce

Cíle, které si systém klade, lze rozdělit na funkční a kvalitativní.

**Funkční cíle:**

- **C1.** Udržovat aktuální inventář všech doménových stanic synchronizovaný z Active Directory, obohacený o telemetrii (IP adresa, přihlášený uživatel, verze OS, OU).
- **C2.** Sbírat a analyzovat protokoly událostí Windows a poskytovat z nich agregované přehledy (počty kritických/chybových/varovných událostí, nejčastější ID událostí, časové řady, nejproblémovější stroje).
- **C3.** Monitorovat diskový prostor a upozorňovat na kritické zaplnění.
- **C4.** Monitorovat stav služeb ve dvou úrovních (široké pokrytí vs. kritické infrastrukturní služby) s možností per‑stanicových výjimek.
- **C5.** Sledovat výkonové události startu a vypnutí systému a identifikovat příčiny zpomalení.
- **C6.** Průběžně ověřovat síťovou dosažitelnost strojů nezávisle na ostatním sběru.
- **C7.** Odesílat e‑mailová upozornění na zjištěné problémy a generovat strukturované reporty.
- **C8.** Poskytovat přehledné grafické rozhraní s možností filtrování, vyhledávání, exportu a prokliků (drill‑down).

**Kvalitativní (nefunkční) cíle:**

- **K1.** Bezagentnost — žádný software na cílových stanicích.
- **K2.** Bezpečnost — vícevrstvé řízení přístupu, žádná hesla v konfiguraci, princip nejmenších oprávnění.
- **K3.** Auditovatelnost — perzistentní záznam činnosti systému.
- **K4.** Přenositelnost — žádné natvrdo zadané IP adresy, hostname či doménová jména ve zdrojovém kódu; veškerá specifika v konfiguraci.
- **K5.** Spolehlivost nasazení — automatizované nasazení s ověřením, že běžící kód odpovídá zdroji.
- **K6.** Princip „pozorovatel, nikoli vykonavatel" — systém zásadně neprovádí automatické změny na cílových systémech.

## 1.4 Struktura dokumentu

Dokument je členěn do šesti částí. **Část I** uvádí do problému a analyzuje požadavky. **Část II** popisuje architekturu a datový model. **Část III** se věnuje implementaci serverové části (API, sběrné služby, alerting, skórování). **Část IV** popisuje klientskou aplikaci. **Část V** pokrývá bezpečnost, nasazení a testování. **Část VI** obsahuje zhodnocení a závěr. Přílohy poskytují referenční přehledy API, datového modelu a konfigurace.

---

# 2. Analýza problému a požadavků

## 2.1 Funkční požadavky

Z cílů uvedených v kapitole 1.3 plynou konkrétní funkční požadavky (FR), které systém realizuje:

| ID | Funkční požadavek | Realizace |
|----|-------------------|-----------|
| FR‑1 | Synchronizace inventáře z AD | Služba `ad-sync`, `Get-ADComputer`, MERGE do tabulky `computers` |
| FR‑2 | Sběr protokolů událostí | Služba `eventlog-collector`, `Get-WinEvent` přes RPC |
| FR‑3 | Agregace a analýza událostí | Endpointy `/events/*`, denní agregace `event_daily_agg` |
| FR‑4 | Skóre problémovosti stanice | Endpoint `/events/pc-health`, tlumený mix |
| FR‑5 | Monitoring diskového prostoru | Služba `disk-collector`, `Get-CimInstance Win32_LogicalDisk` |
| FR‑6 | Diskové alerty | `evaluateAndSendDiskAlerts`, per‑PC opt‑in |
| FR‑7 | Monitoring služeb (dvě úrovně) | Služba `services-collector`, tabulky `service_problems`, `critical_service_status` |
| FR‑8 | Servisní alerty s per‑PC výjimkami | `loadDownServices`, sloupce `*_exceptions` |
| FR‑9 | Výkonové události (boot/shutdown) | Služba `perf-collector`, kanál Diagnostics‑Performance |
| FR‑10 | Síťová dosažitelnost | Služba `reachability-collector`, TCP 135/445 + ICMP |
| FR‑11 | Port‑checky (LDAP/SMB/RDP/Kerberos/DNS) | `evaluateAndSendPortAlerts`, tabulka `port_check_state` |
| FR‑12 | E‑mailové notifikace | Služba `alerts`, nodemailer, M365 Direct Send |
| FR‑13 | Strukturovaný report parku | Služba `reports`, endpoint `/reports/*` |
| FR‑14 | Historie přihlášení uživatelů | Tabulka `pc_user_history` |
| FR‑15 | Auditní záznam činnosti | Služba `activity-log`, tabulka `activity_log` |
| FR‑16 | Grafické rozhraní s filtry a exportem | Klient Electron/React, komponenta `ExportMenu` |
| FR‑17 | Akce na vzdálené stanici | Komponenta `PcActions`, URL protocol handlers |
| FR‑18 | Konfigurace bez restartu | `settings` v DB, živé přeplánování |

## 2.2 Nefunkční požadavky

| ID | Nefunkční požadavek | Metrika / přístup |
|----|---------------------|-------------------|
| NFR‑1 | Bezagentnost | Nulová instalace na cílových stanicích |
| NFR‑2 | Výkon sběru | Paralelní sběr (concurrency 5–16), fail‑fast TCP probe |
| NFR‑3 | Odolnost sběru | Jedna chybná událost neshodí dávku; max. události/PC/běh |
| NFR‑4 | Bezpečnost přístupu | IP whitelist + LDAP bind + AD skupina (edit tier) |
| NFR‑5 | Žádná hesla v konfiguraci | Windows Integrated Auth k DB, DPAPI pro úschovu |
| NFR‑6 | Auditovatelnost | Perzistentní activity_log + provozní historie běhů |
| NFR‑7 | Přenositelnost | Žádné natvrdo zadané hodnoty ve zdroji, `.env` jako jediný zdroj |
| NFR‑8 | Spolehlivost nasazení | Smoke test shody SHA běžící binárky s commitem |
| NFR‑9 | Lokalizace | Dvojjazyčné rozhraní (CS/EN) |
| NFR‑10 | Konzistence kódování | UTF‑8 s BOM u exportů (diakritika) |

## 2.3 Rešerše existujících přístupů

Při návrhu byly zvažovány tři principiální přístupy ke sběru telemetrie z Windows stanic:

**(a) Agentní model.** Na každé stanici běží proces, který lokálně sbírá data a odesílá je na server. Výhodou je bohatost dat a funkčnost i mimo doménu; nevýhodou je správa životního cyklu agenta, jeho aktualizace, bezpečnostní povrch a náklady. Tento model používá většina komerčních nástrojů (SCCM klient, Zabbix agent).

**(b) WinRM / PowerShell Remoting.** Vzdálené spouštění příkazů přes WS‑Management. Výhodou je standardizace a šifrování; nevýhodou je, že WinRM **není** ve výchozím stavu na klientských stanicích povolen a jeho plošné zapnutí přes GPO je organizační zásah s bezpečnostními dopady.

**(c) Klasické RPC/DCOM + WMI/CIM.** Vzdálené čtení protokolu událostí (`Get-WinEvent -ComputerName` přes protokol MS‑EVEN6 nad RPC) a dotazy WMI/CIM přes DCOM. Klíčová výhoda: **tyto kanály jsou na doménově připojených strojích Windows dostupné ve výchozím stavu** (port 135 — RPC endpoint mapper, port 445 — SMB). Stačí servisní účet ve správné skupině (např. Event Log Readers, distribuované přes GPO).

ITDashboard zvolil přístup **(c)** jako nejméně invazivní. Doplňkově využívá ICMP ping jako záložní indikátor dosažitelnosti pro stroje, které blokují RPC/SMB, ale odpovídají na ping.

Tato volba má i svá omezení — zejména na zamčených serverech a řadičích domény může servisní účet narazit na chybu `Access is denied` při vytváření CIM session, pokud nemá příslušná DCOM/WMI oprávnění. Tato omezení jsou diskutována v kapitole 12.

### Srovnání s existujícími nástroji

Pro úplnost analýzy uvádíme srovnání ITDashboard s reprezentativními zástupci kategorie. Cílem není tvrdit, že vlastní řešení je obecně lepší — komerční nástroje jsou mnohem mocnější — nýbrž doložit, že pro **úzce vymezený účel** (bezagentní pozorovací vrstva nad jednou doménou) je menší účelové řešení obhajitelné.

| Kritérium | ITDashboard | SCCM / Intune | Zabbix | PRTG | Nagios |
|-----------|-------------|---------------|--------|------|--------|
| Agent na stanici | Ne | Ano | Ano (nebo agentless přes WMI) | Ano/agentless | Obvykle ano (NRPE/NSClient++) |
| Doménová integrace (SSO/Kerberos) | Nativní | Nativní | Omezená | Omezená | Omezená |
| Hesla v konfiguraci | Žádná (Integrated Auth) | Spravované | Ano (DB, SNMP) | Ano | Ano |
| Sběr protokolu událostí | Ano (RPC) | Ano | Ano (agent) | Omezeně | Pluginy |
| Doménově specifické pojmy (kritické služby, OU) | Ano | Částečně | Konfigurovatelné | Konfigurovatelné | Konfigurovatelné |
| Automatická remediace | Ne (záměrně) | Ano | Ano | Omezeně | Ano |
| Cena a složitost nasazení | Nízká | Vysoká | Střední–vysoká | Střední | Střední |
| Přizpůsobitelnost zdroji | Plná (vlastní kód) | Omezená | Skripty/šablony | Šablony | Pluginy |

Z tabulky plyne pozice ITDashboard: **maximálně nízká invazivita a provozní náklad za cenu užšího záběru**. Tam, kde organizace potřebuje plnohodnotnou správu konfigurace, distribuci softwaru nebo plošnou remediaci, je vlastní řešení nedostačující a komerční nástroj je správnou volbou. Tam, kde jde primárně o **přehled, detekci a notifikaci** v jediné doméně, přináší vlastní řešení výhodu jednoduchosti, bezpečnosti (žádný agent, žádné heslo) a plné přizpůsobitelnosti.

### Metodika sběru a její teoretické pozadí

Bezagentní sběr nad protokoly Windows stojí na třech vrstvách komunikace:

1. **Lokátor koncových bodů (Endpoint Mapper, port 135/TCP).** Klient se nejprve dotáže služby RPC Endpoint Mapper, na kterém dynamickém portu naslouchá konkrétní RPC rozhraní (např. EventLog). Proto je dostupnost portu 135 spolehlivým prvním indikátorem, zda má smysl pokračovat.
2. **Vlastní RPC rozhraní.** Pro protokol událostí jde o rozhraní **MS‑EVEN6** (moderní varianta nad starším MS‑EVEN). PowerShell `Get-WinEvent -ComputerName` jej využívá transparentně.
3. **WMI/CIM nad DCOM.** Dotazy `Get-CimInstance` (disky, služby, informace o stroji) procházejí přes DCOM, který opět vychází z RPC. Použití CIM session (`New-CimSession`) namísto starší cesty WMI je voleno pro konzistenci s moderním PowerShell stackem.

Tato volba má důsledky pro **autorizaci**: čtení protokolu událostí vyžaduje členství ve skupině *Event Log Readers* (delegovatelné přes GPO), zatímco WMI/CIM vyžaduje příslušná DCOM a WMI oprávnění (Namespace security). Právě druhá kategorie je na nejpřísněji zabezpečených strojích (řadiče domény) nejčastěji nedostatečná — viz omezení v kapitole 12.

### Analýza rizik návrhu

Každé architektonické rozhodnutí nese rizika, která byla vědomě vážena:

- **Riziko nedostupnosti cílů.** Část parku jsou notebooky s proměnlivou přítomností. Mitigace: fail‑fast TCP sonda, nezávislý plánovač dosažitelnosti, klasifikace stavu místo binárního „online/offline".
- **Riziko zahlcení daty.** Stroj s rozbitou komponentou může generovat tisíce událostí. Mitigace: strop na dávku, deduplikace, denní agregace, tlumené skóre se stropem na typ.
- **Riziko falešných poplachů.** Mnoho služeb legitimně neběží. Mitigace: klasifikace `service_policy`, globální whitelist, per‑stanicové výjimky, debounce a okno údržby.
- **Riziko bezpečnostní eskalace.** Monitorovací systém s plošným dosahem je atraktivní cíl. Mitigace: princip nejmenších oprávnění (jen čtení), „observer, not executor", oddělení čtecí a editační roviny, žádná hesla v konfiguraci.

## 2.4 Provozní omezení a předpoklady

Návrh vychází z následujících předpokladů o prostředí:

- Stroje jsou připojeny do domény Active Directory.
- Existuje doménový servisní účet (referenčně `svc-itdashboard`) s oprávněním ke čtení protokolu událostí a WMI na cílových stanicích.
- Servisní účet je namapován na SQL login s rolí `db_owner` v databázi systému, čímž odpadá nutnost ukládat heslo k databázi (Windows Integrated Authentication).
- Na stanicích běží služby Event Log a WMI (výchozí stav).
- Síťová konektivita umožňuje RPC (135), SMB (445) a volitelně ICMP z aplikačního serveru k cílovým strojům.

Z bezpečnostního hlediska platí zásada **nejmenších oprávnění**: servisní účet má pouze čtecí oprávnění potřebná ke sběru, nikoli administrátorská oprávnění k zásahům. Akce vyžadující administrátorská práva (vzdálená správa, RDP) provádí operátor pod vlastními přihlašovacími údaji prostřednictvím samostatného autentizačního mechanismu (Auth Gate, kapitola 9).

## 2.5 Metodika hodnocení

Vzhledem k povaze systému (silná integrace s živým doménovým prostředím) byla zvolena **kombinace ověřovacích metod** namísto spoléhání na jediný přístup:

- **Verifikace shody s požadavky** — každý funkční požadavek (FR) má identifikovatelnou realizaci v kódu (modul/služba/endpoint), viz tabulka traceability v kapitole 2.6.
- **Statická verifikace** — typová kontrola TypeScriptu ve striktním režimu jako kontinuální brána.
- **Verifikace nasazení** — automatický smoke test shody běžící binárky se zdrojem.
- **Empirická verifikace v provozu** — pozorování chování proti reálným datům parku (~225 strojů), včetně testovacích tlačítek pro jednotlivé agendy alertů.

Jako **kritéria úspěšnosti** byla stanovena: (1) systém získává telemetrii ze strojů bez agenta; (2) detekuje a notifikuje definované třídy problémů; (3) je provozovatelný s minimální obsluhou; (4) je bezpečný dle vrstvového modelu; (5) je přenositelný bez zásahu do kódu. Naplnění těchto kritérií je zhodnoceno v kapitole 14.

## 2.6 Matice trasovatelnosti požadavků

Tabulka mapuje funkční požadavky na jejich realizaci a způsob ověření — slouží jako důkaz pokrytí.

| Požadavek | Realizace (modul) | Ověření |
|-----------|-------------------|---------|
| FR‑1 Inventář z AD | `ad-sync.ts` | Historie `ad_sync_runs`, viditelný inventář |
| FR‑2 Sběr událostí | `eventlog-collector.ts` | `collector_runs`, počty událostí |
| FR‑3 Agregace událostí | `routes/events.ts` | Dashboard dlaždice, časové řady |
| FR‑4 Skóre problémovosti | `/events/pc-health` | Žebříček v UI, propočet (kap. 7.2) |
| FR‑5 Monitoring disků | `disk-collector.ts` | Sloupec disků, dlaždice |
| FR‑6 Diskové alerty | `alerts.ts` | Testovací tlačítko, reálné e‑maily |
| FR‑7 Monitoring služeb | `services-collector.ts` | Záložky Služby / Kritické služby |
| FR‑8 Per‑PC výjimky | `loadDownServices` | Potlačení alertů na DC (NTDS/Kdc) |
| FR‑9 Výkonové události | `perf-collector.ts` | Záložka Výkon |
| FR‑10 Dosažitelnost | `reachability-collector.ts` | Sloupec Stav, dlaždice |
| FR‑11 Port‑checky | `alerts.ts` | Testovací tlačítko |
| FR‑12 E‑maily | `alerts.ts` (nodemailer) | Doručené zprávy |
| FR‑13 Report parku | `reports.ts` | `/reports/overview`, e‑mail |
| FR‑14 Historie přihlášení | `pc_user_history` | Modal historie v UI |
| FR‑15 Auditní záznam | `activity-log.ts` | Záložka Aktivita |
| FR‑16 GUI s filtry/exportem | klient React | Funkční rozhraní, export |
| FR‑17 Akce na stanici | `PcActions` | Spuštění RDP/mmc/… |
| FR‑18 Konfigurace bez restartu | `settings` + `rescheduleChecks` | Změna intervalu za běhu |

---

# Část II — Architektura a datový model

# 3. Architektura systému

## 3.1 Přehled

ITDashboard je realizován jako **monorepo** — jeden repozitář obsahující více vzájemně provázaných balíků. Hlavní členění:

```
ITDashboard/
├── apps/
│   ├── server/        … backend: Fastify API + sběrné služby (Node.js 20, TS)
│   └── desktop/       … klient: Electron + React + Vite (TS)
├── packages/          … sdílené moduly (ad-bridge, credential-vault, …)
├── scripts/           … pomocné PowerShell skripty
├── docs/              … dokumentace (ARCHITECTURE.md, dashboard.html, …)
├── .github/workflows/ … CI/CD pipeline (deploy.yml)
└── apps/server/migrations/  … SQL migrace 001–040
```

Volba monorepa je motivována tím, že server i klient sdílejí doménové pojmy (tvary dat, výčty, terminologii) a jejich společné verzování zjednodušuje nasazení — jeden commit reprezentuje konzistentní stav celého systému.

Logicky je systém **třívrstvý**:

1. **Vrstva sběru (collectors).** Sada služeb běžících v rámci backendu, které periodicky nebo na vyžádání získávají telemetrii z cílových stanic standardními protokoly Windows. Tato vrstva je „aktivní" — sama oslovuje cílové stroje.
2. **Vrstva perzistence a aplikační logiky (API + DB).** Backend Fastify vystavuje REST API, ukládá data do relační databáze MSSQL a obsahuje aplikační logiku (vyhodnocování prahů, skórování, alerting, reporting).
3. **Prezentační vrstva (klient).** Aplikace v Electronu/Reactu, kterou backend zároveň servíruje jako webovou aplikaci (stejný build běží v prohlížeči i jako desktopová aplikace).

## 3.2 Topologie nasazení

Referenční nasazení (konkrétní hodnoty jsou plně konfigurovatelné a v dokumentaci slouží jen jako příklad) má následující topologii:

```
┌───────────────────────────────────────────────┐
│  Pracovní stanice operátora (IT)              │
│  • Prohlížeč → http://<api-host>:4000         │
│  • Desktopový klient (Electron)               │
│  • Protokolové handlery itd-*:// (volitelně)  │
└───────────────────────┬───────────────────────┘
                        │ HTTP(S)
                        ▼
┌───────────────────────────────────────────────┐
│  Aplikační server  (referenčně 10.8.2.213)    │
│  • Node.js 20 + Fastify API, port 4000        │
│  • Windows služba „ITDashboardAPI" (NSSM)     │
│  • Identita: doménový účet svc-itdashboard    │
│  • Servíruje webové UI (apps/desktop/dist)    │
│  • Plánovače: checks / reachability / retention│
│  • Self-hosted GitHub Actions runner           │
└──────────┬──────────────────────────┬─────────┘
           │ TDS (MSSQL)              │ RPC 135 / SMB 445 / ICMP
           ▼                          ▼
┌────────────────────────┐  ┌──────────────────────────────┐
│ SQL Server             │  │ Cílové stanice (~225)        │
│ (referenčně 10.8.2.225)│  │ Windows 10/11/Server         │
│ • Databáze ITDashboard │  │ • Protokoly událostí         │
│ • Windows Integ. Auth  │  │ • Diskový prostor (WMI/CIM)  │
│ • ~18 tabulek          │  │ • Stav služeb (WMI/CIM)      │
└────────────────────────┘  │ • Výkonové události          │
                            │ • Dosažitelnost (TCP/ICMP)   │
                            └──────────────────────────────┘
```

Klíčové vlastnosti topologie:

- **Aplikační server** běží jako služba Windows spravovaná nástrojem NSSM, pod identitou doménového servisního účtu. Naslouchá na `0.0.0.0:4000`.
- **Databáze** běží odděleně; připojení používá Windows Integrated Authentication (Trusted Connection), takže v aplikaci ani konfiguraci není uloženo žádné heslo k databázi.
- **Cílové stanice** jsou oslovovány aktivně sběrnými službami. Před každým spuštěním PowerShellu se provádí rychlá TCP sonda na port 135, aby se neztrácel čas na vypnutých strojích.

## 3.3 Princip bezagentního sběru

Jádrem návrhu je bezagentní sběr. Každá sběrná služba pracuje podle stejného vzoru:

1. **Výběr cílů.** Z databáze se načte množina relevantních strojů (zpravidla `enabled = 1 AND monitor_enabled = 1 AND excluded = 0`).
2. **Fail‑fast sonda.** Pro každý cíl se nejprve provede TCP připojení na port 135 (RPC endpoint mapper) s krátkým timeoutem (2 s). Pokud selže, stroj je považován za nedostupný a PowerShell se vůbec nespouští — to zásadně urychluje běh nad parkem, kde je část strojů vypnutá.
3. **Paralelní sběr.** Dostupné stroje se zpracovávají paralelně s omezenou mírou souběžnosti (`CONCURRENCY = 5` u náročnějších kolektorů, `16` u lehké sondy dosažitelnosti).
4. **Spuštění PowerShellu.** Pro každý stroj se spustí `powershell.exe` se skriptem, který vrací data ve strojově čitelném formátu (s vynuceným kódováním UTF‑8 kvůli diakritice).
5. **Perzistence.** Výsledek se uloží do příslušné tabulky (zpravidla strategií „nahraď snímek pro daný stroj").
6. **Návazné vyhodnocení.** Po dokončení sběru se spustí navázané vyhodnocení alertů (např. po diskovém sběru `evaluateAndSendDiskAlerts`).

Tento jednotný vzor zajišťuje konzistentní chování, odolnost a předvídatelný výkon napříč všemi kolektory.

## 3.4 Technologický zásobník a jeho zdůvodnění

| Vrstva | Technologie | Zdůvodnění volby |
|--------|-------------|------------------|
| Běhové prostředí backendu | Node.js 20 | Asynchronní I/O ideální pro paralelní síťový sběr; snadné spouštění podprocesů (PowerShell). |
| Webový framework | Fastify 4 | Vysoký výkon, nativní podpora schémat a pluginů, nízká režie. |
| Jazyk | TypeScript (ES2022) | Statická typová kontrola jako primární „testovací" brána; sdílené typy mezi serverem a klientem. |
| Databáze | Microsoft SQL Server | Nativní integrace s doménou (Integrated Auth), robustní, již provozovaná v cílovém prostředí. |
| Databázový ovladač | `msnodesqlv8` | Na rozdíl od `tedious` umožňuje Windows Integrated Authentication (SSPI) — bezpečné připojení bez hesla. |
| Validace vstupů | Zod | Deklarativní validace a parsování těl požadavků. |
| E‑mail | Nodemailer | Standardní SMTP klient; M365 Direct Send (STARTTLS, bez autentizace). |
| LDAP | `ldapts` | Ověřování operátorů proti AD (edit tier). |
| Frontend | React 18 + Vite 5 | Komponentní model, rychlý vývojový cyklus, malý produkční bundle. |
| Desktopový obal | Electron 33 | Tentýž kód běží jako desktopová aplikace i webově. |
| Logování | Pino | Strukturované logování s nízkou režií. |

Zásadní architektonické rozhodnutí je volba `msnodesqlv8` namísto čistě JavaScriptového ovladače. Umožňuje totiž připojit se k SQL Serveru pod identitou servisního účtu Windows (SSPI/Kerberos), čímž z celého systému mizí potřeba uchovávat databázové heslo — což je významný bezpečnostní přínos a zároveň zjednodušení provozu.

## 3.5 Klíčové sekvenční toky

Pro pochopení dynamiky systému jsou níže popsány tři reprezentativní toky.

### Tok A — periodický sběr událostí

```
Plánovač (checks-runner)        eventlog-collector        Cílové PC        DB
       │                                │                     │            │
       │ interval vyprší                │                     │            │
       │ a jsme v okně údržby           │                     │            │
       ├──── runChecksOnce() ──────────>│                     │            │
       │                                │ načti cíle ─────────┼───────────>│
       │                                │<── seznam PC ───────┼────────────┤
       │                                │ pro každý cíl (||5):│            │
       │                                │  TCP probe :135 ───>│            │
       │                                │  (selže → skip)     │            │
       │                                │  Get-WinEvent ─────>│            │
       │                                │<── události ────────┤            │
       │                                │  insert (dedup) ────┼───────────>│
       │                                │ update last_collected_at ───────>│
       │                                │ evaluateAndSendServiceAlerts()   │
       │                                │ evaluateAndSendPortAlerts()      │
       │<── výsledek ───────────────────┤                     │            │
       │ logActivity('Checks done')     │                     │            │
```

### Tok B — vyhodnocení a odeslání alertu služby

```
services-collector       alerts.loadDownServices       DB         SMTP (M365)
      │                          │                       │             │
      │ po skenu služeb          │                       │             │
      ├── evaluateAndSendServiceAlerts() ───────────────>│             │
      │                          │ načti down služby ───>│             │
      │                          │  (gate + výjimky +    │             │
      │                          │   whitelist + crit/   │             │
      │                          │   broad rozlišení)    │             │
      │                          │<── kandidáti ─────────┤             │
      │                          │ aktualizuj            │             │
      │                          │ service_alert_state   │             │
      │                          │ (first_down_at) ─────>│             │
      │                          │ pokud v okně údržby → konec         │
      │                          │ filtr debounce+throttle             │
      │                          │ render e-mailu (subjectPrefix)      │
      │                          │ sendMail() ─────────────────────────>│
      │                          │ update last_sent_at ─>│             │
```

### Tok C — kontinuální nasazení

```
git push main → GitHub Actions (self-hosted runner na app serveru)
   │ checkout → setup-node → robocopy zdroje (mimo .env)
   │ npm install → tsc typecheck → build server → build UI
   │ npm run migrate (aplikace nových migrací v transakcích)
   │ sc stop ITDashboardAPI → čekej STOPPED → sc start
   │ smoke test: GET /version/sha == commit SHA  &&  GET / servíruje UI
   └ úspěch (~45 s) / selhání zastaví nasazení
```

## 3.6 Přehled architektonických rozhodnutí

Návrh systému je sumou desítek vědomých rozhodnutí. Nejvýznamnější shrnuje tabulka (mnohá jsou rozvedena v dalších kapitolách):

| Rozhodnutí | Zdůvodnění |
|------------|-----------|
| Bezagentní sběr přes RPC/DCOM | Nulová instalace na cílech, kanály dostupné ve výchozím stavu |
| `Get-WinEvent` přes RPC, ne WinRM | WinRM není na klientech defaultně zapnutý |
| DCOM CIM session pro WMI | Konzistence s moderním PowerShell stackem |
| TCP sonda :135 před spuštěním PS | Fail‑fast pro vypnuté stroje, výrazné zrychlení |
| `msnodesqlv8` (Integrated Auth) | Žádné heslo k DB |
| Konfigurace v DB (`settings`) | Změny za běhu bez restartu |
| Nezávislý plánovač dosažitelnosti | „Stav" je čerstvý 24/7 nezávisle na okně |
| `monitor_enabled` přežívá AD sync | Zachování operátorova záměru |
| Odolnost vůči chybné události | Jeden vadný záznam neshodí celou dávku |
| Tlumené skóre se stropem na typ | Robustní detekce problémových strojů |
| Observer, not executor | Minimalizace bezpečnostního rizika |
| UTF‑8 BOM u exportů | Korektní diakritika v Excelu/editorech |
| Activity log dvouvrstvě | Živý ring buffer + perzistentní DB |
| `sc` + čekání na STOPPED | Spolehlivý restart služby (ne STOP_PENDING) |
| Smoke test shody SHA | Odhalí zaseknutou starou binárku |

---

# 4. Datový model

## 4.1 Přehled schématu

Datový model je relační, realizovaný v MSSQL, a vznikal **evolučně** prostřednictvím 40 očíslovaných migrací (`001_init.sql` až `040_service_exceptions.sql`). Schéma lze rozdělit do tematických skupin:

- **Inventář a telemetrie:** `computers` (centrální registr strojů), `disks`, `pc_user_history`.
- **Události:** `events` (surové záznamy), `event_daily_agg` (denní agregace), `perf_events` (výkonové).
- **Služby:** `service_problems` (snímek problémových služeb), `critical_service_status` (stav kritických služeb v jakémkoli stavu), `service_policy` (klasifikace známého šumu).
- **Stav alertů:** `service_alert_state`, `port_check_state` (sledování výpadků a tlumení).
- **Provozní historie:** `collector_runs`, `ad_sync_runs`, `activity_log`.
- **Konfigurace a rozšiřitelnost:** `settings` (klíč‑hodnota), `scripts`, `script_runs`, `credentials`.
- **Verzování schématu:** `schema_migrations`.

Centrální tabulkou je `computers`, na kterou se přímo či nepřímo váže většina ostatních dat. V průběhu vývoje narostla z původních 7 sloupců na 28 sloupců — každé rozšíření telemetrie nebo monitorovací funkce přidalo příslušné sloupce (např. `reachable` pro dosažitelnost, `service_monitor` a `*_exceptions` pro dvouúrovňové monitorování služeb).

## 4.2 Klíčové tabulky

Úplný datový slovník je v příloze B. Zde uvádíme nejdůležitější tabulky a jejich roli.

### computers

Centrální registr všech strojů. Vzniká a aktualizuje se synchronizací z AD a je obohacován telemetrií ze sběrných služeb. Vybrané skupiny sloupců:

- **Identita a AD:** `id`, `name` (unikátní), `fqdn`, `os_version`, `distinguished_name`, `ou_path`, `enabled` (odráží přítomnost v AD).
- **Provozní stav sběru:** `last_collected_at`, `last_error`, `consecutive_failures`, `last_status` (kategorie: `online`/`offline`/`rpc_unavailable`/`access_denied`/`unknown`).
- **Dosažitelnost:** `reachable`, `last_reachable_at`, `reach_checked_at`.
- **Telemetrie:** `ip_address`, `current_user`, `current_user_seen_at`, `pc_info_collected_at`, `last_seen`.
- **Operátorské příznaky:** `monitor_enabled` (sledovat?), `excluded` (tvrdě vyřadit ze všech statistik).
- **Monitorovací opt‑in:** `disk_email_monitor`, `disk_email_drives` (rozsah disků), `service_email_monitor` (kritické služby), `service_monitor` (široké), `service_exceptions`, `critical_service_exceptions` (per‑PC výjimky).

Důležitým návrhovým rozhodnutím je, že příznak `monitor_enabled` **synchronizace z AD nepřepisuje** — operátorův záměr (např. vyřadit konkrétní stroj z monitoringu) přežije noční synchronizaci. Podobně `excluded` označuje stroje trvale vyřazené ze všech pohledů a statistik.

### events a event_daily_agg

Tabulka `events` uchovává surové záznamy protokolu událostí: `computer_id`, `log_name`, `event_id`, `level` (1 = Critical … 5 = Verbose), `time_created`, `provider_name`, `message`, `raw_xml`. Pro výkon nese clusterovaný index podle `time_created DESC, level` a další pokrývající indexy. **Deduplikace** je řešena unikátním indexem `ux_events_dedup` s `IGNORE_DUP_KEY`, takže opakovaný sběr téže události je idempotentní.

Surová data mají konfigurovatelnou retenci (výchozí 90 dní). Pro dlouhodobé trendy slouží `event_daily_agg` — denní agregace podle (den, stroj, log, ID, úroveň) s počty, která se uchovává **trvale** (řádově menší objem dat).

### service_problems a critical_service_status

Tyto dvě tabulky zachycují stav služeb ze dvou různých úhlů:

- `service_problems` je **snímek problémů** — služby typu Auto, které neběží — který se při každém skenu pro daný stroj kompletně nahradí. Nese bohaté atributy (`start_mode`, `state`, `delayed_start`, `trigger_start`, `per_user_start`, `exit_code`, `service_specific_exit_code`) a vazbu na `service_policy` (`is_compliant`, `policy_id`).
- `critical_service_status` naopak sleduje **konfigurované kritické služby v JAKÉMKOLI stavu** (i běžící) na všech strojích, kde existují. To umožňuje pozitivně potvrdit, že např. NTDS, DNS nebo Veeam skutečně běží, nikoli jen detekovat jejich absenci.

### service_policy

Klasifikační pravidla pro **rozlišení skutečných problémů od šumu**. Mnoho služeb typu Auto legitimně neběží (aktualizátory prohlížečů, ovladače). Tabulka obsahuje vzory (`pattern`), očekávaný režim/stav a prioritu; je předvyplněna 24 pravidly pro běžně „hlučné" služby. Slouží k označení `is_compliant` a k generování remediačního GPO skriptu.

### Stavové tabulky alertů

`service_alert_state` (klíč `computer_id` + `service_name`) a `port_check_state` (klíč `computer_id` + `check_name`) uchovávají časování výpadků: `first_down_at` (kdy výpadek začal — pro debounce) a `last_sent_at` (kdy byl naposledy odeslán alert — pro throttle). `port_check_state` navíc nese `last_ok_at` pro „učení základní linie" (port se stane alertovatelným až po prvním úspěšném spojení).

### settings

Univerzální úložiště konfigurace typu klíč‑hodnota (`key`, `value`, `updated_at`). Veškerá provozní konfigurace — prahy, plány, alerting, retence, seznamy kritických služeb, příjemci e‑mailů — je uložena zde, nikoli v souborech. To umožňuje měnit chování systému za běhu bez restartu (viz kapitola 5.5). Kompletní přehled klíčů je v příloze C.

## 4.3 Migrace a verzování schématu

Schéma se vyvíjí pomocí **dopředných migrací**. Každá migrace je SQL skript s pořadovým číslem a popisným názvem. Aplikace migrací probíhá skriptem `apps/server/src/db/migrate.ts`:

1. Zajistí existenci tabulky `schema_migrations` (evidence aplikovaných migrací).
2. Načte množinu již aplikovaných migrací.
3. Načte všechny `*.sql` z adresáře `migrations/` v lexikografickém pořadí.
4. Pro každou dosud neaplikovanou migraci otevře transakci, provede SQL dávku, zaznamená migraci do `schema_migrations` a potvrdí; při chybě transakci odvolá a skončí s chybou.

Migrace jsou psány **idempotentně a obranně** — používají konstrukce typu `IF COL_LENGTH(...) IS NULL ALTER TABLE …` a `MERGE` pro seedování nastavení, takže opakované spuštění neškodí a seedované hodnoty nikdy nepřepíšou operátorovy úpravy. Aplikace migrací je integrální součástí nasazovací pipeline (kapitola 10).

## 4.4 Konfigurace jako data

Důsledné oddělení konfigurace od kódu je realizováno dvěma mechanismy:

- **Prostředí (`.env`):** infrastrukturní parametry, které musí být známé před připojením k DB — adresa SQL serveru, instance, název databáze, parametry LDAP, port API. Soubor `.env` je vlastnictvím provozovatele, není ve zdrojovém kódu (pouze šablona `.env.example`) a nasazovací pipeline jej výslovně nepřepisuje.
- **Databáze (`settings`):** veškerá ostatní provozní konfigurace. Změny se projeví okamžitě; časově řízené úlohy se přeplánují živě.

Tímto je naplněn nefunkční požadavek NFR‑7 (přenositelnost): zdrojový kód neobsahuje žádné natvrdo zadané IP adresy, hostname ani doménová jména.

## 4.5 Datové vzory: snímek vs. přírůstek vs. stav

Datový model záměrně používá tři odlišné strategie ukládání podle povahy dat:

- **Přírůstkový log (append‑only) s retencí** — tabulka `events`. Data se pouze přidávají (s deduplikací), nikdy nemění; staré záznamy mizí retenční úlohou. Vhodné pro historii událostí, kde nás zajímá vývoj v čase.
- **Snímek (snapshot) nahrazovaný při skenu** — tabulky `service_problems`, `disks`, `critical_service_status`. Při každém skenu se data pro daný stroj kompletně přepíší aktuálním stavem. Vhodné tam, kde nás zajímá *aktuální* stav, ne historie každé změny. Výhodou je jednoduchost a omezený objem; nevýhodou ztráta historie (kterou pro tyto domény nepotřebujeme — nahrazuje ji activity log a alerty).
- **Stavová tabulka (state machine)** — `service_alert_state`, `port_check_state`. Drží minimální stav potřebný pro logiku alertů (kdy výpadek začal, kdy byl naposledy odeslán alert). Řádek vzniká při vzniku problému a zaniká při jeho vyřešení.

Toto rozlišení je klíčové pro pochopení chování systému: např. tabulka `service_problems` nikdy neobsahuje běžící služby (snímek jen problémů), zatímco `critical_service_status` obsahuje i běžící (snímek úplného stavu kritických služeb) — a offline stroj v ní drží **zastaralý (stale)** poslední známý stav, který UI vizuálně odliší.

## 4.6 Strategie indexace a výkon

Nejnáročnější tabulkou je `events` (řádově miliony záznamů). Její indexace je navržena pro tři dominantní dotazovací vzory:

1. **Časově‑úrovňové dotazy** (dashboard: „kolik kritických/chyb za okno") — pokrývá clusterovaný index `(time_created DESC, level)`.
2. **Dotazy podle stroje** (detail stroje, skóre zdraví) — pokrývá `(computer_id, time_created DESC)` s INCLUDE `level, event_id`.
3. **Dotazy podle typu události** (nejčastější ID) — pokrývá `(event_id, time_created DESC)` s INCLUDE `level`.

Deduplikace na úrovni úložiště (`ux_events_dedup` s `IGNORE_DUP_KEY`) přesouvá idempotenci ze sběrné logiky do databáze — opakovaný insert téže události je beztiše ignorován, což zjednodušuje kolektor. Doplňkově běží periodická deduplikace přes uloženou proceduru pro případ, že by se duplicity přesto objevily.

Denní agregace (`event_daily_agg`) je projevem vzoru **materializovaného souhrnu**: dotazy na dlouhodobé trendy by nad surovými daty byly drahé a navíc by narazily na retenci, proto se denně předpočítají kompaktní agregáty, které se uchovávají trvale při řádově menším objemu.

## 4.7 Normalizace a integritní omezení

Schéma je v zásadě ve **třetí normální formě**: `computers` je hlavní entita, ostatní tabulky se na ni vážou cizím klíčem `computer_id`. Záměrné odchylky od přísné normalizace jsou dvě a obě jsou pragmatické:

- **Denormalizovaná telemetrie v `computers`** — sloupce jako `current_user`, `ip_address`, `last_status`, `reachable` jsou aktuální hodnoty uložené přímo u stroje (nikoli ve zvláštní tabulce historie), protože UI je potřebuje číst v jediném dotazu na seznam strojů. Historie uživatelů má naopak vlastní tabulku (`pc_user_history`).
- **Konfigurace jako klíč‑hodnota** (`settings`) — místo silně typovaných sloupců pro každý parametr je zvolen univerzální slovník. To obětuje typovou kontrolu na úrovni DB (vše je `NVARCHAR`) výměnou za flexibilitu (přidání nového nastavení nevyžaduje migraci sloupce, jen seed řádku) a jednotný CRUD.

Unikátní omezení (`computers.name`, `disks(computer_id, drive_letter)`, `service_problems(computer_id, service_name)`) zajišťují konzistenci snímků a umožňují strategii „nahraď" implementovat přes MERGE/UPSERT.

## 4.8 Návrhové zdůvodnění klíčových tabulek

Tato sekce shrnuje, **proč** mají klíčové tabulky právě tuto podobu — což je pro oponenturu podstatnější než pouhý výčet sloupců.

**`computers` jako jediná pravda o stroji.** Veškerá identita, telemetrie i monitorovací příznaky jsou u jedné entity. Alternativou by bylo rozdělit telemetrii do samostatných tabulek (1:1), to by ale zkomplikovalo nejčastější dotaz (seznam strojů s aktuálním stavem) na join mnoha tabulek. Vědomá denormalizace aktuálních hodnot do `computers` optimalizuje právě tento dominantní přístupový vzor; historie, kde je potřeba (uživatelé), má vlastní tabulku.

**`events` odděleně od `event_daily_agg`.** Surová data odpovídají na otázku „co přesně se stalo", agregace na „jak se vyvíjí trend". Mají odlišnou retenci (90 dní vs. trvale), odlišný objem (miliony vs. tisíce) a odlišné dotazovací vzory. Jejich oddělení je klasický vzor **hot/cold** dat: drahá, objemná, krátkodobá vs. levná, kompaktní, dlouhodobá.

**`service_problems` vs. `critical_service_status`.** Zdánlivá duplicita má jasný důvod: první tabulka odpovídá na „co je rozbité" (jen problémy, bohaté atributy pro diagnostiku), druhá na „běží opravdu vše kritické" (úplný stav konfigurované množiny, i běžící služby). Sloučení do jedné tabulky by buď ztratilo pozitivní potvrzení (kdybychom ukládali jen problémy), nebo by neúměrně nafouklo objem (kdybychom ukládali všechny služby všech strojů).

**Stavové tabulky alertů odděleně od dat.** `service_alert_state` a `port_check_state` nesou pouze logiku tlumení (kdy začalo, kdy odesláno). Mít tento stav v hlavních datových tabulkách by mísilo „co je" se „co jsme o tom řekli" — oddělení udržuje datové snímky čisté a logiku alertů soustředěnou.

**`service_policy` jako konfigurovatelná znalost domény.** Klasifikace šumu by mohla být zadrátována v kódu, ale jako tabulka je **rozšiřitelná za provozu** — správce může přidat pravidlo pro novou hlučnou službu bez nasazení. To je projev obecného principu „doménová znalost patří do dat, ne do kódu".

**`activity_log` jako oddělená auditní stopa.** Auditní záznam je záměrně oddělen od provozní historie běhů (`collector_runs`), protože plní jinou roli (auditovatelnost vůči NIS2/ISO 27001) a má vlastní retenci a indexaci pro fulltextové dohledávání.

---

# Část III — Implementace serverové části

# 5. Backend: API a sběrné služby

## 5.1 Inicializace aplikace

Vstupním bodem backendu je `apps/server/src/index.ts`. Aplikace Fastify se vytváří s strukturovaným logováním (Pino) a registruje tři bezpečnostní/komunikační pluginy:

- **`@fastify/helmet`** — bezpečnostní HTTP hlavičky; politika obsahu (CSP) je upravena tak, aby nevynucovala `upgrade-insecure-requests` (TLS terminace je řešena reverzní proxy, ne aplikací).
- **`@fastify/cors`** — povolení cross‑origin požadavků (operátor přistupuje z prohlížeče na jiném původu).
- **`@fastify/cookie`** — správa session cookie pro autentizaci operátorů.

Následuje registrace **18 modulů tras** v pevném pořadí (auth, health, events, computers, scripts, collector, activity, version, settings, disks, firewall, services, perf‑events, actions, retention, alerts, reports, frontend). Trasa frontendu je registrována poslední, protože obsluhuje statické soubory a zachytávací cesty.

Důležitý je **pořádek startu**:

1. **Před nasloucháním** se zavolá `refreshIpGuard('boot')`, který přednačte seznam povolených IP (whitelist) z pravidla Windows Firewallu do paměťové cache. Tím se předejde okénku po restartu, kdy by prázdná cache odmítla všechny požadavky.
2. **Naslouchání** na `API_PORT` (výchozí 4000) a `API_BIND` (výchozí `0.0.0.0`).
3. **Po úspěšném nasouchání** se spustí tři plánovače: `startChecksSchedule()`, `startReachabilitySchedule()`, `startRetentionSchedule()`.

## 5.2 Databázová vrstva

Modul `apps/server/src/db/pool.ts` poskytuje singleton připojovacího poolu (`getPool()`) k MSSQL přes ovladač `msnodesqlv8`. Připojení je konfigurováno jako **trusted** (`trustedConnection: true`) — autentizace probíhá identitou servisního účtu Windows, pod nímž běží služba, nikoli uživatelským jménem a heslem. Pool má parametry max 10 / min 0 spojení a idle timeout 30 s.

Všechny dotazy jsou **parametrizované** (`pool.request().input(name, value).query(sql)`), čímž je eliminováno riziko SQL injection. Uložené procedury se volají přes `.execute(procName)`.

## 5.3 Přehled REST API

API je organizováno do tematických modulů. Úplný referenční přehled je v příloze A; zde uvádíme přehled domén:

| Doména | Vybrané endpointy | Účel |
|--------|-------------------|------|
| Autentizace | `POST /api/auth/session`, `/logout`, `GET /whoami`, `POST /launch-token`, `GET /redeem` | Přihlášení operátora (LDAP), session, jednorázové tokeny pro spouštěče |
| Počítače | `GET /computers`, `POST /computers/sync`, `PATCH /computers/:id/*`, `POST /computers/bulk-flag` | Inventář, synchronizace AD, per‑PC příznaky, hromadné operace |
| Události | `GET /events`, `/events/summary`, `/events/top-ids`, `/events/timeline`, `/events/pc-health` | Dotazy a agregace nad protokoly událostí, skóre zdraví |
| Disky | `GET /disks`, `POST /disks/collect` | Inventář diskového prostoru, ruční sken |
| Služby | `GET /services/problems`, `/services/critical`, `/services/aggregate`, `/services/gpo-script` | Problémové a kritické služby, agregace, remediační skript |
| Výkon | `GET /perf-events`, `/perf-events/summary`, `/top-culprits`, `/top-pcs` | Výkonové události, viníci zpomalení |
| Alerty | `POST /alerts/disk/test`, `/alerts/services/test`, `/alerts/ports/test` | Testovací odeslání jednotlivých agend |
| Reporty | `GET /reports/overview`, `POST /reports/email` | Strukturovaný přehled parku, odeslání e‑mailem |
| Nastavení | `GET /settings`, `PUT /settings` | Čtení a zápis konfigurace (s živým přeplánováním) |
| Firewall | `GET /access-check`, `/firewall/whitelist`, `PUT /firewall/whitelist` | Řízení přístupu, správa IP whitelistu |
| Kolektor | `GET /collector/status`, `POST /collector/run`, `/run-all`, `/stop`, `POST /reachability/run` | Ruční spuštění a sledování sběru |
| Aktivita | `GET /activity/log`, `/activity/history`, `/activity/sources` | Auditní záznam (živý i perzistentní) |
| Údržba | `GET /api/retention/status`, `POST /api/retention/run` | Stav a ruční spuštění retenčních úloh |
| Verze/zdraví | `GET /version`, `/version/sha`, `/health` | Build info (pro smoke test), liveness/readiness |

API kombinuje dvě konvence cest — část pod `/api/*` (autentizace, retence) a část v kořeni (datové endpointy). Validace vstupů je realizována knihovnou Zod přímo v definici tras.

## 5.4 Sběrné služby (kolektory)

Backend obsahuje pět hlavních sběrných služeb plus pomocné. Všechny dodržují vzor popsaný v kapitole 3.3.

### ad-sync — synchronizace inventáře

Služba `ad-sync.ts` (`syncComputersFromAD`) spustí PowerShell s `Get-ADComputer` a načte všechny počítače z AD: jméno, DNS jméno, OS, datum posledního přihlášení, příznak povolení a `DistinguishedName`. DN se převede na čitelnou OU cestu. Data se strategií **MERGE** zapíší do tabulky `computers`:

- **shoda podle jména:** aktualizují se atributy z AD (FQDN, OS, OU, …), ale **nedotčen zůstane** `monitor_enabled`;
- **nový stroj:** vloží se s `monitor_enabled` podle nastavení `adsync.default_monitor_enabled`;
- **chybějící v AD:** označí se `enabled = 0` (zakázán, nikoli smazán).

Každý běh se eviduje v `ad_sync_runs` (počty fetched/inserted/updated/removed) a zaloguje do activity logu.

### eventlog-collector — protokoly událostí

Služba `eventlog-collector.ts` (`runCollectorOnce`) sbírá události přes `Get-WinEvent -ComputerName` (protokol MS‑EVEN6 nad RPC, nikoli WinRM). Servisní účet musí být ve skupině **Event Log Readers** na cílových strojích (distribuováno přes GPO).

Klíčové vlastnosti:

- **Inkrementální sběr:** od `last_collected_at`, při studeném startu za posledních 24 h.
- **Strop na dávku:** `MAX_EVENTS_PER_PC_PER_RUN = 500` brání zahlcení od „ukecaných" strojů.
- **Odolnost vůči chybným událostem:** pokud se jediná událost nepodaří vykreslit (Windows vrátí placeholder `%1`), neshodí to celou dávku — chyba se izoluje a zbytek událostí se sebere. (Tato oprava reálně zvýšila počet úspěšně sbíraných strojů.)
- **Řízení selhání:** po 10 po sobě jdoucích selháních se stroj dočasně přeskakuje, uloží se `last_error` a inkrementuje `consecutive_failures`; úspěch čítač vynuluje.
- **Sledování postupu a přerušení:** běh poskytuje průběžný stav (`/collector/status`) a lze jej zrušit (`/collector/stop`) přes AbortController.
- **Návazné alerty:** po sběru se spustí `evaluateAndSendServiceAlerts` a `evaluateAndSendPortAlerts`.

### disk-collector — diskový prostor a info o PC

Služba `disk-collector.ts` přes `Get-CimInstance Win32_LogicalDisk` (jen pevné disky) sbírá kapacitu a volné místo. Při téže relaci sbírá i **informace o stroji**: primární IPv4 adresu a interaktivně přihlášeného uživatele (`Win32_ComputerSystem.UserName`). Uživatel se ukládá jen při nenulové hodnotě (přežívá výpadky) a do historie `pc_user_history`. Po sběru se spouští diskové alerty.

### services-collector — stav služeb

Služba `services-collector.ts` přes WMI/CIM (`Win32_Service`) produkuje dva výstupy: (1) **problémy** — služby Auto, které neběží, doplněné o příznaky z registru (delayed/trigger start) a o klasifikaci proti `service_policy`; (2) **kritické služby** — konfigurované kritické služby v jakémkoli stavu. Služby specifické pro uživatelskou relaci (vzor `_[a-f0-9]{4,12}$`) se odfiltrují.

### perf-collector — výkonové události

Služba `perf-collector.ts` čte kanál *Microsoft‑Windows‑Diagnostics‑Performance/Operational* a klasifikuje události podle rozsahu ID na kategorie boot (100–199), shutdown (200–299), standby (300–399), resume (400–499). Extrahuje celkový čas, dobu degradace a viníka (proces/služba/ovladač). Studený start má konfigurovatelné okno (`perf.cold_start_days`, výchozí 30 dní). Na serverových edicích bývá kanál vypnutý.

### reachability-collector — síťová dosažitelnost

Služba `reachability-collector.ts` běží na **vlastním nezávislém plánovači** (výchozí interval 300 s), odděleně od ostatního sběru — díky tomu zůstává sloupec „Stav" v UI aktuální nepřetržitě (24/7), nezávisle na pracovním okně. Sonduje TCP porty (výchozí 135 a 445), a pokud selžou, použije záložní **ICMP ping** (pro stroje, které blokují RPC/SMB, ale odpovídají na ping). Souběžnost je vyšší (16), protože sonda je levná. Výsledek (`reachable`, `reach_checked_at`) se ukládá do `computers`.

## 5.5 Plánovač a okno údržby

Modul `checks-runner.ts` orchestruje periodický sběr. Při startu serveru se podle `checks.interval_sec` (výchozí 900 s) nastaví interval, který volá běh kontrol — ovšem jen **uvnitř konfigurovaného okna**:

- `checks.days` — dny v týdnu (výchozí Po–Pá),
- `checks.window_start` / `checks.window_end` — časové okno (výchozí 06:00–18:00, podpora přechodu přes půlnoc).

Každý druh kontroly lze nezávisle zapnout (`checks.run_eventlog`, `run_disk`, `run_services`, `run_perf`, `run_adsync`, `run_reachability`). Kontroly běží **sekvenčně** (AD sync první, aby ostatní kolektory viděly čerstvý inventář). Pokud je některý kolektor právě v běhu, deduplikuje se (nespustí se podruhé).

Zásadní vlastností je **živé přeplánování**: změna `checks.interval_sec` přes `PUT /settings` okamžitě zruší starý interval a nastaví nový (`rescheduleChecks`), bez nutnosti restartu služby. To naplňuje NFR a usnadňuje provoz.

## 5.6 Retence a údržba dat

Modul `retention-runner.ts` provádí denní údržbu databáze v konfigurovanou hodinu (`retention.run_at_hour`, výchozí 2:00) — nezávisle na pracovním okně, neboť jde o údržbu, ne o uživatelskou činnost. Volá uložené procedury pro:

- purgování starých událostí (`events.retention_days`, výchozí 90),
- purgování starého activity logu (`activity.retention_days`, výchozí 30),
- purgování staré historie uživatelů (`pcUserHistory.retention_days`, výchozí 90),
- deduplikaci událostí v rámci okna (`events.dedup_lookback_days`).

Úlohu lze spustit i ručně (`POST /api/retention/run`) s volbou konkrétních kroků. Surová data mají retenci, denní agregace (`event_daily_agg`) se uchovávají trvale.

## 5.7 Model souběžnosti a odolnosti sběru

Sběr nad parkem ~225 strojů má dvě protichůdné potřeby: být dostatečně rychlý (sériový sběr by trval neúnosně dlouho) a zároveň nezahltit aplikační server ani síť stovkami souběžných PowerShell procesů. Řešením je **omezená souběžnost (bounded concurrency)**:

- Náročnější kolektory (události, disky, služby, výkon) běží s `CONCURRENCY = 5` — v každém okamžiku se zpracovává nejvýše 5 strojů, ostatní čekají ve frontě.
- Lehká sonda dosažitelnosti běží s `CONCURRENCY = 16`, protože jde jen o TCP/ICMP bez spuštění PowerShellu.

Každý kolektor je chráněn **příznakem „již běží" (in‑flight)**, takže se nikdy nespustí dvě instance téhož sběru souběžně (ať už z plánovače, nebo z ručního spuštění) — druhý pokus se beztiše deduplikuje a vrátí `null`.

Odolnost je řešena na třech úrovních:

1. **Úroveň události** — vykreslení jediné události může selhat (Windows vrátí placeholder `%1`, pokud chybí resource DLL poskytovatele). Taková událost se přeskočí, ale dávka pokračuje. Před opravou tohoto chování shazovala jediná nevykreslitelná událost celý sběr ze stroje.
2. **Úroveň stroje** — selhání sběru z jednoho stroje (timeout, odmítnutí, chyba PS) neovlivní ostatní; zaznamená se `last_error`, inkrementuje `consecutive_failures`, a po překročení prahu (10) se stroj dočasně přeskakuje, aby neplýtval časem každého běhu.
3. **Úroveň běhu** — i kdyby selhalo více strojů, běh se dokončí, vrátí souhrn (kolik OK / kolik selhalo) a zaloguje se do `collector_runs` i activity logu.

## 5.8 Taxonomie chyb a klasifikace stavu

Systém nerozlišuje jen „dostupný/nedostupný", ale klasifikuje výsledek sběru do kategorií, které mají pro operátora různý význam a vedou k různé reakci:

| `last_status` | Význam | Typická příčina | Reakce |
|---------------|--------|-----------------|--------|
| `online` | Sběr proběhl | — | Žádná |
| `offline` | Stroj neodpovídá na síti | Vypnutý, odpojený | Počkat / ověřit fyzicky |
| `rpc_unavailable` | Odpovídá, ale RPC nedostupné | Firewall, služby vypnuté | Ověřit konfiguraci stroje |
| `access_denied` | RPC dostupné, ale chybí oprávnění | Servisní účet nemá práva | Delegace oprávnění (GPO) |
| `unknown` | Neklasifikovatelné selhání | Různé | Diagnostika z `last_error` |

Toto rozlišení je důležité zejména kvůli kategorii `access_denied`, která odhaluje **infrastrukturní**, nikoli softwarový problém — typicky na řadičích domény a zamčených serverech (viz kapitola 12). Sloupec „Stav" v UI navíc vedle `Active` zobrazuje sekundární indikátor `⚠ logs`, pokud je stroj sice dosažitelný, ale jeho protokol událostí se nedaří číst — odlišuje tak síťovou dostupnost od úspěšnosti sběru.

## 5.9 Obohacení o informace o stroji a historii uživatelů

Diskový kolektor při téže relaci sbírá i metadata stroje: primární IPv4 adresu (filtruje neroutovatelné rozsahy 0.x, 127.x, 169.254.x) a interaktivně přihlášeného uživatele (`Win32_ComputerSystem.UserName`). Tato data plní dvojí účel:

- **Aktuální stav** v tabulce `computers` (IP a uživatel jsou viditelné v seznamu) — uživatel se přepisuje jen při nenulové hodnotě, takže informace „kdo tu naposledy byl" přežije odhlášení.
- **Historie** v tabulce `pc_user_history` — sleduje distinktní uživatele na stroji v čase (s IP v době první observace). To má hodnotu zejména u sdílených stanic a roamujících notebooků pro audit „kdo se kdy odkud přihlašoval".

## 5.10 Klasifikace služeb a generování remediace

Surová data o službách obsahují mnoho **legitimního šumu** — služby typu Auto, které neběží, ale jejichž zastavení je v pořádku (aktualizátory, ovladače aktivované jen při potřebě, služby spouštěné triggerem). Bez klasifikace by seznam „problémů" byl zaplaven falešně pozitivními záznamy.

Klasifikace probíhá ve dvou vrstvách:

1. **Strukturální příznaky** detekované při sběru: `trigger_start` (služba se spouští jen na trigger, ne trvale), `delayed_start` (zpožděný automatický start — krátce po zastavení je v pořádku), `per_user_start` (per‑uživatelská služba se vzorem `_[a-f0-9]{4,12}$`, která legitimně stojí bez přihlášeného uživatele), `exit_code` (nulový = pokojné zastavení, nenulový = skutečný pád).
2. **Politiková pravidla** (`service_policy`) — tabulka vzorů s očekávaným režimem/stavem a prioritou, předvyplněná 24 pravidly pro běžně hlučné služby (Google/Dropbox/Intel/Lenovo aktualizátory s nízkou prioritou) i pro kritickou infrastrukturu (s vyšší prioritou). Každý problém se proti pravidlům porovná a označí `is_compliant` + `policy_id`.

Uživatelské rozhraní pak ve výchozím stavu skrývá pokojná zastavení a šum a zvýrazňuje **skutečné pády** (nenulový exit‑code). Z politikových pravidel s definovaným očekávaným režimem lze navíc vygenerovat **GPO remediační skript** (`GET /services/gpo-script`) — PowerShell, který nastaví očekávané režimy spuštění služeb plošně přes startup skript GPO. To je v souladu s filozofií „observer, not executor": systém remediaci **negeneruje a neaplikuje sám**, pouze připraví skript, který správce vědomě nasadí standardním doménovým mechanismem.

## 5.11 Sonda dosažitelnosti — návrhové detaily

Sonda dosažitelnosti je záměrně oddělena od ostatního sběru, protože plní jiný účel: udržovat **aktuální obraz o tom, které stroje jsou právě teď na síti**, nezávisle na tom, zda se zrovna sbírají události.

Klíčová rozhodnutí:

- **Vlastní plánovač.** Sonda běží na vlastním intervalu (výchozí 300 s) mimo pracovní okno periodických kontrol — sloupec „Stav" v UI je tak čerstvý nepřetržitě 24/7, i v noci a o víkendu, kdy ostatní sběr neběží.
- **Dvojí metoda.** Primárně TCP připojení na konfigurované porty (výchozí 135 a 445 — první, který odpoví, znamená „dosažitelný"). Pokud oba selžou, použije se **záložní ICMP ping** — pro stroje, které blokují RPC/SMB, ale na ping odpovídají (typické u zpevněných serverů). Záloha je zapínatelná (`reachability.ping`).
- **Vyšší souběžnost.** Protože sonda nespouští PowerShell (jen TCP socket / ping), zvládne souběžnost 16 a proběhne nad celým parkem rychle.
- **Záběr.** Sonduje všechny povolené, nevyřazené stroje **nezávisle** na `monitor_enabled` — i nemonitorovaný stroj má smysl vidět jako (ne)dostupný.
- **Potlačení šumu v logu.** Pokud se počet dosažitelných strojů oproti minulému běhu nezměnil, identický log „N/M online" se nezaznamenává, aby se activity log nezahlcoval.

Výsledek (`reachable`, `last_reachable_at`, `reach_checked_at`) řídí jak sloupec „Stav" (Disabled/Active/Offline), tak rozlišení „živý vs. zastaralý" v matici kritických služeb a v reportu.

## 5.12 Analytické endpointy nad událostmi

Hodnota systému nespočívá jen ve sběru, ale v **agregaci** surových událostí do srozumitelných ukazatelů. Backend nabízí sadu analytických endpointů, jejichž výpočet probíhá v databázi (SQL agregace nad indexy), aby klient přenášel jen výsledky:

- **`/events/summary`** — počty kritických / chybových / varovných událostí v konfigurovaném okně (`events.summary_window_days`). Pohání tři hlavní dlaždice dashboardu. Okno je laditelné (24 h až několik dní), aby si správce mohl zvolit citlivost.
- **`/events/timeline`** — hodinová časová řada počtů podle úrovně. Vizualizuje, kdy se problémy kumulují (např. ranní špička při startech stanic).
- **`/events/top-ids`** — nejčastější trojice (poskytovatel, ID, úroveň) s počty. Odpovídá na „co se opakuje nejvíc" — vstup pro cílenou nápravu.
- **`/events/top-computers`** — stroje s nejvyšším počtem událostí, rozpadem podle úrovně. Rychlá identifikace „kdo nejvíc chybuje".
- **`/events/pc-health`** — skóre problémovosti (kap. 7). Nejnáročnější dotaz (14denní okno, agregace podle stroje a typu), proto běží na klientovi na vlastní pomalejší kadenci (5 min).

Tyto endpointy ilustrují obecný princip **„agregace na serveru, vykreslení na klientovi"**: veškerá náročná práce probíhá v databázi nad pokrývajícími indexy, klient je tenký. To minimalizuje přenos dat (dashboard každých 30 s přenáší kompaktní souhrny, ne tisíce surových událostí) a centralizuje logiku.

## 5.13 Strategie životního cyklu dat

Data systému mají různou hodnotu v čase, čemuž odpovídá diferencovaná retence:

| Data | Retence | Zdůvodnění |
|------|---------|-----------|
| Surové události | 90 dní (konfig.) | Forenzní okno; objemná, drahá |
| Denní agregace | Trvale | Trendy; kompaktní |
| Snímky služeb/disků | Jen aktuální | Zajímá nás stav, ne historie |
| Stav kritických služeb | Jen aktuální (vč. stale) | Pozitivní potvrzení běhu |
| Activity log | 30 dní (konfig.) | Auditní okno |
| Historie uživatelů | 90 dní (konfig.) | Audit přihlášení |
| Historie běhů | Trvale | Provozní dohledatelnost |

Retenční úloha běží denně mimo pracovní okno a kombinuje purgování s deduplikací. Diferenciace retence je projevem **vědomého řízení objemu dat** — nejdražší data (surové události) mají nejkratší retenci, zatímco levné agregáty a auditní historie přežívají dlouhodobě.

---

# 6. Alerting a notifikace

## 6.1 Model upozorňování

Všechny e‑mailové agendy (disky, služby, porty) sdílejí robustní model, který má za cíl **upozornit včas, ale neotravovat**:

- **Debounce (ochrana proti flapování):** problém musí trvat alespoň stanovenou dobu, než se odešle první upozornění (u služeb `alerts.services.debounce_minutes`, výchozí 10 min). Tím se potlačí krátkodobé výpadky např. při noční instalaci aktualizací.
- **Throttle (omezení frekvence připomínek):** zatímco problém trvá, připomínka se posílá nejvýše jednou za stanovený interval (`*.frequency_hours`, výchozí 24 h).
- **Hranová detekce:** první výskyt problému se odešle ihned; po vyřešení se stav resetuje, takže příští incident opět upozorní bez prodlení.
- **Okno údržby:** volitelné `HH:MM‑HH:MM` (`alerts.services.maintenance_window`), během něhož se alerty potlačí (podpora přechodu přes půlnoc).
- **Globální whitelist:** seznam služeb, na které se nikdy neupozorňuje, sdílený s pohledem v UI.

Stav výpadků (kdy začal, kdy byl naposledy odeslán alert) se uchovává ve stavových tabulkách (`service_alert_state`, `port_check_state`).

## 6.2 Disková agenda

Po každém diskovém skenu se vyhodnotí monitorované disky (`disk_email_monitor = 1`) proti prahům. Rozsah disků lze omezit per‑stroj (`disk_email_drives`, např. `C,F` nebo s vylučovací syntaxí `<>C`). Prahy jsou konfigurovatelné procentuálně i absolutně (`disk.critical_pct`, `disk.critical_gb`, režim `disk.threshold_mode`). Alert je throttlován `alerts.disk.frequency_hours`. E‑mail je vykreslen jako HTML s vloženými styly (kompatibilita s Outlookem i mobilními klienty) a barevnými kartami pro každý kritický disk.

## 6.3 Služby — dvě úrovně a per‑stanicové výjimky

Monitorování služeb je realizováno ve **dvou nezávislých úrovních**, obě jako per‑stanicový opt‑in s vlastním seznamem výjimek (analogie per‑PC rozsahu disků):

- **Široká úroveň „Služby"** (`service_monitor`): hlídá *všechny* služby typu Auto, které neběží, **kromě** kritických (ty patří druhé úrovni), minus globální whitelist, minus per‑PC `service_exceptions`.
- **Úzká úroveň „Kritické služby"** (`service_email_monitor`): hlídá pouze služby z globálního seznamu `alerts.services.critical_names` (NTDS, DNS, Kdc, Veeam, …), minus per‑PC `critical_service_exceptions`.

Společná funkce `loadDownServices(settings, { gate, exceptionsCol, critical })` parametrizuje obě úrovně: `gate` určuje opt‑in sloupec, `exceptionsCol` per‑PC výjimky a `critical` to, zda se reportují jen kritické názvy, nebo naopak všechny kromě kritických. **Pravidlo proti duplicitě:** kritická služba se nikdy nereportuje oběma úrovněmi — široká úroveň kritické názvy explicitně přeskakuje.

Per‑stanicové výjimky řeší reálný provozní problém: na degradovaném (demoted) řadiči domény jsou služby NTDS/Kdc legitimně zastavené; operátor je přidá do výjimek dané stanice a přestanou generovat falešné alerty, aniž by se přestaly hlídat na ostatních strojích.

Výsledný e‑mail spojuje obě úrovně (kritické první), každá karta je barevně a odznakem odlišena.

## 6.4 Port‑checky

Doplňková agenda (`port_check_state`) sonduje zvenčí TCP dostupnost infrastrukturních portů (výchozí `LDAP:389, SMB:445, RDP:3389, Kerberos:88, DNS:53`). Používá **učení základní linie** — port se stane alertovatelným až po prvním úspěšném spojení (aby se nealertovalo na služby, které na daném stroji nikdy neběžely). Sdílí debounce, okno údržby a throttle se servisní agendou.

## 6.5 E‑mailový transport (M365 Direct Send)

Odesílání e‑mailů zajišťuje Nodemailer. Cílové prostředí používá **Microsoft 365 Direct Send**: připojení na MX hostitele organizace na portu 25 s oportunistickým STARTTLS, **bez autentizace**, s odesílatelem z vlastní domény. Veškerá konfigurace (`alerts.smtp_host`, `alerts.smtp_port`, `alerts.smtp_from`) je v nastavení, nikoli v `.env`.

Příjemci jsou řešeni **per‑agenda s fallbackem**: každá agenda (disky/služby/porty/reporty) může mít vlastní seznam (`alerts.disk.recipients` atd.); je‑li prázdný, použije se sdílený `alerts.recipients`.

## 6.6 Strukturovaný report a strojově čitelné subjekty

Kromě reaktivních alertů systém generuje **strukturovaný přehledový report** parku (servery vs. PC, offline stroje s dobou výpadku, stav sběru). Report lze poslat z klienta pro právě vyfiltrovanou množinu strojů; sdílí jeden generátor s e‑mailovou podobou, takže UI a e‑mail nikdy nedivergují.

Důležitým provozním prvkem je **strojově čitelné označení stavu v předmětu** každého reportu i alertu, navržené tak, aby na něm šlo postavit automatické třídění pošty:

- `[OK]` vs. `[CHYBA]` — nese zpráva problém? (cíl pravidla pro automatický přesun bezchybných zpráv do složky)
- `[RUČNĚ]` — zpráva byla spuštěna ručně (test / na vyžádání); automatická ji nemá.

Přehledový report navíc obsahuje vizuální stavový proužek (zelený/červený) a v patičce rozlišení ručního a automatického odeslání.

## 6.7 Vykreslování HTML e‑mailů

Tvorba e‑mailů, které se korektně zobrazí napříč klienty (Outlook desktop, Outlook Web, Gmail, mobilní klienti), je netriviální disciplína s vlastními omezeními:

- **Žádné externí CSS, žádné `<style>` bloky** (mnoho klientů je odstraní) — veškeré styly jsou **vloženy inline** u každého elementu.
- **Layout pomocí tabulek**, nikoli moderního CSS (flexbox/grid nejsou spolehlivě podporovány). Karty jednotlivých problémů jsou tabulkové bloky, které se na úzké obrazovce přirozeně skládají pod sebe.
- **Vizualizace bez obrázků** — např. pruh zaplnění disku je realizován dvěma buňkami tabulky s barevným pozadím (červená = zabráno, světlá = volno), takže nepotřebuje externí zdroje, které klienti blokují.
- **Sanitizace vstupů** — všechny dynamické hodnoty (jména strojů, služeb) procházejí funkcí `escHtml` (escapování `& < > "`), aby nemohlo dojít k rozbití struktury ani k injektáži.
- **Textová alternativa** — každý e‑mail nese i `text/plain` variantu pro klienty bez HTML a pro lepší doručitelnost.

Render je parametrizovaný příznakem testu/ručního spuštění (přidá informační banner a token `[RUČNĚ]`) a barevně rozlišuje stav (zelená hlavička „vše v pořádku" vs. červená „problém"). Servisní alert navíc barevně i odznakem odlišuje kritické služby (červená) od širších (oranžová) — viz kapitola 6.3.

## 6.8 Vyhodnocení diskových prahů

Vyhodnocení diskového prostoru je propracovanější, než se na první pohled zdá, protože systémový a datový disk mají odlišnou citlivost:

- Prahy lze zadat **procentuálně** (`disk.critical_pct`, `disk.warning_pct`) i **absolutně v GB** (`disk.critical_gb`, `disk.warning_gb`); režim `disk.threshold_mode` určuje, zda se použije procento, absolutní hodnota, nebo „kterékoli z obou" (varování, pokud je překročen kterýkoli práh).
- **Rozsah disků** je dvouúrovňový: kritický práh se vyhodnocuje proti jedné množině písmen (typicky systémový disk `C`), varovný proti jiné (typicky datové disky). Rozsah lze zadat výčtem (`C,D`) nebo vylučovací syntaxí (`<>C` = „vše kromě C", `!C`).
- **Per‑stanicový rozsah** (`disk_email_drives`) přebíjí globální nastavení — operátor může pro konkrétní stroj hlídat jen vybrané disky.
- Disky mimo oba rozsahy se v UI **zobrazují** (pro situační přehled), ale **neovlivňují stav** stroje ani nealertují.

Tato pružnost řeší reálné situace: systémový disk se hlídá přísně (zaplnění ohrozí běh OS), zatímco u velkých datových svazků je relevantní spíše absolutní rezerva v GB než procento.

---

# 7. Detekce problémových stanic

Jedním z původních konceptů systému je **skóre problémovosti stanice** (faulty/problem‑PC score), které z protokolů událostí identifikuje stroje, jež je vhodné prověřit nebo reinstalovat. Cílem je převést „šum" tisíců událostí na jediné srovnatelné číslo.

## 7.1 Tlumený mix (damped blend)

Naivní přístup — prostý součet chyb — selhává, protože jeden „ukecaný" zdroj (jediná opakující se chyba) by stroj vyhnal na vrchol žebříčku, aniž by to znamenalo skutečný problém. Skóre proto kombinuje čtyři složky s **tlumením**:

1. **Vážený počet se stropem na typ.** Pro každý distinktní typ události (kombinace poskytovatel + ID + úroveň) se započítá nejvýše `faulty.signature_cap` (výchozí 20) výskytů, vynásobených váhou podle úrovně: kritická ×`weight_critical` (10), chyba ×`weight_error` (3), varování ×`weight_warning` (1). Strop brání tomu, aby jeden zdroj skóre nafoukl.
2. **Šíře (breadth).** Bonus `weight_breadth` (5) za každý distinktní chybový/kritický typ — větší rozmanitost problémů je horší signál než jeden opakující se.
3. **Perzistence.** Bonus `weight_persistence` (3) za každý distinktní den s chybami v okně — problém táhnoucí se více dní je závažnější než jednorázový.
4. **Okno.** Vše se počítá v okně `faulty.window_days` (výchozí 14 dní).

Výsledné skóre se porovnává se dvěma prahy: `faulty.threshold_watch` (sledovat) a `faulty.threshold_risk` (riziko, kandidát na reinstalaci). Prahy byly **kalibrovány na živých datech** (migrace 034 je zvýšila z původních 60/150 na 400/600), aby žebříček odpovídal reálnému rozložení parku (řádově desítky strojů ve „watch", jednotky v „risk").

Všechny váhy a prahy jsou konfigurovatelné v nastavení, takže model lze doladit bez zásahu do kódu. V uživatelském rozhraní je výpočet vysvětlen v nápovědě a buňky skóre prokliknou na filtrované události daného stroje.

## 7.2 Ilustrativní propočet skóre

Pro názornost uveďme dva hypotetické stroje s odlišným profilem chyb v okně 14 dní (výchozí váhy: kritická 10, chyba 3, varování 1, strop na typ 20, šíře 5, perzistence 3).

**Stroj A — jeden ukecaný zdroj.** Stroj opakuje tutéž chybu (jeden poskytovatel + ID, úroveň „chyba") 5 000×, jinak je v pořádku. Bez stropu by naivní součet byl 5 000 × 3 = 15 000. Se **stropem na typ** se však započítá nejvýše 20 výskytů: 20 × 3 = 60. Šíře = 1 distinktní typ → 5. Perzistence = řekněme 14 dní → 14 × 3 = 42. **Skóre ≈ 60 + 5 + 42 = 107.** Pod prahem „watch" (400) — správně, jde o jeden otravný, ale izolovaný problém.

**Stroj B — rozpadající se systém.** Stroj generuje rozmanité chyby: 15 distinktních chybových typů (každý ~30×, tj. po stropu 20×3=60) a 3 kritické typy (každý ~10×, po stropu 10×10=100 — strop se neuplatní, je pod ním), napříč 12 dny.
- Vážený počet (se stropem): 15 typů × 60 + 3 typy × 100 = 900 + 300 = 1 200.
- Šíře: 18 distinktních chybových/kritických typů × 5 = 90.
- Perzistence: 12 dní × 3 = 36.
- **Skóre ≈ 1 200 + 90 + 36 = 1 326.** Vysoko nad prahem „risk" (600) — správně, jde o systémově problémový stroj, kandidát na reinstalaci.

Příklad ilustruje, proč jsou všechny tři tlumicí mechanismy nutné: **strop** brání dominanci jednoho zdroje, **šíře** odměňuje rozmanitost problémů (horší signál), **perzistence** odměňuje vytrvalost v čase. Teprve jejich kombinace dává robustní pořadí, které odpovídá intuici správce.

## 7.3 Kalibrace na živých datech

Prahy byly původně nastaveny konzervativně (watch 60 / risk 150), ale reálná data z parku ukázala, že při daných váhách produkují příliš mnoho strojů v kategorii „risk". Migrace 034 prahy rekalibrovala na 400 / 600 tak, aby kategorie odpovídaly užitečnému rozlišení (řádově desítky strojů ve „watch", jednotky v „risk"). Tato zkušenost ilustruje **iterativní povahu skórovacích heuristik** — model je nutné ladit proti realitě, a proto jsou všechny parametry vyvedeny do konfigurace, nikoli zadrátovány v kódu.

---

# Část IV — Klientská část

# 8. Desktopová a webová aplikace

## 8.1 Architektura klienta

Klient je implementován v **Reactu 18** se sestavovacím nástrojem **Vite 5** a zabalen do **Electronu 33**. Stejný produkční build (`apps/desktop/dist`) je zároveň servírován backendem jako webová aplikace — operátor tak může používat buď nativní desktopovou aplikaci, nebo přistupovat prohlížečem na `http://<api-host>:4000/`. Webová varianta používá relativní URL; desktopová varianta má cílové API zapečené přes `VITE_API_BASE` v době sestavení.

Aplikace je jednostránková (SPA). Komunikace s backendem je soustředěna do typovaného klienta `api.ts` (pomocné funkce `jget`/`jpost`), který vrací silně typované struktury sdílené napříč komponentami.

## 8.2 Navigace a stránky

Hlavní obrazovka (`App.tsx`) obsahuje horní lištu s přepínáním osmi pohledů:

| Záložka | Obsah |
|---------|-------|
| **Přehled (Dashboard)** | Souhrnné dlaždice, skóre problémových PC, rozpad podle OS |
| **Události** | Tabulka událostí s filtry (stroj, úroveň, ID, poskytovatel, okno), detail |
| **Počítače** | Kompletní inventář s filtry, per‑PC příznaky, hromadné operace, export, report e‑mailem |
| **Služby** | Problémové služby (po PC / agregovaně), filtry exit‑code, whitelist, GPO skript |
| **Kritické služby** | Matice kritických služeb × stroje, skutečný stav, filtr „jen mimo Running" |
| **Výkon** | Pomalé starty/vypnutí, viníci, nejhorší stroje |
| **Aktivita** | Auditní záznam (živý ring buffer i perzistentní historie) |
| **Nastavení** | Plán kontrol, prahy, e‑mail/SMTP, alerty, retence, firewall, skórování |

Mezi záložkami existuje **provázaná navigace (drill‑down)**: kliknutí na dlaždici nebo na jméno stroje přepne na příslušnou záložku s předvyplněným filtrem (např. dlaždice „Offline" → Počítače filtrované na nedostupné; jméno stroje kdekoli → Počítače s předvyplněným hledáním).

Data se obnovují ve **dvou kadencích**: hlavní dashboard každých 30 s, náročnější 14denní výpočet skóre zdraví na vlastní pomalejší kadenci (5 min).

## 8.3 Dashboard a barevné kódování závažnosti

Dashboard tvoří sada **dlaždic** (komponenta `SummaryCards`), z nichž každá ukazuje jednu metriku (kritické/chybové/varovné události, nedostupné stroje, kritické/varovné disky, sledované disky a služby, zastavené služby, kritické služby, pomalý boot, neaktivní PC, počet počítačů). 

Klíčovým UX prvkem je, že **barva čísla dlaždice odráží závažnost**: je‑li hodnota nulová (žádný problém), číslo je zelené; teprve při výskytu problému zčervená (kritické metriky) nebo zoranžoví (varovné metriky). Stavy načítání zůstávají neutrální. Tím operátor jediným pohledem rozezná, kde je problém, aniž by musel číst čísla.

Komponenta `HealthCards` zobrazuje dlaždici „PC v problémech" se skórem z kapitoly 7; po rozkliknutí se rozbalí tabulka rizikových strojů. Komponenta `OsBreakdownChart` ukazuje rozpad parku podle normalizovaných kategorií OS s rozlišením živých a zastaralých (stale) záznamů a prokliem do filtrovaných Počítačů.

Úplný katalog dlaždic dashboardu a jejich proklikové cíle:

| Dlaždice | Metrika | Barva | Proklik na |
|----------|---------|-------|------------|
| Kritické / Chyby / Varování (okno) | Počty událostí podle úrovně | dle hodnoty | Filtrované Události |
| Nedostupné | Monitorované selhávající stroje (rozpad offline/RPC/auth/jiné) | červená/zelená | Počítače (selhávající) |
| Disk kritický | Stroje a disky pod kritickým prahem | červená/zelená | Počítače (disk kritický) |
| Disk varování | Stroje a disky pod varovným prahem | oranžová/zelená | Počítače (disk varování) |
| 📧 Sledované disky | Poměr kritických/sledovaných | dle hodnoty | Počítače (📧 disk) |
| 🔔 Sledované služby | Poměr postižených/sledovaných | dle hodnoty | Počítače (🔔 služby) |
| Zastavené služby | Stroje s problémovými službami | oranžová/zelená | Záložka Služby |
| 🛡 Kritické služby | Počet mimo Running / poměr OK | červená/zelená | Záložka Kritické služby |
| Pomalý boot/shutdown | Postižené stroje / události | oranžová/zelená | Záložka Výkon |
| Neaktivní PC (Nd+) | Neaktivní povolené/zakázané | oranžová/zelená | Počítače (neaktivní) |
| Počítače | Povolené / celkem | neutrální | Záložka Počítače |
| 🩺 PC v problémech | Stroje nad prahem „risk" | červená/zelená | Rozbalovací tabulka |
| 📊 Operační systémy | Počet kategorií OS | neutrální | Rozbalovací graf |

Barevné kódování (zelená při nule, červená/oranžová při výskytu) převádí celý dashboard na **přehled stavu jediným pohledem** — operátor okamžitě vidí, zda je vše v pořádku (převaha zelené), nebo kde se objevil problém.

## 8.4 Lokalizace (i18n)

Rozhraní je **dvojjazyčné (čeština / angličtina)**. Lokalizace je řešena slovníkovým přístupem v `i18n.tsx`: jeden objekt se dvěma jazykovými variantami, typový klíč `TKey` odvozený z klíčů slovníku (kompilátor tak hlídá existenci každého použitého klíče), hook `useI18n()` poskytuje funkci `t(key, vars?)` s interpolací proměnných. Tentýž mechanismus zajišťuje i přepínání motivu (světlý/tmavý).

## 8.5 Export a akce na stanicích

Komponenta `ExportMenu` umožňuje export tabulek do **CSV, TSV a HTML**. Všechny textové exporty nesou **UTF‑8 BOM**, aby Excel i editory s výchozím ANSI kódováním na české Windows správně zobrazily diakritiku (jinak vzniká mojibake).

Komponenta `PcActions` nabízí akce na vzdálené stanici (Computer Management, Services, Event Viewer, Task Scheduler, RDP, PowerShell Remote, PsExec, přístup k admin sdílením). Tyto akce se spouštějí přes volitelné **URL protokolové handlery** (`itd-mmc://`, `itd-rdp://`, …) registrované v uživatelském profilu; alternativou je kopírování do schránky nebo stažení dávkového souboru. Akce vyžadující administrátorská práva běží pod přihlašovacími údaji operátora získanými přes Auth Gate (kapitola 9), nikoli pod servisním účtem — v souladu s principem nejmenších oprávnění a oddělením rolí.

## 8.6 Podrobný průchod záložkami

### Záložka Události

Tabulka událostí (`EventsTable`) je nejbohatší filtrovací plocha v aplikaci. Operátor kombinuje:

- **fulltextové hledání** v textu zprávy, jménu stroje, ID a poskytovateli;
- **výběr stroje** a **poskytovatele** (rozbalovací seznamy plněné z dat);
- **filtr ID událostí** s flexibilní syntaxí — jednotlivé `4098`, rozsah `4000..8000` nebo `4000-8000`, výčet `1001,4098,7031`; neplatný vstup zvýrazní pole červeně;
- **úroveň** (kritická/chyba/varování) a **časové okno** (hodiny).

Kliknutí na řádek otevře detail s úplným textem a surovým XML, kliknutí na hlavičku sloupce řadí. Tabulka je tak použitelná i pro ad‑hoc forenzní analýzu („ukaž mi všechny chyby DNS klienta za posledních 48 h na řadičích").

### Záložka Počítače

Centrální pracovní plocha správce. Kromě inventáře nese **per‑stanicové ovládací prvky** přímo ve sloupcích: přepínač sledování, vyřazení, diskové monitorování s rozsahem disků, a dva sloupce služeb (široké/kritické) s poli výjimek. Hlavičky sloupců nesou hromadné přepínače (✓ vše / ✗ nic), které působí na **právě zobrazené (vyfiltrované) řádky** — konzistentní model „platí na to, co vidíš".

Stavové „čipy" nad tabulkou fungují jako rychlé filtry (aktivní, monitorované, selhávající, offline, disk kritický/varování, e‑mailově sledované, neaktivní, zakázané, vyřazené). Akční řádek nabízí synchronizaci z AD, ruční diskový sken, **odeslání strukturovaného reportu e‑mailem** pro zobrazené stroje a export. Sloupec disků (`DisksCell`) vizualizuje zaplnění barevnými pruhy s dvouúrovňovým rozsahem (kritický práh proti systémovému disku, varovný proti datovým).

### Záložka Služby

Dva pohledy: **po stroji** (plochý seznam problémů) a **po službě** (agregace napříč parkem). Filtry odrážejí doménovou znalost: ve výchozím stavu jsou skryté služby s nulovým exit‑code (graceful zastavení), trigger‑start a per‑uživatelské služby a globálně whitelistované — zobrazují se tedy primárně **skutečné pády** (nenulový exit‑code se zvýrazní). Záložka umožňuje stáhnout vygenerovaný **GPO remediační skript** z klasifikačních pravidel.

### Záložka Kritické služby

Matice konfigurovaných kritických služeb × stroje, zobrazující **skutečný stav v jakémkoli stavu** (nejen když služba stojí). Slouží k pozitivnímu ověření, že NTDS, DNS, Kdc, Veeam apod. skutečně běží na všech strojích, kde mají běžet. Offline stroje drží poslední známý (zastaralý) stav, vizuálně odlišený. Filtr „jen mimo Running" rychle ukáže odchylky.

### Záložka Výkon

Přehled pomalých startů a vypnutí z kanálu Diagnostics‑Performance: souhrnné počty podle kategorie, seznam událostí s viníkem a dobou degradace, **nejčastější příčiny** (top culprits) a **nejpomalejší stroje** (top PCs). Pomáhá zodpovědět „proč některé stanice startují minuty".

### Záložka Aktivita

Auditní záznam ve dvou režimech: **živý** (paměťový ring buffer posledních 500 záznamů, dotazovaný každé 2 s) a **historický** (perzistentní tabulka `activity_log` s filtry podle úrovně, zdroje, časového rozsahu a fulltextu, stránkovaný). Barvy úrovní (info/varování/chyba/úspěch) usnadňují orientaci. Tato záložka je přímým naplněním požadavku na auditovatelnost (NFR‑6, soulad s NIS2/ISO 27001).

### Záložka Nastavení

Veškerá konfigurace v jednom místě, členěná do sekcí: plán kontrol, samostatná sekce **Nastavení e‑mailu (SMTP)** sdílená všemi agendami, dále jednotlivé agendy (diskové alerty, servisní alerty, port‑checky, reporting) každá se svým zapnutím a vlastním přepisem příjemců, dále sonda dosažitelnosti, prahy skórování, retence, firewall. Změny se ukládají do DB a projeví se živě; uložení vyšle událost, na kterou se zbytek aplikace přeplní bez plného obnovení.

## 8.7 Vzory správy stavu a provázané navigace

Klient používá několik opakujících se vzorů:

- **Předfiltry s jednorázovou spotřebou.** Když dlaždice na dashboardu přepne na záložku Počítače s filtrem, předává se „předfiltr", který se po aplikaci spotřebuje (`onFilterConsumed`), aby se po další navigaci znovu neaplikoval.
- **Vzájemně výlučné filtry.** Stavové čipy a OS drill‑down se vzájemně vylučují — výběr jednoho zruší druhý, aby čísla vždy odpovídala jednomu mentálnímu modelu.
- **Dvourychlostní obnova.** Lehká data se obnovují každých 30 s, náročný 14denní výpočet skóre na vlastní 5minutové kadenci.
- **Jeden generátor pro UI i e‑mail.** Strukturovaný report sdílí jeden generátor mezi obrazovkou a e‑mailem, takže obě podoby nikdy nedivergují.

---

# Část V — Provoz, bezpečnost, nasazení

# 9. Bezpečnostní model

Bezpečnost systému je řešena ve více vrstvách, s důsledným oddělením **čtecí** (read tier) a **editační/akční** (edit tier) roviny.

## 9.1 Vrstvy řízení přístupu

1. **IP whitelist (UX brána).** Přístup k UI je omezen seznamem povolených IP/CIDR, který je zrcadlen do pravidla Windows Firewallu a zároveň držen v paměťové cache aplikace (endpoint `/access-check`). Jde o pohodlnou první vrstvu, nikoli o bezpečnostní hranici — tou je firewall sám.
2. **LDAP autentizace operátora (edit tier).** Akce měnící stav nebo přistupující k citlivým funkcím vyžadují přihlášení operátora ověřené **bindem proti Active Directory** (`ldapts`). Vytvoří se session (cookie, 8 h max).
3. **Členství v AD skupině.** Editační oprávnění jsou navíc podmíněna členstvím ve vyhrazené AD skupině (`AD_EDIT_GROUP`) — ne každý ověřený uživatel smí editovat.

## 9.2 Auth Gate a jednorázové tokeny

Pro akce na vzdálených stanicích (RDP, mmc, PsExec) je navržen **Auth Gate** — serverem zprostředkovaná úschova přihlašovacích údajů s krátkou platností (30 min nečinnosti / max. 8 h). Spouštění konkrétní akce probíhá přes **jednorázový token** (`POST /api/auth/launch-token` → `GET /api/auth/redeem`), který spouštěč na straně operátora vymění za údaje potřebné k autentizaci vůči Windows. Cílový hostname je validován přísnou regulární maskou (alfanumerické znaky, tečka, pomlčka, podtržítko, max. 63 znaků), aby se zabránilo injektáži do konzolových příkazů.

## 9.3 Žádná hesla v konfiguraci

Dvě klíčová rozhodnutí minimalizují plochu pro únik tajemství:

- **K databázi** se systém připojuje pod identitou servisního účtu Windows (Integrated Authentication) — v aplikaci ani konfiguraci tedy **není žádné databázové heslo**.
- **Citlivé údaje** (pokud jsou potřeba) jsou ukládány šifrovaně (DPAPI, sloupec `encrypted_blob` typu `VARBINARY` neprůhledný pro SQL).

## 9.4 Princip „pozorovatel, nikoli vykonavatel"

Zásadní bezpečnostní (a provozní) filozofií je, že **systém sám neprovádí žádné automatické zásahy** do cílových stanic. Sbírá, vyhodnocuje a upozorňuje, ale neremediuje. Jakákoli změna (restart služby, vzdálená správa) je vědomá akce operátora pod jeho vlastní identitou. Tím se dramaticky zmenšuje riziko: kompromitace monitorovacího systému neumožní plošný destruktivní zásah, protože servisní účet má pouze čtecí oprávnění.

## 9.5 Soulad s NIS2 a ISO/IEC 27001

Systém přispívá k naplnění několika kontrol:

- **Asset management** (inventář aktiv) — aktuální přehled všech doménových strojů, jejich OS a stavu.
- **Logging a monitoring** — sběr a analýza protokolů událostí, detekce anomálií, perzistentní auditní záznam činnosti systému (`activity_log`).
- **Řízení přístupu** — vícevrstvé řízení přístupu (IP, LDAP, AD skupina).
- **Detekce a reakce** — včasné upozornění na výpadky kritických služeb a kapacitní problémy.

Je třeba zdůraznit, že ITDashboard **není** nástrojem zajišťujícím soulad s NIS2 či ISO/IEC 27001 jako celkem — soulad je organizační záležitost přesahující jediný systém. ITDashboard je **dílčím technickým opatřením**, které přispívá k naplnění konkrétních kontrol (správa aktiv, logování a monitoring, auditovatelnost, řízení přístupu). Jeho hodnota v tomto kontextu spočívá zejména v tom, že poskytuje **prokazatelný a auditovatelný** přehled o stavu infrastruktury — schopnost doložit „víme, jaká zařízení provozujeme a v jakém jsou stavu" je sama o sobě požadovanou kontrolou. Perzistentní activity log navíc poskytuje stopu o činnosti samotného monitorovacího systému, což je relevantní pro princip „kdo, kdy, co" při auditu.

## 9.6 Modelování hrozeb (STRIDE)

Pro systematické zhodnocení bezpečnosti je vhodné použít metodiku **STRIDE**, která člení hrozby do šesti kategorií. Tabulka mapuje relevantní hrozby na opatření v ITDashboard:

| Kategorie | Hrozba | Opatření v systému |
|-----------|--------|---------------------|
| **S**poofing (podvržení identity) | Útočník se vydává za operátora | LDAP bind proti AD, session cookie (httpOnly, sameSite=strict), členství v AD skupině pro edit |
| **T**ampering (manipulace) | Změna dat za přenosu nebo v úložišti | Parametrizované dotazy (anti‑SQL‑injection), validace vstupů (Zod), volitelná TLS terminace na proxy |
| **R**epudiation (popření) | Operátor popře provedenou akci | Perzistentní activity log (kdo, kdy, odkud — IP), logování vytvoření session a tokenů |
| **I**nformation disclosure (únik informací) | Únik citlivých dat | Žádné heslo k DB (Integrated Auth), DPAPI pro úschovu údajů, IP whitelist, princip nejmenších oprávnění |
| **D**enial of service (odepření služby) | Zahlcení sběrem nebo dotazy | Omezená souběžnost, strop na dávku, fail‑fast sonda, indexace náročných dotazů |
| **E**levation of privilege (eskalace) | Získání vyšších práv přes systém | „Observer, not executor" (jen čtení), oddělení čtecí/editační roviny, akce pod identitou operátora, ne servisního účtu |

Nejvýznamnějším opatřením proti eskalaci je **architektonické omezení dosahu**: i kdyby byl monitorovací systém plně kompromitován, servisní účet, pod nímž běží, má pouze čtecí oprávnění na cílových strojích. Útočník by získal přehled, ale nikoli schopnost plošného destruktivního zásahu. Tato vlastnost je přímým důsledkem filozofie „pozorovatel, nikoli vykonavatel" a je hlavním bezpečnostním argumentem celého návrhu.

## 9.7 Doplňková zpevnění (hardening)

Nad rámec základních vrstev byla implementována řada zpevnění:

- **Failover více řadičů domény.** LDAP bind i AD dotazy zkoušejí více řadičů domény, takže výpadek jednoho DC neznemožní přihlášení ani synchronizaci.
- **Ochrana proti injektáži do konzole.** Hodnoty vkládané do spouštěných příkazů (hostname cílů) procházejí přísnou validací (whitelist znaků), čímž se brání injektáži ANSI escape sekvencí nebo argumentů.
- **Ochrana produkčního prostředí.** Testovací „stub" režim LDAP (umožňující vývoj bez reálné domény) je v produkci (`NODE_ENV=production`) odmítnut, aby nemohlo dojít k neúmyslnému obejití autentizace.
- **Jednorázové tokeny s krátkou platností** pro spouštěče akcí — token nelze použít opakovaně ani po vypršení.
- **Vyloučení `.env` z nasazení** — operátorská konfigurace na běhovém hostiteli se při nasazení nepřepisuje.
- **Bezpečnostní HTTP hlavičky** přes Helmet (CSP, atd.).

## 9.8 Životní cyklus Auth Gate

Akce na vzdálené stanici (RDP, mmc, PsExec) vyžadují administrátorská oprávnění, která **nemá** servisní účet (ten jen čte). Tato oprávnění poskytuje operátor pod vlastní identitou prostřednictvím mechanismu **Auth Gate**:

```
1. Operátor se přihlásí (LDAP bind) → session (cookie, max 8 h, idle 30 min)
2. Operátor zvolí akci na stroji → klient žádá POST /api/auth/launch-token
   { target: "B-S-W-DC-01", tool: "rdp" }
3. Server ověří session + skupinu, vytvoří jednorázový token s krátkou platností
   → { token, expiresAt }
4. Spouštěč na straně operátora (URL handler itd-rdp://…) předá token zpět:
   GET /api/auth/redeem?token=…
5. Server token ověří, jednorázově zneplatní a vrátí údaje potřebné k autentizaci
   vůči Windows (uživatel/heslo z úschovy), cíl a nástroj
6. Spouštěč zahájí RDP/mmc/PsExec pod identitou operátora
```

Bezpečnostní vlastnosti tohoto toku:

- **Jednorázovost a krátká platnost tokenu** — token nelze použít opakovaně ani po vypršení; minimalizuje okno zneužití.
- **Validace cíle** — `target` musí projít přísnou maskou (alfanumerické znaky, tečka, pomlčka, podtržítko, max. 63 znaků), `tool` je z uzavřeného výčtu — brání injektáži do konzolových příkazů.
- **Úschova s časovým omezením** — přihlašovací údaje operátora jsou drženy serverem jen po dobu relace (30 min nečinnosti / max. 8 h), nikoli trvale.
- **Oddělení identit** — sběr běží pod servisním účtem (jen čtení), akce pod operátorem (s jeho právy a auditní stopou). Kompromitace monitorovací roviny tedy neposkytuje administrátorská práva.

Tento návrh je praktickou realizací oddělení **read tier** a **edit/action tier** zmíněného v kapitole 9.1.

---

# 10. Nasazení a CI/CD

## 10.1 Pipeline kontinuálního nasazení

Nasazení je plně automatizováno přes **GitHub Actions self‑hosted runner** běžící přímo na aplikačním serveru. Spouštěčem je `push` do větve `main`. Pipeline (`deploy.yml`) provede tyto kroky:

1. **Checkout** revize.
2. **Setup Node.js** (verze 20).
3. **Sync zdroje** do běhového umístění (`robocopy /MIR`, s vyloučením `node_modules` a operátorského `.env`).
4. **Instalace závislostí** (`npm install`).
5. **Typecheck** (`tsc --noEmit`) — statická typová kontrola jako brána kvality.
6. **Build serveru** a **build webového UI**.
7. **Aplikace DB migrací** (`npm run migrate`).
8. **Restart služby** `ITDashboardAPI` (`sc stop` s čekáním na úplný stav STOPPED, poté `sc start`).
9. **Smoke test** shody SHA.

Celý cyklus trvá řádově ~45 sekund.

## 10.2 Ověření shody nasazené binárky

Klíčovým prvkem spolehlivosti nasazení je **smoke test, který ověřuje, že běžící binárka odpovídá nasazované revizi**. Při sestavení se skriptem `build-info.mjs` zapečou do kódu konstanty s commit SHA a větví (zdrojem je `GITHUB_SHA`, protože běhový strom je `robocopy`‑ovaná kopie bez `.git`). Endpoint `GET /version/sha` tuto hodnotu vystavuje. Smoke test po restartu opakovaně dotazuje tento endpoint a porovnává jej s commitem, který deploy spustil; navíc ověřuje, že kořen `/` servíruje webové UI. Při neshodě nebo chybějícím UI job selže — což odhalí zaseknutou starou binárku nebo chybějící build frontendu.

## 10.3 Konfigurace a přenositelnost

Pipeline striktně odděluje kód od konfigurace. Soubor `.env` na běhovém hostiteli je vlastnictvím provozovatele a `robocopy` jej výslovně vyjímá (`/XF .env`). Infrastrukturní proměnné pro migrace (adresa SQL, instance, databáze) pocházejí z proměnných repozitáře. Zdrojový kód neobsahuje žádné natvrdo zadané hodnoty prostředí — systém je tak přenositelný do jiné domény pouze úpravou `.env` a nastavení, bez zásahu do kódu.

## 10.4 Mechanika kritických kroků

Některé kroky pipeline mají netriviální mechaniku, která vznikla z provozní zkušenosti:

- **Synchronizace zdroje (`robocopy /MIR`).** Zrcadlí pracovní strom do běhového umístění, ale vyjímá `node_modules`, diagnostické adresáře a zejména `.env`. Běhové umístění je tedy „čistá" kopie repozitáře bez `.git` — proto se commit SHA nezískává za běhu z Gitu, ale **zapéká při sestavení** (viz 10.2).
- **Restart služby s čekáním na úplný stav STOPPED.** Naivní `net stop` se vrací již ve stavu `STOP_PENDING`, takže následný start může selhat na dosud běžícím procesu. Pipeline proto používá `sc stop` a poté **aktivně čeká dotazováním `sc query`, dokud služba není plně ve stavu STOPPED**, teprve pak `sc start`. Tím se eliminuje třída chyb „služba nešla nastartovat".
- **Oprávnění k restartu.** Servisnímu účtu je explicitně uděleno právo zastavit/spustit vlastní službu (`sc sdset`), aby restart v pipeline proběhl bez administrátorské eskalace.
- **Shell `cmd`, ne PowerShell.** V doménách s politikou `AllSigned` by nepodepsané skripty PowerShellu neběžely; pipeline proto používá `cmd`.

## 10.5 Odolnost nasazení a návrat

Spolehlivost nasazení stojí na třech pojistkách:

1. **Typecheck jako brána.** Selhání typové kontroly zastaví nasazení dříve, než se cokoli změní na produkci.
2. **Migrace v transakcích.** Každá migrace běží v transakci; chyba ji odvolá a nasazení skončí — schéma nezůstane v polovičním stavu.
3. **Smoke test po restartu.** Ověří, že běžící binárka odpovídá nasazovanému commitu a že se servíruje UI. Při neshodě job selže a problém je okamžitě viditelný.

**Návrat (rollback)** je díky modelu „nasazení = stav Gitu" jednoduchý: revert commitu nebo nové nasazení předchozí revize projde toutéž pipeline. Protože migrace jsou dopředné, případný návrat schématu by vyžadoval samostatnou migraci (v praxi se řeší dopředu — migrace jsou aditivní a obranné, takže starší kód s novějším schématem zpravidla funguje).

---

# 11. Testování a ověřování kvality

Strategie zajištění kvality stojí na několika pilířích, přizpůsobených povaze systému (silná integrace s živým doménovým prostředím, kde klasické jednotkové testy mají omezenou výpovědní hodnotu):

- **Statická typová kontrola jako primární brána.** TypeScript ve striktním režimu (`strict: true`, `noUncheckedIndexedAccess`) zachytí velkou třídu chyb v době kompilace. `tsc --noEmit` je povinným krokem jak lokálně před každým pushem, tak v nasazovací pipeline — neúspěšný typecheck nasazení zastaví.
- **Smoke test po nasazení.** Automatické ověření, že běžící systém odpovídá zdroji a servíruje UI (kapitola 10.2).
- **Endpoint zdraví.** `GET /health` měří latenci DB a slouží jako liveness/readiness sonda.
- **Manuální verifikace v reálném prostředí.** Vzhledem k tomu, že chování závisí na živé doméně (oprávnění, dostupnost strojů, reálná telemetrie), je řada funkcí ověřována přímo proti produkčním datům — s ručními testovacími tlačítky pro alerty (které posílají reálný stav, ale obcházejí throttle a okno údržby).
- **Idempotentní a obranné migrace.** Migrace jsou psány tak, aby opakované spuštění neškodilo a aby nepřepsaly operátorskou konfiguraci.

Tato strategie reflektuje pragmatickou realitu: pro systém tohoto typu přináší nejvyšší hodnotu kombinace silného typového systému, ověření shody nasazení a verifikace proti reálnému prostředí, spíše než rozsáhlá sada jednotkových testů nad kódem, jehož podstatou je interakce s externími systémy.

## 11.5 Metodika vývoje a kontinuální integrace

Vývoj systému se řídí několika zásadami, které přispívají k jeho kvalitě a udržitelnosti:

- **Commit po logických celcích.** Změny se commitují v souvislých, samostatně srozumitelných celcích s popisnou zprávou; každý commit reprezentuje konzistentní stav.
- **Hlavní větev je nasaditelná.** Push do `main` spouští nasazení, proto se před pushem lokálně ověřuje typová kontrola (server) a build (klient). Hlavní větev je vždy ve stavu schopném nasazení.
- **Konfigurace, ne kód.** Nové parametry chování se přidávají jako konfigurační klíče (seedované migrací), nikoli jako konstanty v kódu — laditelné za provozu bez nasazení.
- **Migrace jako jediná cesta změny schématu.** Žádné ruční zásahy do produkčního schématu; vše prochází verzovanými, transakčními, idempotentními migracemi.
- **Dokumentace jako součást dodávky.** Uživatelská dokumentace (`/docs`), architektonický popis a provozní deník (handoff) se udržují souběžně s kódem.
- **Zviditelnění stavu.** Verze běžícího systému je vždy dohledatelná (`/version`), průběh sběru sledovatelný (`/collector/status`), činnost auditovaná (activity log). Systém je „pozorovatelný" nejen navenek, ale i sám vůči sobě.

Tato kultura — malé ověřené změny, automatické nasazení s kontrolou, konfigurace v datech, vše auditovatelné — je sama o sobě faktorem spolehlivosti srovnatelným s formálním testováním.

---

# 12. Výkon a škálování

## 12.1 Charakteristika zátěže

Zátěž systému má tři odlišné profily:

1. **Sběr (write‑heavy, dávkový).** Periodicky se z desítek strojů paralelně načítají a vkládají události. Dominantní operací je hromadný insert do `events` (s deduplikací) a přepis snímků služeb/disků.
2. **Dotazování dashboardu (read‑heavy, periodické).** Každých 30 s klient žádá souhrny, časové řady a seznam strojů. Dotazy jsou agregační nad oknem (24 h až 14 dní).
3. **Ad‑hoc dotazy (read, nárazové).** Filtrování událostí, detail stroje, skóre zdraví.

## 12.2 Úzká hrdla a jejich ošetření

| Potenciální úzké hrdlo | Ošetření |
|------------------------|----------|
| Sériový sběr nad 225 stroji | Omezená souběžnost (5–16), fail‑fast sonda |
| Spouštění PowerShellu na mrtvý stroj | TCP sonda :135 s 2s timeoutem před spuštěním |
| Zahlcení tabulky `events` | Strop na dávku (500/PC/běh), retence 90 dní, dedup |
| Drahé agregační dotazy | Pokrývající indexy, denní materializované agregáty |
| Náročné skóre zdraví (14 dní) | Vlastní pomalejší kadence (5 min), oddělená od dashboardu |
| Souběžné instance sběru | In‑flight deduplikace |

## 12.3 Škálovatelnost

Systém je navržen pro řádově stovky strojů (cílově ~225). Klíčové škálovací parametry jsou konfigurovatelné:

- **Souběžnost sběru** lze zvýšit, pokud to aplikační server i síť unesou.
- **Interval kontrol** a **pracovní okno** umožňují rozložit zátěž (např. sběr jen v pracovní době).
- **Retence** udržuje objem dat v mezích.

Při výrazně větším parku (tisíce strojů) by bylo nutné zvážit horizontální rozdělení sběru (více sběrných uzlů), případně přechod na agentní model pro stroje mimo dosah RPC. Pro cílový rozsah je však jednouzlový bezagentní model dostatečný a jeho jednoduchost je předností.

## 12.4 Spotřeba zdrojů

Aplikační server hostí Node.js proces (API + plánovače) a během sběru krátkodobě sadu PowerShell podprocesů (max. dle souběžnosti). Databáze je hlavním nositelem stavu; její velikost roste primárně s tabulkou `events`, jejíž růst je ohraničen retencí a deduplikací. Klient (webový i desktopový) je tenký — veškerá agregace probíhá na serveru, klient jen vykresluje.

---

# 13. Provoz a údržba

## 13.1 Provozní model

Systém je navržen pro **provoz s minimální obsluhou**. Po prvotním nastavení (kapitola 10, příloha o instalaci) běží sběr i údržba automaticky:

- periodické kontroly podle plánu,
- nezávislá sonda dosažitelnosti 24/7,
- denní retenční údržba databáze,
- automatické nasazení změn přes CI/CD.

Operátor zasahuje pouze při reakci na alerty nebo při cílené diagnostice.

## 13.2 Pozorovatelnost samotného systému

Systém poskytuje vhled do vlastního chování několika kanály:

- **Activity log** (živý i historický) zaznamenává každý významný krok (běhy sběru, synchronizace, odeslané alerty, změny nastavení).
- **Historie běhů** (`collector_runs`, `ad_sync_runs`) eviduje výsledky každého sběru a synchronizace.
- **Endpoint `/health`** poskytuje liveness/readiness včetně latence DB pro externí monitoring.
- **Endpoint `/version`** a smoke test zajišťují, že je vždy zřejmé, jaká revize běží.
- **Stav kolektoru** (`/collector/status`) ukazuje průběh právě běžícího sběru.

## 13.3 Zálohování a obnova

Veškerý perzistentní stav je v databázi MSSQL, takže strategie zálohování systému je totožná se zálohováním této databáze (mimo rozsah tohoto dokumentu, řešeno na úrovni SQL serveru). Aplikační server je **bezstavový** — jeho běhové umístění je `robocopy`‑ovaná kopie repozitáře a při ztrátě se obnoví novým nasazením z Gitu. Konfigurace prostředí (`.env`) je jediný soubor, který je třeba zálohovat zvlášť.

## 13.4 Typické provozní scénáře

- **Nová stanice v doméně** → automaticky se objeví při nejbližší AD synchronizaci, ve výchozím stavu sledovaná.
- **Stanice vyřazena z provozu** → zmizí z AD, při synchronizaci se označí jako zakázaná (nemaže se, historie zůstává).
- **Falešné alerty z legitimně zastavené služby** → operátor přidá službu do per‑stanicových výjimek nebo globálního whitelistu.
- **Plánovaná odstávka** → nastaví se okno údržby, během něhož se alerty potlačí.
- **Diagnostika problémové stanice** → skóre zdraví → proklik na události → detail → akce na stroji.

---

# Část VI — Zhodnocení

# 14. Diskuse, omezení a budoucí práce

## 14.1 Zhodnocení dosažených cílů

Systém naplňuje stanovené funkční i nefunkční cíle. Pro průkaznost je zhodnotíme jednotlivě.

**Funkční cíle (C1–C8):**

- **C1 (inventář z AD)** — splněno: synchronizace MERGE udržuje aktuální obraz parku s telemetrií, operátorův záměr (monitor/exclude) přežívá synchronizaci.
- **C2 (analýza událostí)** — splněno: sběr přes RPC, agregace, časové řady, top‑ID, top‑stroje, skóre problémovosti.
- **C3 (disky)** — splněno: dvouúrovňové prahy (procentuální i absolutní), per‑stanicový rozsah, alerty.
- **C4 (služby ve dvou úrovních)** — splněno: široká a kritická úroveň s per‑stanicovými výjimkami a pravidlem proti duplicitě.
- **C5 (výkonové události)** — splněno s výhradou: na klientech plně, na serverech omezeno vypnutým kanálem (infrastrukturní, ne softwarové omezení).
- **C6 (dosažitelnost)** — splněno: nezávislý plánovač, TCP + ICMP, klasifikace stavu.
- **C7 (notifikace a reporty)** — splněno: tři alertovací agendy + strukturovaný report, vše se strojově čitelným označením stavu.
- **C8 (GUI)** — splněno: osm záložek, filtry, vyhledávání, export, provázaná navigace, dvojjazyčnost.

**Kvalitativní cíle (K1–K6):**

- **K1 (bezagentnost)** — splněno: žádný software na cílech, výhradně standardní protokoly.
- **K2 (bezpečnost)** — splněno: třívrstvé řízení přístupu, princip nejmenších oprávnění, threat model (kap. 9.6).
- **K3 (auditovatelnost)** — splněno: perzistentní activity log + provozní historie.
- **K4 (přenositelnost)** — splněno: žádné natvrdo zadané hodnoty, `.env` + nastavení jako jediné konfigurační plochy.
- **K5 (spolehlivost nasazení)** — splněno: smoke test shody SHA, migrace v transakcích, typecheck jako brána.
- **K6 (observer, not executor)** — splněno: žádné automatické zásahy, remediace jen jako vědomě nasazovaný skript.

Souhrnně lze konstatovat, že systém naplňuje **všechna stanovená kritéria úspěšnosti** (kap. 2.5); jediné dílčí omezení (C5 na serverech) je infrastrukturní povahy.

## 14.2 Známá omezení

Návrh má i dokumentovaná omezení, z nichž nejvýznamnější je provozního, nikoli kódového rázu:

- **Oprávnění CIM/DCOM na řadičích domény a zamčených serverech.** Na nejpřísněji zabezpečených strojích (řadiče domény, zamčené servery) může servisní účet při vytváření CIM session narazit na `New-CimSession: Access is denied`, pokud nemá příslušná DCOM/WMI oprávnění. Z těchto strojů se pak nesbírá stav disků a služeb — což je paradoxně omezení právě tam, kde je sledování kritických služeb (NTDS, DNS) nejdůležitější. Řešení je infrastrukturní (delegace oprávnění přes GPO), nikoli softwarové.
- **Port‑checky jako samostatná agenda** jsou ve fázi rozšiřování; aktuálně se per‑port stav neperzistuje do strukturovaného reportu.
- **Výkonový kanál na serverech** je často ve výchozím stavu vypnutý, takže výkonová telemetrie ze serverů bývá neúplná.
- **Bezagentnost vs. mimo doménu.** Systém z principu nepokrývá stroje mimo doménu nebo nedosažitelné po RPC/SMB jinak než indikací nedostupnosti.

## 14.3 Budoucí práce

- **Delegace CIM oprávnění** na DC a zamčené servery (infrastrukturní krok odblokující sběr kritických služeb z nejdůležitějších strojů).
- **Rozšíření port‑checků** do strukturovaného reportu (perzistence per‑port stavu, on‑demand sonda).
- **Per‑agenda e‑maily** — další zjemnění směrování notifikací.
- **Rozšíření remediačních pomůcek** (GPO skripty) při zachování principu „pozorovatel" — tj. generování doporučení, nikoli automatický zásah.

# 15. Závěr

ITDashboard demonstruje, že pro značnou část potřeb správy doménového prostředí Windows lze postavit **lehký, bezpečný a přenositelný bezagentní monitorovací systém** nad standardními protokoly, které doménové stanice již ve výchozím stavu poskytují. Kombinace moderního typovaného zásobníku (Node.js/TypeScript/React), relačního datového modelu vyvíjeného evolučními migracemi, vícevrstvého bezpečnostního modelu a robustního kontinuálního nasazení s ověřením shody binárky vede k systému, který je v produkčním provozu udržitelný a rozšiřitelný.

Hlavními koncepčními přínosy jsou tlumené skóre problémovosti stanic, dvouúrovňové monitorování služeb s per‑stanicovými výjimkami, strukturované reporty se strojově čitelným označením stavu a důsledně uplatněná filozofie „pozorovatel, nikoli vykonavatel", která minimalizuje bezpečnostní riziko monitorovací vrstvy. Identifikovaná omezení — především oprávnění CIM na nejpřísněji zabezpečených strojích — jsou převážně infrastrukturní a vytyčují směr další práce.

---

# Přílohy

## Příloha A — Referenční přehled REST API

Legenda: **A** = vyžaduje autentizaci/edit tier (kde relevantní). Cesty jsou uvedeny tak, jak je systém registruje.

### Autentizace
| Metoda | Cesta | Účel |
|--------|-------|------|
| POST | `/api/auth/session` | Přihlášení operátora (LDAP bind), vytvoření session |
| POST | `/api/auth/logout` | Zrušení session |
| GET | `/api/auth/whoami` | Zjištění stavu přihlášení |
| POST | `/api/auth/launch-token` | Vytvoření jednorázového tokenu pro spouštěč akce |
| GET | `/api/auth/redeem` | Výměna tokenu za přihlašovací údaje |
| GET | `/api/auth/stats` | Statistiky session |

### Počítače
| Metoda | Cesta | Účel |
|--------|-------|------|
| GET | `/computers` | Seznam všech strojů s telemetrií |
| POST | `/computers/sync` | Ruční synchronizace z AD |
| GET | `/computers/inactive-stats` | Počty neaktivních strojů |
| POST | `/computers/:id/refresh` | Okamžitý sběr všech dat z jednoho stroje |
| GET | `/computers/:id/user-history` | Historie přihlášení uživatelů |
| GET | `/computers/sync/history` | Posledních 20 synchronizací |
| GET | `/computers/sync/last` | Poslední synchronizace |
| PATCH | `/computers/:id/excluded` | Přepnutí příznaku „vyřazen" |
| PATCH | `/computers/:id/monitor` | Přepnutí příznaku „sledovat" |
| PATCH | `/computers/:id/disk-email-monitor` | Diskové alerty + rozsah disků |
| PATCH | `/computers/:id/service-email-monitor` | Kritické služby + výjimky |
| PATCH | `/computers/:id/service-monitor` | Široké služby + výjimky |
| POST | `/computers/bulk-flag` | Hromadné nastavení příznaku |
| POST | `/computers/monitor/bulk` | Hromadné nastavení sledování |

### Události
| Metoda | Cesta | Účel |
|--------|-------|------|
| GET | `/events` | Dotaz na události (filtry stroj/úroveň/okno/limit) |
| GET | `/events/summary` | Souhrnné počty podle úrovně |
| GET | `/events/top-ids` | Nejčastější ID událostí |
| GET | `/events/timeline` | Hodinová časová řada |
| GET | `/events/top-computers` | Nejproblémovější stroje |
| GET | `/events/pc-health` | Skóre zdraví/problémovosti stanic |

### Disky, služby, výkon
| Metoda | Cesta | Účel |
|--------|-------|------|
| GET | `/disks` | Inventář diskového prostoru |
| POST | `/disks/collect` | Ruční diskový sken |
| GET | `/services/problems` | Problémové služby |
| GET | `/services/critical` | Kritické služby v jakémkoli stavu |
| GET | `/services/aggregate` | Agregace služeb napříč stroji |
| GET | `/services/gpo-script` | Generovaný remediační GPO skript |
| GET | `/services/policies` | Klasifikační pravidla služeb |
| POST | `/services/scan` | Ruční sken služeb |
| GET | `/perf-events` | Výkonové události |
| GET | `/perf-events/summary` | Souhrn výkonových událostí |
| GET | `/perf-events/top-culprits` | Nejčastější příčiny zpomalení |
| GET | `/perf-events/top-pcs` | Nejpomalejší stroje |
| POST | `/perf-events/scan` | Ruční sken výkonových událostí |

### Alerty, reporty, nastavení
| Metoda | Cesta | Účel |
|--------|-------|------|
| POST | `/alerts/disk/test` | Test diskového alertu |
| POST | `/alerts/services/test` | Test servisního alertu |
| POST | `/alerts/ports/test` | Test port‑checku |
| GET | `/reports/overview` | Strukturovaný přehled parku |
| POST | `/reports/email` | Odeslání reportu e‑mailem (volitelně výběr strojů) |
| GET | `/settings` | Čtení veškeré konfigurace |
| PUT | `/settings` | Zápis konfigurace (živé přeplánování) |

### Provoz, firewall, údržba, verze
| Metoda | Cesta | Účel |
|--------|-------|------|
| GET | `/access-check` | Ověření, zda je IP povolena |
| GET | `/firewall/domain-profile` | Stav doménového firewall profilu |
| GET | `/firewall/whitelist` | Seznam povolených IP |
| PUT | `/firewall/whitelist` | Nastavení povolených IP |
| GET | `/collector/status` | Průběh sběru |
| POST | `/collector/run` | Ruční sběr událostí |
| POST | `/collector/run-all` | Spuštění všech kontrol |
| POST | `/collector/stop` | Zastavení sběru |
| POST | `/reachability/run` | Ruční sonda dosažitelnosti |
| GET | `/api/retention/status` | Stav retenčních úloh |
| POST | `/api/retention/run` | Ruční spuštění retence |
| GET | `/activity/log` | Živý auditní záznam |
| GET | `/activity/history` | Perzistentní historie aktivity |
| GET | `/activity/sources` | Zdroje aktivity |
| GET | `/health` | Liveness/readiness + latence DB |
| GET | `/version`, `/version/sha` | Build info (pro smoke test) |
| GET | `/docs` | Uživatelská dokumentace (HTML) |

## Příloha B — Datový slovník

### computers (centrální registr strojů)
| Sloupec | Typ | Null | Význam |
|---------|-----|------|--------|
| id | INT IDENTITY | N | Primární klíč |
| name | NVARCHAR(255) | N | Jméno stroje (unikátní) |
| fqdn | NVARCHAR(512) | A | Plně kvalifikované jméno |
| os_version | NVARCHAR(128) | A | Verze OS |
| last_seen | DATETIME2 | A | Poslední synchronizace/sběr |
| enabled | BIT | N | Přítomnost v AD |
| created_at | DATETIME2 | N | Vznik záznamu |
| last_collected_at | DATETIME2 | A | Poslední úspěšný sběr událostí |
| last_error | NVARCHAR(MAX) | A | Poslední chyba sběru |
| consecutive_failures | INT | N | Počet po sobě jdoucích selhání |
| monitor_enabled | BIT | N | Operátorský příznak „sledovat" |
| distinguished_name | NVARCHAR(1024) | A | AD DN |
| ou_path | NVARCHAR(1024) | A | Čitelná OU cesta |
| current_user | NVARCHAR(255) | A | Interaktivně přihlášený uživatel |
| current_user_seen_at | DATETIME2 | A | Čas poslední nenulové observace |
| ip_address | NVARCHAR(64) | A | Primární IPv4 |
| pc_info_collected_at | DATETIME2 | A | Čas posledního sběru info |
| last_status | NVARCHAR(32) | A | online/offline/rpc_unavailable/access_denied/unknown |
| reachable | BIT | A | Výsledek poslední sondy |
| last_reachable_at | DATETIME2 | A | Naposledy odpověděl |
| reach_checked_at | DATETIME2 | A | Naposledy sondováno |
| excluded | BIT | N | Tvrdé vyřazení |
| disk_email_monitor | BIT | N | Opt‑in diskové alerty |
| disk_email_drives | NVARCHAR(64) | N | Rozsah disků (prázdné = vše) |
| service_email_monitor | BIT | N | Opt‑in kritické služby |
| service_monitor | BIT | N | Opt‑in široké služby |
| service_exceptions | NVARCHAR(MAX) | A | Per‑PC výjimky (široké) |
| critical_service_exceptions | NVARCHAR(MAX) | A | Per‑PC výjimky (kritické) |

### events (surové události)
| Sloupec | Typ | Null | Význam |
|---------|-----|------|--------|
| id | BIGINT IDENTITY | N | Identita (součást PK) |
| computer_id | INT | N | FK na computers |
| log_name | NVARCHAR(128) | N | Kanál (Application/System/…) |
| event_id | INT | N | ID události |
| level | TINYINT | N | 1=Critical … 5=Verbose |
| time_created | DATETIME2 | N | Čas vzniku (clusterovaný index) |
| provider_name | NVARCHAR(255) | A | Poskytovatel/zdroj |
| task | NVARCHAR(255) | A | Kategorie úlohy |
| message | NVARCHAR(MAX) | A | Text události |
| raw_xml | NVARCHAR(MAX) | A | Surový XML záznam |
| collected_at | DATETIME2 | N | Čas ingesce |

Indexy: `ix_events_time_level`, `ix_events_computer_time`, `ix_events_eventid_time`, unikátní `ux_events_dedup` (IGNORE_DUP_KEY).

### event_daily_agg (denní agregace, trvale)
| Sloupec | Typ | Význam |
|---------|-----|--------|
| day | DATE | Den agregace |
| computer_id | INT | FK |
| log_name | NVARCHAR(128) | Kanál |
| event_id | INT | ID |
| level | TINYINT | Úroveň |
| count | INT | Počet výskytů |

### disks
| Sloupec | Typ | Význam |
|---------|-----|--------|
| id | INT IDENTITY | PK |
| computer_id | INT | FK |
| drive_letter | NVARCHAR(8) | Písmeno disku |
| volume_label | NVARCHAR(255) | Jmenovka |
| filesystem | NVARCHAR(32) | Souborový systém |
| total_bytes | BIGINT | Kapacita |
| free_bytes | BIGINT | Volné místo |
| collected_at | DATETIME2 | Čas snímku |

### service_problems
| Sloupec | Typ | Význam |
|---------|-----|--------|
| id | INT IDENTITY | PK |
| computer_id | INT | FK |
| service_name | NVARCHAR(255) | Název služby |
| display_name | NVARCHAR(512) | Zobrazované jméno |
| start_mode | NVARCHAR(32) | Auto/Manual/Disabled/Trigger |
| state | NVARCHAR(32) | Running/Stopped/… |
| delayed_start | BIT | Delayed Auto‑Start |
| trigger_start | BIT | Trigger Start |
| per_user_start | BIT | Per‑uživatelská služba |
| is_compliant | BIT | Shoda s politikou |
| policy_id | INT | FK na service_policy |
| exit_code | INT | Win32 exit kód |
| service_specific_exit_code | INT | Interní chybový kód |
| collected_at | DATETIME2 | Čas snímku |

### critical_service_status
| Sloupec | Typ | Význam |
|---------|-----|--------|
| computer_id | INT | FK (PK část 1) |
| service_name | NVARCHAR(255) | Název (PK část 2) |
| display_name | NVARCHAR(255) | Zobrazované jméno |
| state | NVARCHAR(32) | Stav |
| start_mode | NVARCHAR(32) | Režim spuštění |
| collected_at | DATETIME2 | Čas snímku |

### service_policy
| Sloupec | Typ | Význam |
|---------|-----|--------|
| id | INT IDENTITY | PK |
| pattern | NVARCHAR(255) | Vzor (glob/regex) |
| expected_start_mode | NVARCHAR(32) | Očekávaný režim |
| expected_state | NVARCHAR(32) | Očekávaný stav |
| priority | INT | Priorita (nižší vyhrává) |
| reason | NVARCHAR(MAX) | Důvod |
| created_at | DATETIME2 | Vznik |

### perf_events
| Sloupec | Typ | Význam |
|---------|-----|--------|
| id | BIGINT IDENTITY | PK |
| computer_id | INT | FK |
| time_created | DATETIME2 | Čas |
| event_id | INT | ID |
| level | TINYINT | Úroveň |
| category | NVARCHAR(16) | boot/shutdown/standby/resume/other |
| total_time_ms | BIGINT | Celkový čas |
| degradation_ms | BIGINT | Doba degradace |
| culprit_name | NVARCHAR(512) | Viník |
| culprit_friendly | NVARCHAR(512) | Čitelný popis |
| message | NVARCHAR(MAX) | Text |
| collected_at | DATETIME2 | Ingesce |

### pc_user_history
| Sloupec | Typ | Význam |
|---------|-----|--------|
| id | BIGINT IDENTITY | PK |
| computer_id | INT | FK |
| user_name | NVARCHAR(255) | Uživatel |
| first_seen | DATETIME2 | Poprvé spatřen |
| last_seen | DATETIME2 | Naposledy spatřen |
| ip_address | NVARCHAR(64) | IP v době první observace |

### service_alert_state / port_check_state
| Tabulka | Klíč | Sloupce stavu |
|---------|------|---------------|
| service_alert_state | (computer_id, service_name) | first_down_at, last_sent_at |
| port_check_state | (computer_id, check_name) | port, last_ok_at, first_down_at, last_sent_at |

### activity_log
| Sloupec | Typ | Význam |
|---------|-----|--------|
| id | BIGINT IDENTITY | PK |
| ts | DATETIME2 | Čas |
| level | NVARCHAR(16) | info/warn/error/success |
| source | NVARCHAR(64) | Zdroj (collector/disk/services/…) |
| message | NVARCHAR(MAX) | Zpráva |

### Provozní a podpůrné tabulky
| Tabulka | Účel |
|---------|------|
| collector_runs | Historie běhů sběru událostí |
| ad_sync_runs | Historie synchronizací z AD |
| scripts / script_runs | Katalog a historie skriptů (runbooky) |
| credentials | Šifrovaná úschova přihlašovacích údajů (DPAPI) |
| settings | Konfigurace klíč‑hodnota |
| schema_migrations | Evidence aplikovaných migrací |

## Příloha C — Referenční přehled konfiguračních klíčů (settings)

### Plánovač kontrol
| Klíč | Výchozí | Význam |
|------|---------|--------|
| checks.interval_sec | 900 | Interval periodických kontrol |
| checks.days | 1,2,3,4,5 | Dny v týdnu (Po–Pá) |
| checks.window_start / window_end | 06:00 / 18:00 | Pracovní okno |
| checks.run_eventlog/disk/services/perf | true | Zapnutí jednotlivých kontrol |
| checks.run_adsync | false | Zahrnout AD sync do periody |
| checks.run_reachability | 1 | Sonda dosažitelnosti |

### Intervaly sběru
| Klíč | Výchozí | Význam |
|------|---------|--------|
| collector.interval_sec | 300 | Sběr událostí |
| disk.interval_sec | 1800 | Diskový sken |
| adsync.interval_sec | 86400 | Synchronizace AD |
| adsync.default_monitor_enabled | true | Nové PC výchozí sledovat |
| services.interval_sec | 900 | Sken služeb |
| perf.cold_start_days | 30 | Okno studeného startu výkonu |

### Diskové prahy
| Klíč | Výchozí | Význam |
|------|---------|--------|
| disk.critical_pct / warning_pct | 5 / 15 | Procentuální prahy |
| disk.critical_gb / warning_gb | 5 / 20 | Absolutní prahy (GB) |
| disk.threshold_mode | pct | pct/gb/either |

### Diskové alerty
| Klíč | Výchozí | Význam |
|------|---------|--------|
| alerts.disk.enabled | 0 | Hlavní vypínač |
| alerts.disk.frequency_hours | 24 | Throttle |
| alerts.disk.recipients | (prázdné) | Příjemci (fallback na sdílené) |

### Servisní alerty
| Klíč | Výchozí | Význam |
|------|---------|--------|
| alerts.services.enabled | 0 | Hlavní vypínač |
| alerts.services.debounce_minutes | 10 | Ochrana proti flapování |
| alerts.services.frequency_hours | 24 | Kadence připomínek |
| alerts.services.maintenance_window | (prázdné) | Okno údržby HH:MM‑HH:MM |
| alerts.services.critical_names | NTDS,DNS,Kdc,Netlogon,W32Time,VMTools,Veeam…,ekrn,DHCPServer,LanmanServer | Seznam kritických služeb |
| alerts.services.whitelist | (prázdné) | Nikdy nealertovat |
| alerts.services.recipients | (prázdné) | Příjemci |

### Port‑checky
| Klíč | Výchozí | Význam |
|------|---------|--------|
| alerts.services.port_checks_enabled | 0 | Hlavní vypínač |
| alerts.services.port_checks | LDAP:389,SMB:445,RDP:3389,Kerberos:88,DNS:53 | Seznam portů |
| alerts.services.port_timeout_ms | 2000 | Timeout sondy |
| alerts.ports.recipients | (prázdné) | Příjemci |

### SMTP a sdílené příjemce
| Klíč | Výchozí | Význam |
|------|---------|--------|
| alerts.smtp_host / smtp_port / smtp_from | (prázdné) / 25 / (prázdné) | Relay, port, odesílatel |
| alerts.recipients | (prázdné) | Sdílení příjemci (fallback) |
| alerts.reports.recipients | (prázdné) | Příjemci reportu |
| alerts.dashboard_url | (prázdné) | Odkaz v patičce e‑mailů |

### Skóre problémovosti
| Klíč | Výchozí | Význam |
|------|---------|--------|
| faulty.window_days | 14 | Okno analýzy |
| faulty.signature_cap | 20 | Strop na typ události |
| faulty.weight_critical/error/warning | 10/3/1 | Váhy úrovní |
| faulty.weight_breadth | 5 | Bonus za šíři |
| faulty.weight_persistence | 3 | Bonus za perzistenci |
| faulty.threshold_watch / risk | 400 / 600 | Prahy (kalibrováno) |

### Dosažitelnost, retence, ostatní
| Klíč | Výchozí | Význam |
|------|---------|--------|
| reachability.interval_sec | 300 | Nezávislý interval sondy |
| reachability.ports | 135,445 | TCP porty |
| reachability.timeout_ms | 2000 | Timeout |
| reachability.ping | 1 | ICMP fallback |
| events.retention_days | 90 | Retence událostí |
| events.dedup_enabled / lookback_days | 1 / 90 | Deduplikace |
| events.summary_window_days | 1 | Okno souhrnných dlaždic |
| activity.retention_days | 30 | Retence activity logu |
| pcUserHistory.retention_days | 90 | Retence historie uživatelů |
| inactive.threshold_days | 90 | Práh neaktivity |
| retention.run_at_hour | 2 | Hodina denní údržby |

## Příloha D — Seznam migrací schématu

| # | Soubor | Hlavní obsah |
|---|--------|--------------|
| 001 | init | Základní schéma (computers, events, event_daily_agg, scripts, credentials) |
| 002 | retention_job | Uložené procedury pro agregaci a purgování |
| 003 | collector | Sloupce stavu sběru, collector_runs, dedup index |
| 004 | activity | ad_sync_runs |
| 005 | monitor_flag | computers.monitor_enabled |
| 006 | ou_path | distinguished_name, ou_path |
| 007 | disks_settings | Tabulka disks + settings + diskové prahy |
| 008 | interval_settings | Intervaly sběru |
| 009 | last_status | computers.last_status |
| 010 | service_problems | Tabulka service_problems + interval |
| 011 | service_trigger_delayed | Příznaky trigger/delayed start |
| 012 | per_user_service | per_user_start |
| 013 | excluded_flag | computers.excluded |
| 014 | service_policy | Tabulka pravidel + 24 seedů |
| 015 | periodic_checks | Konfigurace plánovače |
| 016 | perf_events | Tabulka perf_events |
| 017 | adsync_in_runall | Volby AD syncu |
| 018 | perf_cold_start_days | Okno studeného startu |
| 019 | pc_info | current_user, ip_address, … |
| 020 | activity_log_persistent | Tabulka activity_log + purge |
| 021 | retention_settings | Retence událostí |
| 022 | inactive_threshold | Práh neaktivity |
| 023 | pc_user_history | Historie uživatelů |
| 024 | pc_user_history_ip | IP v historii |
| 025 | event_dedup | Procedura deduplikace |
| 026 | service_exit_code | Exit kódy služeb |
| 027 | event_summary_window | Okno souhrnu |
| 028 | disk_email_alerts | Diskové alerty + SMTP |
| 029 | disk_email_drives | Rozsah disků per‑PC |
| 030 | service_email_alerts | Servisní alerty + service_alert_state |
| 031 | service_port_checks | Port‑checky + port_check_state |
| 032 | reachability | Dosažitelnost |
| 033 | faulty_pc | Skóre problémovosti |
| 034 | faulty_thresholds | Rekalibrace prahů |
| 035 | reachability_interval | Nezávislý interval sondy |
| 036 | reachability_ping | ICMP fallback |
| 037 | critical_service_status | Stav kritických služeb v jakémkoli stavu |
| 038 | per_agenda_recipients | Per‑agenda příjemci |
| 039 | report_recipients | Příjemci reportu |
| 040 | service_exceptions | Dvouúrovňové služby + per‑PC výjimky |

## Příloha E — Glosář pojmů

| Pojem | Význam |
|-------|--------|
| **Bezagentní sběr** | Získávání dat bez instalace klienta na cílovém stroji, jen standardními protokoly. |
| **RPC / DCOM** | Vzdálené volání procedur Windows (port 135) využívané ke čtení událostí a WMI. |
| **WMI / CIM** | Rozhraní Windows pro správu (dotazy na disky, služby, info o stroji). |
| **MERGE** | SQL operace „vlož nebo aktualizuj" použitá při synchronizaci inventáře. |
| **Debounce** | Prodleva, po kterou musí problém trvat, než se odešle první alert. |
| **Throttle** | Omezení frekvence opakovaných upozornění na trvající problém. |
| **Okno údržby** | Časový interval, během něhož se alerty potlačí. |
| **Damped blend** | „Tlumený mix" — skórovací metoda kombinující vážený počet se stropem, šíři a perzistenci. |
| **Direct Send** | Způsob odesílání e‑mailů přes M365 bez autentizace, z vlastní domény. |
| **Smoke test** | Rychlé ověření po nasazení, že běžící systém odpovídá zdroji. |
| **Observer, not executor** | Princip, že systém pozoruje a upozorňuje, ale neprovádí automatické zásahy. |
| **Read/Edit tier** | Oddělení čtecí (jen prohlížení) a editační (změny, akce) roviny oprávnění. |
| **Stale (zastaralý)** | Záznam stroje, jehož telemetrie pochází z doby před prahem aktuálnosti. |
| **NSSM** | Non‑Sucking Service Manager — nástroj pro provoz libovolného procesu jako služby Windows. |
| **DPAPI** | Data Protection API — služba Windows pro šifrování dat vázané na účet/stroj. |
| **SSPI / Kerberos** | Mechanismus integrované autentizace Windows (bez hesla). |
| **MERGE / UPSERT** | SQL operace „vlož nebo aktualizuj podle shody klíče". |
| **GPO** | Group Policy Object — mechanismus centrální konfigurace v doméně. |

## Příloha F — Instalační a konfigurační runbook (přehled)

Prvotní zprovoznění systému (jednorázové) zahrnuje následující kroky. Konkrétní hodnoty (jména hostitelů, domény) jsou referenční a plně konfigurovatelné.

1. **Předpoklady na aplikačním serveru:** Windows Server, Node.js LTS 20, Git, NSSM, modul RSAT ActiveDirectory pro PowerShell. Ověřit politiku spouštění skriptů (v doménách bývá `AllSigned` — proto nasazovací pipeline používá shell `cmd`, nikoli PowerShell).
2. **Servisní účet v AD:** vytvořit doménový účet (referenčně `svc-itdashboard`), zařadit jej do skupiny *Event Log Readers* na cílových strojích (přes GPO) a delegovat potřebná WMI/DCOM oprávnění.
3. **Databáze:** vytvořit databázi `ITDashboard` na SQL serveru, vytvořit SQL login namapovaný na servisní účet a přidělit roli `db_owner`.
4. **Repozitář a konfigurace:** naklonovat repozitář do běhového umístění (`C:\Apps\ITDashboard`), zkopírovat `.env.example` na `.env` a vyplnit infrastrukturní hodnoty (SQL host/instance/databáze, parametry LDAP, edit skupina).
5. **Migrace:** spustit `npm run migrate` (vytvoří/aktualizuje schéma a naseeduje výchozí nastavení).
6. **Self‑hosted runner:** zaregistrovat GitHub Actions runner se shodným štítkem, aby se na něj směrovala nasazovací pipeline.
7. **Windows služba:** přes NSSM vytvořit službu `ITDashboardAPI` spouštějící `node dist/index.js` pod servisním účtem; udělit účtu právo službu zastavit/spustit (`sc sdset`).
8. **Firewall / whitelist:** povolit přístup operátorských IP na port 4000.
9. **Smoke test:** ověřit, že `GET /version/sha` vrací očekávanou revizi a `GET /` servíruje UI.

## Příloha G — Referenční konfigurace prostředí (.env)

Soubor `.env` (na běhovém hostiteli, mimo verzování) je jediným zdrojem infrastrukturní konfigurace. Šablona `.env.example` obsahuje:

| Proměnná | Účel |
|----------|------|
| `SQL_HOST`, `SQL_INSTANCE`, `SQL_DATABASE` | Připojení k databázi |
| `API_PORT` (4000), `API_BIND` (0.0.0.0) | Naslouchání API |
| `AD_LDAP_URL`, `AD_LDAP_DOMAIN`, `AD_LDAP_BASE_DN` | Parametry LDAP pro autentizaci operátorů |
| `AD_EDIT_GROUP` | DN/název AD skupiny opravňující k editaci |
| `AD_LDAP_TIMEOUT_MS` | Timeout LDAP operací |
| `AD_LDAP_STUB` | Testovací režim (v produkci odmítnut) |
| `NODE_ENV` | `production` zapíná produkční zpevnění |
| `ITD_COOKIE_SECURE` | `1` při TLS terminaci (secure cookie) |
| `VITE_API_BASE` | Cílové API zapečené do desktopového buildu |

Zásada: ve zdrojovém kódu nejsou žádné natvrdo zadané hodnoty prostředí; přenos do jiné domény vyžaduje pouze úpravu `.env` a případně nastavení v DB.

## Příloha H — Příklady API (ilustrativní)

**Souhrn událostí:**
```
GET /events/summary
→ { "critical_24h": 24, "error_24h": 65405, "warning_24h": 63826, "window_days": 1 }
```

**Strukturovaný přehled parku:**
```
GET /reports/overview
→ {
    "generatedAt": "2026-06-12T12:00:00.000Z",
    "totals": { "total": 228, "servers": 31, "pcs": 197,
                "active": 99, "offline": 112, "disabled": 17,
                "monitored": 211, "failing": 86 },
    "machines": [ … ], "offline": [ … ]
  }
```

**Odeslání reportu pro výběr strojů:**
```
POST /reports/email
Body: { "machines": ["B-S-W-DC-01", "B-S-W-DC-02"] }
→ { "ok": true, "recipients": 2, "total": 2, "offline": 0 }
```

**Změna per‑stanicových výjimek kritických služeb:**
```
PATCH /computers/42/service-email-monitor
Body: { "enabled": true, "exceptions": "NTDS,Kdc" }
→ { "id": 42, "name": "DOMENA01",
    "service_email_monitor": true, "critical_service_exceptions": "NTDS,Kdc" }
```

**Zápis nastavení (živé přeplánování při změně intervalu):**
```
PUT /settings
Body: { "checks.interval_sec": "600" }
→ { "updated": 1 }
```

## Příloha I — Evoluce návrhu a poučení

Vývoj systému, čitelný z posloupnosti 40 migrací a provozního deníku, ukazuje několik obecnějších poučení:

- **Schéma roste s funkcemi, ne dopředu.** Tabulka `computers` začala se 7 sloupci a postupně narostla na 28 — každá nová funkce (dosažitelnost, dvouúrovňové služby, per‑PC výjimky) přidala právě to, co potřebovala. Dopředné modelování „pro všechny případy" by bylo plýtváním; evoluční migrace se ukázaly jako udržitelná cesta.
- **Heuristiky se musí ladit proti realitě.** Prahy skóre problémovosti byly rekalibrovány až podle živých dat (migrace 034). Proto jsou všechny parametry v konfiguraci.
- **Odolnost se platí zkušeností.** Oprava, aby jedna nevykreslitelná událost neshodila celý sběr ze stroje, vznikla z konkrétního provozního pozorování (řada strojů se přestala sbírat kvůli jediné vadné události). Robustnost vůči „špinavým" datům z reálného světa je nutnost, ne luxus.
- **Konzistence napříč vrstvami.** Whitelist služeb či generátor reportu jsou navrženy jako **jediný zdroj pravdy** sdílený mezi UI, statistikami a e‑maily — aby tatáž věc nebyla počítána dvakrát různě.
- **Provozní vs. softwarová omezení.** Nejvýznamnější omezení (oprávnění CIM na DC) není v kódu, ale v infrastruktuře. Dobrý návrh tato omezení **zviditelní** (kategorie stavu `access_denied`), místo aby je skrýval.
- **Bezpečnost jako architektura, ne přídavek.** Princip „observer, not executor" a integrovaná autentizace nejsou dodatečné kontroly, ale základní architektonická rozhodnutí, která omezují dopad případné kompromitace.

## Příloha J — Související normy a protokoly

| Standard / protokol | Relevance pro systém |
|---------------------|----------------------|
| **NIS2** (směrnice EU) | Požadavky na řízení aktiv, detekci incidentů, logování — systém přispívá inventářem, analýzou událostí a auditním záznamem. |
| **ISO/IEC 27001** | Kontroly řízení přístupu, logování a monitoringu, správy aktiv — viz mapování v kap. 9.5. |
| **MS‑EVEN6** | RPC protokol pro vzdálené čtení protokolu událostí (využívá `Get-WinEvent`). |
| **WMI / CIM (DMTF)** | Standard pro správu — dotazy na disky, služby, informace o stroji přes DCOM. |
| **DCOM / MS‑RPCE** | Distribuované volání procedur Windows; základ pro WMI i čtení událostí (port 135 + dynamické). |
| **SMB (MS‑SMB2)** | Sdílení souborů; port 445 jako alternativní indikátor dosažitelnosti a kanál pro DCOM. |
| **LDAP (RFC 4511)** | Ověřování operátorů bindem proti Active Directory. |
| **Kerberos / SSPI** | Integrovaná autentizace k SQL serveru (bez hesla). |
| **SMTP (RFC 5321) + STARTTLS** | Odesílání e‑mailů přes M365 Direct Send. |
| **TDS** | Aplikační protokol komunikace s MSSQL. |

## Příloha K — Referenční hodnoty nasazení

Následující hodnoty jsou **referenční** (ilustrativní pro reálné nasazení) a všechny jsou konfigurovatelné; ve zdrojovém kódu nejsou natvrdo.

| Položka | Referenční hodnota |
|---------|--------------------|
| Aplikační server (API) | 10.8.2.213 |
| Port API | 4000 |
| Windows služba | `ITDashboardAPI` (NSSM) |
| Servisní účet | `AXINETWORK\svc-itdashboard` |
| SQL server | 10.8.2.225 (výchozí instance) |
| Databáze | `ITDashboard` |
| Doména | `AXINETWORK` / `axinetwork.loc` |
| Běhové umístění | `C:\Apps\ITDashboard` |
| Webové UI | `http://<api-host>:4000/` |
| Uživatelská dokumentace | `http://<api-host>:4000/docs` |
| Počet sledovaných strojů | ~225 |
| Štítek runneru | (samostatný self‑hosted runner na app serveru) |

## Příloha L — Přehled použitých technologií a verzí

| Komponenta | Technologie | Verze (řádově) |
|------------|-------------|----------------|
| Běhové prostředí | Node.js | 20 (LTS) |
| Webový framework | Fastify | 4.x |
| DB ovladač | msnodesqlv8 / mssql | 4.x / 11.x |
| Validace | Zod | 3.x |
| LDAP | ldapts | 8.x |
| E‑mail | Nodemailer | 6.x |
| Logování | Pino | 9.x |
| Frontend | React | 18.x |
| Build | Vite | 5.x |
| Desktop | Electron | 33.x |
| Jazyk | TypeScript | ES2022 |
| Databáze | Microsoft SQL Server | 2019+ |
| Provoz služby | NSSM | — |
| CI/CD | GitHub Actions (self‑hosted) | — |

## Příloha M — Vybrané případy užití

Následující scénáře ilustrují každodenní použití systému správcem.

### M.1 Ranní kontrola stavu parku

Správce ráno otevře dashboard. Převaha **zelených** dlaždic signalizuje, že je vše v pořádku. Červená dlaždice „Kritické služby (2)" jej upozorní na problém — kliknutím přejde na záložku Kritické služby, kde matice ukáže, že na jednom serveru neběží služba Veeam. Kliknutím na jméno serveru přejde na Počítače s detailem stroje a odtud může spustit vzdálenou správu služeb (mmc) pod vlastní identitou (Auth Gate).

### M.2 Identifikace stroje k reinstalaci

Dlaždice „PC v problémech (3)" je červená. Správce ji rozklikne a vidí tři stroje nad prahem „risk" se skóre 1 300+. U nejhoršího klikne na skóre, čímž přejde na filtrované Události daného stroje za 14 dní. Vidí rozmanité chyby disku a ovladačů napříč dny — typický obraz hardwarového/systémového rozpadu. Rozhodne se stroj reinstalovat.

### M.3 Potlačení falešných alertů z demoted řadiče

Po degradaci řadiče domény (`DOMENA01`) jsou na něm služby NTDS a Kdc legitimně zastavené a generují alerty „kritická služba mimo provoz". Správce na záložce Počítače do pole výjimek sloupce „Krit. služby" u tohoto stroje zapíše `NTDS,Kdc`. Alerty z tohoto stroje na tyto služby ustanou, ale na ostatních řadičích jsou NTDS/Kdc dál hlídány.

### M.4 Plánovaná noční odstávka

Před plánovanou noční instalací aktualizací správce v Nastavení nastaví okno údržby služeb na `22:00‑04:00`. Během této doby se servisní alerty potlačí, takže restarty služeb při instalaci nevygenerují záplavu e‑mailů. Po skončení okna se monitoring sám obnoví.

### M.5 Cílený report pro vedení

Správce na záložce Počítače vyfiltruje pouze servery (stavový čip / OS) a klikne na „✉ Report e‑mailem". Vygeneruje se strukturovaný přehled jen serverů (počty, offline, stav sběru) a odešle se příjemcům reportu. Předmět e‑mailu nese `[OK]` nebo `[CHYBA]`, takže pravidlo v poštovním klientovi může bezchybné reporty automaticky odložit do složky.

### M.6 Forenzní dohledání incidentu

Po hlášení o problému s přihlašováním v určitý čas správce na záložce Události zadá filtr poskytovatele a rozsah ID událostí Kerberos/Netlogon za příslušné okno a stroj. Detail události se surovým XML poskytne přesný kontext. Záložka Aktivita zároveň doloží, co v té době dělal samotný monitorovací systém.

## Příloha N — Zvažované návrhové alternativy

Pro úplnost uvádíme alternativy, které byly při návrhu zvažovány a zamítnuty, s odůvodněním.

| Oblast | Zvolené řešení | Zvažovaná alternativa | Důvod volby |
|--------|----------------|------------------------|-------------|
| Sběr | RPC/DCOM bezagentně | Agent na stanici | Nulová instalace, menší bezpečnostní povrch |
| Sběr událostí | Get‑WinEvent (RPC) | WinRM / PSRemoting | WinRM není defaultně zapnutý na klientech |
| DB ovladač | msnodesqlv8 | tedious | Integrovaná autentizace (bez hesla) |
| Konfigurace | settings v DB | Konfigurační soubory | Změny za běhu, jednotný CRUD |
| Skóre | Tlumený mix | Prostý součet chyb | Robustnost vůči jednomu ukecanému zdroji |
| Remediace | Generování GPO skriptu | Automatická remediace | Princip „observer, not executor", bezpečnost |
| Frontend distribuce | Sdílený web+desktop build | Oddělené aplikace | Jeden kód, jedna verze |
| Verzování schématu | Dopředné migrace | ORM auto‑migrace | Plná kontrola, transakční bezpečnost |
| Identifikace revize | Zapečení SHA při buildu | Čtení z .git za běhu | Běhové umístění je kopie bez .git |
| Dosažitelnost | Vlastní plánovač | Součást periodických kontrol | Čerstvost 24/7 nezávisle na okně |

## Příloha O — Hranice a předpoklady systému

Pro korektní interpretaci možností systému je třeba znát jeho hranice:

- **Doménové prostředí.** Systém předpokládá doménu Active Directory; stroje mimo doménu nejsou v jeho záběru.
- **Dosažitelnost po RPC/SMB.** Stroje nedosažitelné po těchto kanálech (mimo síť, blokující firewall) se projeví jako nedostupné; jejich vnitřní stav systém nezískává (kromě indikace dosažitelnosti pingem).
- **Oprávnění servisního účtu.** Sběr disků a služeb vyžaduje WMI/DCOM oprávnění; na nejpřísněji zabezpečených strojích (DC) může chybět (kategorie `access_denied`).
- **Výkonový kanál na serverech.** Bývá vypnutý, takže výkonová telemetrie ze serverů je často neúplná.
- **Pozorovací, nikoli řídicí role.** Systém neprovádí žádné automatické zásahy; veškeré změny iniciuje operátor.
- **Jednouzlový sběr.** Pro cílový rozsah (~stovky strojů) dostačující; pro tisíce strojů by vyžadoval horizontální rozdělení.

Znalost těchto hranic je součástí korektního provozu — systém je navržen tak, aby své slepé skvrny **zviditelnil** (klasifikace stavu, indikace zastaralých dat), nikoli aby je skrýval.

---

*Konec dokumentu.*






