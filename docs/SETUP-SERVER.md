# Setup admin serveru `10.8.2.213`

Jednorázové kroky. Spouští se přes RDP pod účtem s admin právy na serveru.

Po dokončení už nikdy nemusíš na server ručně — každý `git push` do `main` se auto-deployne přes GitHub Actions self-hosted runner.

## 0. Prerekvizity

- [ ] RDP přístup na `10.8.2.213` s lokálním admin / Domain Admin
- [ ] SQL přístup na `10.8.2.225\BCNEW` jako sysadmin (jednorázově pro create DB)
- [ ] Doménový service account `MICOS\svc-itdashboard` (pokud neexistuje, vytvoř přes ADUC)
- [ ] GitHub repo admin role na `Anamax443/ITDashboard` (pro registraci runneru)

## 1. Install Node.js LTS 20

```powershell
# Stáhni LTS installer z https://nodejs.org/ a nainstaluj
# Ověř:
node --version    # v20.x.x
npm --version
```

## 2. Install Git

```powershell
# https://git-scm.com/download/win
git --version
```

## 3. Install RSAT ActiveDirectory PowerShell module

```powershell
Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0
Import-Module ActiveDirectory
Get-ADDomain | Select Name    # smoke test
```

## 4. Install NSSM (pro Windows Service wrapper)

```powershell
# Stáhni nssm.exe z https://nssm.cc/download a rozbal do C:\Tools\nssm\
# Ověř:
C:\Tools\nssm\nssm.exe version
```

## 5. Clone repo + první build

```powershell
New-Item -ItemType Directory -Force C:\Apps
cd C:\Apps
git clone https://github.com/Anamax443/ITDashboard.git
cd ITDashboard
npm ci
npm run build
```

## 6. Configure `.env`

```powershell
Copy-Item .env.example .env
notepad .env
# Nastav:
#   SQL_HOST=10.8.2.225
#   SQL_INSTANCE=BCNEW
#   SQL_DATABASE=ITDashboard
#   SQL_TRUSTED_CONNECTION=true
#   API_PORT=4000
#   COLLECTOR_LEVELS=Warning,Error,Critical
#   RETENTION_RAW_DAYS=90
```

## 7. Create DB + grant service account

Spusť v SSMS (nebo `sqlcmd`) proti `10.8.2.225\BCNEW`:

```sql
CREATE DATABASE ITDashboard;
GO
USE ITDashboard;
GO
CREATE LOGIN [MICOS\svc-itdashboard] FROM WINDOWS;
CREATE USER [MICOS\svc-itdashboard] FOR LOGIN [MICOS\svc-itdashboard];
ALTER ROLE db_owner ADD MEMBER [MICOS\svc-itdashboard];
GO
```

Pak v repo dir spusť migrace (poprvé pod tvým účtem stačí, pokud máš grant):

```powershell
cd C:\Apps\ITDashboard\apps\server
npm run migrate
```

## 8. Install API jako Windows Service

```powershell
$svc = 'ITDashboardAPI'
$nssm = 'C:\Tools\nssm\nssm.exe'
$node = (Get-Command node).Source
$app  = 'C:\Apps\ITDashboard\apps\server\dist\index.js'

& $nssm install $svc $node $app
& $nssm set $svc AppDirectory 'C:\Apps\ITDashboard\apps\server'
& $nssm set $svc AppStdout 'C:\Apps\ITDashboard\logs\api.out.log'
& $nssm set $svc AppStderr 'C:\Apps\ITDashboard\logs\api.err.log'
& $nssm set $svc ObjectName 'MICOS\svc-itdashboard' '<svc-account-password>'
& $nssm set $svc Start SERVICE_AUTO_START
New-Item -ItemType Directory -Force C:\Apps\ITDashboard\logs
Start-Service $svc
Get-Service $svc
```

Smoke test:

```powershell
Invoke-RestMethod http://localhost:4000/health
Invoke-RestMethod http://localhost:4000/health/db
```

## 9. Firewall — povol port 4000 v doméně

```powershell
New-NetFirewallRule -DisplayName 'ITDashboard API' `
  -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow `
  -Profile Domain
```

## 10. Register GitHub Actions self-hosted runner

V GitHub UI: **Anamax443/ITDashboard → Settings → Actions → Runners → New self-hosted runner → Windows x64**.

Zkopíruj příkazy z GitHub UI a spusť je v PowerShellu jako admin. Postupně:

```powershell
New-Item -ItemType Directory -Force C:\Actions-Runner
cd C:\Actions-Runner

# 1) Download (GitHub ti dá konkrétní verzi)
Invoke-WebRequest -Uri <URL z GitHub UI> -OutFile actions-runner.zip
Expand-Archive actions-runner.zip -DestinationPath .

# 2) Configure (token je z GitHub UI, jednorázový)
.\config.cmd --url https://github.com/Anamax443/ITDashboard --token <token z UI> `
  --labels itdashboard-prod --runasservice --windowslogonaccount 'MICOS\svc-itdashboard' `
  --windowslogonpassword '<svc-account-password>'

# 3) Install + start jako Windows Service (config.cmd to udělal s --runasservice)
Get-Service 'actions.runner.*'
```

Ověř v GitHub UI → Settings → Actions → Runners — runner musí být **Idle** s labelem `itdashboard-prod`.

## 11. Repo secrets / variables

V GitHub UI: **Settings → Secrets and variables → Actions → Variables → New variable**:

| Name | Value |
|------|-------|
| `SQL_HOST` | `10.8.2.225` |
| `SQL_INSTANCE` | `BCNEW` |
| `SQL_DATABASE` | `ITDashboard` |

(Žádné secrets potřeba — SQL používá Integrated Auth přes service account, který spouští runner.)

## 12. První deploy přes Actions

```powershell
# Na tvém local PC:
cd d:\git\ITDashboard
git commit --allow-empty -m "chore: trigger first deploy"
git push
```

V GitHub UI → Actions → "Deploy to 10.8.2.213" run by sjet zelený. Ověř na serveru:

```powershell
Invoke-RestMethod http://10.8.2.213:4000/health
```

## Hotovo

Od teď: `local edit → git push → auto-deploy`. Na server už nemusíš sahat.

Troubleshooting:

- Actions run failne → GitHub UI → Actions → workflow run → logs
- API service nestartuje → `C:\Apps\ITDashboard\logs\api.err.log`
- DB connect fail → `Test-NetConnection 10.8.2.225 -Port 1433` a ověř `MICOS\svc-itdashboard` grant
