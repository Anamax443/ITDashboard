# Reakce na oponenturu 3 - URL protocol handlers follow-up

> Datum: 2026-06-03
> Reaguje: Milan Trnka
> Oponentura: [2026-06-03-oponentura-3-protocol-handlers-followup.md](2026-06-03-oponentura-3-protocol-handlers-followup.md)
> Posuzovany commit: `e7a1aaa`

---

## TL;DR

Follow-up oponentura potvrzuje, ze kriticky RCE problem z prvni verze handleru je opraveny. Neidentifikuje novy blocker.

Status: **AKCEPTUJI jako potvrzovaci review**. Zadne urgentni code change neni potreba.

---

## Bod po bodu

### 1. `runas /netonly` heslo - AKCEPTUJI jako UX trade-off

Ano, `runas /netonly` bude pri kazdem spusteni chtit heslo. To je vlastnost Windows `runas`, ne chyba handleru.

Aktualni rozhodnuti:
- `ITD_ADMIN_USER` je optional user env var, ne default.
- Kdo chce one-click bez hesla, necha env var prazdnou a pouzije aktualne prihlaseny ucet.
- Kdo potrebuje remote admin identity, zaplati za to promptem.

Automaticke predavani hesla do skriptu nechceme. Znamenalo by to credential handling v lokalnim launcheru, coz by bylo horsi nez dnesni friction.

### 2. `itd-explorer` jen pro admin shares - POTVRZUJI jako zamer

Omezeni na jedno pismeno disku je zamerne.

Actions modal dnes generuje `itd-explorer://NAME/LETTER` z `disks` tabulky, tedy z drive letteru zjistenych kolektorem. Cilem je rychle otevrit administrativni share `C$`, `D$`, ne delat obecny UNC launcher pro libovolne sdilene slozky.

Rozsireni na `itd-explorer://host/share-name` by bylo samostatne feature request. Bezpecne by slo udelat s allowlistem pro share segment, delkovym limitem a zakazem vnorene cesty, ale ted to neni potreba.

### 3. Vnitrni quoting v `runas` command stringu - NECHAVAM beze zmeny

Reviewer ma pravdu, ze v beznem CLI kodu je explicitni quoting argumentu cistsi. Tady ale bezi tri vrstvy parseru: generating installer `.cmd` -> generated launcher `.cmd` -> `runas` command string.

Soucasny stav je bezpecny, protoze:
- snap-in (`compmgmt.msc`, `services.msc`, `eventvwr.msc`, `taskschd.msc`) neprichazi z URL ani od uzivatele,
- `host` je non-empty, max 63 znaku a matchuje pouze `[a-zA-Z0-9._-]+`,
- mezera, uvozovka, ampersand, pipe, redirection a dalsi shell metaznaky neprojdou validaci.

Bez jasneho runtime benefitu nechci riskovat regresi v `runas` quoting syntaxi. Pokud nekdy zacneme poustet argument s mezerou, tahle cast se musi prepsat cilene a otestovat na operator workstation.

---

## Rozhodnuti

- Kriticky stav: **OK k nasazeni**.
- Admin share only pro Explorer: **ponechat**.
- `ITD_ADMIN_USER` friction: **zdokumentovana vlastnost**.
- Code change: **zadny**.
- Dokumentace: oponentura + reakce archivovana.
