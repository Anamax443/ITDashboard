# ITDashboard

Internal IT operations dashboard for the **AXINETWORK** domain. Eventlog analytics, AD-synced computer inventory, disk space monitoring, live per-PC network reachability — ~225 domain machines.

## What it does

- **Eventlog visibility** — pulls Warning/Error/Critical events from every monitored PC into a central DB. Filter, search, sort, drill down.
- **AD-synced inventory** — keeps a current list of domain computers (OS, last logon, OU path) with operator-controlled per-PC monitor toggle.
- **Disk space monitoring** — periodic DCOM scan; configurable thresholds (% / GB); colored progress bars; drill-down filter.
- **Disk email alerts** — per-PC opt-in (📧 Disk column in Computers, optional per-PC drive letters like `C,F`); emails a mobile-friendly critical-disk report (per-disk card, PC IP, generation timestamp, dashboard link) after a scan, throttled to once per configurable interval. SMTP relay, recipients, cadence and dashboard URL all in Settings; off by default. Reference deployment delivers via Microsoft 365 Direct Send (port 25, no auth).
- **Service email alerts (two levels, per-PC exceptions)** — two per-PC opt-in columns in Computers, each a checkbox + an ignore-list field: **🔧 Služby** (broad — every Auto service not Running) and **🛡 Krit. služby** (the configurable critical-services list: NTDS, DNS, Kdc, Netlogon, … + wildcards). A critical service is reported only by the critical level (broad skips critical names → never twice). Per-PC exceptions (`service_exceptions` / `critical_service_exceptions`, glob) let a demoted DC suppress e.g. `NTDS,Kdc` locally without muting them fleet-wide; the broad level also excludes on-demand trigger/delayed services. Flapping protection (time-based debounce + optional maintenance window) so nightly reboots don't page anyone; a whitelist for noisy updaters that also doubles as a global view filter (Dashboard "Stopped services" tile + Services tab). Optional **port checks** TCP-probe key infra ports (LDAP 389, SMB 445, RDP 3389, Kerberos 88, DNS 53) to catch "running but unreachable". **Per-agenda recipients**: disk / services / ports / report alerts each route to their own list (`alerts.*.recipients`) with fallback to the shared `alerts.recipients`; SMTP relay/From/dashboard URL are shared in a standalone Email settings section. Off by default.
- **Structured fleet report + email** — a PC-vs-servers overview (offline machines with down-since, collection-health counts) you can email straight from the Computers tab ("✉ Report e-mailem") for the currently filtered machines; same generator drives the on-screen and emailed forms. Every alert/report email subject leads with a **machine-readable marker** — `[OK]`/`[CHYBA]` (does it carry a problem) + `[RUČNĚ]` (manual vs automatic) — so a mail rule can auto-file the clean ones.
- **Services collector + policy** — detects Auto + non-Running services across the fleet, classifies legitimate cases (Trigger / Delayed / per-user), flags real drift against a policy table, GPO PS script export.
- **Critical services — real state** — the configured critical-services list (`alerts.services.critical_names`: NTDS, DNS, Kdc, Veeam, …) is now captured on every machine where it exists, in **any** state (Running included), from the same CIM enumeration as the problem scan — so you can confirm the critical services actually run, not just spot the ones that broke. Dashboard tile "🛡 Critical services" (count not-running on reachable machines, red when >0) opens a "Critical services" tab: a sortable service × machine table of real State (Running/Stopped), start mode, IP, last check, with offline machines flagged amber (last-known rows kept stale), an only-not-running filter, search and export. Only services that exist on a machine get a row (servers vs PCs sorts itself out). Per-PC critical-service exceptions are honoured here too — an excepted non-running service is dropped from the "N not running" count and the dashboard tile, sinks to the bottom and renders greyed with an "exception" tag instead of red. DCs/locked-down servers that fail the CIM scan with "Access is denied" have no rows until the service account is granted WMI/DCOM rights there.
- **Performance events** — pulls slow boot / shutdown / standby / resume records from the `Microsoft-Windows-Diagnostics-Performance/Operational` channel with named culprits and timings (observer of Windows' own diagnostics, no continuous polling).
- **Port availability (Ports tab)** — a standalone collector TCP-probes each monitored PC's configured ports on its **own interval** (`port_status.interval_sec`, default 300 s; toggle `checks.run_port_status`), reusing the existing port list and timeout (`alerts.services.port_checks`, `alerts.services.port_timeout_ms`) so it works even when the phase-2 service/port alert emails are off. Offline PCs (`computers.reachable=0`) are skipped. The Ports tab is a grid of PC × port (● open + latency / ○ closed / — offline) with an "only issues" filter, a "Refresh" button (whole-fleet probe now), and a per-row "Ping" button. Removing a port from the Settings list drops it from the grid (the feed filters to currently-configured names and the probe prunes stale rows). Dashboard tile "🔌 Ports" (PCs with a closed port / total) opens it.
- **Device inventory (Devices tab)** — multi-source network inventory merged by MAC: MikroTik DHCP leases (dynamic leases **and** static reservations), the router ARP table, and an active subnet scan run from the app server (ping-sweep + local/router ARP). Each row carries its `source` (dhcp / arp / scan). Scan ranges are operator-configurable in Settings (CIDR `10.8.2.0/24` or wildcard `10.8.2.*`, optional `Site=` label; a leading `!`/`<>` excludes a whole subnet); discovery caches known IP↔MAC and a MAC reappearing at a new IP releases the old one, while remote subnets resolve MACs via the router ARP table. Each device is paired with an AD computer by host name (fallback IP): matched devices reuse the reachability collector's online/offline and pre-select pc/server from AD; unmatched devices (printers, phones, IoT) are pinged directly. Device names are resolved via NetBIOS (`nbtstat -A`) for scanned/ARP devices — with known printer NetBIOS prefixes (NPI/BRN/BRW/RNP/KMBT) feeding a printer/phone category suggestion — and the operator can manually edit a name (stored by MAC). An operator-assigned category is authoritative and **persists by MAC** across reloads and sites; categories themselves are operator-configurable in Settings (`devices.categories`, `key=Label`), with a generic "Printer" category collapsing per-vendor variants. The reachability ping also records per-device packet loss and average latency, shown as a compact `ms / %` column (e.g. `<5/0`). The Devices tab is a site / IP / hostname / MAC grid with a per-row category dropdown (clickable suggestion), Static/Dynamic Type column, online/offline, loss/latency, AD link, filters (site / "not in AD only" / "printers only" / "issues only"), Refresh, and a per-row Ping console.
- **Database tab** — DB size plus per-table footprint (rows / reserved / data) read from the SQL system catalog.
- **Reachability classification** — every collector run categorises each PC as `online` / `offline` / `rpc_unavailable` / `access_denied`. Dashboard surfaces breakdown.
- **Live reachability probe** — a standalone probe marks every enabled, non-excluded PC reachable if any of TCP 135 / TCP 445 / an ICMP ping fallback (`reachability.ping`, on by default — catches hosts that block RPC/SMB but answer ping) responds, on its **own interval** (`reachability.interval_sec`, default 300 s), independent of monitoring, the collector failure cap, **and the main-scan window** — so Status stays fresh 24/7. Drives the Computers **Status** column as live "is this PC on the network now": `Active` = reachable (dim "logs" marker if up but event log unreadable), `Offline` = not reachable, `Disabled` = AD account disabled. New **offline** filter chip/dropdown; toggle + interval in Settings → "Network reachability (Status)".
- **OS breakdown chart** — second-row "📊 Operating systems" dashboard tile (count of OS buckets) that expands an inline bar chart of the live managed fleet by canonical OS bucket (Windows 11/10/Server/…), each bar split into an active and a hatched "stale" (past inactivity threshold) segment; click a segment to drill into the Computers tab filtered to that OS + live/stale.
- **Problem-PC detection** — a second-row "Problem PCs" dashboard tile that ranks PCs by accumulated eventlog problems to surface boxes in trouble. A "damped blend" score over a configurable window caps per-signature occurrences (so one chatty driver can't flag a healthy box), weights severity, and rewards breadth (many *different* errors) and persistence (errors across many *days*) — catching a systemically sick box, not just a noisy one. Clicking the tile expands an inline breakdown table (score · crit · err · warn · types · days); each row jumps to that PC.
- **Activity log** — terminal-style live view of every collector / sync / disk-scan action with filter, pause, copy-to-clipboard.
- **Settings page** — periodic check frequency, days/time window, enabled checks + disk thresholds, applied live without service restart.
- **Per-PC Refresh** — the per-row 🔄 action in Computers (component `PcActions`) refreshes everything monitored for one PC in a single pass: disk, services, eventlog, perf, and now **ports** as a 5th step (`refresh-single-pc.ts`). The launcher / remote-management UI that used to live here (Remote MMC compmgmt/services/eventvwr/taskschd, Remote access RDP/PsExec/PS Remote, admin shares, copy helpers, the URL-handler installer banner) was **removed at operator request** — the modal now contains only the single-PC Refresh, and the launcher `actions.*` i18n keys were dropped. The server `/actions/*` install-handler routes and the handler scripts described in **Status** below are **retained but no longer surfaced from the UI**.
- **Ping console** — the per-row "Ping" button (Ports and Devices tabs) opens a cmd-style console modal showing the real `ping.exe` output (run via `cmd /c chcp 65001 & ping -n 4` so localized output comes back as UTF-8) plus per-port open/closed/latency lines. `POST /computers/:id/probe` runs a live ICMP ping + per-port TCP probe for one PC.

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
   | `MIKROTIK_SECRET` | AES-256-CBC key material (SHA-256'd) for the encrypted RouterOS password — set on the **application host** (10.8.2.213), where the in-process collector decrypts it |

2. **GitHub Actions variables** (only if you use the auto-deploy pipeline) — set
   `SQL_HOST`, `SQL_INSTANCE`, `SQL_DATABASE` as repository *Variables*; the
   self-hosted runner label in [`deploy.yml`](.github/workflows/deploy.yml) must
   match a runner registered on your host.

3. **Clients need no code change** — the browser UI is served by the API and uses
   relative URLs. The protocol-handler installer (`/actions/install-handlers.cmd`)
   is rewritten by the server at download time to point back at whatever host it
   was fetched from. Only the packaged Electron client needs an explicit
   `VITE_API_BASE` baked at build time.

4. **MikroTik DHCP + device inventory (Devices tab)** — **fully DB-driven**:
   the enable toggle, collection interval, routers (`Site=IP` comma list),
   RouterOS read-only user and the (encrypted) password all live in Settings →
   "MikroTik DHCP" — there are **no `MIKROTIK_*` env vars except `MIKROTIK_SECRET`**
   (the AES key). The password is stored **encrypted** in the DB, never plaintext —
   `secret-crypto.ts` (AES-256-CBC, key = SHA-256 of env `MIKROTIK_SECRET`).
   `GET /settings` masks it (••••); `PUT` encrypts it into
   `mikrotik.password_enc` (a submitted mask = leave unchanged, empty = clear).
   If `MIKROTIK_SECRET` is unset it falls back to a clearly-marked `plain:`
   prefix with a warning. The collector is **in-process and self-rescheduling**
   on the application server (10.8.2.213), exactly like every other collector
   (the DB on 10.8.2.225 is storage only, no PowerShell scripts on other
   servers); it idles when disabled, otherwise reads the router list/user from
   settings, decrypts the password, collects DHCP leases + router ARP + an active
   subnet scan, and pings unmatched devices. Active-scan ranges and device
   categories (`devices.categories`) are likewise Settings-driven; loss/latency
   "problem" thresholds tune the dashboard tile and "issues only" filter
   (`devices.problem_loss_pct` default 1, `devices.problem_latency_ms` default 50).
   Optional cert-bypassing printer web-UI proxy via `devices.web_proxy`
   (best-effort). Routes: `GET /devices`, `PATCH /devices/category`,
   `PATCH /devices/name`, `POST /devices/run`, `POST /devices/probe`.

## Layout

```
ITDashboard/
  apps/
    desktop/                       # Electron + React UI (Dashboard, Events, Computers, Services, Ports, Devices, Database, Activity, Settings)
    server/                        # Fastify API + collectors + AD sync
      migrations/                  # MSSQL migrations 001–047
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

**Service whitelist as view filter (commit `848af42`):** the `alerts.services.whitelist` setting (Settings → "Email alerty — služby") previously only suppressed email alerts. It now also hides matching services from two views, keeping them in sync: (a) the Dashboard "Stopped services" / "Zastavené služby" tile always excludes whitelisted services from its affected-PC count and "N services" subtitle; (b) the Services tab gets a "Hide whitelisted" checkbox (default ON) that hides matching rows and removes them from the top-line counts (total · crashes · drift · OK · unclassified) in both the By-PC and By-service views. Matching is the existing case-insensitive glob (`*`/`?`, against service name or display name). Motivation: known-benign updaters (`gupdate*`, `GoogleUpdater*`, `edgeupdate*`) were already whitelisted for alerts but still polluted the drift count and the tile. Shared client helpers `serviceWhitelist()` / `isServiceWhitelisted()` in `apps/desktop/src/api.ts`. Client-only — no server/DB change.

**OS breakdown chart (commit `38ba1c4`):** new homepage panel "Operating systems" / "Operační systémy" below the summary cards (`apps/desktop/src/components/OsBreakdownChart.tsx`), one horizontal bar per OS bucket over the live managed fleet (enabled and not excluded). The free-text AD `os_version` is normalized into canonical buckets by shared `osBucket()` ("Windows 11/10/8.1/8/7", "Windows Server <year>[ R2]", "Windows Vista/XP", generic "Windows Server", else "Other"; null/empty = "Unknown"). Each bar splits into an active segment and a hatched dimmed "stale" segment — "stale" being machines past the inactivity threshold (`inactive.threshold_days`, default 90) that are not excluded and not yet deactivated (helper `isStaleComputer()`, same definition as the inactive card/filter). Clicking the active segment drills into Computers filtered to that OS bucket + live; clicking the stale segment filters to that OS + stale, surfaced as a removable chip ("OS: Windows 11 · stale ✕") in the Computers header and mutually exclusive with the status chips. Chart counts and the drill-down list agree (both go through `osBucket()` / `isStaleComputer()`). Client-only — no server/DB change.

**Live reachability probe (commit `a12ad36`):** the Computers **Status** column used to be a by-product of the eventlog collector — it ran only on enabled + monitored + non-excluded PCs, classified failures crudely (offline / rpc_unavailable / access_denied / unknown), and FROZE once a PC passed the failure cap, so a reachable box with an unreadable event log showed "Unknown" and an AD-enabled box never classified got a green "Active" fallback. It never answered "is this PC on the network now"; there was no ping. New standalone probe `apps/server/src/services/reachability-collector.ts` treats EVERY enabled && !excluded PC (independent of monitoring and of the failure cap) as reachable if any of TCP 135 (RPC endpoint mapper) / TCP 445 (SMB) / an ICMP ping fallback (`reachability.ping`, migration 036, on by default — for hosts that block RPC/SMB but answer ping) responds. Runs on its own standalone timer (`startReachabilitySchedule`, every `reachability.interval_sec`), recording `reachable` / `last_reachable_at` / `reach_checked_at`. Status now means live reachability: `Disabled` = AD account disabled; `Active` = reachable now (secondary dim "logs" marker when up but event log unreadable — permissions/RPC); `Offline` = not reachable (powered off / disconnected). Until the first probe `reachable` is null and the column falls back to the old `last_status` with a neutral "— not probed". New **offline** filter (status chip + dropdown) = enabled && !excluded && reachable false, plus a Settings toggle for the probe. Migration 032 adds the three columns + settings `checks.run_reachability=1`, `reachability.ports=135,445`, `reachability.timeout_ms=2000`; migration 035 adds `reachability.interval_sec=300` and the probe was moved out of checks-runner onto its own timer (independent of the main-scan window, so Status stays fresh 24/7), configurable in Settings → "Network reachability (Status)".

**Problem-PC detection (commit `31347b0`, renamed from "reinstall candidates"):** a second-row "Problem PCs" dashboard tile that ranks PCs by accumulated eventlog problems to surface boxes in trouble. New server endpoint `GET /events/pc-health`. Over a window (default 14 days, configurable) it computes, per enabled && !excluded PC, a **"damped blend"** score: for each distinct signature (`provider`+`event_id`+`level`) it caps occurrences at `signature_cap` (default 20) so one chatty source (e.g. a driver spamming thousands of events) can't flag a healthy box; weights severity critical×10 / error×3 / warning×1; adds a **breadth bonus** (count of DISTINCT error/critical signatures ×5) and a **persistence bonus** (DISTINCT days with errors ×3). `score = Σ min(cnt,cap)·weight + signatures·5 + days·3`. Classified **risk** (≥ `threshold_risk` 600) / **watch** (≥ `threshold_watch` 400) — recalibrated from the 60/150 seed against live data (migration 034). A single second-row tile "🩺 Problem PCs" (count at/above the risk threshold; the watch tier exists but isn't shown as a tile) expands an inline breakdown table on click (score + crit/err/warn + distinct error types + active days), each row clickable to jump to the PC (the table is hidden until the tile is clicked). New Settings block (window days / per-event-type cap / watch & risk thresholds); severity weights DB-tunable. Migration 033 seeds all knobs as tunable settings. Client fetches on a slow 5-min cadence (heavier 14-day query). Rationale: raw event volume misleads (one noisy driver); the cap + breadth/persistence captures a systemically sick box (many DIFFERENT errors across many DAYS).

**Critical services — real state in any state (commit `7ac0962`, migration 037):** the services collector previously stored only Auto + non-Running "problems", so a critical service that was RUNNING was invisible — you couldn't confirm the critical services (NTDS, DNS, Kdc, Veeam…) actually run. The collector now ALSO captures the configured critical services (setting `alerts.services.critical_names`) on every machine where they exist, in ANY state, from the SAME CIM session — one enumeration deriving both the problems and the critical rows. Stored in new table `critical_service_status` (migration 037); only services that exist on a machine are stored, so a workstation without NTDS has no NTDS row (servers vs PCs sorts itself out). Offline machines keep their last-known rows (flagged stale). New endpoint `GET /services/critical`. New "Critical services" tab: a sortable service × machine table showing real State (Running/Stopped), start mode, IP, last check; offline machines flagged amber; only-not-running filter + search + export. New dashboard tile "🛡 Critical services" (count not-running on reachable machines, red when >0) opens the tab. Caveat: DCs / locked-down servers that fail the CIM scan with "Access is denied" have no rows until the service account is granted WMI/DCOM rights there.

**OS breakdown now an expandable tile (commit `1767c39`):** the OS chart (previously the always-visible full-width "Operating systems" panel, commit `38ba1c4`) is now a second-row tile "📊 Operating systems" (count of OS buckets) that expands the bar chart inline on click, like the problem-PCs tile. Segment drill-through to Computers unchanged.

**Eventlog collector resilience (commit `e6d5851`):** `Get-WinEvent` emits "The description string for parameter reference (%1) could not be found" for events whose provider template is missing; under `-ErrorAction Stop` that aborted the whole batch, so NO events were collected from ~16 PCs. `Get-WinEvent` now runs `-ErrorAction SilentlyContinue` (+ `-ErrorVariable`), per-event `Message` render is wrapped in try/catch with a raw-`Properties` fallback, and an empty result is treated as a failure only when a real connection/access error is present. Collection failures dropped 20→1; +16 PCs now collect events.

**Reachability extras:** per-PC state-change logging (commit `03a9ad5`) — the activity log now logs each PC that flips reachable, with name + IP (`PESEKJW11N (10.8.2.140) → Offline`): warn on down / success on up, first-time silent, and the summary line logs only on a count change (no repeated heartbeat). Manual "Run now" button (commit `392bd6d`) — Settings → "Network reachability (Status)" gets a Run-now button (`POST /reachability/run`).

**TXT export BOM (commit `563a147`):** the TXT (Tab) export now carries a UTF-8 BOM so an ANSI-default editor doesn't render →/✓/— as mojibake.

**Recipients, reporting, two-level services, tests (2026-06-12 batch 2, migrations 038–040):** per-agenda email recipients with shared fallback + a standalone Email/SMTP settings section (mig 038/039). Structured PC-vs-servers fleet report — `GET /reports/overview` + `POST /reports/email` (one generator), emailed from the Computers tab for the filtered machines, disabled machines included. Machine-readable email subjects `[OK]`/`[CHYBA]` + `[RUČNĚ]`, status banner. Two-level service monitoring (broad 🔧 Služby + 🛡 Krit. služby) with per-PC ignore lists (mig 040); broad level = the collector's "real" set (excludes trigger/delayed, exit-code-agnostic — 413 of 454 real Auto-down problems report exit 0/null, so exit code is not a discriminator). Services-tab filters fixed to treat `exit_code` null as graceful and the "Only ExitCode != 0" default flipped off. Critical-service per-PC exceptions now honoured in the tab + dashboard tile. Dashboard **tile numbers colour by severity** (green at zero, red/orange when there's a problem). **First automated test suites** — Vitest, 54 cases across desktop (`api.test.ts`) and server (`alerts-util.test.ts`, pure helpers extracted to `alerts-util.ts`); CI runs `npm test` after typecheck as a deploy gate. A ~90-page Czech review/defence document is in `docs/oponentura.md`.

**Ports tab + Devices tab + per-PC refresh trim (migrations 041–042):** two new tabs and a trimmed per-PC modal.

- **Ports tab** (migration 041 adds table `port_status` — latest per-(computer, check_name) verdict: `is_open`, `latency_ms`, `checked_at`). Standalone collector `port-status-collector.ts` TCP-probes each monitored PC's configured ports on its own schedule (settings `checks.run_port_status` default 1, `port_status.interval_sec` default 300), reusing the existing port list + timeout (`alerts.services.port_checks`, `alerts.services.port_timeout_ms`) so it runs even with phase-2 alert emails off; offline PCs (`reachable=0`) are skipped. Routes: `GET /port-status` (grid feed, filtered to currently-configured port names + paired with computer reachability), `POST /port-status/run` (whole-fleet probe now), `POST /computers/:id/probe` (live ICMP ping + per-port TCP for one PC). Desktop `PortsPage`: PC × port grid (● open + latency / ○ closed / — offline), "only issues" filter, "Refresh" button, per-row "Ping". Removing a port from the Settings list drops it from the grid (GET filters to configured names; the probe prunes stale rows).
- **Per-PC Refresh now also probes ports** — the per-row 🔄 action (`PcActions` / `refresh-single-pc.ts`) refreshes all five monitored areas: disk, services, eventlog, perf, ports.
- **PcActions trimmed** — the launcher / remote-management content (Remote MMC, RDP/PsExec/PS Remote, admin shares, copy helpers, URL-handler installer banner) was **removed at operator request**; the modal now holds only the single-PC Refresh, and the launcher `actions.*` i18n keys were removed. The server `/actions/*` install-handler routes and handler scripts (documented above) are retained but no longer surfaced from the UI.
- **Ping console** — the per-row "Ping" (Ports and Devices tabs) opens a cmd-style console modal with the real `ping.exe` output (run via `cmd /c chcp 65001 & ping -n 4` for UTF-8 localized output) plus per-port open/closed/latency lines.
- **Dashboard tiles** — new tile "🔌 Ports" (PCs with a closed port / total) opens the Ports tab. Clicking a dashboard tile now also pre-checks the relevant filter (one-shot): Ports → "only issues"; Critical services → "only down (not Running)"; Stopped services → "only ExitCode != 0".
- **Devices tab** (migration 042 adds `dhcp_leases` — PK site+mac_address: ip, host_name, server, comment, status, dynamic, expires_after, first_seen/last_seen, reachable/reach_checked_at — and `device_categories` — PK mac_address, operator-assigned category persisting by MAC across reloads/sites). MikroTik DHCP lease inventory; each lease is paired with an AD `computers` row by host_name (fallback IP): matched devices reuse the reachability collector's online/offline, unmatched devices (printers, phones, IoT) are pinged. A `suggestCategory` hint guesses printer vendors (Canon/Kyocera/Zebra/HP via OUI/hostname) and phones — operator override is authoritative. Routes: `GET /devices` (leases + matched computer + category + suggestion), `PATCH /devices/category`, `POST /devices/run`, `POST /devices/probe`. Desktop `DevicesPage`: site / IP / hostname / MAC grid, per-row category dropdown (clickable suggestion), online/offline, AD link, filters (site / "not in AD only" / "printers only"), Refresh, per-row Ping console.
- **MikroTik config + encrypted password** — Settings → "MikroTik DHCP" (routers as `Site=IP` comma list, RouterOS user, password). Password stored **encrypted** via `secret-crypto.ts` (AES-256-CBC, key = SHA-256 of env `MIKROTIK_SECRET`); `GET /settings` masks it (••••), `PUT` encrypts into `mikrotik.password_enc` (mask = unchanged, empty = clear); `plain:`-prefixed fallback with a warning if `MIKROTIK_SECRET` is unset. New env var `MIKROTIK_SECRET` documented in `.env.example` (set on the application host). **Superseded (2026-06-16):** an earlier draft documented the DHCP pull as an external scheduled PowerShell job on the SQL server (10.8.2.225); the operator decision is a strict two-tier model — all operativa runs in-process on the application server (10.8.2.213), the DB is storage only, no scripts on other servers — so MikroTik collection runs in-app like every other collector. **Resolved (commit `62c9f26`):** collection is now LIVE and fully DB-driven (enable toggle + interval + routers + user + encrypted password all in Settings; only `MIKROTIK_SECRET` remains an env var), with multi-source inventory and the Database tab — see the "Devices inventory live" Status entry below.

**Devices inventory live + Database tab (commit `62c9f26`, migrations 043–047):** the Devices feature is now LIVE and fully DB-driven.

- **MikroTik DHCP collection LIVE** — the enable toggle, interval, routers, RouterOS user and (encrypted) password all come from Settings; the only remaining `MIKROTIK_*` env var is `MIKROTIK_SECRET` (the AES key). The in-process collector self-reschedules and idles when disabled (migration 043 adds the MikroTik settings + printer-offline alert agenda).
- **Multi-source inventory merged by MAC** — DHCP leases (dynamic **and** static reservations) + the router ARP table + an active subnet scan run from the app server (ping-sweep + local/router ARP); each row carries a `source` (dhcp/arp/scan). Migration 044 adds the `source` column to `dhcp_leases` plus the scan settings.
- **Active scan ranges configurable** — Settings take CIDR (`10.8.2.0/24`) or wildcard (`10.8.2.*`) with an optional `Site=` label; a leading `!`/`<>` excludes a whole subnet. Discovery caches known IP↔MAC (never re-discovered); a MAC reappearing at a new IP releases the old IP; remote subnets resolve MACs via the router ARP table.
- **Device names** — NetBIOS resolution via `nbtstat -A` for scanned/ARP devices (so the printer/phone suggestion can fire), with known printer prefixes (NPI/BRN/BRW/RNP/KMBT); the operator can also manually edit a name, stored by MAC (migration 046).
- **Type + categories** — Static vs Dynamic "Type" column; AD-derived pc/server pre-select for AD-matched devices; a generic "Printer" category collapses per-vendor variants; device categories are operator-configurable in Settings (`devices.categories`, `key=Label`).
- **Per-device loss + latency** — the reachability ping measures packet loss and average latency (counts `TTL=` replies, locale-independent; migrations 045/047), shown as a compact `ms / %` column (e.g. `<5/0`). "Problem" thresholds are tunable in Settings (`devices.problem_loss_pct` default 1%, `devices.problem_latency_ms` default 50 ms) and drive a dashboard "Loss / latency" tile + an "issues only" filter.
- **Printer alerts + tiles** — printer-offline email alert agenda (migration 043); dashboard "Printers" tile (online/offline); printer IP → web-UI link with an optional server-side cert-bypassing proxy (Settings `devices.web_proxy`, best-effort).
- **Database tab** — DB size + per-table footprint (rows / reserved / data) read from the system catalog.
- **Deploy fix** — the deploy's robocopy `/MIR` now excludes `dist`, so the live frontend is no longer deleted mid-deploy (previously caused a transient "frontend build not found").

## Testing

```powershell
npm test          # runs every workspace's Vitest suite (desktop + server), 54 cases
```

Covers the deterministic pure logic (service crash/exception classification, disk
threshold + drive-scope evaluation, OS bucketing, alert subject markers,
maintenance window, debounce/throttle). Runs in CI after typecheck — a failing
test stops the deploy before build/migrate.

## Setup

- [docs/SETUP-SERVER.md](docs/SETUP-SERVER.md) — one-time server bootstrap (Node, NSSM, DB, runner registration, ACL grants)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions
- [docs/dashboard.html](docs/dashboard.html) — full user/operator documentation (also served live at `http://10.8.2.213:4000/docs`)
