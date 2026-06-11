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

## Configuration

All environment-specific values (SQL host, AD/LDAP endpoints, domain, ports)
are config, not code — the source tree carries no IPs or hostnames. To deploy
this repo into a different environment you only change access/config, not code:

1. **Runtime `.env`** — copy [`.env.example`](.env.example) to `apps/server/.env`
   on the API host and fill in your values. It is the single source of truth and
   documents every variable the server reads. The `.env` is operator-owned and is
   never overwritten by deploys (`robocopy … /XF .env`). The keys you must set for
   a new environment (`[REQUIRED]` in the template):

   | Key | What it is |
   |-----|------------|
   | `SQL_HOST` | SQL server IP/hostname |
   | `SQL_INSTANCE` | named instance, or empty for default instance |
   | `SQL_DATABASE` | database name (default `ITDashboard`) |
   | `AD_LDAP_URL` | comma-separated DC LDAP URLs (edit-tier login) |
   | `AD_LDAP_DOMAIN` | default UPN suffix for bare usernames |
   | `AD_LDAP_BASE_DN` / `AD_EDIT_GROUP` | search root + edit-tier group DN |

2. **GitHub Actions variables** (only if you use the auto-deploy pipeline) — set
   `SQL_HOST`, `SQL_INSTANCE`, `SQL_DATABASE` as repository *Variables*; the
   self-hosted runner label in [`deploy.yml`](.github/workflows/deploy.yml) must
   match a runner registered on your host.

3. **Clients need no code change** — the browser UI is served by the API and uses
   relative URLs. The protocol-handler installer (`/actions/install-handlers.cmd`)
   is rewritten by the server at download time to point back at whatever host it
   was fetched from. Only the packaged Electron client needs an explicit
   `VITE_API_BASE` baked at build time.

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

**Sprint 1.5 (2026-06-04):** edit-tier hardening. (a) Successful LDAP bind alone is not enough — the dashboard also requires the authenticated user to be a member of an AD group (`AD_EDIT_GROUP`, transitive membership via `LDAP_MATCHING_RULE_IN_CHAIN`). Without the group, a domain janitor who knows their own password could still unlock the edit tier. Defaults to deny in production when `AD_EDIT_GROUP` is unset. (b) `AD_LDAP_STUB=1` now refuses to boot if `NODE_ENV=production`. (b1) `AD_LDAP_URL` accepts a comma-separated list of LDAP URLs for multi-DC failover (one entry per DC; `ldapts` does not do AD SRV discovery, so list each explicitly). (c) Downloaded `.bat` files for PsExec and admin-share open now force a credential prompt at run time (`set /p adminuser` + `runas /netonly`) — never silently fall back to the operator's current Windows session credentials, which on a multi-tier-account workstation would typically be the basic-tier user and get Access Denied. The `.rdp` file already forces credentials via `prompt for credentials:i:1`. New env vars: `AD_LDAP_BASE_DN`, `AD_EDIT_GROUP`.

New `itd-ps://` launcher for remote PowerShell via `Enter-PSSession`. Registered alongside the existing handlers; PowerShell `Get-Credential` is used for the native both-fields credential dialog (PS `-Command` inline form bypasses ExecutionPolicy / AllSigned restrictions). The same `last-admin-user.txt` cache is shared with the cmd-side ask mode.

**Sprint 1.6 prep (2026-06-04):** DC-side prerequisites for the upcoming Windows Authentication via IIS reverse proxy are now in place — DNS A record `itdashboard.axinetwork.loc → 10.8.2.213`, two HTTP SPNs registered on `svc-itdashboard`. Server-side env vars configured against the 3-DC AXINETWORK domain; `/api/auth/stats` reports `ldapMode: "ldap"`. MIKOS-side IIS install + URL Rewrite + ARR + HTTPS binding remains a separate CR (pending). Session-store TypeScript groundwork (Session.authMethod union, createWindowsSession helper) merged; auth.ts cookie `secure` flag is gated by `ITD_COOKIE_SECURE` env var to flip on TLS rollout. CR and reaction documents archived under `docs/oponentury/` and `docs/change-requests/`. gMSA migration for `svc-itdashboard` was reviewed and **rejected** by operator — account remains a regular domain user.

**Retention pipeline (2026-06-04):** added `sp_purge_duplicate_events` daily pass alongside the existing event/activity/pc_user_history purges. Settings UI exposes the full retention block (per-table retention days + run hour + dedup enabled + dedup lookback). Manual run button with per-step checkboxes — operator picks which step to run (events purge / activity purge / pc_user_history purge / dedup). Structured run report in the UI shows rows deleted + duration + status per step. New routes `GET /api/retention/status` and `POST /api/retention/run`.

**Sprint 1.7 — Services tab (2026-06-04):** Win32 ExitCode + ServiceSpecificExitCode now collected from each monitored service (migration 026). The Services tab gets an Exit column + "⚠ Only ExitCode != 0" filter (default ON) so the primary view shows genuinely crashed services rather than gracefully self-stopped trigger-start services. Hide trigger-start / Hide delayed-start filters refined: they now hide only the graceful (exit=0) cases; a trigger-start service that crashed always surfaces. Header tile shows "⚠ N crashes" as the primary metric. NIS2 / ISO 27001 monitoring policy section in `docs/dashboard.html` documents what is monitored, what is hidden by default and why, ExitCode semantics, and known blind spots (no crash-loop detection, no state history, per-install whitelist, scan interval gap). External oponentura on alert-fatigue + ExitCode landed and is archived; gMSA / SCOM / Zabbix alternative suggestions were rejected per separate analysis.

**Sprint 1.8 — table UX (2026-06-04):** per-tab export button (PDF / HTML / CSV / TXT) on every table tab — Události / Počítače / Služby / Aktivita / Výkon. Exported files carry a visible "⚠ Filtrováno: …" banner whenever a filter is active so the audit trail is unambiguous. New `Filtrování — vícenásobná kombinace` section in `docs/dashboard.html` documenting AND combination semantics across tabs. Events tab gets a dedicated Event ID filter input supporting single (`4098`), inclusive range (`4000..8000` or `4000-8000`), and comma list (`1001, 4098, 7031`) syntax. Cross-tab navigation: clicking a computer name in Events / Services / Perf jumps to the Computers tab with the search pre-filled and any status chip cleared. Search inputs across all tabs widened 2x. Floppy emoji 💾 (= SAVE) replaced with 🩺 (diagnostic) wherever it was used for "scan disks" — semantic correction, archived as a memory rule for future regression prevention.

**Disk evaluation (2026-06-04):** new per-tier drive-letter scope. Two settings (`disk.crit_drives` and `disk.warn_drives`, default `C` for both) decide which drives participate in the critical and warning thresholds respectively. Negation syntax `<>C` or `!C` means "every drive except C". Typical multi-drive recipe: critical=`C` (system), warning=`<>C` (data / external / USB — a problem but not a system emergency). Drives outside both scopes still appear in the Disks column for situational awareness but do not change the PC status. Legacy single-tier `disk.eval_drive_letters` setting still works as the fallback default for both tiers.

## Setup

- [docs/SETUP-SERVER.md](docs/SETUP-SERVER.md) — one-time server bootstrap (Node, NSSM, DB, runner registration, ACL grants)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions
- [docs/dashboard.html](docs/dashboard.html) — full user/operator documentation (also served live at `http://10.8.2.213:4000/docs`)
