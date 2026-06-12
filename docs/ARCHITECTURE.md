# Architecture

## Components

> **Reference deployment** — the project ships with no environment-specific values baked into code; everything below is the *current operator's* concrete deployment, recorded here for reference only. To run elsewhere you change config (`apps/server/.env` + GitHub Actions Variables), not code. See **## Configuration & portability**.
>
> | Role | Value |
> |------|-------|
> | API / runtime host | `10.8.2.213` (B-S-W-MIKOS) |
> | SQL host | `10.8.2.225` (B-S-W-SQL-04, default instance) |
> | AD domain (NetBIOS / FQDN) | `AXINETWORK` / `axinetwork.loc` |
> | Service account | `AXINETWORK\svc-itdashboard` |
> | Domain controller (example) | `10.8.2.254` |

### Desktop client (`apps/desktop`)
- Electron + React + Vite + TypeScript.
- Per-PC install (NSIS / portable build via electron-builder) OR run via browser through Vite dev server.
- The browser UI is served **by the API** and talks to it over **relative URLs** — no hardcoded base, no IP. Only the packaged Electron client points at an explicit API host, set via `VITE_API_BASE` at build time.
- `contextIsolation: true`, `nodeIntegration: false` — renderer has no direct Node.js access.
- Scripts don't execute locally — client calls `POST /scripts/:slug/run` and API spawns them on the server.

6 navigation tabs:
- **Dashboard** — collector status, summary cards (clickable drill-down), health cards (reinstall risk/watch tiles), timeline chart, top noisy PCs chart, top event IDs, computers summary
- **Events** — full-width events table with search + filters (Computer, Source, Level, Time range)
- **Computers** — inventory with status chips, monitor checkboxes, bulk all/none, AD sync, disk scan, sync history. The 📧 Disk / 🔔 Services / Exclude column headers each carry a "✓ all / ✗ none" control that sets that flag for all currently visible (filtered) rows in one shot, via `POST /computers/bulk-flag { ids, flag, value }` (server whitelists the `flag` column name).
- **Services** — Auto + non-Running detection with policy/drift, by-PC + by-service views, GPO PS script export
- **Perf** — Diagnostics-Performance channel: summary cards, top culprits, most-affected PCs, recent slow boot/shutdown/standby/resume events
- **Activity** — terminal-style live log (filter, pause, copy)
- **Settings** — periodic check frequency + enabled checks + disk thresholds (applied live, no restart)

### API + collectors (`apps/server`)
- Fastify + TypeScript, runs as Windows Service `ITDashboardAPI` (NSSM) on the API host.
- Runs under a domain service account (suggested name `svc-itdashboard`).
- Endpoints organised by feature (see `routes/*.ts`):
  - `health`, `version`, `docs`
  - `events` — list, summary, top-ids, timeline, top-computers, pc-health (reinstall-candidate scoring)
  - `computers` — list, sync, sync/last, sync/history, :id/monitor (PATCH), monitor/bulk (POST)
  - `collector` — status, run, stop
  - `disks` — list, collect
  - `activity` — log
  - `settings` — get all, put bulk
  - `scripts` — list (run endpoint pending)
- Background tasks:
  - **Periodic checks scheduler** — every `checks.interval_sec` (default 900) within `checks.days` + `checks.window_start/end` runs selected checks from Settings: eventlog, disk, services, perf, adsync, reachability (adsync default OFF in periodic)
  - **AD sync** — registered as the first check; `Get-ADComputer -Filter *` + MERGE. Default off in periodic, forced on by "Run all". New PCs default to `monitor_enabled = adsync.default_monitor_enabled` (default `true`)
  - **Reachability probe** — runs after AD sync and before the eventlog collector; TCP-connects every enabled, non-excluded PC (port 135, fallback 445) to record live network presence in `computers.reachable` independently of the data collectors. See **### Live network reachability probe drives the Status column**.
  - **Eventlog collector** — pulls Warning/Error/Critical events
  - **Disk + PC-info collector** — pulls Win32_LogicalDisk, Win32_ComputerSystem (current logged-in user), Win32_NetworkAdapterConfiguration (primary IPv4) via a single DCOM session. PC info populates `computers.current_user`, `current_user_seen_at`, `ip_address`, `pc_info_collected_at`. User is only overwritten when non-null (last-seen persists); IP is always overwritten.
  - **Services collector** — checks Auto + non-running Windows services and drift policy
  - **Perf-events collector** — pulls slow boot/shutdown/standby/resume records from the `Microsoft-Windows-Diagnostics-Performance/Operational` channel; parses EventData XML for TotalTime / DegradationTime / culprit
  - **Retention purge** — `sp_purge_old_events @retention_days = 90` daily

### Database (MSSQL on the SQL host — `SQL_HOST` / `SQL_INSTANCE`, DB `SQL_DATABASE`)
Tables:
- `computers` — name, fqdn, os_version, last_seen, enabled (AD presence), monitor_enabled (operator intent), last_collected_at, last_error, consecutive_failures, distinguished_name, ou_path, last_status, `reachable` (live TCP reachability, set by the reachability probe) + `last_reachable_at` (last successful connect) + `reach_checked_at` (last probe attempt), `disk_email_monitor` (per-PC opt-in to disk-critical email alerts) + `disk_email_drives` (optional per-PC drive-letter scope), `service_email_monitor` (per-PC opt-in to critical-service email alerts)
- `events` — raw events with unique idx `(computer_id, event_id, log_name, time_created)` for idempotency
- `event_daily_agg` — daily aggregates per (computer, log_name, event_id, level), kept forever
- `disks` — per-drive snapshot (replaces row on each scan)
- `perf_events` — slow boot/shutdown/standby/resume records with parsed culprit + total/degradation timings; dedupe on `(computer_id, time_created, event_id)`
- `service_problems`, `service_policy` — services collector state + drift rules
- `service_alert_state` — per-(PC, service) flapping-debounce state for critical-service email alerts (`first_down_at`); row cleared on service recovery
- `port_check_state` — per-(PC, port) state for service port reachability checks: baseline `last_ok_at` (a port becomes alert-eligible only once it has answered) + flapping-debounce state; row cleared on port recovery
- `settings` — key-value, edited via Settings tab
- `collector_runs` — eventlog collector run audit
- `ad_sync_runs` — AD sync audit
- `scripts`, `script_runs` — catalog + history
- `credentials` — DPAPI-encrypted blobs
- `schema_migrations` — migration tracking

## Configuration & portability

All environment-specific configuration is fully externalized — the source tree carries **no IPs, hostnames, or domain names**. To stand the project up in a different environment you change config only, never code:

- **`apps/server/.env`** is the single place for runtime config (SQL host/instance/database, AD/LDAP settings, edit-group DN, retention overrides, etc.). The committed **`.env.example`** is the template and the single source of truth for what knobs exist — copy it to `.env` and fill in access/values.
- **GitHub Actions repository Variables** drive the auto-deploy pipeline: the workflow reads `SQL_HOST`, `SQL_INSTANCE`, and `SQL_DATABASE` from repo-level Variables, so the deploy target is configured in the repo settings, not in committed YAML.
- **Browser client** uses relative URLs (served by the API), so it needs no base configuration. The **Electron** client sets `VITE_API_BASE` at build time. The **protocol-handler installer** base is injected by the server at download time (committed default is a neutral `localhost` placeholder).

Handing the project to a new operator means: edit `apps/server/.env`, set the GitHub Actions Variables, and adjust access — no code changes.

## Key design decisions

### `msnodesqlv8` over `tedious`
Default `mssql` package uses `tedious` (pure-JS) which fails in AD environments with "untrusted domain" — it implements NTLM auth but not full SSPI. Switching to `msnodesqlv8` (Windows-native ODBC) enables true Integrated Auth. Pre-built binaries available for Node 20 Win x64.

### Get-WinEvent over RPC, not PSRemoting/WinRM
Initial collector used `New-PSSession + Invoke-Command` which requires WinRM configured on every target. WinRM is rarely enabled fleet-wide by default. Switched to `Get-WinEvent -ComputerName` which uses MS-EVEN6 RPC over SMB — enabled by default on domain-joined Windows.

### DCOM session for Get-CimInstance
Same pattern for disk collector: default `Get-CimInstance` uses WinRM transport. We explicitly create `New-CimSessionOption -Protocol Dcom` to force the same RPC stack as Get-WinEvent. Consistent reachability semantics across both collectors.

### Node-side TCP probe before PS spawn
Both collectors do a 2-second TCP probe to port 135 (RPC endpoint mapper) before spawning PowerShell. Fail-fast for offline PCs (~2s vs ~30s PS timeout). Clean error message `OFFLINE: TCP/135 unreachable` instead of PS error noise. Implemented in pure Node `net.Socket` — no PS overhead.

### UTF-8 PowerShell output
Czech diacritics in event messages get mangled because PS defaults to console codepage (Windows-1250). PS scripts now set `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8` at start so Node reads UTF-8 cleanly.

### Classify reachability
After fail-fast TCP probe, classify any PS failure by error message:
- `OFFLINE` prefix or `No such host` / `network path was not found` → **offline**
- `RPC server is unavailable` → **rpc_unavailable** (TCP/135 OK but RPC layer blocked — typically firewall rule "Remote Event Log Management" missing)
- `Access is denied` → **access_denied** (svc-itdashboard not in Event Log Readers / Performance Monitor Users)
- Otherwise → **unknown**

Persisted in `computers.last_status`. UI shows breakdown in Dashboard Unreachable card subtitle + Status column in Computers tab.

### Operator monitor flag persists across AD sync
`computers.monitor_enabled` is the operator's intent. AD sync explicitly does **not** touch this column on UPDATE — it only updates `fqdn`, `os_version`, `last_seen`, `enabled` (AD presence). When a PC is removed from AD it gets soft-disabled (`enabled = 0`) but its events stay. If it reappears, `enabled = 1` again and the original `monitor_enabled` state persists.

On INSERT (newly discovered PC), AD sync applies `adsync.default_monitor_enabled` (default `true`). The previous column-level `DEFAULT 1` is preserved as a safety net, but the value is now explicit per the setting so an operator can flip the default to "off" if they want new PCs to require explicit opt-in.

### Settings live-reschedule
`checks.interval_sec` causes immediate scheduler reschedule on save — no service restart. The day/time window and check enable flags (`checks.run_eventlog`, `checks.run_disk`, `checks.run_services`, `checks.run_perf`, `checks.run_adsync`, `checks.run_reachability`) are read on every scheduled run, so toggles apply to the next cycle.

### AD sync in checks runner
AD sync is registered as the first check in the registry. Order matters: if a periodic run includes both `adsync` and the data collectors, AD sync runs first so subsequent collectors operate on fresh inventory in the same cycle. By default `checks.run_adsync = false` (fleet-wide MERGE every 15 min is wasteful), but `runAllChecksOnce` (manual "Run all") forces all checks on regardless of selection — so clicking "Run all" always pulls a fresh AD view before the data collectors.

`adsync.default_monitor_enabled` controls the `monitor_enabled` value applied to newly discovered PCs. Default `true` so a new domain join is automatically monitored. Existing PCs are not touched — operator intent persists across syncs (this was already true, the setting only governs the INSERT path).

### Observer, not executor
The whole tool follows the loop `observe → compare with threshold → show to operator`, never `observe → act → re-observe`. Remediation is delegated to the human at the screen. The Services tab "GPO script export" stays on the right side of this line (we export a script, we don't execute it). Future backlog items like "Direct fix button per service-PC" would cross it, and should be evaluated against this principle before being implemented. Two reasons: (1) absence of signal is ambiguous — an OFFLINE PC could be down, the network could be down, or the monitor itself could be blind, so acting on incomplete state is dangerous; (2) the monitor doesn't own truth, the machines do — every shown value is a 30-second-to-15-minute-stale derivative, and acting on stale state is how races and storms start.

### Per-PC Actions and URL protocol handlers
Computers tab Actions are operator launch shortcuts, not automated remediation. Every row offers copy/download fallbacks. Optional one-click launch is implemented by a per-workstation installer (`apps/server/scripts/install-itd-handlers.cmd`) that registers custom `itd-*` URL protocols under HKCU only. The installer does **not** hardcode the API base — the committed default is a neutral `localhost` placeholder, and the server rewrites it at download time to whatever host the browser fetched it from, honoring `x-forwarded-proto` / `x-forwarded-host` so the injected base is correct behind a TLS-terminating reverse proxy.

Security posture:
- Generated launchers accept only non-empty hostnames matching `[a-zA-Z0-9._-]+` with a 63-character cap. Spaces, quotes, shell metacharacters, redirection and path traversal do not pass validation.
- Browser prompt guidance is explicit: do not tick "Always allow"; per-click confirmation is a second layer against unrelated websites probing registered protocols.
- PsExec is not installed by default because it opens `cmd.exe` on the remote PC; opt-in requires `/with-psexec`.
- `itd-explorer://HOST/LETTER` intentionally supports only administrative drive shares (`C$`, `D$`). It is not a generic UNC share launcher.
- `ITD_ADMIN_USER` defaults to **ask** mode when unset (no per-user setup needed; default is correct for multi-admin workstations). Behavior matrix: **(a) Unset (default ask):** the launcher prompts in CMD for the admin account on every launch — empty the first time, pre-fills the last entered user from `%LOCALAPPDATA%\ITDashboard\launchers\last-admin-user.txt` on subsequent runs (Enter accepts the cached value). Typed user is validated (max 128 chars, non-empty) and persisted; password is never persisted. **(b) Literal value `ask`:** same as unset, explicit form. **(c) Concrete value** (e.g. `DOMAIN\admin_user`): `runas /user:%ITD_ADMIN_USER% /netonly` wraps every command, Windows credential dialog has the user pre-filled and asks only for password. **(d) Literal value `current`:** opt-in to the pre-default-change behavior — launchers run as the operator's current Windows account with no admin wrap. The PowerShell-based `itd-ps` launcher uses the same shared last-admin-user cache but renders the credential UI via `Get-Credential` for a native single-dialog both-fields experience. The default `set "ITD_ADMIN_USER=ask"` happens inside the launcher's `setlocal`, so the user's actual environment is never touched.
- New `itd-ps://HOST` launcher opens a PowerShell console with `Enter-PSSession -ComputerName <host>`. In `ask`/preset mode, credentials are collected via `Get-Credential` (native Windows credential UI). PowerShell `-Command` inline form is used because it bypasses the `.ps1` file ExecutionPolicy / AllSigned restriction — no signed-script requirement. The host is regex-allowlisted (`[a-zA-Z0-9._-]+`, max 63 chars) before being injected into the PS command string, and the typed admin user is validated `^[A-Za-z0-9._@\\-]+$` inside PS before being persisted, preventing PS quoting / injection issues.
- Installer supports two install scopes via flags: **per-user (default)** writes launcher files to `%LOCALAPPDATA%\ITDashboard\launchers` and registers handlers under `HKCU\Software\Classes\itd-*` — no admin required. **Machine-wide** via `/machine` flag writes launchers to `C:\ProgramData\ITDashboard\launchers` and registers handlers under `HKLM\Software\Classes\itd-*` — requires elevation, covers every Windows account on the workstation. Generated launchers always write logs and the `last-admin-user.txt` cache to per-user `%LOCALAPPDATA%` (each Windows user gets their own diagnostic trail and last-typed-admin pre-fill) and `mkdir` the dir at startup so a first-time user under a machine-wide install does not fail on missing dir. The `/uninstall-hkcu` flag (no admin) removes the current user's HKCU registrations + per-user launcher dir, used when switching a workstation from per-user to machine-wide install to clear the HKCU-over-HKLM shadowing.

### Read tier vs edit tier — explicit boundary

Read tier (whitelist IP, no authentication, runs under `svc-itdashboard`):
dashboard view, list / search / filter, "Aktualizovat teď" refresh-single-PC
(on-demand run of the same collectors as the periodic cron — read-only
WMI / WinRM queries, no state change on the target), copy-to-clipboard
buttons. Anyone whose IP is whitelisted can connect from any PC without
installing anything.

Edit tier (requires personal AD admin attribution, audited by user):
Launch buttons (1-click via `itd-*` protocol handlers, then `cmdkey` +
admin tool against the target), downloaded `.bat` / `.rdp` artefacts that
spawn admin tools at run time. The operator's environment uses a
multi-tier identity model (basic user / admin-PC / admin-server / admin-DC),
and the edit-tier mechanism is designed so the operator always explicitly
chooses which identity to use for each target — silent fallback to the
operator's current Windows session creds (basic-tier) is suppressed in
every path that touches a remote PC.

### Auth Gate — session-scoped credential vault for silent launches

Per-launch CMD prompts are friction when an IT specialist runs many tools in one session. The Auth Gate (`apps/server/src/auth/*` + `apps/server/src/routes/auth.ts` + `apps/desktop/src/components/AuthGate.tsx`) implements a server-mediated short-lived credential vault: the operator signs in once per browser session (LDAP bind against `AD_LDAP_URL`), credentials live in **server memory only** (Node Map) with a 30 min idle / 8 h hard max TTL, and every Launch click generates a 30-second one-shot redeem token, appends it to the protocol URL (`itd-mmc://HOST?tk=TOKEN`), and the launcher .cmd extracts the token, calls `GET /api/auth/redeem?token=X`, receives `{user, password}`, and uses them via `cmdkey` + the target tool (mstsc / mmc / explorer / psexec) or directly via `New-Object PSCredential` + `Enter-PSSession` for the PowerShell launcher. The cmdkey entry is created right before the tool starts and deleted after the tool exits (the PS wrapper does `Start-Process -PassThru | WaitForExit | cmdkey /delete`), so the credential is scoped to the tool's lifetime. Session cookie is HttpOnly + `SameSite=Strict`. Token can only be redeemed once; expired or already-redeemed tokens return `401`. All redeem events are audit-logged via `activity-log.ts` (who, when, target, tool, IP). Server restart clears all sessions — passwords are NEVER written to disk. Launchers retain the per-launch ask mode as a fallback when no token is present in the URL, so the system degrades gracefully if the auth backend is down or the operator is using a different browser tab. Server env vars: `AD_LDAP_URL` (LDAP URL of a domain controller, e.g. `ldap://DC_HOST:389`), `AD_LDAP_DOMAIN` (no hardcoded default — when unset, users sign in with a full UPN or `DOMAIN\user`, and the edit-group LDAP filter matches on `sAMAccountName` alone), `AD_LDAP_TIMEOUT_MS` (default 5000), `AD_LDAP_BASE_DN` (search root, required when group gate is on), `AD_EDIT_GROUP` (distinguishedName of the AD group whose members may unlock the edit tier — defaults to deny in production when unset).

### Sprint 1.5 edit-tier hardening (2026-06-04)

(a) **AD group gate after LDAP bind.** Successful bind alone is insufficient — any domain user that knows their own password would pass. `checkEditGroupMembership` in `apps/server/src/auth/ldap.ts` runs an LDAP search filter `(&(objectCategory=person)(objectClass=user)(|userPrincipalName / sAMAccountName)(memberOf:1.2.840.113556.1.4.1941:=AD_EDIT_GROUP_DN))` after the bind — the OID is `LDAP_MATCHING_RULE_IN_CHAIN`, AD's transitive group resolution, so nested group memberships are honored. Production + `AD_EDIT_GROUP` set → require membership. Production + `AD_EDIT_GROUP` unset → deny by default (cannot accidentally ship open). Development + `AD_EDIT_GROUP` unset → allow (iteration without group infra). Failed group check returns `not_in_edit_group` reason, localized in the auth modal.

(b) **Stub-mode production guard.** `AD_LDAP_STUB=1` accepts any non-empty credential for first-deploy testing. Module-init guard in `ldap.ts` throws at boot if `NODE_ENV=production && AD_LDAP_STUB=1`, so a forgotten env var cannot silently open the edit tier in production.

(b.1) **Multi-DC failover.** `AD_LDAP_URL` accepts a comma-separated list of LDAP URLs (one entry per domain controller). `ldapts` does not do AD's SRV-record DC discovery, so each DC must be listed explicitly. The bind loop tries each in order; on a connection or timeout error it tries the next. On a definitive auth response (invalid_credentials / not_in_edit_group / ok) it stops immediately — no point retrying with a wrong password.

(c) **Downloaded artefacts force credential prompt.** `.rdp` files already set `prompt for credentials:i:1` (mstsc always shows credential dialog, ignoring SSO cache). `.bat` files for PsExec and admin-share open now wrap the target command in `set /p adminuser` + `runas /netonly /user:"%adminuser%"`. The operator who double-clicks a downloaded `.bat` always sees a CMD prompt for the admin identity, then a Windows credential dialog for the password — no silent fallback to current Windows session creds (which, on a multi-tier-identity workstation, is typically the basic-tier user that lacks remote admin and would fail Access Denied without explanation). `Kopírovat příkaz` / `Kopírovat UNC` / `Kopírovat hostname` remain read-tier (clipboard string, operator chooses when and how to use it).
- Batch installer/launcher files are pinned to CRLF through `.gitattributes`. This is load-bearing: `cmd.exe` can misparse LF-only `.cmd` files and appear as a flashing window that immediately closes.
- Generated launchers leave the console open only on validation/setup failure and append diagnostics to `%LOCALAPPDATA%\ITDashboard\launchers\last-itd-*.log`. Existing HKCU handlers are not self-updating; after deploying installer fixes, each operator workstation must run `/actions/install-handlers.cmd` again.
- The fail block prints only validated/derived fields (`reason`, `host`, `letter`) to the console — never the raw `url`. The URL is attacker-controllable (protocol handler invocation) and could contain ANSI escape sequences to manipulate the operator's terminal (console reflected injection). Raw URL is still recorded in `last-itd-*.log` because file writes do not interpret terminal escapes. This is intentional; see inline comment in `:append_common_footer`.

This design was reviewed three times on 2026-06-03: first as an RCE fix review, then as a follow-up confirming the hardened installer is OK to deploy, and finally a code-quality + console-hardening review. Response archives: `docs/oponentury/2026-06-03-reakce-3-protocol-handlers-followup.md` and `docs/oponentury/2026-06-03-reakce-4-installer-v2-review.md`.

### Perf-events: discrete slow records, not continuous CPU history
The perf-events collector subscribes to the `Microsoft-Windows-Diagnostics-Performance/Operational` channel, which contains only the events Windows itself diagnosed as "slow" (boot/shutdown/standby/resume timing degradations) — not a continuous CPU curve. Windows does not natively retain CPU usage history without an opt-in Data Collector Set; SRUM has rough per-process daily data but isn't WMI-accessible. The diagnostics channel was chosen because it is enabled by default on Win10/11 client, gives per-incident attribution (named culprit process / service / driver), and reuses the existing RPC collection path with no agent install. Default channel retention is small (~1 MB ring buffer) so we sweep into SQL to preserve history; cold-start pulls 7 days, then incremental.

**Server SKU gotcha:** the channel is **disabled by default on Windows Server**. Get-WinEvent on a disabled channel returns `"There is not an event log on the X computer that matches"`. The collector detects this pattern, classifies it as `channel-disabled` (separate from `fail`), and skips silently — no per-PC noise in the activity log, one aggregate count at end of run. To enable across the server fleet, push a GPO computer-startup script that runs `wevtutil sl Microsoft-Windows-Diagnostics-Performance/Operational /e:true` (same pattern as the Services GPO script export).

### Disk email alerting (per-PC, opt-in)

A few "key" PCs can be opted into disk-critical email alerting — the operator ticks them in the Computers tab (new "📧 Disk" column), and each ticked PC can optionally be narrowed to specific drive letters typed in a small field next to the checkbox (`C` or `C,F`; empty = all in-scope drives). The scope field uses the same syntax as `disk.crit_drives` (`C`, `C,D`, `<>C`/`!C`, `*`), and falls back to the global `disk.crit_drives` scope when the per-PC field is empty. This is deliberately not a fleet-wide page — alerting on every monitored PC would be noise; the model is "a handful of PCs that matter get email, everything else stays on the dashboard".

**Hook point.** Evaluation runs at the end of `runDiskCollectorOnce`, after every disk scan. Monitored PCs' disks are checked against the CRITICAL threshold from the Disks settings (pct/gb/either + per-PC drive scope), reusing the same scope/threshold rules the dashboard applies — the server-side evaluation in `apps/server/src/services/alerts.ts` mirrors those rules rather than inventing its own. If any in-scope drive is critical, an email report is sent (HTML table: PC, drive, free/total, % free). The hook is self-contained: it checks the master enable flag + throttle internally and never throws, so a mail failure can't fail the scan.

**Throttle (edge + reminder).** At most one mail per `alerts.disk.frequency_hours` (default 24) while at least one monitored disk stays critical. First detection sends immediately, resends at the cadence while still critical, and clearing the condition resets the throttle (stored in `alerts.disk.last_sent_at`) so the next incident alerts promptly rather than waiting out a stale window.

**Transport.** nodemailer to an internal SMTP relay (`alerts.smtp_host`/`alerts.smtp_port`, default port 25), opportunistic TLS with cert validation disabled (internal self-signed relays), no client auth assumed. Sender is `alerts.smtp_from`, recipients are `alerts.recipients` (comma/newline list).

**Mail transport reality — Microsoft 365 Direct Send.** In the reference deployment the `axima.cz` mail domain is hosted on Microsoft 365 (no on-prem Exchange/relay), so ITDashboard sends via O365 **Direct Send**: host `axima-cz.mail.protection.outlook.com`, port **25**, STARTTLS, **no authentication** (sender identity is established by the sending IP / SPF), From an `@axima.cz` address. Direct Send delivers **only to your own domain** — external recipients require authenticated submission. SMTP port landscape for portability: **25** = Direct Send / MX (no auth, own-domain only); **587** = SMTP AUTH client submission (login + app password, any recipient); **465** = SMTPS implicit TLS (legacy). Deliverability note: if mail from the API host is quarantined, add the host's public/NAT IP to the domain SPF record.

**Config & routes.** Configuration lives entirely in Settings (DB `settings` table, `alerts.*` keys) plus the per-PC columns — nothing in `.env`, consistent with the portability model. Routes: `PATCH /computers/:id/disk-email-monitor` `{ enabled?, drives? }` and `POST /alerts/disk/test` (sends the current state ignoring enable/throttle, backing the Settings test button); `GET /computers` now returns `disk_email_monitor` + `disk_email_drives`. The Dashboard shows a "Watched disks" tile (criticalPcs/monitoredPcs + alerts on/off). The runtime settings key `alerts.dashboard_url` (see below) has no migration — it is a plain settings key created on first save.

This stays on the right side of **Observer, not executor**: it emails the operator about a stale-derived threshold breach, it does not act on the target.

### Disk alert email report

The email is a responsive **600px table-based HTML layout** (Outlook / Gmail / mobile-safe): a colored header (red = critical, green = all-clear test), then one stacking white card per critical disk with a used/free bar (red = used, light = free) and the free/total figures + % free. A plaintext fallback is retained for clients that don't render HTML.

- Each disk card shows the affected PC's **IP address** (`computers.ip_address`) so the recipient can locate the machine.
- The footer carries a **generation timestamp** on every report, formatted for `Europe/Prague`.
- New configurable setting **`alerts.dashboard_url`** (Settings field): when set, the email renders an "Otevřít ITDashboard" button plus the address in the footer so recipients know where to go to act; the button/address are omitted when the setting is empty. `renderDiskAlert` is exported for preview/testing.
- `alerts.dashboard_url` is a runtime settings key created on first save — **no migration** was added for it (it is not part of any migration row).

### Critical-service email alerting (per-PC, opt-in)

Built as a direct mirror of disk alerting (2026-06-11), for the small set of servers where a stopped service is an incident, not a footnote. The operator ticks key servers in the Computers tab (new "🔔 Services" column); a status chip + a "service monitored" filter list which PCs are opted in. Opt-in is stored per-PC in `computers.service_email_monitor`. Same rationale as disk alerts: alerting on every monitored PC would be noise, so the model is "a handful of PCs that matter get email, everything else stays on the dashboard". It shares the transport, sender, recipients and dashboard URL with disk alerts (see **Disk email alerting** above) — only the evaluation logic and flapping guard are new.

**What counts as critical.** A configurable list `alerts.services.critical_names` (seeded with `NTDS`, `DNS`, `Kdc`, `Netlogon`, `W32Time`, `VMTools`, `VeeamBackupSvc`, `VeeamBrokerSvc`, `ekrn`, `DHCPServer`, `LanmanServer`) is matched case-insensitively with `*`/`?` glob wildcards against each service's name. A second list `alerts.services.whitelist` (e.g. `gupdate*`, `GoogleUpdater*`) names services that must **never** alert even if they match the critical list — noisy auto-updaters that legitimately sit in `Stopped` between runs. Per-user services (LUID-suffixed instances) are excluded outright.

**Hook point.** Evaluation runs at the end of `runServicesScanOnce`, after every services scan. For each monitored PC, its Auto + non-`Running` services that match the critical list (and not the whitelist) are candidates. The hook lives in `apps/server/src/services/alerts.ts` (glob match, debounce, maintenance-window suppression, throttle) and is self-contained — it checks the master enable flag internally and never throws, so a mail failure can't fail the scan, exactly like the disk hook.

**Flapping guard (the reason this isn't just disk-alerting copy-paste).** Services legitimately bounce during patch reboots, so a naive "Auto + not Running → page" would storm every Patch Tuesday. Three layers protect against it:
- **Time-based debounce.** A service must have been down for at least `alerts.services.debounce_minutes` (default 10) before the *first* alert fires. The first-seen-down timestamp is tracked per `(PC, service)` in the new `service_alert_state` table (`first_down_at`); a nightly reboot blip that comes back inside the window never pages anyone.
- **Maintenance window.** Optional `alerts.services.maintenance_window` (`"HH:MM-HH:MM"`, server local time, may cross midnight) during which service alerts are fully suppressed.
- **Reminder throttle.** At most one reminder per `alerts.services.frequency_hours` (default 24) while a service stays down. Recovery clears the state row, so the next outage starts a fresh debounce rather than inheriting a stale window.

**Report email.** Same mobile-friendly 600px card layout as the disk report — one card per down service showing PC, IP address, service name + display name, and how long it has been down; a generation timestamp footer (`Europe/Prague`) and the "Otevřít ITDashboard" link when `alerts.dashboard_url` is set.

**Settings & dashboard.** A "Email alerts — services" section in Settings exposes enable, debounce, reminder, maintenance window, and the critical-names + whitelist textareas, with a save-first test button (`POST /alerts/services/test` sends the current state ignoring enable/throttle). The Dashboard shows a "Watched services" tile (affectedPcs/monitoredPcs + alerts on/off); clicking it filters the Computers tab to service-monitored PCs. Routes: `PATCH /computers/:id/service-email-monitor`; `GET /computers` now also returns `service_email_monitor`.

**Observer, not executor — preserved.** The feature emails the operator about a stopped service; it does **not** restart it. A "restart service" button would cross the line in **Observer, not executor** and is deliberately out of scope.

### Service whitelist as a global view filter (single source of truth)

`alerts.services.whitelist` started life as a purely server-side gate — names that must **never** email even if they match the critical list (noisy auto-updaters like `gupdate*`, `GoogleUpdater*` that legitimately sit in `Stopped`). The same whitelist string is now **also applied client-side as a view filter**, so one setting is the single source of truth for both "don't email" and "don't show as noise". There is no server change — the server still evaluates the whitelist only for alerting; the client just reuses the same string off the already-loaded `settings` map.

**Shared helpers** live in `apps/desktop/src/api.ts`: `serviceWhitelist(settings)` compiles `alerts.services.whitelist` into `RegExp[]`, and `isServiceWhitelisted(name, displayName, whitelist)` tests a service against it. They reuse the existing `svcGlob`/`svcNameList` matcher already used for the critical-names list — case-insensitive, `*`/`?` glob wildcards, matched against the service **name OR display name**. An empty whitelist matches nothing (the helper short-circuits), so the filter is inert until the operator populates it.

**Where the filter is applied (client-only):**
- **Dashboard "Stopped services" tile** (`apps/desktop/src/components/SummaryCards.tsx`) — whitelisted services are *always* excluded from the count and the affected-PC subtitle, so the headline number never inflates with known-benign idlers. This is unconditional (no toggle) because the tile is meant to read as "things worth looking at".
- **Services tab** (`apps/desktop/src/pages/ServicesPage.tsx`) — a "Hide whitelisted" checkbox (default **on**) drops whitelisted rows out of *both* the table and the top-line counts, in both the by-PC and by-service views. Turning it off shows everything (the raw scan), so the operator can still audit what the whitelist is hiding. The toggle state is folded into the GPO-export filter description so an exported script reflects what was on screen.

Design rationale: the dashboard tile and the alert evaluator should agree on what counts as "noise"; reusing the exact same string and matcher guarantees they stay aligned without a second config knob to keep in sync.

### Service port reachability checks (phase 2)

Checking the service's `Running` state only proves the service-control manager *thinks* the service is up; it does not prove the service is actually answering. Phase 2 (shipped 2026-06-11) adds an outside-in port probe that exercises the whole path — network → firewall → OS → service — and catches the "running but unreachable" failure mode (firewall rule dropped, process wedged/frozen) that a `Running` flag misses.

**What is probed.** After each services scan, for every `service_email_monitor` PC the API host TCP-connects key infra ports: LDAP 389, SMB 445, RDP 3389, Kerberos 88, DNS 53 — all **TCP** (Windows DNS also listens on TCP/53, so a TCP connect is a valid liveness probe). A successful connect means the path is open end-to-end.

**Baseline learning (avoids false alerts on never-open ports).** A `(PC, port)` becomes alert-eligible only once it has been reachable at least once — the first successful connect stamps `port_check_state.last_ok_at`. A port that never answers on a given box (e.g. RDP closed on a server that does not accept RDP) is never alerted, because the tool has no baseline that it *should* be open. A whole-PC-offline condition (TCP/135 unreachable, the same fail-fast probe the collectors use) is detected first and skips all per-port evaluation, so a powered-off box fires nothing rather than one alert per port.

**Reuses the service-alert guards.** The port checks reuse the service-alert `debounce_minutes` / `maintenance_window` / `frequency_hours` (no separate flapping config), but have their own enable toggle so port checks can be turned on/off independently of the `Running`-state alerts. Settings keys: `alerts.services.port_checks_enabled`, `alerts.services.port_checks` (seeded `LDAP:389,SMB:445,RDP:3389,Kerberos:88,DNS:53`), and `alerts.services.port_timeout_ms` (default 2000).

**Implementation.** `evaluateAndSendPortAlerts` in `apps/server/src/services/alerts.ts` does the TCP probe, baseline learning, debounce / maintenance-window / throttle, and renders its own mobile-friendly report; it is hooked right after `evaluateAndSendServiceAlerts` in `runServicesScanOnce`. Route `POST /alerts/ports/test` runs a live probe (ignoring enable/throttle) to back the Settings test button.

### Live network reachability probe drives the Status column

Until this feature (2026-06-12, commit `a12ad36`) the Computers "Status" column was a **by-product of the event-log collector** rather than a measure of network presence. That coupling produced three wrong answers: the collector only ran on `enabled && monitor_enabled && !excluded` PCs (so anything unmonitored had no fresh status); failures were classified crudely from the PS error text (`offline` / `rpc_unavailable` / `access_denied` / `unknown`), so a perfectly reachable box whose event log simply couldn't be read showed **"Unknown"**; and — worst — once a PC passed the failure cap (`consecutive_failures >= MAX_FAILURES_BEFORE_SKIP`, at which point `listTargets` skips it) its status **froze**, so an AD-enabled box that was never successfully classified kept showing a green "Active" fallback forever. No live presence signal existed; there was no ICMP ping anywhere.

**New collector — decoupled from event-log health.** `runReachabilityProbeOnce()` in `apps/server/src/services/reachability-collector.ts` lists **every `enabled && !excluded` computer** — deliberately **not** gated by `monitor_enabled` and **not** subject to the failure cap, so it sees PCs the event-log collector has given up on. Each is probed by a **TCP connect** to port 135 (RPC endpoint mapper) with a 445 (SMB) fallback — **not ICMP**, because a domain's Windows Firewall blocks ping by default while leaving these RPC/SMB ports open. Concurrency is 16. The probe is self-contained: it never throws, and returns `null` only if a run is already in flight. It persists `reachable` (BIT), `last_reachable_at` (bumped **only** on a successful connect, so it preserves "last seen alive" across later failures), and `reach_checked_at` (every attempt).

**Wiring into the checks runner.** Registered in `apps/server/src/services/checks-runner.ts` as a new `CHECKS` entry `'reachability'` (`settingKey` `checks.run_reachability`, `defaultEnabled true`), ordered **after `adsync` and before `eventlog`** so the Status reflects current reachability regardless of whether the data collectors succeed in the same cycle. `RunChecksResult` / `CheckSelection` are extended for it and `loadSelection` picks it up automatically, so the Settings "enabled checks" toggle works with no extra plumbing. `refresh-single-pc` also sets `reachable = 1` on a successful single-PC refresh (a successful collect implies the box answered).

**Migration `032_reachability.sql`** adds the three columns and seeds `checks.run_reachability = '1'`, `reachability.ports = '135,445'`, and `reachability.timeout_ms = '2000'`.

**Client — the Status cell is redefined.** `GET /computers` returns the new columns; `ComputerItem` (`apps/desktop/src/api.ts`) gains `reachable` / `last_reachable_at` / `reach_checked_at`. The ComputersPage Status cell now reads from live reachability rather than collector health:
- **Disabled** — not `enabled` in AD.
- **Active** — `reachable` now true, with a secondary **"logs"** marker when event-log collection is unhealthy (derived from `last_status` ∈ `access_denied | rpc_unavailable | unknown`, or `consecutive_failures > 0`). The box is up; its log path may not be.
- **Offline** — `reachable` is false. A new `'offline'` status filter selects `enabled && !excluded && reachable === false`.
- **— not probed** — `reachable` is `null`, a transitional state before the first probe has run.

The key design split is that three previously-conflated signals are now distinct: **reachability** (live, this probe) vs **event-log collection health** (`last_status`) vs **AD inactivity** (`last_seen` / `inactive.threshold_days`). A box can be Active-but-"logs", reachable-but-AD-inactive, etc., and the UI no longer flattens those into one column.

**Design caveat.** The probe runs **inside the periodic-checks window** (`checks.days` / window, default Mon–Fri 06:00–18:00), so in the default config reachability is **not** refreshed overnight or at weekends. Making it a window-independent timer (so presence stays fresh 24/7 while the heavier collectors stay windowed) is a possible follow-up.

### Computers tab sorting (reliability)
Sorting is locale-aware with numeric chunking, so IPs order naturally (`10.8.2.9` < `10.8.2.10`), hostnames order naturally (`PC2` < `PC10`), accented names collate correctly, and nulls sort last. The "Status" column sorts by the displayed reachability status, now derived from the live `computers.reachable` probe (see **### Live network reachability probe drives the Status column**) rather than the `enabled` flag. Closing the Per-PC Actions modal after a manual refresh re-syncs the list so the row reflects the latest scan.

### Dashboard OS breakdown chart (live/stale split + drill-down)

A homepage panel (`apps/desktop/src/components/OsBreakdownChart.tsx`, rendered after `SummaryCards` in `apps/desktop/src/App.tsx`) shows the fleet's OS distribution as one horizontal bar per OS bucket. It is **pure client-side aggregation over the already-loaded `computers` array** — no new endpoint, no DB column. Scope is the **live managed fleet**: `enabled && !excluded`.

**Normalizing the free-text OS column.** AD gives us a single free-text `os_version` string (the AD `OperatingSystem` attribute), which we never want to chart raw — too many near-duplicate spellings. `osBucket(os_version)` in `apps/desktop/src/api.ts` collapses it into a small canonical set: `Windows 11/10/8.1/8/7`, `Windows Server <year>[ R2]`, `Windows Vista`/`Windows XP`, a generic `Windows Server` fallback, `Other` for anything else, and `Unknown` for null/blank. `summarizeOs(computers, thresholdDays)` walks the scoped fleet and returns per-bucket `{ total, stale, live }`, sorted by size.

**"Stale" reuses the inactivity model — single source of truth.** A bucket's stale count is the subset of machines that are inactive by the existing definition: `isStaleComputer(c, thresholdDays)` = `!excluded && (last_seen null || older than inactive.threshold_days)` (default 90, migration 022). This is the *same* predicate that drives the Dashboard "Inactive PCs" card and the Computers tab inactive filter, so the OS chart's stale figures can't drift from the rest of the UI. Each bar renders as a solid **live** segment plus a hatched **stale** segment (live = total − stale).

**Drill-down into Computers.** Clicking a segment selects an OS drill-down filter (`{ bucket, staleness }`) that `App.tsx` passes to `ComputersPage` via `initialOsFilter`; the page consumes it into local `osFilter` state and applies it in the filter predicate, mirroring the chart's scope exactly — `enabled && !excluded && osBucket(c.os_version) === bucket && requested staleness`. It surfaces as a removable chip and is mutually exclusive with the status filter chips. Because the chart and the filter predicate both call `osBucket()` and `isStaleComputer()`, the segment count and the drilled-in list **agree by construction** — there is no separate query that could return a different number.

### Faulty-PC / reinstall-candidate detection

Surfaces **"reinstall candidates"** — PCs whose event log shows chronic, *broad*, *persistent* problem accumulation, the systemic-rot signature that a single noisy provider can't fake. The intent is a triage shortlist ("which boxes are sick enough that a reinstall is cheaper than chasing individual errors") rather than another per-event view. The heavy lifting is server-side: a new endpoint **`GET /events/pc-health`** (`apps/server/src/routes/events.ts`) reads every knob from `settings`, runs a single CTE query over the `events` table, scores and classifies each computer, and returns only the ones above the watch line — the client renders, it does not compute.

**The scoring query (one CTE, three stages).** All within a `faulty.window_days` (default 14) lookback:
- **`sig`** — `GROUP BY computer_id, level, event_id, provider_name` to get a per-*signature* count. A signature is one distinct (level, event id, provider) tuple on one PC.
- **`agg`** — per computer, `SUM(min(cnt, @cap) × weight)` where `@cap` is `faulty.signature_cap` (default 20) and weight is `faulty.weight_critical` (level 1, default 10) / `faulty.weight_error` (level 2, default 3) / `faulty.weight_warning` (level 3, default 1). Also computes `signatures` = count of distinct level-1/2 signatures (breadth), plus the raw critical/error/warning totals for display.
- **`dys`** — per computer, `COUNT(DISTINCT CAST(time_created AS DATE))` over level 1/2 events = `active_days` (persistence: how many separate days the box was throwing problems).

Final `score = weighted + signatures·@wb + active_days·@wp` where `@wb` is `faulty.weight_breadth` (default 5) and `@wp` is `faulty.weight_persistence` (default 3). Scope is `enabled && !excluded`. Classification is **server-side**: `score >= faulty.threshold_risk` (default 150) → `'risk'`, `>= faulty.threshold_watch` (default 60) → `'watch'`, anything below is dropped. The response is `{ windowDays, thresholdWatch, thresholdRisk, items[] }`, sorted worst-first.

**Why the per-signature cap is the whole idea.** The dedup pass only removes *exact* duplicates, so a single wedged driver emitting thousands of *distinct-timestamp* errors would otherwise dominate the score and flag an otherwise-healthy box. Capping each signature's contribution at `@cap` defangs the one-chatty-provider case, and then the breadth (`signatures`) and persistence (`active_days`) terms explicitly reward the opposite shape — **many different problems across many different days**, which is what "systemically sick, reinstall it" actually looks like. Weights stay DB-tunable (no Settings UI) precisely so the operator can retune the shape of "sick" without a redeploy; window / cap / thresholds are the knobs exposed in Settings.

**Client — a second tile row + an ID drill-down.** `PcHealth` / `PcHealthResult` types and `api.pcHealth()` live in `apps/desktop/src/api.ts`. Because the 14-day `GROUP BY` is markedly heavier than the 30 s dashboard refresh, `App.tsx` fetches it on a **separate slow 5-minute interval** and re-pulls whenever any `faulty.*` setting changes. A new `apps/desktop/src/components/HealthCards.tsx` renders a **second row of summary tiles** (reinstall *risk* / *watch*) below `SummaryCards`, plus a candidates panel; the `Card` component is now **exported from `SummaryCards.tsx`** for reuse. Clicking a tile sets a new App-level `computersIdFilter` (`{ ids, label }`) passed to `ComputersPage` via `initialIdFilter`, consumed into local `idFilter` state and applied in the filter predicate (`c.id` ∈ the set). It surfaces as a removable chip and is **mutually exclusive** with the status / OS / search filters — the same drill-down pattern as the OS breakdown chart, but keyed on an explicit id set rather than a derived predicate (the server already decided who qualifies, so the client filters by identity, not by re-deriving the score). A new Settings block exposes window / cap / thresholds.

**Migration `033_faulty_pc.sql`** seeds the settings: `faulty.window_days` (14), `faulty.signature_cap` (20), `faulty.weight_critical` (10) / `weight_error` (3) / `weight_warning` (1), `faulty.weight_breadth` (5), `faulty.weight_persistence` (3), `faulty.threshold_watch` (60), `faulty.threshold_risk` (150).

This stays on the right side of **Observer, not executor**: it ranks boxes for the operator's attention and drills into the inventory, it does not touch the target.

### Activity log is two-tier
Live view: ring buffer of 500 entries, polled by dashboard every 2s. Lost on service restart. Persistent history: every `logActivity()` call is also fire-and-forget INSERT into `activity_log` table (`apps/server/src/services/activity-log.ts`). DB writes are intentionally not awaited so collector cadence isn't tied to DB latency; if persistence fails the live view is unaffected. The Activity tab has a Live/History mode toggle — History queries `activity_log` with filters (time range, level, source, message search) and supports pagination. Retention via `activity.retention_days` setting (default 30) and `sp_purge_old_activity` stored procedure.

### Deploy.yml restart with sc + STOPPED polling
`net stop` returns when service is `STOP_PENDING`, NOT yet `STOPPED`. If `net start` runs immediately, it can race and end up running on the old PID/binary. Workflow uses `sc stop` + cmd loop polling for `STOPPED` state via `sc query | findstr STOPPED`, then `sc start`. Verified by checking topbar SHA after every push.

Deploy smoke checks both `/version/sha` and `/`. The SHA check confirms the
running Node process picked up the expected build; the root-page check confirms
the browser UI dist is reachable from the service process. Frontend dist paths
must be resolved from module location (`import.meta.url`), not `process.cwd()`,
because NSSM/Windows Service cwd is not a stable contract.

### Service Control ACL grant
The runner runs as `svc-itdashboard` which by default cannot stop/start the `ITDashboardAPI` service it itself hosts. One-time setup grant via `sc sdset` adds explicit Stop/Start ACE for the SID. Without it deploys succeed at robocopy/build but service keeps running old code.

### Domain GPO AllSigned ExecutionPolicy
The domain enforces `AllSigned` ExecutionPolicy on Windows servers, blocking unsigned PS scripts including GitHub Actions runner's temp step files. Workflow uses `defaults.run.shell: cmd` (cmd not subject to PS ExecutionPolicy). Service restart in workflow uses `sc stop/start` (cmd), not `Restart-Service`.

The deploy workflow's `actions/checkout` and `actions/setup-node` were bumped v4 → v5 (Node 24; GitHub forces Node 24 from 2026-06-16).

## Retention policy

| Data | Retention | Mechanism |
|------|-----------|-----------|
| Raw `events` | 90 days | `sp_purge_old_events @retention_days = 90` daily |
| `event_daily_agg` | navždy | žádné delete |
| `collector_runs` | navždy | žádné delete |
| `ad_sync_runs` | navždy | žádné delete |
| `disks` | jen poslední per (PC, drive) | MERGE replaces |
| `script_runs` | 1 rok (planned) | TODO |

Raw-event retention is governed by the `events.retention_days` setting (default 90, migration 021), consumed by the retention-runner — not by any env var or hardcoded constant.

## Required permissions on target PCs

For both collectors to succeed against a target PC, the domain service account (`svc-itdashboard`) needs:

1. **TCP/135 reachable** — PC online, Domain firewall profile allows
2. **Firewall rule "Remote Event Log Management"** enabled (predefined Windows rule)
3. **Member of local Event Log Readers** — for Get-WinEvent ACL
4. **Member of local Performance Monitor Users** — for Get-CimInstance Win32_LogicalDisk
5. **WMI namespace ACL on `Root\CIMV2`** — Remote Enable for DCOM remote query

Fleet rollout via single "ITDashboard collection" GPO linked to OUs containing target PCs.

## Security

- **DB:** Integrated Auth via `msnodesqlv8`, no password in config. `db_owner` on `ITDashboard`.
- **API service account:** doménový `svc-itdashboard` (NOT Domain Admin). Needs only:
  - Event Log Readers + Performance Monitor Users on target PCs (via GPO)
  - DB `db_owner`
  - Stop/Start ACL on its own service (`ITDashboardAPI`)
- **Credentials vault:** DPAPI CurrentUser scope — encryption bound to the service account. Rotating account invalidates secrets.
- **API → desktop:** currently HTTP on port 4000. The dashboard UI is gated frontend-side: on mount, `App.tsx` calls `GET /access-check` which returns `{ ip, allowed }`; if not allowed, the app renders an "access not configured" screen instead of the dashboard. The Windows Firewall rule "ITDashboard API (4000)" provides the whitelist source of truth — its `RemoteAddress` field is cached in memory and refreshed on PUT. The whitelist is now loaded (`refreshIpGuard('boot')`) **before** `app.listen()`, so there is no longer a brief window right after a deploy/restart where the in-memory whitelist is empty and every request gets "Access not configured". **The JSON API itself, the bundle, and `/docs` are intentionally open** — the server is on an internal domain network and the API is intentionally reachable by anyone in the domain. This is a UX gate, not a security boundary; bypass via DevTools is acceptable for the threat model (incidental UI discovery, not adversarial access). TLS termination + auth tokens planned if the API needs to become a real security boundary.
- **Audit:** every script run captured in `script_runs` (invoker, target, params, exit code, stdout/stderr).
- **Runner auth:** outbound HTTPS only. No inbound holes from GitHub into the network.

## Migration history

| ID | Purpose |
|----|---------|
| 001_init | Initial schema (computers, events, event_daily_agg, scripts, script_runs, credentials) |
| 002_retention_job | `sp_rollup_yesterday` + `sp_purge_old_events` |
| 003_collector | computers: last_collected_at, last_error, consecutive_failures; collector_runs table; unique idx on events for dedup |
| 004_activity | ad_sync_runs table (in-memory activity log handled separately) |
| 005_monitor_flag | computers.monitor_enabled |
| 006_ou_path | computers.distinguished_name + ou_path |
| 007_disks_settings | disks table + settings table + default disk thresholds |
| 008_interval_settings | settings rows for collector/disk/adsync intervals |
| 009_last_status | computers.last_status (online/offline/rpc_unavailable/access_denied) |
| 010_service_problems | service_problems table (Win32_Service Auto+!Running snapshot) + services.interval_sec default 900s |
| 011_service_trigger_delayed_columns | service_problems.delayed_start + trigger_start columns |
| 012_per_user_service | service_problems.per_user_start (LUID suffix detection) |
| 013_excluded_flag | computers.excluded (operator-controlled hard exclude) |
| 014_service_policy | service_policy table with seeded defaults + service_problems drift columns |
| 015_periodic_checks | unified periodic check scheduler settings |
| 016_perf_events | perf_events table (Diagnostics-Performance channel) + checks.run_perf setting |
| 017_adsync_in_runall | checks.run_adsync (default false) + adsync.default_monitor_enabled (default true) |
| 018_perf_cold_start_days | perf.cold_start_days (default 30) — configurable first-sweep lookback for perf-events collector |
| 019_pc_info | computers.current_user, current_user_seen_at, ip_address, pc_info_collected_at — telemetry collected alongside disk scan |
| 020_activity_log_persistent | activity_log table + 3 indexes + activity.retention_days setting + sp_purge_old_activity procedure |
| 021_retention_settings | events.retention_days (90) + retention.run_at_hour (2) settings consumed by retention-runner |
| 022_inactive_threshold | inactive.threshold_days (90) — drives Dashboard "Inactive PCs" card and Computers tab filter chip |
| 023_pc_user_history | pc_user_history table + pcUserHistory.retention_days (90) + sp_purge_pc_user_history — per-PC interactive login history |
| 024_pc_user_history_ip | pc_user_history.ip_address — IP the PC had at the moment of each login session |
| 025_event_dedup | event dedup lookback settings |
| 026_service_exit_code | service_problems.exit_code + service_specific_exit_code |
| 027_event_summary_window | events.summary_window_days setting |
| 028_disk_email_alerts | computers.disk_email_monitor BIT + alerts.* settings seed (enabled, frequency_hours, smtp_host, smtp_port, smtp_from, recipients) |
| 029_disk_email_drives | computers.disk_email_drives NVARCHAR(64) — per-PC drive-letter scope |
| 030_service_email_alerts | computers.service_email_monitor BIT + service_alert_state table (per-(PC, service) `first_down_at` flapping-debounce state) + alerts.services.* settings seed (enabled, debounce_minutes, frequency_hours, maintenance_window, critical_names, whitelist) |
| 031_service_port_checks | port_check_state table (per-(PC, port) baseline `last_ok_at` + flapping-debounce state) + alerts.services.port_checks_enabled / port_checks (seeded `LDAP:389,SMB:445,RDP:3389,Kerberos:88,DNS:53`) / port_timeout_ms (2000) settings seed |
| 032_reachability | computers.reachable BIT + last_reachable_at + reach_checked_at (live TCP reachability probe) + checks.run_reachability (1) / reachability.ports (`135,445`) / reachability.timeout_ms (2000) settings seed |
| 033_faulty_pc | faulty.* settings seed for reinstall-candidate scoring: window_days (14), signature_cap (20), weight_critical (10) / weight_error (3) / weight_warning (1), weight_breadth (5), weight_persistence (3), threshold_watch (60), threshold_risk (150) — consumed by `GET /events/pc-health` |

> `alerts.dashboard_url` (added 2026-06-11 for the redesigned disk alert email report) is a runtime settings key created on first save — it has **no migration** of its own (it was added alongside the 029→030 work but is not part of any migration).
