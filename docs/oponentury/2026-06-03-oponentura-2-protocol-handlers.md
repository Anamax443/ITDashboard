# Oponentura ITDashboard — URL protocol handlers (RCE risk)

> Archivováno: 2026-06-03
> Zdroj: paste-nuto do session
> Reakce: [2026-06-03-reakce-2-protocol-handlers.md](2026-06-03-reakce-2-protocol-handlers.md)
> Posuzovaný commit: `e0c17ad` (feat(actions): one-click 'Launch' via itd-* URL protocol handlers)

---

Stručně řečeno: **V základu je tento koncept geniální pro usnadnění práce (tzv. "quality-of-life"), ale v této konkrétní podobě představuje obrovské bezpečnostní riziko (zranitelnost typu Remote Code Execution).** Pokud by útočník věděl, že máš tyto protokoly zaregistrované, stačí mu, abys navštívil jeho webovou stránku, a může ti v počítači spustit libovolný kód.

Níže podrobně rozebírám, proč tomu tak je a jak to opravit, aby to bezpečné bylo.

---

## 🛑 Hlavní bezpečnostní rizika (Proč to TEĎ hned nespouštět)

### 1. Extrémní zranitelnost vůči "Argument Injection" (Vstřikování parametrů)

Největší problém je v tom, jak skript zpracovává text z URL adresy. Windows předává celou URL adresu do skriptu jako jeden parametr (`%1`).

Podívejme se na příklad s RDP (`itd-rdp.cmd`):

```cmd
set host=%url:itd-rdp://=%
start "" mstsc.exe /v:%host%
```

Skript se snaží pouze odmazat `itd-rdp://`, ale nijak nekontroluje, co následuje. Pokud útočník na svém webu vytvoří odkaz jako:
`itd-rdp://10.0.0.1 /shadow:1 /control /noAnimate`
Skript dosadí do příkazu vše a spustí `mstsc.exe /v:10.0.0.1 /shadow:1 ...`. Útočník ti právě mohl vzdáleně ovládnout relaci.

Ještě horší je to u **Exploreru** nebo **PsExec**, kde se dají pomocí speciálních znaků (jako jsou mezery, uvozovky nebo znak `&`) podstrčit úplně jiné příkazy. Útočník by mohl přes odkaz na webu spustit na tvém PC skript, který ti zašifruje disk.

### 2. Spouštění citlivých nástrojů jedním kliknutím z prohlížeče

Tento skript registruje protokoly tak, že jakmile na webu klikneš na odkaz (nebo web použije JavaScript k jeho otevření), Windows se zeptá: *"Chcete otevřít aplikaci ITDashboard?"*. Pokud jednou zaškrtneš **"Vždy povolit"**, jakýkoliv web na internetu může na pozadí zkoušet posílat příkazy do tvého počítače přes tyto protokoly.

---

## 🛠️ Jak z toho udělat bezpečný nástroj?

Pokud se ti tato funkčnost líbí (v IT správě je to běžná věc), musíš skripty upravit tak, aby **striktně čistily a ověřovaly vstup**.

### Úprava 1: Validace hostname (Sanitizace)

Nikdy nesmíš věřit tomu, co přijde z URL. Musíš zajistit, že proměnná `host` obsahuje **pouze** legální znaky pro název počítače (písmena, čísla, pomlčky) a žádné mezery nebo nebezpečné znaky (`&`, `|`, `<`, `>`, `"`).

Příklad, jak bezpečně vyčistit vstup v dávkovém souboru (Batch):

```cmd
:: Odstranění protokolu a lomítek
set url=%1
set host=%url:itd-rdp://=%
set host=%host:/=%

:: Odstranění uvozovek, které by mohly rozbít kód
set host=%host:"=%

:: Striktní kontrola: Pokud host obsahuje mezeru, skript okamžitě skončí!
echo %host% | findstr /c:" " >nul && exit /b 1
```

### Úprava 2: Bezpečné předávání parametrů

Při spouštění aplikací vždy dávej proměnné do uvozovek, aby se zabránilo rozpadu příkazu na více parametrů:

```cmd
start "" mstsc.exe /v:"%host%"
```

### Úprava 3: Použití PowerShellu místo stařičkého CMD

Dávkové soubory (.cmd/.bat) jsou pro parsování textu textově neohrabané a nebezpečné. Mnohem bezpečnější je zaregistrovat jako handler PowerShell skript, který dokáže vstup zkontrolovat pomocí regulárních výrazů (Regex).

Příklad bezpečné validace v PowerShellu:

```powershell
$url = $args[0]
$hostName = $url -replace "itd-rdp://", "" -replace "/", ""

# Povolíme pouze alfanumerické znaky a pomlčku (regulární výraz)
if ($hostName -match "^[a-zA-Z0-9-]+$") {
    Start-Process "mstsc.exe" -ArgumentList "/v:$hostName"
} else {
    Write-Error "Neplatný název hostitele!"
}
```

---

## 📊 Shrnutí

| Aspekt | Stav v poskytnutém skriptu | Bezpečný stav (Po úpravě) |
| --- | --- | --- |
| **Práva administrátora** | 🟢 Bezpečná (Běží pod HKCU, nepotřebuje admina) | 🟢 Stejné |
| **Ochrana proti zneužití z webu** | 🔴 Žádná (Slepě důvěřuje čemukoliv v URL) | 🟢 Vysoká (Odmítne nebezpečné znaky a mezery) |
| **Riziko pro PC** | 🔴 Vysoké (Možnost spuštění škodlivého kódu) | 🟢 Nízké (Spustí pouze legální msc/rdp konzoli) |

**Verdikt:** Skript v tomto stavu **nespouštěj**. Pokud ho chceš používat, přepiš parsování URL adres tak, aby zahodilo jakýkoliv vstup, který obsahuje mezery nebo jiné znaky než standardní název počítače.
