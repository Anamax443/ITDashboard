---
date: 2026-06-04
type: oponentura
target: ITDashboard Services tab — services-collector.ts + service_problems schema + UI
reviewer: external (sec/IT operations review)
verdict: partially valid — significant gap on Win32ExitCode capture
followup: 2026-06-04-reakce-services-exitcode-alert-fatigue.md
---

# Oponentura — Services tab: ExitCode + alert fatigue + NIS2/ISO27001 (2026-06-04)

Externí review hovořící o monitoring of Windows services v ITDashboard, alert fatigue, ExitCode handling, NIS2/ISO27001 implikace + meta-review odpovídající na první critique. Obě části archivovány jako jedna diskuzní vlákno.

## Část 1 — Original critique

Problém: Nepochopení chování moderních Windows služeb

Ve Windows už dávno neplatí, že Auto znamená "musí běžet neustále".

**Trigger-Start a Idle-Stop:** Obrovské množství služeb (přesně ty, co vidíš v reportu – Google Updater, MapsBroker, M-Files Assistant) nastartuje, udělá svůj úkol (např. zkontroluje aktualizace) a následně se korektně samy ukončí (Graceful stop), aby uvolnily RAM a CPU.

**Falešné poplachy (False Positives):** Pokud nástroj řve pokaždé, když se Google Updater po kontrole sám vypne, vyrábíte si obrovský šum.

**Z pohledu vedoucího IT a bezpečnosti:** Takový dashboard je nebezpečný. Způsobí to "alert fatigue" (únavu z poplachů). Když vám pak na nějakém serveru nebo stanici reálně spadne služba Esetu nebo zhavaruje Veeam agent, prostě si toho v tom moři červených čísel nevšimnete. A u auditu NIS2/ISO27001 byste těžko obhajovali, proč ignorujete stovky "chybových" hlášení z vlastního monitoringu.

### Jak to postavit správně (Simple solution)

Nejlepší kód a monitoring je ten, který ukazuje jen to, co vyžaduje akci. Kolega musí změnit logiku sběru dat. Zde je návod, jak to udělat jednoduše a efektivně:

**1. Sledovat Exit Code, ne jen Status**
Nástroj nesmí reportovat chybu jen proto, že služba stojí. Musí se přes WMI (nebo Get-CimInstance) podívat na Win32ExitCode dané služby.

- Pokud služba stojí, ale ExitCode == 0, znamená to, že se korektně ukončila. Zahodit, ignorovat.
- Pokud služba stojí a ExitCode != 0 (nebo má specifický chybový kód), znamená to, že spadla nebo zhavarovala. Zobrazit červeně.

**2. White-listing kritických služeb**
Nesnažte se monitorovat úplně všechno. Udělejte si seznam kritických služeb, u kterých naopak vyžadujete, aby běžely neustále (např. Antiviry, RMM agenti, LAPS, zálohovací agenti). U těchto konkrétních služeb má smysl spustit alarm při jakémkoliv výpadku, nezávisle na Exit Code. U updatovacích utilit pro Asus to nikoho nezajímá.

## Část 2 — Meta-review (odpověď na první critique)

Naprosto s vámi souhlasím. Vaše analýza je věcná, přesná a bohužel velmi častá – spousta monitoringových nástrojů dnes stále žije v představě Windows Server 2003, kde "služka buď běží, nebo je mrtvá".

### Co bych jen drobně doplnil:

1. **Exit code není jediný svatý grál** – někdy služba skončí s `ExitCode = 0`, ale nestihla dokončit svůj úkol (např. timeout, zamrzlý start). Proto bych přidal i kontrolu `State` vs. `StartMode`. Služba nastavená na `Auto` (trigger-start) je v klidu, když je `Stopped` + `ExitCode 0`. Služba s `Auto` (klasický) by neměla být zastavená nikdy – to je rovnou red flag.

2. **Rozlišovat "graceful stop" od "crash loop"** – u updaterů jako Google Updater je normální, že každou hodinu naskočí, udělá práci a zhasne. Pokud ale naskakuje každých 30 sekund a padá s exit code 0, ale nijak nepracuje? To už je podezřelé – může jít o nějakou zaseknutou plánovačku nebo corrupted konfiguraci. Monitor by si měl všímat i **frekvence start/stop** u těchto "letmých" služeb.

3. **White-list kritických služeb** – ano, ale dělejte ho **centrálně** (např. GPO nebo CMDB). Jinak si každý admin bude whitelistovat věci, které ho zrovna otravují, a přitom by je monitorovat měl (např. Print Spooler na tiskovém serveru – neběží pořád, ale jeho náhlý exit code 0 může značit zásah ransomware).

4. **Co audit NIS2/ISO27001?** – U auditu se vás zeptají: "Máte definováno, co je normální chování služeb?" Pokud řeknete "všechny služby s Auto a Stop + exit 0 ignorujeme", musíte to mít zdokumentované a pravidelně revidované. Jinak auditor prohlásí, že váš monitoring má slepou skvrnu.

### Pro kolegu implementátora:

Nepište si vlastní WMI skripty od nuly – použijte hotové řešení, jako je **SCOM management pack pro Windows Services** (umí trigger-start rozlišovat) nebo **Zabbix s template "Windows service by status and exit code"**. A pokud už musíte dělat vlastní PowerShell, tak aspoň:

```powershell
$service = Get-CimInstance -ClassName Win32_Service -Filter "Name='MapsBroker'"
if ($service.State -eq 'Stopped' -and $service.StartMode -eq 'Auto' -and $service.ExitCode -eq 0) {
    # Normální chování trigger-start služby – žádný alert
} elseif ($service.State -eq 'Stopped' -and $service.StartMode -eq 'Auto' -and $service.ExitCode -ne 0) {
    Write-Warning "Service $($service.Name) stopped with error exit code $($service.ExitCode)"
}
```

Díky za tenhle osvěžující postřeh – přesně takhle má vypadat **inženýrský přístup k monitoringu**: žádný šum, jen signál a akce.
