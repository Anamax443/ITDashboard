# ITDashboard

Domain & PC admin dashboard. AD insight, eventlog analytics (warning/critical focus), and a script runner for IT operators.

## Architecture

```
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│ IT specialista  │       │  10.8.2.213          │       │  10.8.2.225      │
│ Electron client │◄─────►│  Node.js API svc     │◄─────►│  SQL Server      │
│ (per-PC install)│ HTTPS │  Eventlog collector  │ TDS   │  DB: ITDashboard │
│                 │       │  Script runner       │ Integ │                  │
└─────────────────┘       │  (Windows Services)  │ Auth  │                  │
                          └──────────────────────┘       └─────────────────┘
                                    ▲
                                    │ WinRM (Get-WinEvent)
                                    ▼
                          ┌──────────────────────┐
                          │ Target PCs / NTB     │
                          │ (Windows in doméně)  │
                          └──────────────────────┘
```

- **Klient:** Electron + React + TypeScript. Per-PC install pro IT operátory.
- **API + collector:** Node.js + Fastify + TypeScript. Běží jako Windows Service na `10.8.2.213`.
- **DB:** MSSQL na `10.8.2.225\BCNEW`. Windows Integrated Auth (service account).
- **Sběr eventlogů:** Pull přes WinRM (`Get-WinEvent`), focus na Warning/Error/Critical.
- **Retence:** Raw events 90 dní, denní agregáty napořád.

## Layout

```
ITDashboard/
  apps/
    desktop/                  # Electron + React (klient)
    server/                   # Fastify API + collector + retention jobs
      migrations/             # MSSQL SQL files
  packages/
    ad-bridge/                # PS wrapper pro Get-ADComputer, Get-ADUser
    eventlog-collector/       # PS wrapper pro Get-WinEvent přes WinRM
    credential-vault/         # DPAPI encrypt/decrypt (CurrentUser scope)
  scripts/                    # Versionovaný katalog PS/Python/C# skriptů
    powershell/
    manifest.json
  docs/
    ARCHITECTURE.md
    SETUP-SERVER.md           # Jednorázový setup 10.8.2.213
  .github/workflows/
    ci.yml                    # typecheck + build na PR
    deploy.yml                # self-hosted runner → 10.8.2.213
```

## Development workflow

```
local edit → git push → GitHub Actions (self-hosted runner) → 10.8.2.213 auto-deploy
```

Local dev:
```
npm install
cp .env.example .env       # nastav SQL_HOST etc.
npm run dev --workspace @itdashboard/server
npm run dev --workspace @itdashboard/desktop
```

## Status

`0.0.1` — scaffold. Žádný produkční nasazený kód.

## Setup

- [docs/SETUP-SERVER.md](docs/SETUP-SERVER.md) — jednorázový setup admin serveru `10.8.2.213`
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions, retention, security
