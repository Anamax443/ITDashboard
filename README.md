# ITDashboard

Internal IT operations dashboard for the **AXINETWORK** domain. Eventlog analytics, AD-synced computer inventory, disk space monitoring, per-PC reachability classification — ~225 domain machines.

## What it does

- **Eventlog visibility** — pulls Warning/Error/Critical events from every monitored PC into a central DB. Filter, search, sort, drill down.
- **AD-synced inventory** — keeps a current list of domain computers (OS, last logon, OU path) with operator-controlled per-PC monitor toggle.
- **Disk space monitoring** — periodic DCOM scan; configurable thresholds (% / GB); colored progress bars; drill-down filter.
- **Services collector + policy** — detects Auto + non-Running services across the fleet, classifies legitimate cases (Trigger / Delayed / per-user), flags real drift against a policy table, GPO PS script export.
- **Performance events** — pulls slow boot / shutdown / standby / resume records from the `Microsoft-Windows-Diagnostics-Performance/Operational` channel with named culprits and timings (observer of Windows' own diagnostics, no continuous polling).
- **Reachability classification** — every collector run categorises each PC as `online` / `offline` / `rpc_unavailable` / `access_denied`. Dashboard surfaces breakdown.
- **Activity log** — terminal-style live view of every collector / sync / disk-scan action with filter, pause, copy-to-clipboard.
- **Settings page** — periodic check frequency, days/time window, enabled checks + disk thresholds, applied live without service restart.
- **Per-PC Actions** — one-row remote-admin shortcuts (MMC, services, event viewer, task scheduler, RDP, admin shares) with copy/download fallbacks and optional hardened `itd-*` URL protocol handlers.

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
      migrations/                  # MSSQL migrations 001–016
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

Protocol handler security follow-up from 2026-06-03 is archived in [docs/oponentury/2026-06-03-oponentura-3-protocol-handlers-followup.md](docs/oponentury/2026-06-03-oponentura-3-protocol-handlers-followup.md) with response in [docs/oponentury/2026-06-03-reakce-3-protocol-handlers-followup.md](docs/oponentury/2026-06-03-reakce-3-protocol-handlers-followup.md). Verdict: hardened handlers are OK to deploy; Explorer intentionally supports only admin shares (`C$`, `D$`), PsExec remains opt-in, and `ITD_ADMIN_USER` uses expected `runas /netonly` password prompts.

Protocol handler installer fix from commit `0cc27a3`: Windows `.cmd/.bat` files are pinned to CRLF, the installer avoids cmd-unsafe comment text, and generated launchers leave the console open with a reason + `%LOCALAPPDATA%\ITDashboard\launchers\last-itd-*.log` on failure. If a workstation already installed older handlers and Launch only flashes a CMD window, download and run `/actions/install-handlers.cmd` again on that workstation.

Deploy smoke tests now verify both the running `/version/sha` and the browser UI root `/`. This catches cases where the API service picked up the new commit but the server cannot find `apps/desktop/dist/renderer`.

Protocol handler oponentura 4 from 2026-06-03 is archived in [docs/oponentury/2026-06-03-oponentura-4-installer-v2-review.md](docs/oponentury/2026-06-03-oponentura-4-installer-v2-review.md) with response [docs/oponentury/2026-06-03-reakce-4-installer-v2-review.md](docs/oponentury/2026-06-03-reakce-4-installer-v2-review.md). Verdict: production enterprise-ready, one accepted hardening — generated launcher fail screens no longer echo the raw URL to console (console reflected injection eliminated). Full URL is still recorded in `%LOCALAPPDATA%\ITDashboard\launchers\last-itd-*.log` for helpdesk diagnosis. Reinstall via `/actions/install-handlers.cmd` on each operator workstation to pick up the change.

`ITD_ADMIN_USER` defaults to `ask` mode when the env var is **unset** (the typical case after a fresh handler install). In `ask` mode, every Launch prompts in CMD for the admin account (empty first time, pre-fills the last typed user on subsequent runs from `%LOCALAPPDATA%\ITDashboard\launchers\last-admin-user.txt`), then opens the Windows credential dialog for the password. Password is never persisted. **No per-user setup is needed** — multiple IT specialists sharing the operator workstation each just type their own admin login when prompted. Overrides: `ITD_ADMIN_USER=AXINETWORK\trnka_admin` for a fixed pre-filled user (single-admin workstation, dialog only asks for password); `ITD_ADMIN_USER=current` to opt out of the admin wrap and run launchers as the current Windows user.

For workstations where multiple Windows accounts (operator regular login + domain admin account + helpdesk login…) all need the handlers, run the installer with `/machine` from elevated cmd / PS. That installs launcher files to `C:\ProgramData\ITDashboard\launchers` and protocol handlers to `HKLM\Software\Classes\itd-*` — every Windows account on the workstation immediately gets the handlers, no per-user installer run needed. If any user has prior per-user (HKCU) pollution that shadows the HKLM registrations, they run `install-handlers.cmd /uninstall-hkcu` once (no admin needed) to clear it.

**Auth Gate (Sprint 1, 2026-06-03):** the dashboard now supports a page-load admin credential prompt with a server-mediated short-lived credential vault. Send a recipient the dashboard URL; on first Launch click they type their admin credentials (LDAP bind against AXINETWORK), the server stores them in memory for the duration of their browser session (30 min idle / 8 h hard max), and every subsequent Launch click uses those credentials silently via a one-shot 30 s redeem token + cmdkey. No per-launch CMD prompt or Windows credential dialog. Launchers still support the per-launch ask mode as a fallback when no token is in the URL. New server env vars: `AD_LDAP_URL`, `AD_LDAP_DOMAIN`, `AD_LDAP_TIMEOUT_MS`. Set `AD_LDAP_STUB=1` to accept any non-empty creds for first-deploy testing (NOT for production).

New `itd-ps://` launcher for remote PowerShell via `Enter-PSSession`. Registered alongside the existing handlers; PowerShell `Get-Credential` is used for the native both-fields credential dialog (PS `-Command` inline form bypasses ExecutionPolicy / AllSigned restrictions). The same `last-admin-user.txt` cache is shared with the cmd-side ask mode.

## Setup

- [docs/SETUP-SERVER.md](docs/SETUP-SERVER.md) — one-time server bootstrap (Node, NSSM, DB, runner registration, ACL grants)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions
- [docs/dashboard.html](docs/dashboard.html) — full user/operator documentation (also served live at `http://10.8.2.213:4000/docs`)
