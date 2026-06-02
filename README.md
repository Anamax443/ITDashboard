# ITDashboard

Internal IT operations dashboard for the **AXINETWORK** domain. Eventlog analytics, AD-synced computer inventory, disk space monitoring, per-PC reachability classification — ~225 domain machines.

## What it does

- **Eventlog visibility** — pulls Warning/Error/Critical events from every monitored PC into a central DB. Filter, search, sort, drill down.
- **AD-synced inventory** — keeps a current list of domain computers (OS, last logon, OU path) with operator-controlled per-PC monitor toggle.
- **Disk space monitoring** — periodic DCOM scan; configurable thresholds (% / GB); colored progress bars; drill-down filter.
- **Reachability classification** — every collector run categorises each PC as `online` / `offline` / `rpc_unavailable` / `access_denied`. Dashboard surfaces breakdown.
- **Activity log** — terminal-style live view of every collector / sync / disk-scan action with filter, pause, copy-to-clipboard.
- **Settings page** — collection intervals + disk thresholds, applied live without service restart.

## Live topology

```
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│ IT operator     │       │  10.8.2.213 (MIKOS)  │       │  10.8.2.225     │
│ Electron client │◄─────►│  Node.js API svc     │◄─────►│  SQL Server     │
│ or browser      │ HTTPS │  Eventlog collector  │ TDS   │  DB: ITDashboard│
│                 │       │  Disk collector      │ Integ │                 │
└─────────────────┘       │  AD sync             │ Auth  └─────────────────┘
                          │  (Windows Services)  │
                          └──────────────────────┘
                                    ▲ Get-WinEvent / Get-CimInstance via DCOM
                                    │ TCP probe :135 for fail-fast offline detect
                                    ▼
                          ┌──────────────────────┐
                          │ Target PCs (AXINET)  │
                          └──────────────────────┘
```

## Stack

- **Server (`apps/server`)** — Node.js 20 + Fastify + TypeScript. Runs as Windows Service `ITDashboardAPI` (NSSM) under `AXINETWORK\svc-itdashboard`.
- **DB** — MSSQL on `10.8.2.225` (default instance), DB `ITDashboard`, Integrated Auth via `msnodesqlv8` driver (NOT pure-JS tedious — that fails with "untrusted domain" in domain envs).
- **Desktop client (`apps/desktop`)** — Electron + React + Vite + TypeScript. Per-PC install or accessed via browser through Vite.
- **Deploy** — GitHub Actions self-hosted runner on 10.8.2.213. Push to `main` → auto-deploy.

## Layout

```
ITDashboard/
  apps/
    desktop/                       # Electron + React UI (Dashboard, Events, Computers, Activity, Settings)
    server/                        # Fastify API + collectors + AD sync
      migrations/                  # MSSQL migrations 001–009
  packages/
    ad-bridge/                     # AD wrapper (Get-ADComputer)
    eventlog-collector/            # standalone wrapper (currently inlined in server)
    credential-vault/              # DPAPI wrapper
  scripts/                         # Versionovaný katalog PS/Python/C# skriptů
    powershell/
    manifest.json
  docs/
    dashboard.html                 # Comprehensive user-facing doc (served at /docs)
    ARCHITECTURE.md                # Architecture decisions
    SETUP-SERVER.md                # One-time server bootstrap
  .github/workflows/
    deploy.yml                     # self-hosted runner → 10.8.2.213
```

## Development workflow

```
local edit (d:/git/ITDashboard) → git push origin main → GitHub Actions → 10.8.2.213 auto-deploy
```

For UI work (frontend HMR):
```powershell
cd apps/desktop
npm install   # if first time
npm run dev   # opens http://localhost:5173/
```

The browser UI talks to API at `http://10.8.2.213:4000` (CORS open). Your dev PC's IP must be in the firewall whitelist on the server.

## Status

**LIVE since 2026-06-01.** Auto-deploy pipeline green. 211 monitored PCs covered by eventlog + disk collectors. See [docs/dashboard.html](docs/dashboard.html) for full feature reference.

## Setup

- [docs/SETUP-SERVER.md](docs/SETUP-SERVER.md) — one-time server bootstrap (Node, NSSM, DB, runner registration, ACL grants)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions
- [docs/dashboard.html](docs/dashboard.html) — full user/operator documentation (also served live at `http://10.8.2.213:4000/docs`)
