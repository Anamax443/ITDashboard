import React, { createContext, useContext, useEffect, useState } from 'react';

export type Lang = 'cs' | 'en';

// First-iteration i18n. Top-level UI surfaces (nav, status bar, summary cards,
// common buttons) are translated. Detailed HelpBox copy and per-page text
// remain English-only for now — full translation will roll in as separate
// commits per page so PRs stay reviewable.
const dict = {
  cs: {
    'nav.dashboard': 'Přehled',
    'nav.events': 'Události',
    'nav.computers': 'Počítače',
    'nav.services': 'Služby',
    'nav.perf': 'Výkon',
    'nav.activity': 'Aktivita',
    'nav.settings': 'Nastavení',
    'nav.docs': 'Dokumentace',

    'topbar.api': 'API',
    'topbar.lang': 'Jazyk',
    'topbar.theme': 'Motiv',
    'topbar.theme.dark': 'Tmavý',
    'topbar.theme.light': 'Světlý',

    'status.connected': 'Připojeno',
    'status.lastRefresh': 'Poslední aktualizace',
    'status.autoEvery': 'auto každých',

    'cards.critical': 'Kritické (24h)',
    'cards.errors': 'Chyby (24h)',
    'cards.warnings': 'Varování (24h)',
    'cards.unreachable': 'Nedostupné',
    'cards.diskCritical': 'Disk kritický',
    'cards.diskWarning': 'Disk varování',
    'cards.stoppedServices': 'Zastavené služby',
    'cards.slowBootShutdown': 'Pomalý boot/shutdown (7d)',
    'cards.inactive': 'Neaktivní PC',
    'cards.inactiveSub': '{enabled} enabled · {disabled} disabled',
    'cards.computers': 'Počítače',

    'dashboard.help.title': 'Co tento dashboard ukazuje',
    'dashboard.help.intro': 'Souhrnný přehled zdraví flotily. Každá karta je klikatelná a otevře příslušnou záložku s předvyplněným filtrem.',
    'dashboard.help.bullet.events': 'Kritické / Chyby / Varování (24h) — klik → záložka Události s filtrem podle úrovně',
    'dashboard.help.bullet.unreachable': 'Nedostupné — PC kde collectory selhávají; podtitulek rozkládá offline / RPC fail / auth → záložka Počítače',
    'dashboard.help.bullet.disk': 'Disk kritický / varování — PC s disky pod thresholdem → záložka Počítače',
    'dashboard.help.bullet.services': 'Zastavené služby — PC s non-noise stopnutými auto-službami → záložka Služby',
    'dashboard.help.bullet.inactive': 'Neaktivní PC (Nd+) — PC s LastLogon starším než threshold → záložka Počítače s filtrem inactive',
    'dashboard.help.bullet.computers': 'Počítače — aktivní / celkový inventář → záložka Počítače',
    'dashboard.help.collector': 'Collector bar ukazuje živý progress eventlog skenu (▶ Spustit teď / ⏹ Stop) a může spouštět všechny checks sekvenčně (eventlog → disk → services).',
    'dashboard.help.footer': 'Detailní seznamy (Události, Počítače, Služby, Aktivita, Nastavení) mají vlastní záložky.',

    'help.tabTitle': 'Co tato záložka ukazuje',

    'events.help.intro': 'Plně zobrazená tabulka surových událostí ze System a Application logu napříč všemi monitorovanými PC. Stahuje eventlog collector přes RPC.',
    'events.help.filters': 'Filtry (kombinují se AND — všechny musí současně sedět): 🔍 Search prohledává message + PC + event ID jako substring (case-insensitive). 🖥 Počítač = single-select dropdown (default "All computers"). 🏷 Provider = source komponenta (např. "Brother BrLog"). 🔢 Event ID input — single (4098), inclusive range (4000..8000 nebo 4000-8000), nebo comma list (1001,4098,7031). Invalid input = filter ignorován (červený border). ⚠ Úroveň = Critical / Error / Warning. ⏱ Časový rozsah = posledních N hodin. Vyprazdnění filtru = vrať dropdown na default / smaž search. Klik na sloupec řadí. Klik na řádek otevře detail eventu s plnou message a raw XML.',
    'events.help.noise': 'Application log obsahuje hodně šumu (Office crashes, WMI). Pro signál spíš sleduj Critical úroveň, nebo agregát "Top event IDs" v Dashboardu.',

    'computers.help.intro': 'Plný inventář doménových PC s operátorskými ovládacími prvky. Aktualizováno AD syncem; ostatní sloupce z collectorů.',
    'computers.help.chips': 'Status chips v hlavičce jsou klikatelné filtry: active, monitored, unmonitored, failing (consecutive_failures > 0), disk critical/warning, inactive (Nd+), disabled, excluded.',
    'computers.help.monitor': 'Monitor checkbox řídí jestli collectory pollí daný PC. Perzistuje napříč AD syncs. Exclude = hard skip i z dashboard statistik. Klik na User otevře historii přihlášených.',
    'computers.help.actions': 'Tlačítka: ↻ Sync from AD (znovu Get-ADComputer + MERGE), 🩺 Scan disks (manuální disk scan), ✓ All / ✗ None (bulk toggle Monitor respektující filtr).',

    'services.help.intro': 'Detekuje Windows služby s StartMode = Automatic ale State ≠ Running napříč monitorovanými PC. Filtruje legitimní případy (Trigger / Delayed / per-user) a porovnává proti policy tabulce.',
    'services.help.views': '📋 By PC view = flat list problémů. 📊 By service view = agregát "tato služba je stopnutá na N PC". Klasifikace: OK (matchne policy, vyhovuje), Drift (matchne, nevyhovuje), Unclassified (žádný policy match).',
    'services.help.actions': 'Filtry (kombinují AND): ⚠ Only ExitCode != 0 (DEFAULT ON, primární signál — skryje graceful exits), Hide trigger-start (default ON, ale skryje JEN graceful trigger-start; trigger-start co spadl s exit != 0 vždy ukáže), Hide delayed-start (stejná logika), Hide per-user (default ON), Hide compliant. Sloupec Exit ukazuje Win32 ExitCode služby — 0 = graceful, != 0 = SCM-level crash (červeně). Hlavička ukazuje "⚠ N crashes" jako primární metriku. 🔧 Scan services = manuální scan. 📤 GPO script = stáhne PowerShell pro hromadnou opravu přes GPO startup script.',

    'perf.help.intro': 'Pomalé boot / shutdown / standby / resume události z kanálu Microsoft-Windows-Diagnostics-Performance/Operational. Není to kontinuální CPU graf — jen outliers, které Windows samo označilo jako degradované.',
    'perf.help.ids': 'Event ID rozsahy: 100–199 boot · 200–299 shutdown · 300–399 standby · 400–499 resume. Cold-start sweep stahuje posledních N dní (default 30, konfigurovatelné v Nastavení).',
    'perf.help.serverNote': 'Kanál je defaultně off na Windows Server SKU. Servery vidíš jako "channel-disabled" v aggregátu. Pro povolení: GPO startup script wevtutil sl Microsoft-Windows-Diagnostics-Performance/Operational /e:true.',

    'activity.live.help.intro': 'Real-time stream každé background akce: eventlog collector, AD sync, disk scan, services scan, perf scan, firewall změny, IP guard. Pollováno každé 2s.',
    'activity.live.help.tags': 'Source tagy: [checks], [collector], [disk], [services], [perf], [ad-sync], [firewall], [access-check], [retention]. Úrovně: Success (zelená), Info (dim), Warning (amber), Error (red).',
    'activity.live.help.buffer': 'Buffer je in-memory (posledních 500 položek), ztrácí se při restart služby. 📋 Copy exportuje filtrované řádky jako tab-separated text. 📚 History přepne na DB-backed perzistentní vyhledávání.',

    'activity.history.help.intro': 'Perzistentní historie aktivit — každá logActivity volání se fire-and-forget INSERTuje do activity_log tabulky. Přežije restart služby. Default retence 30 dní (Nastavení → activity.retention_days).',
    'activity.history.help.filters': 'Filtry: časový rozsah, level, source dropdown (plněný z posledních 30 dní reálných sources), full-text vyhledávání ve zprávách. Vrací max {limit} řádků na stránku; paginátor pro víc.',
    'activity.history.help.live': 'Přepnutí zpět na Živě = in-memory ring buffer (posledních 500 položek, pollování každé 2s).',

    'btn.refresh': 'Obnovit',
    'btn.runAll': 'Spustit vše',
    'btn.runNow': 'Spustit teď',
    'btn.stop': 'Stop',
    'btn.scan': 'Skenovat',
    'btn.save': 'Uložit',
    'btn.copy': 'Kopírovat',
    'btn.history': 'Historie',
    'btn.live': 'Živě',
    'btn.pause': 'Pauza',
    'btn.resume': 'Pokračovat',
    'btn.clear': 'Vyčistit',

    'common.search': 'Hledat…',
    'common.all': 'Vše',
    'common.noData': 'žádná data',
    'common.loading': 'Načítám…',
    'common.lastSeen': 'Naposledy viděn',
    'common.lastError': 'Poslední chyba',

    'settings.title': 'Nastavení',
    'settings.helpTitle': 'K čemu tato záložka slouží',
    'settings.helpBody': 'Nakonfiguruj intervaly všech background skenů, dashboard thresholdy a IP které vidí UI. Vše se ukládá do DB a aktivuje se live — bez restart služby. Periodické checks: jak často scheduler běží, ve které dny a čase, a které checks zahrnout. Manuální Run all běží i mimo window. Network access: Windows Firewall whitelist pro inbound 4000. Pozor: smazání tvé IP tě uzamkne. Disk thresholdy: když volné % nebo GB klesnou pod threshold, disk se na dashboardu označí Critical/Warning.',
    'settings.unsaved': 'neuložené změny',
    'settings.saved': 'Uloženo',
    'settings.saving': 'Ukládám…',

    'settings.section.periodic': 'Periodické checks',
    'settings.section.periodicDesc': 'Jeden scheduler spouští vybrané checks v pořadí. Změny se aplikují okamžitě, restart služby není potřeba.',
    'settings.section.perfLookback': 'Perf-events lookback',
    'settings.section.perfLookbackDesc': 'Jak hluboko zpět skenovat při prvním sweep PC (cold-start). Následující sweepy jdou inkrementálně od poslední uložené události.',
    'settings.section.inactive': 'Neaktivní PC threshold',
    'settings.section.inactiveDesc': 'Kolik dnů bez AD LastLogon označí počítač jako neaktivní. Používá to Dashboard karta "Neaktivní PC" a filtr chip v Computers tabu.',
    'settings.field.inactiveDays': 'Threshold (dny)',
    'settings.section.pcUserHistory': 'Retence historie přihlášení',
    'settings.section.pcUserHistoryDesc': 'Kolik dnů ukládat historii přihlášených uživatelů per PC. Aktualizováno při každém disk skenu. Mažeme přes sp_purge_pc_user_history v noční retenční úloze.',
    'settings.field.pcUserHistoryDays': 'Retence (dny)',
    'settings.section.eventRetention': 'Retence událostí + dedup',
    'settings.section.eventRetentionDesc': 'Denní úloha (v zadanou hodinu serverového času) maže staré řádky a duplikáty. Mažeme přes sp_purge_old_events, sp_purge_old_activity, sp_purge_duplicate_events.',
    'settings.field.eventsRetentionDays': 'Retence events (dny)',
    'settings.field.activityRetentionDays': 'Retence activity log (dny)',
    'settings.field.retentionRunHour': 'Spustit denně v hodině',
    'settings.field.eventsDedupEnabled': 'Zahrnout dedup ve scheduled run',
    'settings.field.eventsDedupLookback': 'Dedup lookback (dny)',
    'settings.field.eventRetentionHelp': 'Collector používá time watermark s inclusive StartTime — hraničních eventů se může inzertovat víc instancí. Dedup pass je drží na uzdě. Lookback typicky = retence events.',
    'settings.unit.hour24': 'h (0-23)',
    'settings.retention.manualHeader': '🔧 Ruční spuštění',
    'settings.retention.manualHint': 'Toto tlačítko spustí ad-hoc retenci MIMO scheduled cron. Automaticky se spouští denně v hodině zadané výše ("Spustit denně v hodině"). Vrchní checkbox "Zahrnout dedup ve scheduled run" ovlivňuje jen automatický scheduled běh — manual run respektuje zaškrtnutí níže.',
    'settings.retention.pickSteps': 'Vyber co spustit (zaškrtnuté kroky se spustí v pořadí, ostatní se přeskočí):',
    'settings.retention.runSelected': '▶ Spustit označené ({n})',
    'settings.retention.running': 'Běží…',
    'settings.retention.next': 'Další scheduled run',
    'settings.retention.lastRun': 'Poslední běh ({source}) {when} — celkem {dur}s',
    'settings.retention.col.step': 'Krok',
    'settings.retention.col.detail': 'Detail',
    'settings.retention.col.rows': 'Řádky smazáno',
    'settings.retention.col.duration': 'Čas',
    'settings.retention.col.status': 'Stav',
    'settings.retention.step.events_purge.label': 'Mazat staré události',
    'settings.retention.step.events_purge.desc': 'sp_purge_old_events smaže řádky z tabulky events starší než "Retence events"',
    'settings.retention.step.activity_log_purge.label': 'Mazat starý activity log',
    'settings.retention.step.activity_log_purge.desc': 'sp_purge_old_activity smaže řádky z tabulky activity_log starší než "Retence activity log"',
    'settings.retention.step.pc_user_history_purge.label': 'Mazat starou PC user history',
    'settings.retention.step.pc_user_history_purge.desc': 'sp_purge_pc_user_history smaže řádky z tabulky pc_user_history starší než hodnota výše v sekci "Retence historie přihlášení"',
    'settings.retention.step.events_dedup.label': 'Mazat duplicitní eventy',
    'settings.retention.step.events_dedup.desc': 'sp_purge_duplicate_events ponechá první výskyt každé skupiny duplicit a smaže ostatní v okně "Dedup lookback"',

    'userHistory.title': 'Historie přihlášení',
    'userHistory.user': 'Uživatel',
    'userHistory.firstSeen': 'První viděn',
    'userHistory.lastSeen': 'Naposledy viděn',
    'userHistory.duration': 'Trvání',
    'userHistory.empty': 'Žádné záznamy v dané retenci.',
    'userHistory.close': 'Zavřít',
    'userHistory.ip': 'IP v té době',

    'actions.title': 'Akce',
    'actions.hint': 'Browser nemůže přímo spustit příkazy — používáme copy-to-clipboard (paste do Win+R) nebo .bat / .rdp download (double-click v Stáhlé).',
    'actions.section.remote': 'Vzdálená MMC správa',
    'actions.section.access': 'Vzdálený přístup',
    'actions.section.shares': 'Admin shares (disky)',
    'actions.section.copy': 'Kopírovat',
    'actions.compmgmt': 'Správa počítače (Computer Management)',
    'actions.services': 'Služby (services.msc)',
    'actions.eventvwr': 'Prohlížeč událostí (eventvwr.msc)',
    'actions.taskschd': 'Plánovač úloh (taskschd.msc)',
    'actions.rdp': 'RDP (mstsc)',
    'actions.psexec': 'CMD na vzdáleném PC (PsExec)',
    'actions.psRemote': 'PowerShell Remote (Enter-PSSession)',
    'actions.hostname': 'Hostname',
    'actions.fqdn': 'FQDN',
    'actions.ip': 'IP adresa',
    'actions.copy': 'Kopírovat',
    'actions.copyCmd': 'Kopírovat příkaz',
    'actions.copyUnc': 'Kopírovat UNC',
    'actions.downloadFile': 'Stáhnout',
    'actions.downloadBat': 'Stáhnout .bat',
    'actions.openShareBat': 'Otevřít přes .bat',
    'actions.noDisks': 'Žádné disky zaznamenané (sken ještě neproběhl).',
    'actions.copied': 'Zkopírováno do schránky',
    'actions.downloaded': 'Staženo — spusť z Downloads',
    'actions.failed': 'Akce selhala',
    'actions.launch': '🚀 Spustit',
    'actions.installBanner': 'Pro 1-click "Spustit" zaregistruj URL handlery (itd-mmc://, itd-rdp://, itd-ps://, …) na svém PC. Stačí jednou — bez instalace funguje copy/download pod každým řádkem.',
    'actions.installDownload': 'Stáhnout installer',
    'actions.installCopyPerUser': 'Kopírovat PS pro tento PC',
    'actions.installCopyMachine': 'Kopírovat PS pro celou stanici (admin)',
    'actions.installCopiedPerUser': 'PS one-liner zkopírovaný — paste do PowerShellu a Enter (instaluje pro tvůj Windows účet)',
    'actions.installCopiedMachine': 'PS one-liner zkopírovaný — paste do PowerShellu, UAC prompt na admin, jeden install pokryje VŠECHNY Windows účty na téhle stanici',
    'actions.installScopeHint': 'Per-user (HKCU) = každý IT specialista jednou na svém PC. /machine (HKLM) = admin jednou na stanici → všichni uživatelé té stanice.',
    'auth.modalTitle': 'Přihlášení admin účtu',
    'auth.modalHint': 'Dashboard si dočasně uloží tyto credentials pro tvojí browser-session. Každý další klik na Launch v Akcích automaticky použije tyto credentials — žádné per-launch zadávání hesla.',
    'auth.user': 'Uživatel',
    'auth.password': 'Heslo',
    'auth.signIn': 'Přihlásit',
    'auth.signingIn': 'Přihlašuji…',
    'auth.cancel': 'Zrušit',
    'auth.invalidCredentials': 'Neplatné credentials. Zkontroluj username (DOMAIN\\user nebo user@domain) a heslo.',
    'auth.notInEditGroup': 'Účet je platný, ale není členem skupiny s edit oprávněním ({detail}). Kontaktuj admina pro přidání do AD skupiny pro ITDashboard editory.',
    'auth.error': 'Chyba: {detail}',
    'auth.modalFooter': 'Auth režim: {mode}. Session timeout: 30 min idle, max 8 h. Heslo se nikdy neukládá na disk.',
    'actions.installedNote': 'Po instalaci browser jednou zeptá "Povolit otevírat tyto odkazy?" — DOPORUČUJEME NEZAŠKRTÁVAT "Vždy povolit". Per-klik prompt je druhá vrstva obrany proti tomu aby cizí webová stránka zneužila tvůj zaregistrovaný protokol.',
    'actions.psexecOptIn': 'PsExec handler se neinstaluje by default (spouští cmd jako SYSTEM na cílovém PC). Pro opt-in spusť installer s argumentem /with-psexec.',
    'actions.validationNote': 'Všechny launchery odmítnou hostname obsahující cokoliv jiného než písmena, číslice, tečku, pomlčku nebo podtržítko (max 63 znaků).',
    'actions.followupNote': 'Follow-up bezpečnostní review potvrdilo: handler je OK k nasazení; Explorer launch záměrně otevírá jen admin shares typu C$ / D$ a ITD_ADMIN_USER znamená očekávaný runas /netonly prompt na heslo.',
    'actions.reinstallNote': 'Když po kliknutí jen krátce blikne CMD okno, stáhni a spusť installer znovu. Nová verze přegeneruje HKCU launchery, drží .cmd v CRLF a při chybě nechá okno otevřené s logem v %LOCALAPPDATA%\\ITDashboard\\launchers.',
    'actions.consoleHardeningNote': 'Oponentura 4 (2026-06-03): chybový výstup launcheru už nezobrazuje raw URL na konzoli (eliminace console reflected injection přes ANSI escape v URL). Ukazuje jen validovaná pole (reason, host, letter). Plné URL je dál v last-itd-*.log pro helpdesk.',
    'actions.refreshTitle': 'Aktualizovat data jednoho PC',
    'actions.refreshDesc': 'Spustí všechny collectory (disk + uživatel + IP, služby, eventlog, perf-events) pouze proti tomuto stroji. Užitečné když chceš mít čerstvá data před tím než s tím PC začneš pracovat.',
    'actions.refreshNow': '🔄 Aktualizovat teď',
    'actions.refreshing': 'Aktualizuji…',
    'actions.refreshDone': 'Aktualizováno za {sec}s',
    'actions.refreshFailed': 'Aktualizace selhala',
    'actions.adminUserHint': 'ITD_ADMIN_USER env variable (User Environment Variables) má 3 módy. DEFAULT (nenastavená env var) = ASK: pro každý launch CMD nejprve vyzve k zadání admin účtu (prázdné poprvé, příště pre-fill posledně zadaného z %LOCALAPPDATA%\\ITDashboard\\launchers\\last-admin-user.txt — Enter potvrdí), pak Windows credential dialog na heslo. Heslo se NIKDY nepamatuje. Pro PowerShell Remote launcher se použije Get-Credential single-dialog s oběma poli. — Override: ITD_ADMIN_USER=AXINETWORK\\trnka_admin pro fixní pre-fill (single-admin workstation, dialog žádá jen heslo). — Opt-in: ITD_ADMIN_USER=current spustí launchery jako tvůj přihlášený účet bez admin wrapu (rychlejší ale typicky bez práv na cíli). Default ask je správný pro multi-admin workstation kde víc IT specialistů sdílí PC — žádný setup per-user.',
    'settings.section.adsync': 'AD sync default',
    'settings.section.adsyncDesc': 'Aplikuje se když AD sync objeví nový počítač (existující PC si ponechají aktuální monitor flag — operator intent perzistuje napříč syncs).',
    'settings.section.network': 'Přístup k UI dashboardu',
    'settings.section.networkDesc': 'Uvedené IP / CIDR vidí UI dashboardu. Ostatní IP dostanou obrazovku "access not configured" při načtení. JSON API, bundle download a stránka /docs zůstávají dostupné komukoliv na interní síti — tohle je UX brána proti incidentálnímu objevení UI non-IT uživateli, ne bezpečnostní hranice. Whitelist se také zrcadlí do Windows Firewall rule "ITDashboard API (4000)", ale ta může být inertní pokud je Domain firewall profile vypnutý.',
    'settings.section.disk': 'Disk space thresholdy',
    'settings.section.diskDesc': 'Když disk klesne pod tyto hodnoty, označí se na dashboardu.',

    'settings.field.runEvery': 'Spouštět každých',
    'settings.field.days': 'Dny',
    'settings.field.windowFrom': 'Okno od',
    'settings.field.windowTo': 'Okno do',
    'settings.field.coldStart': 'Cold-start lookback (dny)',
    'settings.field.coldStartHelp': 'Default 30. Workstationy se rebootují málo často — 7-day okno často míjí poslední boot. Rozsah 1–365.',
    'settings.field.newPcsMonitored': 'Nové PC defaultně monitorované (Monitor = on)',
    'settings.field.runAllAlwaysSyncs': '"Run all checks" vždy zahrne AD sync nezávisle na checkboxu výše.',
    'settings.field.thresholdMode': 'Threshold režim',
    'settings.field.criticalPct': 'Critical (% volného)',
    'settings.field.warningPct': 'Warning (% volného)',
    'settings.field.criticalGb': 'Critical (GB volného)',
    'settings.field.warningGb': 'Warning (GB volného)',
    'settings.field.evalDriveLetters': 'Vyhodnocované disky (písmena)',
    'settings.field.evalDriveLettersHelp': 'Která písmena disků se zahrnují do vyhodnocení critical / warning. Default "C" (jen systémový disk). Comma-separated např. "C,D" nebo "C,D,E". Prázdné nebo "*" = vyhodnoť všechny disky (původní chování). Disky mimo seznam jsou v Disks sloupci stále vidět ale nemění status PC. Aplikuje se na obojí — critical i warning.',

    'settings.check.eventlog': 'Eventlog collector',
    'settings.check.disk': 'Disk scan',
    'settings.check.services': 'Services scan',
    'settings.check.perf': 'Perf events (pomalý boot/shutdown)',
    'settings.check.adsync': 'AD sync (defaultně off v periodic)',

    'settings.thresholdMode.pct': 'Pouze procenta volného',
    'settings.thresholdMode.gb': 'Pouze GB volného',
    'settings.thresholdMode.either': 'Oboje (přísnější vyhrává)',

    'settings.unit.seconds': 'sekundy',
    'settings.unit.minutes': 'minuty',
    'settings.unit.hours': 'hodiny',
    'settings.unit.days': 'dnů',

    'settings.day.mo': 'Po',
    'settings.day.tu': 'Út',
    'settings.day.we': 'St',
    'settings.day.th': 'Čt',
    'settings.day.fr': 'Pá',
    'settings.day.sa': 'So',
    'settings.day.su': 'Ne',

    'settings.network.oneLine': 'Jeden záznam na řádek (IP nebo CIDR, např. 10.8.2.50 nebo 10.8.2.0/24)',
    'settings.network.loading': 'Načítám aktuální whitelist…',
    'settings.network.apply': 'Aplikovat',
    'settings.network.current': 'Aktuální',
    'settings.network.savedIps': 'Uloženo {n} IP záznamů',
    'settings.network.firewallEnabled': 'Windows Firewall — Domain profile: zapnutý',
    'settings.network.firewallDisabled': 'Windows Firewall — Domain profile: VYPNUTÝ',
    'settings.network.firewallUnknown': 'Windows Firewall — Domain profile: neznámý',
    'settings.network.firewallDisabledBody': 'OS-level rule "ITDashboard API (4000)" je inertní. UI access je gated jen frontend whitelistem. K obnovení defense-in-depth na 10.8.2.213:',
    'settings.network.firewallDisabledGpo': 'Nejprve zkontroluj GPO — může být enforced disabled doménovou policy. Default inbound: ',
    'settings.network.firewallReadError': 'Nelze přečíst stav Domain profile: ',
  },
  en: {
    'nav.dashboard': 'Dashboard',
    'nav.events': 'Events',
    'nav.computers': 'Computers',
    'nav.services': 'Services',
    'nav.perf': 'Perf',
    'nav.activity': 'Activity',
    'nav.settings': 'Settings',
    'nav.docs': 'Docs',

    'topbar.api': 'API',
    'topbar.lang': 'Language',
    'topbar.theme': 'Theme',
    'topbar.theme.dark': 'Dark',
    'topbar.theme.light': 'Light',

    'status.connected': 'Connected',
    'status.lastRefresh': 'Last refresh',
    'status.autoEvery': 'auto every',

    'cards.critical': 'Critical events (24h)',
    'cards.errors': 'Errors (24h)',
    'cards.warnings': 'Warnings (24h)',
    'cards.unreachable': 'Unreachable',
    'cards.diskCritical': 'Disk critical',
    'cards.diskWarning': 'Disk warning',
    'cards.stoppedServices': 'Stopped services',
    'cards.slowBootShutdown': 'Slow boot/shutdown (7d)',
    'cards.inactive': 'Inactive PCs',
    'cards.inactiveSub': '{enabled} enabled · {disabled} disabled',
    'cards.computers': 'Computers',

    'dashboard.help.title': 'What this dashboard shows',
    'dashboard.help.intro': 'Summary overview of fleet health. Each card is clickable and drills down to the relevant tab with the appropriate filter pre-applied.',
    'dashboard.help.bullet.events': 'Critical / Errors / Warnings (24h) — click → Events tab pre-filtered by level',
    'dashboard.help.bullet.unreachable': 'Unreachable — PCs where collectors fail; subtitle breaks down offline / RPC fail / auth → Computers tab',
    'dashboard.help.bullet.disk': 'Disk critical / warning — PCs with drives below thresholds → Computers tab',
    'dashboard.help.bullet.services': 'Stopped services — PCs with non-noise stopped auto-services → Services tab',
    'dashboard.help.bullet.inactive': 'Inactive PCs (Nd+) — PCs with LastLogon older than threshold → Computers tab with inactive filter',
    'dashboard.help.bullet.computers': 'Computers — active / total inventory → Computers tab',
    'dashboard.help.collector': 'Collector bar shows live progress of the eventlog scan (▶ Run now / ⏹ Stop) and can run all checks sequentially (eventlog → disk → services).',
    'dashboard.help.footer': 'The detailed lists (Events, Computers, Services, Activity, Settings) have their own tabs.',

    'help.tabTitle': 'What this tab shows',

    'events.help.intro': 'Full-width raw events table from System and Application logs across every monitored PC. Fed by the eventlog collector over RPC.',
    'events.help.filters': 'Filters (combined with AND — all must match at once): 🔍 Search matches message + PC + event ID as substring (case-insensitive). 🖥 Computer = single-select dropdown (default "All computers"). 🏷 Provider = source component (e.g. "Brother BrLog"). 🔢 Event ID input — single (4098), inclusive range (4000..8000 or 4000-8000), or comma list (1001,4098,7031). Invalid input = filter ignored (red border). ⚠ Level = Critical / Error / Warning. ⏱ Time range = last N hours. Clear a filter = reset dropdown to default / clear search. Click a column to sort. Click a row for the detail view with the full message and raw XML.',
    'events.help.noise': 'Application log carries a lot of noise (Office crashes, WMI). For signal stick to Critical, or check the "Top event IDs" aggregate on the Dashboard.',

    'computers.help.intro': 'Full inventory of domain PCs with operator controls. Refreshed by AD sync; other columns come from the collectors.',
    'computers.help.chips': 'Status chips in the header are clickable filter pills: active, monitored, unmonitored, failing (consecutive_failures > 0), disk critical/warning, inactive (Nd+), disabled, excluded.',
    'computers.help.monitor': 'Monitor checkbox controls whether collectors poll this PC. Persists across AD syncs. Exclude = hard skip even from Dashboard stats. Click the User cell to open login history.',
    'computers.help.actions': 'Buttons: ↻ Sync from AD (re-run Get-ADComputer + MERGE), 🩺 Scan disks (manual disk scan), ✓ All / ✗ None (bulk Monitor toggle, respects current filter).',

    'services.help.intro': 'Detects Windows services with StartMode = Automatic but State ≠ Running across all monitored PCs. Filters legitimate cases (Trigger / Delayed / per-user) and matches the rest against a policy table.',
    'services.help.views': '📋 By PC view = flat list of problems. 📊 By service view = aggregate "this service is stopped on N PCs". Classification: OK (matches policy, complies), Drift (matches, does not comply), Unclassified (no policy match).',
    'services.help.actions': 'Filters (combined with AND): ⚠ Only ExitCode != 0 (DEFAULT ON, primary signal — hides graceful exits), Hide trigger-start (default ON, but only hides graceful trigger-start; a trigger-start that crashed with exit != 0 always surfaces), Hide delayed-start (same logic), Hide per-user (default ON), Hide compliant. The Exit column shows the Win32 ExitCode — 0 = graceful, != 0 = SCM-level crash (red). The header shows "⚠ N crashes" as the primary metric. 🔧 Scan services = manual run. 📤 GPO script = downloads PowerShell for fleet-wide remediation via GPO startup script.',

    'perf.help.intro': 'Slow boot / shutdown / standby / resume events from the Microsoft-Windows-Diagnostics-Performance/Operational channel. Not a continuous CPU graph — only the outliers Windows itself flagged as degraded.',
    'perf.help.ids': 'Event ID ranges: 100–199 boot · 200–299 shutdown · 300–399 standby · 400–499 resume. Cold-start sweep pulls last N days (default 30, configurable in Settings).',
    'perf.help.serverNote': 'Channel is off by default on Windows Server SKU. Servers show up as "channel-disabled" in the aggregate. To enable: GPO startup script wevtutil sl Microsoft-Windows-Diagnostics-Performance/Operational /e:true.',

    'activity.live.help.intro': 'Real-time stream of every background action: eventlog collector, AD sync, disk scan, services scan, perf scan, firewall changes, IP guard. Polled every 2s.',
    'activity.live.help.tags': 'Source tags: [checks], [collector], [disk], [services], [perf], [ad-sync], [firewall], [access-check], [retention]. Levels: Success (green), Info (dim), Warning (amber), Error (red).',
    'activity.live.help.buffer': 'Buffer is in-memory (last 500 entries), lost on service restart. 📋 Copy exports filtered lines as tab-separated text. 📚 History switches to DB-backed persistent search.',

    'activity.history.help.intro': 'Persistent activity history — every logActivity call is fire-and-forget INSERTed into the activity_log table. Survives service restart. Default retention 30 days (Settings → activity.retention_days).',
    'activity.history.help.filters': 'Filters: time range, level, source dropdown (populated from last 30 days of actual sources), free-text message search. Returns up to {limit} matching rows per page; use pager for more.',
    'activity.history.help.live': 'Switch back to Live for the in-memory ring buffer (last 500 entries, polled every 2s).',

    'btn.refresh': 'Refresh',
    'btn.runAll': 'Run all',
    'btn.runNow': 'Run now',
    'btn.stop': 'Stop',
    'btn.scan': 'Scan',
    'btn.save': 'Save',
    'btn.copy': 'Copy',
    'btn.history': 'History',
    'btn.live': 'Live',
    'btn.pause': 'Pause',
    'btn.resume': 'Resume',
    'btn.clear': 'Clear',

    'common.search': 'Search…',
    'common.all': 'All',
    'common.noData': 'no data',
    'common.loading': 'Loading…',
    'common.lastSeen': 'Last seen',
    'common.lastError': 'Last error',

    'settings.title': 'Settings',
    'settings.helpTitle': 'What this tab does',
    'settings.helpBody': 'Configure all background-scan intervals, dashboard thresholds, and which IPs may reach the API. All settings persist in the DB and apply live — no service restart needed. Periodic checks: how often the scheduler runs, on which days/time window, and which checks are included. Manual Run all is still allowed outside the window. Network access: Windows Firewall whitelist for inbound 4000. Be careful: removing your own IP locks you out. Disk space thresholds: when a drive\'s free % or GB drops below the threshold, it\'s flagged Critical / Warning.',
    'settings.unsaved': 'unsaved change(s)',
    'settings.saved': 'Saved',
    'settings.saving': 'Saving…',

    'settings.section.periodic': 'Periodic checks',
    'settings.section.periodicDesc': 'One scheduler runs selected checks in order. Changes apply immediately, no service restart needed.',
    'settings.section.perfLookback': 'Perf-events lookback',
    'settings.section.perfLookbackDesc': 'How far back to scan on the very first sweep of a PC (cold-start). Subsequent sweeps go incrementally from the last collected event.',
    'settings.section.inactive': 'Inactive PC threshold',
    'settings.section.inactiveDesc': 'How many days without AD LastLogon flag a computer as inactive. Used by the Dashboard "Inactive PCs" card and the Computers tab "inactive" filter chip.',
    'settings.field.inactiveDays': 'Threshold (days)',
    'settings.section.eventRetention': 'Event retention + dedup',
    'settings.section.eventRetentionDesc': 'Daily job (at the configured server-local hour) deletes old rows and duplicates. Uses sp_purge_old_events, sp_purge_old_activity, sp_purge_duplicate_events.',
    'settings.field.eventsRetentionDays': 'Events retention (days)',
    'settings.field.activityRetentionDays': 'Activity log retention (days)',
    'settings.field.retentionRunHour': 'Run daily at hour',
    'settings.field.eventsDedupEnabled': 'Include dedup in scheduled run',
    'settings.field.eventsDedupLookback': 'Dedup lookback (days)',
    'settings.field.eventRetentionHelp': 'Collector uses a time watermark with inclusive StartTime — boundary events may be inserted twice. The dedup pass cleans them up. Lookback typically = events retention.',
    'settings.unit.hour24': 'h (0-23)',
    'settings.retention.manualHeader': '🔧 Manual run',
    'settings.retention.manualHint': 'This button triggers an ad-hoc retention pass OUTSIDE the scheduled cron. The scheduler runs automatically each day at the hour set above ("Run daily at hour"). The "Include dedup in scheduled run" checkbox above only affects the automatic scheduled pass — a manual run respects the checkboxes below.',
    'settings.retention.pickSteps': 'Pick what to run (checked steps run in order, others are skipped):',
    'settings.retention.runSelected': '▶ Run selected ({n})',
    'settings.retention.running': 'Running…',
    'settings.retention.next': 'Next scheduled run',
    'settings.retention.lastRun': 'Last run ({source}) {when} — total {dur}s',
    'settings.retention.col.step': 'Step',
    'settings.retention.col.detail': 'Detail',
    'settings.retention.col.rows': 'Rows deleted',
    'settings.retention.col.duration': 'Duration',
    'settings.retention.col.status': 'Status',
    'settings.retention.step.events_purge.label': 'Delete old events',
    'settings.retention.step.events_purge.desc': 'sp_purge_old_events removes rows from events table older than "Events retention"',
    'settings.retention.step.activity_log_purge.label': 'Delete old activity log',
    'settings.retention.step.activity_log_purge.desc': 'sp_purge_old_activity removes rows from activity_log older than "Activity log retention"',
    'settings.retention.step.pc_user_history_purge.label': 'Delete old PC user history',
    'settings.retention.step.pc_user_history_purge.desc': 'sp_purge_pc_user_history removes rows from pc_user_history older than the "PC user history retention" value above',
    'settings.retention.step.events_dedup.label': 'Delete duplicate events',
    'settings.retention.step.events_dedup.desc': 'sp_purge_duplicate_events keeps the first occurrence of each duplicate group, deletes the rest within "Dedup lookback"',
    'settings.section.pcUserHistory': 'PC user history retention',
    'settings.section.pcUserHistoryDesc': 'How many days to keep per-PC interactive login history. Recorded on every disk scan when a user is logged in. Purged by sp_purge_pc_user_history in the nightly retention job.',
    'settings.field.pcUserHistoryDays': 'Retention (days)',

    'userHistory.title': 'Login history',
    'userHistory.user': 'User',
    'userHistory.firstSeen': 'First seen',
    'userHistory.lastSeen': 'Last seen',
    'userHistory.duration': 'Duration',
    'userHistory.empty': 'No records within retention window.',
    'userHistory.close': 'Close',
    'userHistory.ip': 'IP at that time',

    'actions.title': 'Actions',
    'actions.hint': 'Browser cannot run native commands directly — we use copy-to-clipboard (paste into Win+R) or .bat / .rdp downloads (double-click in Downloads).',
    'actions.section.remote': 'Remote MMC management',
    'actions.section.access': 'Remote access',
    'actions.section.shares': 'Admin shares (drives)',
    'actions.section.copy': 'Copy',
    'actions.compmgmt': 'Computer Management',
    'actions.services': 'Services (services.msc)',
    'actions.eventvwr': 'Event Viewer (eventvwr.msc)',
    'actions.taskschd': 'Task Scheduler (taskschd.msc)',
    'actions.rdp': 'RDP (mstsc)',
    'actions.psexec': 'CMD on remote PC (PsExec)',
    'actions.psRemote': 'PowerShell Remote (Enter-PSSession)',
    'actions.hostname': 'Hostname',
    'actions.fqdn': 'FQDN',
    'actions.ip': 'IP address',
    'actions.copy': 'Copy',
    'actions.copyCmd': 'Copy command',
    'actions.copyUnc': 'Copy UNC',
    'actions.downloadFile': 'Download',
    'actions.downloadBat': 'Download .bat',
    'actions.openShareBat': 'Open via .bat',
    'actions.noDisks': 'No drives recorded yet (scan has not run).',
    'actions.copied': 'Copied to clipboard',
    'actions.downloaded': 'Downloaded — launch from Downloads',
    'actions.failed': 'Action failed',
    'actions.launch': '🚀 Launch',
    'actions.installBanner': 'For 1-click "Launch", register URL handlers (itd-mmc://, itd-rdp://, itd-ps://, …) on your PC. Run once — without install, copy / download under each row still works.',
    'actions.installDownload': 'Download installer',
    'actions.installCopyPerUser': 'Copy PS for this PC',
    'actions.installCopyMachine': 'Copy PS for whole workstation (admin)',
    'actions.installCopiedPerUser': 'PS one-liner copied — paste into PowerShell and Enter (installs for your Windows account)',
    'actions.installCopiedMachine': 'PS one-liner copied — paste into PowerShell, UAC prompt for admin, one install covers ALL Windows accounts on this workstation',
    'actions.installScopeHint': 'Per-user (HKCU) = each IT specialist runs once on their PC. /machine (HKLM) = admin runs once per workstation → all users on that workstation.',
    'auth.modalTitle': 'Admin sign-in',
    'auth.modalHint': 'Dashboard temporarily caches these credentials for your browser session. Every subsequent Launch click in Actions automatically uses these credentials — no per-launch password prompt.',
    'auth.user': 'Username',
    'auth.password': 'Password',
    'auth.signIn': 'Sign in',
    'auth.signingIn': 'Signing in…',
    'auth.cancel': 'Cancel',
    'auth.invalidCredentials': 'Invalid credentials. Check username (DOMAIN\\user or user@domain) and password.',
    'auth.notInEditGroup': 'Account is valid but is not a member of the edit-permission group ({detail}). Ask an admin to add you to the ITDashboard editors AD group.',
    'auth.error': 'Error: {detail}',
    'auth.modalFooter': 'Auth mode: {mode}. Session timeout: 30 min idle, 8 h hard max. Password is never written to disk.',
    'actions.installedNote': 'After install, browser asks once "Allow this site to open these links?" — DO NOT tick "Always allow". Per-click prompt is your second defense layer against unrelated websites probing your registered protocol.',
    'actions.psexecOptIn': 'PsExec handler is NOT installed by default (it spawns cmd as SYSTEM on the remote). To opt in, run installer with /with-psexec.',
    'actions.validationNote': 'All launchers reject hostnames containing anything other than letters, digits, dot, dash or underscore (max 63 chars).',
    'actions.followupNote': 'Follow-up security review confirmed: the handler is OK to deploy; Explorer launch intentionally opens only admin shares such as C$ / D$, and ITD_ADMIN_USER means an expected runas /netonly password prompt.',
    'actions.reinstallNote': 'If clicking Launch only flashes a CMD window, download and run the installer again. The new version regenerates HKCU launchers, keeps .cmd files CRLF, and leaves the window open on failure with a log under %LOCALAPPDATA%\\ITDashboard\\launchers.',
    'actions.consoleHardeningNote': 'Oponentura 4 (2026-06-03): launcher fail screens no longer echo the raw URL to the console (console reflected injection via ANSI escape in URL eliminated). They show only validated fields (reason, host, letter). Full URL is still recorded in last-itd-*.log for helpdesk.',
    'actions.refreshTitle': 'Refresh data for this PC',
    'actions.refreshDesc': 'Runs all collectors (disk + user + IP, services, eventlog, perf-events) against this machine only. Useful when you want fresh data right before you start working with the PC.',
    'actions.refreshNow': '🔄 Refresh now',
    'actions.refreshing': 'Refreshing…',
    'actions.refreshDone': 'Refreshed in {sec}s',
    'actions.refreshFailed': 'Refresh failed',
    'actions.adminUserHint': 'ITD_ADMIN_USER env variable (User Environment Variables) has 3 modes. DEFAULT (env var unset) = ASK: each launch first prompts in CMD for the admin account (empty the first time, pre-fills the last entered user from %LOCALAPPDATA%\\ITDashboard\\launchers\\last-admin-user.txt on next runs — Enter confirms), then the Windows credential dialog for the password. Password is NEVER remembered. The PowerShell Remote launcher uses Get-Credential single-dialog with both fields. — Override: ITD_ADMIN_USER=AXINETWORK\\trnka_admin for fixed pre-fill (single-admin workstation, dialog only asks for password). — Opt-in: ITD_ADMIN_USER=current runs launchers as your logged-in account with no admin wrap (faster but typically no rights on target). Default ask is the right pick for multi-admin workstations where several IT specialists share one PC — no per-user setup needed.',
    'settings.section.adsync': 'AD sync defaults',
    'settings.section.adsyncDesc': 'Applied when AD sync discovers a new computer (existing PCs keep their current monitor flag — operator intent persists across syncs).',
    'settings.section.network': 'Dashboard UI access',
    'settings.section.networkDesc': 'Listed IPs / CIDRs see the dashboard UI. Other IPs get an "access not configured" screen on load. The JSON API, the bundle download, and the /docs page stay reachable to anyone on the internal network — this is a UX gate to prevent incidental UI discovery by non-IT users, not a security boundary. Whitelist also mirrors into the Windows Firewall rule "ITDashboard API (4000)" but that rule may be inert if the Domain firewall profile is off.',
    'settings.section.disk': 'Disk space thresholds',
    'settings.section.diskDesc': 'When a disk drops below these levels, it\'s flagged on the dashboard.',

    'settings.field.runEvery': 'Run every',
    'settings.field.days': 'Days',
    'settings.field.windowFrom': 'Window from',
    'settings.field.windowTo': 'Window to',
    'settings.field.coldStart': 'Cold-start lookback (days)',
    'settings.field.coldStartHelp': 'Default 30. Workstations are typically rebooted infrequently — a 7-day window often misses the previous boot\'s events. Range 1–365.',
    'settings.field.newPcsMonitored': 'New PCs default to monitored (Monitor = on)',
    'settings.field.runAllAlwaysSyncs': '"Run all checks" always includes AD sync regardless of the periodic checkbox above.',
    'settings.field.thresholdMode': 'Threshold mode',
    'settings.field.criticalPct': 'Critical (% free)',
    'settings.field.warningPct': 'Warning (% free)',
    'settings.field.criticalGb': 'Critical (GB free)',
    'settings.field.warningGb': 'Warning (GB free)',
    'settings.field.evalDriveLetters': 'Evaluated drives (letters)',
    'settings.field.evalDriveLettersHelp': 'Which drive letters participate in the critical / warning evaluation. Default "C" (system drive only). Comma-separated e.g. "C,D" or "C,D,E". Empty or "*" = evaluate all drives (legacy behavior). Drives outside the list still show in the Disks column but do not change the PC status. Applies to BOTH critical and warning.',

    'settings.check.eventlog': 'Eventlog collector',
    'settings.check.disk': 'Disk scan',
    'settings.check.services': 'Services scan',
    'settings.check.perf': 'Perf events (slow boot/shutdown)',
    'settings.check.adsync': 'AD sync (off by default in periodic)',

    'settings.thresholdMode.pct': 'Percent free only',
    'settings.thresholdMode.gb': 'GB free only',
    'settings.thresholdMode.either': 'Either (most strict wins)',

    'settings.unit.seconds': 'seconds',
    'settings.unit.minutes': 'minutes',
    'settings.unit.hours': 'hours',
    'settings.unit.days': 'days',

    'settings.day.mo': 'Mo',
    'settings.day.tu': 'Tu',
    'settings.day.we': 'We',
    'settings.day.th': 'Th',
    'settings.day.fr': 'Fr',
    'settings.day.sa': 'Sa',
    'settings.day.su': 'Su',

    'settings.network.oneLine': 'One per line (IP or CIDR, e.g. 10.8.2.50 or 10.8.2.0/24)',
    'settings.network.loading': 'Loading current whitelist…',
    'settings.network.apply': 'Apply',
    'settings.network.current': 'Current',
    'settings.network.savedIps': 'Saved {n} IP entries',
    'settings.network.firewallEnabled': 'Windows Firewall — Domain profile: enabled',
    'settings.network.firewallDisabled': 'Windows Firewall — Domain profile: DISABLED',
    'settings.network.firewallUnknown': 'Windows Firewall — Domain profile: unknown',
    'settings.network.firewallDisabledBody': 'The OS-level rule "ITDashboard API (4000)" is inert. UI access is gated by the frontend whitelist only. To restore defense-in-depth on 10.8.2.213:',
    'settings.network.firewallDisabledGpo': 'Check GPO first — may be enforced disabled by domain policy. Default inbound: ',
    'settings.network.firewallReadError': 'Could not read Domain profile state: ',
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type TKey = keyof (typeof dict)['en'];

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const LANG_KEY = 'itd-lang';

function detectLang(): Lang {
  const stored = (localStorage.getItem(LANG_KEY) || '').toLowerCase();
  if (stored === 'cs' || stored === 'en') return stored;
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '').toLowerCase();
  if (nav.startsWith('cs') || nav.startsWith('sk')) return 'cs';
  return 'en';
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang());
  const setLang = (next: Lang) => {
    localStorage.setItem(LANG_KEY, next);
    setLangState(next);
  };
  const t = (key: TKey, vars?: Record<string, string | number>): string => {
    let s: string = dict[lang][key] ?? dict.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return s;
  };
  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

// Theme module — exported from same file so callers import one thing.
export type Theme = 'dark' | 'light';

const THEME_KEY = 'itd-theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = (localStorage.getItem(THEME_KEY) || '').toLowerCase();
    return stored === 'light' ? 'light' : 'dark';
  });
  useEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
  }, [theme]);
  const setTheme = (next: Theme) => {
    localStorage.setItem(THEME_KEY, next);
    setThemeState(next);
  };
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
