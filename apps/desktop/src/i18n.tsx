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
  t: (key: TKey) => string;
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
  const t = (key: TKey): string => dict[lang][key] ?? dict.en[key] ?? key;
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
