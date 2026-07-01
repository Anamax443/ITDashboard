# Setup admin serveru `10.8.2.213` (B-S-W-MIKOS)

Jednorázové kroky pro bootstrap. Spouští se přes RDP pod účtem s admin právy na serveru a SQL sysadmin na 10.8.2.225.

Po dokončení už nikdy nemusíš na server ručně — každý `git push` do `main` se auto-deployne přes GitHub Actions self-hosted runner.

**Real-world setup proběhl 2026-06-01.** Tento dokument reflektuje skutečnost, ne ideál.

> **Stav dokumentu:** aktualizováno **2026-07-01**, živý commit `d7d6890`, migrace **001–074**. Rebuild dle tohoto dokumentu postaví systém včetně WAN monitoru (krok 7c), parkovaného service-port maticového scheduleru (krok 7d) a link-speed měření po SMB (krok 7e, default vypnuté).

## Reference deployment values

Projekt je portable — žádné IP, hostname ani doménová jména nejsou v kódu. Veškeré site-specific hodnoty žijí v configu. Níže jsou **referenční hodnoty aktuálního nasazení** (AXINETWORK). Pokud stavíš projekt v jiném prostředí, **nahraď je svými vlastními** — celý runbook níže používá tyto referenční hodnoty inline, abys je mohl copy-pastovat, ale v novém prostředí je musíš vyměnit.

| Parameter | Reference value | Where used |
|-----------|-----------------|------------|
| API/runtime host | `10.8.2.213` (`B-S-W-MIKOS`) | RDP target, firewall, runner name, deploy workflow |
| SQL host | `10.8.2.225` (`B-S-W-SQL-04`, **default instance** — NE pojmenovaná `\BCNEW`) | `.env` `SQL_HOST`, repo variable, SSMS connect |
| AD doména NetBIOS / FQDN | `AXINETWORK` / `axinetwork.loc` | doménové ověření, SQL login prefix, UPN suffix |
| Service account | `svc-itdashboard` (UPN `svc-itdashboard@axinetwork.loc`; SQL login `AXINETWORK\svc-itdashboard`) | AD user, NSSM service identity, runner identity, DB grant |
| Dashboard hostname (volitelné, za IIS+TLS) | `itdashboard.axinetwork.loc` | jen pokud frontuješ API přes IIS reverse proxy s TLS |
| DC pro DNS / doménové ověření | `10.8.2.254` | ověření připojení k doméně / DNS |

> **Pozn. ke klientovi:** browser UI používá **relativní URL** (žádný API base se nekonfiguruje — buildí se ze serveru a běží same-origin). API base v installeru protocol-handleru **injektuje server při downloadu**. V klientovi tedy není nic host-specific k editaci.

## 0. Prerekvizity

- [ ] RDP přístup na `10.8.2.213` s lokálním admin / Domain Admin v doméně `AXINETWORK.LOC`
- [ ] SQL přístup na `10.8.2.225` (default instance — `B-S-W-SQL-04`, NE `\BCNEW`) jako sysadmin
- [ ] GitHub repo admin role na `Anamax443/ITDashboard`

> **Než začneš:** všechny příkazy níže obsahují **referenční hodnoty** z tabulky *Reference deployment values* nahoře (IP, hostname, doména, service account), aby je aktuální operátor mohl copy-pastovat. **V novém prostředí musíš tyto hodnoty vyměnit za své** — projdi příkaz po příkazu a nahraď `10.8.2.213`, `10.8.2.225`, `AXINETWORK` / `axinetwork.loc`, `svc-itdashboard`, `B-S-W-MIKOS` atd. Procedura sama se nemění.

## 1. Ověř GPO ExecutionPolicy

```powershell
Get-ExecutionPolicy -List
```

Pokud `MachinePolicy = AllSigned` → setup počítá s tím a používá `cmd` shell místo PS v deploy workflow. Žádný `Set-ExecutionPolicy` to nepřepíše (GPO override).

## 2. Install Node.js LTS 20, Git, NSSM

`winget` na Windows Server obvykle není. Direct download:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dl = 'C:\Setup'
New-Item -ItemType Directory -Force $dl | Out-Null

# Node.js LTS 20
Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi' -OutFile "$dl\node.msi" -UseBasicParsing
Start-Process msiexec.exe -ArgumentList "/i `"$dl\node.msi`" /qn /norestart" -Wait

# Git for Windows
Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe' -OutFile "$dl\git.exe" -UseBasicParsing
Start-Process "$dl\git.exe" -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES' -Wait

# NSSM — nssm.cc občas down, retry, fallback web.archive.org
$nssmSources = @(
    'https://nssm.cc/release/nssm-2.24.zip',
    'https://web.archive.org/web/2024/https://nssm.cc/release/nssm-2.24.zip'
)
foreach ($url in $nssmSources) {
    try {
        Invoke-WebRequest -Uri $url -OutFile "$dl\nssm.zip" -UseBasicParsing -TimeoutSec 30
        if ((Get-Item "$dl\nssm.zip").Length -gt 100000) { break }
    } catch { continue }
}
Expand-Archive "$dl\nssm.zip" -DestinationPath "$dl\nssm-extracted" -Force
$exe = Get-ChildItem "$dl\nssm-extracted" -Recurse -Filter 'nssm.exe' | Where-Object FullName -match 'win64' | Select-Object -First 1
New-Item -ItemType Directory -Force 'C:\Tools\nssm' | Out-Null
Copy-Item $exe.FullName 'C:\Tools\nssm\nssm.exe' -Force
```

Pak **zavři PS, otevři nový jako Admin** (PATH refresh) a ověř:

```powershell
node --version    # v20.18.1
git --version     # 2.47.x
& 'C:\Tools\nssm\nssm.exe' version 2>&1 | Select-Object -First 1
```

## 3. RSAT ActiveDirectory PowerShell modul

```powershell
Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0
Import-Module ActiveDirectory
(Get-ADDomain).Name   # → axinetwork
```

## 4. Service account v AD

```powershell
Import-Module ActiveDirectory
$pwd = Read-Host -Prompt "Heslo pro svc-itdashboard" -AsSecureString

New-ADUser `
    -Name 'svc-itdashboard' `
    -SamAccountName 'svc-itdashboard' `
    -UserPrincipalName 'svc-itdashboard@axinetwork.loc' `
    -DisplayName 'ITDashboard Service Account' `
    -AccountPassword $pwd `
    -Enabled $true `
    -PasswordNeverExpires $true `
    -CannotChangePassword $true
```

Schovej heslo do password manageru — budeš ho potřebovat 2× (NSSM service + GitHub runner).

## 5. Create DB + grant (SSMS na 10.8.2.225)

V SSMS connectni `10.8.2.225` jako sysadmin, otevři query do `master`:

```sql
IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name = N'ITDashboard')
    CREATE DATABASE ITDashboard;
GO

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'AXINETWORK\svc-itdashboard')
    CREATE LOGIN [AXINETWORK\svc-itdashboard] FROM WINDOWS;
GO

USE ITDashboard;
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'AXINETWORK\svc-itdashboard')
    CREATE USER [AXINETWORK\svc-itdashboard] FOR LOGIN [AXINETWORK\svc-itdashboard];
GO
ALTER ROLE db_owner ADD MEMBER [AXINETWORK\svc-itdashboard];
GO
```

## 6. Clone repo + build + .env + migrace

```powershell
New-Item -ItemType Directory -Force C:\Apps | Out-Null
Set-Location C:\Apps
git clone https://github.com/Anamax443/ITDashboard.git
Set-Location C:\Apps\ITDashboard

# Workspace install (jen server — desktop se buildí lokálně per IT-PC)
npm install --workspace @itdashboard/server

# .env — kanonický seznam proměnných je `.env.example` v rootu repa.
# Použij ho jako single source of truth (zkopíruj a doplň své hodnoty).
# Auth je VŽDY Windows Integrated (Trusted Connection) přes msnodesqlv8 —
# SQL_USER / SQL_PASSWORD kód NEČTE (service běží pod doménovým účtem
# mapovaným na SQL login). Minimální server .env (referenční hodnoty —
# v jiném prostředí nahraď SQL_HOST svým ze sekce Reference deployment values):
@'
SQL_HOST=10.8.2.225
SQL_INSTANCE=
SQL_DATABASE=ITDashboard
API_PORT=4000
API_BIND=0.0.0.0
COLLECTOR_POLL_INTERVAL_SEC=300
COLLECTOR_LEVELS=Warning,Error,Critical
COLLECTOR_LOGNAMES=System,Application,Security
RETENTION_RAW_DAYS=90
'@ | Out-File 'apps\server\.env' -Encoding utf8 -NoNewline

# Build + migrate
Set-Location apps\server
npm run build
npm run migrate
```

**Pozn. k migracím:** `npm run migrate` aplikuje aktuálně migrace **001–074** (idempotentní, doběhne i na čerstvé i na existující DB). Migrace **062 `wan_monitor`**, **063 `wan_speedtest`** a **064 `wan_speedtest_streams`** **nezakládají žádné nové tabulky** — pouze seedují řádky do `settings` (default hodnoty WAN monitoru, viz krok 7c). Stejně tak migrace **065 `service_port_matrix`**, **066 `drop-phone-default`**, **067 `service_discovery`**, **068 `voip-web`**, **069 `drop-voip`** a **070 `park`** **nezakládají žádné nové tabulky** — jsou to čistě seedy/UPDATE řádků v `settings` (defaulty service-port matice + discovery, viz krok 7d; migrace **070** funkci parkuje nastavením `svcports.enabled=0`). Migrace **071 `link_speed`** **zakládá novou tabulku `link_speed_results`** (výsledky link-speed měření po SMB); migrace **072/073/074** k ní přidávají sloupce `latency_ms` + `cycles` a seedují řádky `linkspeed.*` do `settings` (defaulty link-speed měření, viz krok 7e — funkce je vypnutá defaultem `linkspeed.enabled=0`). Vše je přepsatelné v Settings UI, takže ručně nic nastavovat nemusíš.

**Pozn:** Auto-deploy pipeline (GitHub Actions) **nečte** tento `.env` — migrace v deploy.yml berou `SQL_HOST` / `SQL_INSTANCE` / `SQL_DATABASE` z **repository Variables** (viz krok 10), ne ze souboru.

**Pozn:** Server používá driver `msnodesqlv8` (NE výchozí tedious) kvůli pravému Windows SSPI v doméně. tedious v doméně failuje s "untrusted domain". Driver má prebuilt binaries pro Node 20 Windows, žádný native build nepotřeba.

## 7. Install API jako Windows Service

```powershell
$svc = 'ITDashboardAPI'
$nssm = 'C:\Tools\nssm\nssm.exe'
$node = (Get-Command node).Source
$appDir = 'C:\Apps\ITDashboard\apps\server'
$appJs = "$appDir\dist\index.js"
$logsDir = 'C:\Apps\ITDashboard\logs'
New-Item -ItemType Directory -Force $logsDir | Out-Null

$pwdSecure = Read-Host -Prompt "Heslo pro svc-itdashboard" -AsSecureString
$BSTR = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwdSecure)
$pwdPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)

& $nssm install $svc $node $appJs
& $nssm set $svc AppDirectory $appDir
& $nssm set $svc AppStdout "$logsDir\api.out.log"
& $nssm set $svc AppStderr "$logsDir\api.err.log"
& $nssm set $svc Start SERVICE_AUTO_START
& $nssm set $svc ObjectName 'AXINETWORK\svc-itdashboard' $pwdPlain
& $nssm set $svc Description 'ITDashboard API + eventlog collector + WAN monitor + service-port scheduler (parked) + link-speed scheduler (off by default)'

[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
Remove-Variable pwdPlain, pwdSecure

Start-Service $svc
Invoke-RestMethod http://localhost:4000/health
Invoke-RestMethod http://localhost:4000/health/db   # → ok:true
```

## 7b. Grant svc-itdashboard service control ACL (KRITICKÉ pro auto-deploy)

Bez tohohle grantu deploy.yml-ový `sc stop/start` selže s "Access denied" → service nikdy nerestartuje na nový kód (jen tichý fail). Trvalo nás to objevit dlouho — udělej teď.

```powershell
$svcname = 'ITDashboardAPI'
$account = 'AXINETWORK\svc-itdashboard'
$sid = (New-Object System.Security.Principal.NTAccount($account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$current = (& sc.exe sdshow $svcname | Out-String).Trim()
$newACE = "(A;;CCLCSWRPWPDTLOCRRC;;;$sid)"
$new = if ($current -match 'S:') { $current -replace 'S:', "$newACE`S:" } else { $current + $newACE }
& sc.exe sdset $svcname $new
```

ACE flags: `CC=QueryConfig, LC=QueryStatus, SW=EnumDeps, RP=Start, WP=Stop, DT=Pause, LO=Interrogate, CR=UserControl, RC=ReadControl`.

## 7c. WAN monitor — žádná nová infra, jen egress

API service při startu (`dist/index.js`, `index.ts`) spouští kromě eventlog collectoru i **WAN monitor scheduler** — `startWanMonitorSchedule()`. Žádná nová tabulka, žádná nová OS závislost: pinguje přes vestavěný Windows `ping.exe` (stejný, co používají ostatní collectory) a pro volitelný speed test používá globální `fetch`. Enable/interval je DB-driven jako u ostatních collectorů (řízeno řádky v `settings`), takže se to nasadí samo s každým deployem — **nic se ručně neinstaluje**.

**Co měří:** pinguje IP pobočkových routerů (z `mikrotik.routers`) + jeden veřejný internetový cíl (default `1.1.1.1`) **z app serveru** (`10.8.2.213`). Zdraví linky poboček je **jen latence + ztrátovost** (ne rychlost — viz Gotcha #7). Volitelný speed test (default **vypnutý**) stahuje reálný soubor z konfigurované URL (default Cloudflare) → spotřebovává pásmo, proto OFF.

**Seedované settings** (migrace 062–064, vše přepsatelné v Settings UI v sekci *„Komunikace na pobočky a internet"*):

| Klíč | Default | Význam |
|------|---------|--------|
| `wan.enabled` | `1` | WAN monitor zapnut |
| `wan.interval_sec` | `60` | perioda pingu |
| `wan.internet_target` | `1.1.1.1` | veřejný cíl pro test internetu |
| `wan.ping_count` | `5` | počet pingů na měření |
| `wan.latency_warn_ms` | `80` | práh „degraded" latence |
| `wan.loss_warn_pct` | `5` | práh „degraded" ztrátovosti |
| `wan.speedtest_enabled` | `0` | speed test **vypnut** (stahuje reálný soubor, žere pásmo) |
| `wan.speedtest_url` | `https://speed.cloudflare.com/__down?bytes=25000000` | cíl speed testu |
| `wan.speedtest_interval_sec` | `1800` | perioda speed testu |
| `wan.speedtest_streams` | `6` | počet paralelních streamů |

**Egress / síť (rebuild-relevant):** WAN monitor pinguje IP pobočkových routerů a internetový cíl `1.1.1.1` **z `.213`**; volitelný speed test dělá odchozí **HTTPS** na `wan.speedtest_url` (default Cloudflare). Server už odchozí internet má (cdb symbol downloads pro analýzu pádů), takže pro defaulty **není potřeba žádné nové firewall pravidlo** — ale cíl speed testu i IP poboček **musí být z `.213` dosažitelné**.

**Read-only endpointy** (žádná změna auth): `GET /system/comms`, `GET /system/wan`, `GET /crashes/status`.

## 7d. Service-port matice — žádná nová infra, **parkováno** (jen egress, když se zapne)

API service při startu (`dist/index.js`, `index.ts`) spouští kromě eventlog collectoru a WAN monitoru i **service-port maticový scheduler** — `startServicePortsSchedule()` (per-pobočková matice dostupnosti služebních portů). Žádná nová tabulka, žádná nová OS závislost: TCP probe je **stejný** jako u tabu *Ports*, discovery scan používá globální `fetch`, který už v procesu je. Enable/interval je DB-driven jako u ostatních collectorů (řízeno řádky v `settings`), takže se to nasadí samo s každým deployem — **nic se ručně neinstaluje**.

**Stav: PARKOVÁNO.** Migrace **070** nastavuje `svcports.enabled=0`, takže scheduler při startu nastartuje, ale **nic neběží**. Discovery scan je výhradně **user-triggered** (přes endpoint níže). Pokud rebuild postavíš dle tohoto dokumentu, funkce zůstává v klidu, dokud ji někdo vědomě v Settings UI nezapne.

**Co dělá (po zapnutí):** ke každé pobočce sestaví matici dostupnosti služebních portů — defaultní checky míří na tiskárny (TCP **9100/515/631**) a VoIP telefony (Yealink OUI). Probe jde **odchozí TCP z `.213`** na IP zařízení z inventáře napříč pobočkovými sítěmi (přes stávající VPN). Discovery scan je širší user-triggered TCP sken vzorku zařízení.

**Seedované settings** (migrace 065–070, vše přepsatelné v Settings UI; funkce parkovaná, takže většina je dormantní):

| Klíč | Default | Význam |
|------|---------|--------|
| `svcports.enabled` | `0` | **parkováno** — scheduler neběží |
| `svcports.interval_sec` | `900` | perioda matice (když zapnuto) |
| `svcports.timeout_ms` | `1500` | timeout TCP probe |
| `svcports.max_per_cell` | `60` | max zařízení na buňku matice |
| `svcports.checks` | tiskárny `9100/515/631` | seznam port-checků |
| `svcports.voip_ouis` | Yealink OUIs | OUI prefixy pro detekci VoIP telefonů |
| `svcdisc.sample` | `8` | vzorek zařízení pro discovery |
| `svcdisc.full_sample` | `3` | vzorek pro „full" discovery |
| `svcdisc.timeout_ms` | `800` | timeout discovery probe |
| `svcdisc.categories` | (seed) | kategorie portů pro discovery |

**Egress / síť (rebuild-relevant):** když se matice **zapne**, dělá odchozí TCP connecty z `.213` na inventované IP zařízení napříč pobočkovými sítěmi (přes stávající VPN); discovery scan je úmyslný **user-triggered** probe sweep. Pro defaulty **není potřeba žádné nové firewall pravidlo** — ale je to záměrný probe sweep, ne pasivní čtení. Parkováno by default, takže nic neběží.

**Read-only endpointy** (žádná změna auth): `GET /system/service-ports`, `POST /system/service-discovery` (user-triggered širší TCP sken vzorku zařízení).

## 7e. Link-speed měření po SMB — žádná nová infra, **default vypnuto** (zápis na C$ klientů)

API service při startu (`dist/index.js`, `index.ts`) spouští kromě eventlog collectoru, WAN monitoru a service-port scheduleru i **link-speed scheduler** — `startLinkSpeedSchedule()` (měření propustnosti linky na klientská PC zápisem/čtením souboru po SMB). Žádná nová OS závislost: latenci měří vestavěný Windows `ping.exe` (stejný, co používají ostatní collectory) a přenos dělá Node `fs` přes SMB share. Nová **tabulka `link_speed_results`** (migrace 071, sloupce doplněné 072/073) drží výsledky. Enable/interval je DB-driven jako u ostatních collectorů (řízeno řádky v `settings`), takže se to nasadí samo s každým deployem — **nic se ručně neinstaluje**. Restart-safe.

**Stav: VYPNUTO defaultem.** Seed nastavuje `linkspeed.enabled=0`, takže scheduler při startu nastartuje, ale **nic neběží**, dokud ho někdo vědomě v Settings UI nezapne (a nenastaví cíle/okno).

**Co dělá (po zapnutí):** ke každému cílovému klientskému PC zapíše N-MB soubor na jeho `C$` share přes SMB a přečte ho zpět → z doby změří propustnost linky (Mbps), plus latenci přes `ping.exe`. Měří se v `linkspeed.cycles` cyklech. Testovací soubor i adresář `C:\tmp\itdash-speedtest` se **vždy po sobě uklidí**.

**Seedované settings** (migrace 074, vše přepsatelné v Settings UI; funkce vypnutá, takže je dormantní):

| Klíč | Default | Význam |
|------|---------|--------|
| `linkspeed.enabled` | `0` | **vypnuto** — scheduler neběží |
| `linkspeed.interval_hours` | `24` | perioda měření (když zapnuto) |
| `linkspeed.window_start` | (prázdné) | začátek povoleného okna (HH:MM) |
| `linkspeed.window_end` | (prázdné) | konec povoleného okna (HH:MM) |
| `linkspeed.targets` | (prázdné) | seznam cílových PC (prázdné = žádné) |
| `linkspeed.exclude_hosts` | (prázdné) | vyloučené hosty |
| `linkspeed.cycles` | `4` | počet cyklů zápis/čtení na měření |
| `linkspeed.filename` | `itdash-speedtest.tmp` | jméno testovacího souboru (konfigurovatelné kvůli AV exclusion) |
| `linkspeed.size_mb` | `100` | velikost testovacího souboru (MB) |
| `linkspeed.ok_mbps` | `200` | práh „OK" propustnosti |

**Požadavky / provoz (rebuild-relevant):**
- **Admin C$ na klientech.** Zápis N-MB souboru na `C$` klienta vyžaduje, aby service account `svc-itdashboard` měl **admin C$ přístup na klientech** — což má (přes skupinu **Server Admins**). Servery a doménové řadiče **selžou s EPERM** (service account **není** Domain Admin) — to je **očekávané chování**, ne chyba; cíluj klientská PC, ne servery/DC.
- **Datová náročnost.** Přenos = `size_mb` × počet PC × 2 (zápis+čtení) × `cycles`, takže „všechna PC" je **těžké** — nasazuj s **oknem** (`window_start`/`window_end`) a rozumným **intervalem** (`interval_hours`), ať to neběží celý den a nepřetíží linku.
- **AV (ESET) na klientech.** Testovací soubor + adresář `C:\tmp\itdash-speedtest` se sice vždy uklidí, ale měl by být přidán do **PATH výjimek antiviru (ESET)** na klientech. Soubor je **bez přípony** záměrně (omezuje on-access sken), ale spolehlivě funguje jen **výjimka na cestu** — proto je jméno souboru konfigurovatelné (`linkspeed.filename`), aby šlo přesně vyloučit.

**Egress / síť (rebuild-relevant):** čistě **vnitrosíťový SMB** z `.213` na `C$` klientů + `ping.exe`. **Žádné nové firewall pravidlo pro internet** — jen SMB (445) na klientská PC musí být z `.213` průchozí (v doméně obvykle je).

**Read/action endpointy** (žádná změna auth): `POST /system/linkspeed/{test,run,stop}`, `GET /system/linkspeed/{status,history,summary}`.

## 8. Firewall — whitelist konkrétních IP

```powershell
$allowedSources = @(
    '10.8.2.213',   # localhost (admin server)
    '10.8.2.181',   # tvůj dev PC (uprav)
    '10.8.2.243'    # další IT specialista
)

New-NetFirewallRule -DisplayName 'ITDashboard API (4000)' `
    -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow `
    -Profile Domain `
    -RemoteAddress $allowedSources
```

## 9. GitHub Actions self-hosted runner

V GitHub UI: **Settings → Actions → Runners → New self-hosted runner → Windows x64**. Vygeneruje URL + jednorázový token (platí 1h).

```powershell
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force 'C:\actions-runner' | Out-Null
Set-Location 'C:\actions-runner'

# URL a hash z GitHub UI (verze runneru se mění)
Invoke-WebRequest -Uri 'https://github.com/actions/runner/releases/download/v2.334.0/actions-runner-win-x64-2.334.0.zip' `
    -OutFile 'runner.zip' -UseBasicParsing
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory("$PWD\runner.zip", "$PWD")

$pwdSecure = Read-Host -Prompt "Heslo pro svc-itdashboard" -AsSecureString
$BSTR = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwdSecure)
$pwdPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)

& "$PWD\config.cmd" `
    --url 'https://github.com/Anamax443/ITDashboard' `
    --token '<TOKEN_Z_GITHUB_UI>' `
    --name 'B-S-W-MIKOS' `
    --labels 'itdashboard-prod' `
    --work '_work' `
    --runasservice `
    --windowslogonaccount 'AXINETWORK\svc-itdashboard' `
    --windowslogonpassword $pwdPlain `
    --unattended `
    --replace

[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

Get-Service 'actions.runner.*'   # Running, Automatic
```

## 10. Repo variables (v GitHub UI)

**Settings → Secrets and variables → Actions → Variables → New repository variable:**

| Name | Value |
|------|-------|
| `SQL_HOST` | `10.8.2.225` |
| `SQL_INSTANCE` | `_` (sentinel pro „no instance", GitHub variables nepovolí prázdnou hodnotu) |
| `SQL_DATABASE` | `ITDashboard` |

Žádné secrets potřeba — Integrated Auth.

## 11. První test deploy

Z lokálu (d:/git/ITDashboard):

```bash
git commit --allow-empty -m "chore: trigger first deploy"
git push origin main
```

V GitHub UI → Actions: workflow `Deploy to 10.8.2.213` musí proběhnout zeleně. Pak ověř na serveru:

```powershell
Invoke-RestMethod http://localhost:4000/health
```

## Gotchas zaznamenané ze skutečného setupu

1. **GPO `AllSigned`** v AXINETWORK doméně blokuje PowerShell scripty. Deploy workflow proto používá `shell: cmd`, service restart přes `net stop/start` (NE `Restart-Service`).
2. **`SQL_INSTANCE`** v GitHub variables nesmí být prázdné — používáme `_` jako sentinel, server kód to interpretuje jako „no instance".
3. **`msnodesqlv8`** driver (NE výchozí tedious v `mssql`) — jediný způsob jak udělat pravou Windows Integrated Auth v doméně.
4. **`npm ci`** vs **`npm install`** — `package-lock.json` zatím není v repu, takže workflow používá `npm install`.
5. **`B-S-W-SQL-04`** je default instance, NE `\BCNEW` (BCNEW byl jen RDP alias title baru, mate to).
6. **WAN monitor** = žádná nová infra (žádné tabulky, žádná OS závislost) — jen vestavěný `ping.exe` + `fetch`, řízeno z `settings`. Default speed test je **vypnutý** (`wan.speedtest_enabled=0`), protože stahuje reálný soubor a stojí pásmo. Viz krok 7c.
7. **Rychlost linky pobočky NEMĚŘ přes router.** Měření per-pobočka rychlosti internetu přes MikroTik `/tool/fetch` **nefunguje** — RouterOS fetch je na hEX CPU/TLS-bound (naměřeno ~3.9 Mbps), takže odráží router, ne linku. Tudy už nechoď — zdraví linky pobočky je proto **jen latence + ztrátovost**.
8. **Service-port matice je parkovaná (`svcports.enabled=0`, migrace 070).** Scheduler `startServicePortsSchedule()` startuje při boot, ale nic neběží — žádná nová infra, žádné nové firewall pravidlo (viz krok 7d). Discovery scan je výhradně user-triggered.
9. **Link-speed měření po SMB je default vypnuté (`linkspeed.enabled=0`, migrace 074) a míří jen na klienty.** Scheduler `startLinkSpeedSchedule()` startuje při boot, ale nic neběží, dokud se v Settings UI nezapne + nenastaví cíle/okno. Zápis N-MB souboru jde na `C$` klientů přes SMB — service account `svc-itdashboard` tam má admin přístup (přes **Server Admins**), ale na **serverech/DC selže s EPERM** (není Domain Admin) — očekávané, cíluj klienty. Datová náročnost = `size_mb` × PC × 2 × `cycles`, takže „všechna PC" je těžké → nasazuj s oknem/intervalem. Testovací soubor `C:\tmp\itdash-speedtest\<linkspeed.filename>` se vždy uklidí, ale patří do **PATH výjimek AV (ESET)** na klientech (soubor je bez přípony záměrně, ale spolehlivá je jen výjimka na cestu — proto je jméno konfigurovatelné). Viz krok 7e.
10. **„Dosáhne POBOČKA na tiskárnu" se NEMĚŘÍ z centra.** Probe z `.213` testuje vantage centra, ne pobočky — pro „umí pobočka dosáhnout svou tiskárnu" je správné měřit **z pobočkového routeru** (MikroTik netwatch / REST ping), ne centrálně. Zamítnuto/odloženo do doby, než probíhající SD-WAN separace tiskové sítě nadefinuje tiskový segment. Pozor: API user `dhcp-reader` je **read-only**, takže router-side test/netwatch by potřeboval vyšší policy.

## Hotovo

Od teď: `local edit → git push → auto-deploy`. Žádné manuální sahání na server.

Troubleshooting:

- Actions run failne → GitHub UI → Actions → workflow run → klikni na job → krok s ✗ → log
- API service nestartuje → `C:\Apps\ITDashboard\logs\api.err.log`
- DB connect fail → ověř `AXINETWORK\svc-itdashboard` má `db_owner` na DB `ITDashboard`
- Runner offline v GitHub UI → `Get-Service 'actions.runner.*'`, restart pokud Stopped
