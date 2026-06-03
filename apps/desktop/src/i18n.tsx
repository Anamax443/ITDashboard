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
    'cards.computers': 'Počítače',

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
    'cards.computers': 'Computers',

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
