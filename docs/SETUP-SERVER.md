# Setup admin serveru `10.8.2.213` (B-S-W-MIKOS)

Jednorázové kroky pro bootstrap. Spouští se přes RDP pod účtem s admin právy na serveru a SQL sysadmin na 10.8.2.225.

Po dokončení už nikdy nemusíš na server ručně — každý `git push` do `main` se auto-deployne přes GitHub Actions self-hosted runner.

**Real-world setup proběhl 2026-06-01.** Tento dokument reflektuje skutečnost, ne ideál.

## 0. Prerekvizity

- [ ] RDP přístup na `10.8.2.213` s lokálním admin / Domain Admin v doméně `AXINETWORK.LOC`
- [ ] SQL přístup na `10.8.2.225` (default instance — `B-S-W-SQL-04`, NE `\BCNEW`) jako sysadmin
- [ ] GitHub repo admin role na `Anamax443/ITDashboard`

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

# .env
@'
SQL_HOST=10.8.2.225
SQL_INSTANCE=
SQL_DATABASE=ITDashboard
SQL_TRUSTED_CONNECTION=true
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
& $nssm set $svc Description 'ITDashboard API + eventlog collector'

[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
Remove-Variable pwdPlain, pwdSecure

Start-Service $svc
Invoke-RestMethod http://localhost:4000/health
Invoke-RestMethod http://localhost:4000/health/db   # → ok:true
```

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

## Hotovo

Od teď: `local edit → git push → auto-deploy`. Žádné manuální sahání na server.

Troubleshooting:

- Actions run failne → GitHub UI → Actions → workflow run → klikni na job → krok s ✗ → log
- API service nestartuje → `C:\Apps\ITDashboard\logs\api.err.log`
- DB connect fail → ověř `AXINETWORK\svc-itdashboard` má `db_owner` na DB `ITDashboard`
- Runner offline v GitHub UI → `Get-Service 'actions.runner.*'`, restart pokud Stopped
