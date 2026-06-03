# Reakce na oponenturu 2 — URL protocol handlers (RCE)

> Datum: 2026-06-03
> Reaguje: Milan Trnka
> Oponentura: [2026-06-03-oponentura-2-protocol-handlers.md](2026-06-03-oponentura-2-protocol-handlers.md)
> Posuzovaný commit: `e0c17ad`

---

## TL;DR

**Reviewer má pravdu.** Argument injection v `install-itd-handlers.cmd` z commitu `e0c17ad` je reálná zranitelnost, ne teoretická. Installer **nepoužívat** dokud není opraven.

Status: **AKCEPTUJI VŠE** s následujícími poznámkami / volbami implementace.

---

## Bod po bodu

### 1. Argument Injection — AKCEPTUJI

> "set host=%url:itd-rdp://=% — Skript se snaží pouze odmazat itd-rdp://, ale nijak nekontroluje, co následuje."

Souhlas. Konkrétně:
- `set host=%url:itd-rdp://=%` jen string-replace, žádná validace
- `start "" mstsc.exe /v:%host%` non-quoted, expanze rozdělí na další argy
- Pro `itd-rdp://10.0.0.1 /shadow:1 /control` → `mstsc.exe /v:10.0.0.1 /shadow:1 /control` — funkční payload

PsExec a Explorer jsou ještě horší — `&`, `|` v cmd dokáží řetězit příkazy.

URL-encoding nezachrání: browser sice mezery zakóduje na `%20`, ale Windows handler může URL-decodovat před předáním do `%1`. Test na různých prohlížečích (Chrome / Edge / Firefox) by ukázal různé chování. Bezpečně předpokládat: **vstup může obsahovat cokoliv**.

**Akce:** Přepsat všechny launchery se striktní regex validací + quoted args.

### 2. "Vždy povolit" → trvalá brána z webu — AKCEPTUJI

> "Pokud jednou zaškrtneš 'Vždy povolit', jakýkoliv web na internetu může na pozadí zkoušet posílat příkazy"

Souhlas, ale zmírnění: operátor v AXINETWORKu typicky nesurfuje libovolný internet — pracovní stanice mají proxy whitelist + GPO. Risk reálně:
- BYOD / domácí PC operátora — vyšší
- Supply-chain (npm balíček v cache, externí dependency, kompromitovaný npm registry) — možné
- XSS v interní aplikaci — pokud nějakou máme

**Akce:** V banneru v UI **explicitně doporučit NEZAŠKRTÁVAT "Vždy povolit"** — nechat browser ptát se pokaždé. To je viditelná druhá vrstva obrany navíc k regex validaci.

### 3. Fix přes regex validaci — AKCEPTUJI s úpravou

Reviewer's batch fix:
```cmd
set host=%host:"=%
echo %host% | findstr /c:" " >nul && exit /b 1
```

Beru, ale rozšířím — kontrola jen na mezeru nestačí, taky `&`, `|`, `<`, `>`, `^`, `(`, `)`. Lepší **whitelist** než blacklist:

```cmd
echo %host% | findstr /R "^[a-zA-Z0-9._-][a-zA-Z0-9._-]*$" >nul
if errorlevel 1 exit /b 1
```

Pouze alfanumerické + tečka + pomlčka + podtržítko. Cokoliv jiného → exit.
Plus délkový cap (max ~63 znaků = NetBIOS limit + AD compatibility).
Plus prázdný input check.

### 4. PowerShell místo CMD — DÍLČÍ akceptace

Reviewer doporučuje PowerShell. Souhlas v principu (`Start-Process -ArgumentList` je bezpečné, regex je nativní).

**Důvod proč zůstat u CMD:**
- AXINETWORK GPO enforced AllSigned na PowerShell. `-ExecutionPolicy Bypass` může a nemusí fungovat v závislosti na konfiguraci.
- Code-signing certifikát pro skripty by chtěl deployment přes GPO — overhead.
- Installer .cmd je víc operator-friendly (double-click bez čehokoliv).

**Řešení:** Zůstanu u CMD ALE s striktní validací (whitelist regex + quoted args).
PowerShell varianta jako future enhancement pokud bude potřeba.

### 5. Credentials prompt — ODMÍTÁM jako primární mitigaci

> "nemělo by to být vázáno na credentials?"

Pochopení dotazu: měl by handler před spuštěním promptovat heslo (runas / Credentials UI)?

Pravdivá odpověď: **friction bez security benefitu, pokud injection není fixnut.**

- mmc / mstsc / explorer používají credentials přihlášeného operátora (Kerberos SSO). Nepoužívají heslo, používají token.
- runas /user:OPERATOR by jen vyžadovalo zadat svoje vlastní heslo znovu — žádný útočník není odbarvený.
- runas /user:DIFFERENT_ADMIN by jen předal heslo jiné identitě, která provede injection-attack stejně.

**Credentials prompt je security theater, dokud vstup není validován.** Po validaci je už zbytečný — vstup nemůže být škodlivý.

Kde by credentials prompt měl smysl: **PsExec**. Tam se spouští cmd s NT AUTHORITY\SYSTEM právy na cílovém PC. Toho bych mohl vyřadit z default install úplně (zvlášť po opt-in flagu), protože i s validovaným hostname je psexec inherentně destructive.

### 6. PsExec — návrh: odstranit ze default install

PsExec spustí cmd JAKO SYSTEM na cílovém PC. Z perspektivy threat modelu je to víc nebezpečné než ostatní (mmc/mstsc/explorer pouze read-ish operations s operátorskými credy).

**Akce:** PsExec handler ne-registrovat by default. Instalátor pošle s flagem `--with-psexec` nebo separátním tlačítkem. Default install bude: mmc / services / eventvwr / taskschd / rdp / explorer.

---

## Implementační plán

1. **Hned (kritický fix):**
   - Přepsat všechny launchery v `install-itd-handlers.cmd` se striktní whitelist regex validací (`findstr /R`)
   - Délkový cap 63 znaků
   - Empty input check
   - Všechny args quoted (`/v:"%host%"`)
   - PsExec přesunut do opt-in sekce (nebo úplně odstraněn z default install)

2. **UI změna:**
   - Banner v Actions modalu doporučí **nezaškrtávat "Vždy povolit"** v browseru
   - Add varování "Spouští se pouze proti hostname které matchují ^[a-zA-Z0-9._-]+$"

3. **Dokumentace:**
   - HANDOFF + ARCHITECTURE update se threat model
   - Tato oponentura archivována v `docs/oponentury/`

4. **Verifikace:**
   - Manuální test: spustit installer + zkusit injection payloads přes browser → mělo by selhat
   - Test: legitimní hostname (např. ZAST5W11, B-S-W-MIKOS) → mělo by fungovat

---

## Co dělám teď

1. Archivuji oponenturu + reakci (this commit)
2. Píšu fix installer.cmd
3. Banner v UI s warning
4. Push s `Autorizuj` jakmile přijde

---

— Milan Trnka, 2026-06-03
