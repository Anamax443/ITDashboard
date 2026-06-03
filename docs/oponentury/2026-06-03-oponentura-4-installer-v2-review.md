---
date: 2026-06-03
type: oponentura
target: apps/server/scripts/install-itd-handlers.cmd (post-0cc27a3 revision)
reviewer: external
verdict: production enterprise-ready; one minor console reflection note
followup: 2026-06-03-reakce-4-installer-v2-review.md
---

# Oponentura 4 — install-itd-handlers.cmd (post-0cc27a3)

Externí review revize installeru po commitu `0cc27a3` (cmd-safe installer fix).
Paste verbatim z chat session 2026-06-03.

---

Nová verze souboru `install-itd-handlers.cmd` posunula tenhle skript o úroveň výš. Přidání logování a centralizovaného error handlingu vyřešilo největší slabinu předchozí verze – uživatelskou přívětivost při chybě.

Předtím skript při neplatném URL prostě tiše spadl (`exit /b 1`) a operátor netušil, jestli se něco stalo, nebo proč se nástroj neotevřel. Teď dostane jasnou odpověď.

Zde je přehled toho, co se zlepšilo, a na co si dát v této revizi pozor.

---

## Co se zlepšilo (Skvělé změny v této verzi)

* **Delayed Expansion (`!host!`) a ochrana před prázdnými proměnnými:** Použití `EnableDelayedExpansion` a kontrola přes `if not defined host` odstraňuje riziko, že by se skript zhroutil nebo choval nepředvídatelně, pokud by mu prohlížeč předal neočekávaný nebo prázdný parametr.

* **Centralizovaný footer (`:fail`):** Kód je mnohem čistší díky podskriptu `:append_common_footer`. Generované launchery teď mají jednotný vzhled chybových hlášek.

* **Diagnostika pro operátora:** Když validace selže, okno konzole zůstane viset (`pause`) a vypíše přesný důvod selhání (např. `host_too_long` nebo `invalid_host_chars`). Pokud vše proběhne v pořádku, okno se po spuštění nástroje okamžitě tiše zavře, což je přesně to, co uživatel chce.

* **Persistentní logování do `%LOCALAPPDATA%`:** Zápis úspěchů i pádů do souborů `last-itd-*.log` je skvělý krok pro lidi z helpdesku. Když uživatel nahlásí „mně to nefunguje", stačí se podívat do logu a hned vidíte, jaké URL mu web poslal.

---

## Bezpečnostní detaily k zamyšlení

Z hlediska bezpečnosti je kód stále velmi neprůstřelný díky striktnímu RegExu a délkovému limitu. Nicméně se tu objevuje jeden drobný detail spojený s chováním příkazu `echo` a logováním:

### Riziko s `!url!` v chybovém logu

V bloku `:fail` se do logu zapisuje celý řetězec z URL:

```cmd
>>"%%log%%" echo [%%date%% %%time%%] failed %%~nx0 reason=!reason! url="!url!" ...
```

Protože je zapnutá delayed expansion (`!url!`), nehrozí, že by znaky jako `&` nebo `|` v URL rozbily syntaxi samotného zápisu do logu (což by se stalo u `%url%`).

Problém je spíše **konzole**. Pokud útočník dokáže přimět uživatele kliknout na odkaz typu:
`itd-mmc://nevalidni-host-s-escape-sekvenci`
vypíše se v bloku `:fail` na obrazovku text:

```cmd
echo URL: "!url!"
```

Pokud by v `!url!` byly neočekávané řídicí znaky (např. ANSI escape sekvence), mohl by se útočník pokusit o tzv. *Console Reflected Injection* (manipulaci s textem v terminálu operátora). Vzhledem k tomu, že se jedná o interní ITDashboard, je toto riziko spíše teoretické, ale pro absolutní čistotu by bylo bezpečnější v chybovém výpisu na obrazovku i do logu vypisovat pouze vyčištěnou proměnnou `!host!`, případně z `!url!` před výpisem odstranit rizikové znaky.

---

## Shrnutí

Tato verze souboru `install-itd-handlers.cmd` je **produkční enterprise-ready skript**. Vyřešil dřívější slepá místa ohledně dohledatelnosti chyb, skvěle kombinuje striktní bezpečnostní politiku s komfortem pro uživatele a administrátory.

Chcete se podívat na to, jak ošetřit případné rizikové znaky v tom chybovém výpisu `url="!url!"`, nebo skript v této podobě předáváte do produkce?
