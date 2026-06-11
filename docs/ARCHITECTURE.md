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
- **Dashboard** — collector status, summary cards (clickable drill-down), timeline chart, top noisy PCs chart, top event IDs, computers summary
- **Events** — full-width events table with search + filters (Computer, Source, Level, Time range)
- **Computers** — inventory with status chips, monitor checkboxes, bulk all/none, AD sync, disk scan, sync history
- **Services** — Auto + non-Running detection with policy/drift, by-PC + by-service views, GPO PS script export
- **Perf** — Diagnostics-Performance channel: summary cards, top culprits, most-affected PCs, recent slow boot/shutdown/standby/resume events
- **Activity** — terminal-style live log (filter, pause, copy)
- **Settings** — periodic check frequency + enabled checks + disk thresholds (applied live, no restart)

### API + collectors (`apps/server`)
- Fastify + TypeScript, runs as Windows Service `ITDashboardAPI` (NSSM) on the API host.
- Runs under a domain service account (suggested name `svc-itdashboard`).
- Endpoints organised by feature (see `routes/*.ts`):
  - `health`, `version`, `docs`
  - `events` — list, summary, top-ids, timeline, top-computers
  - `computers` — list, sync, sync/last, sync/history, :id/monitor (PATCH), monitor/bulk (POST)
  - `collector` — status, run, stop
  - `disks` — list, collect
  - `activity` — log
  - `settings` — get all, put bulk
  - `scripts` — list (run endpoint pending)
- Background tasks:
  - **Periodic checks scheduler** — every `checks.interval_sec` (default 900) within `checks.days` + `checks.window_start/end` runs selected checks from Settings: eventlog, disk, services, perf, adsync (adsync default OFF in periodic)
  - **AD sync** — registered as the first check; `Get-ADComputer -Filter *` + MERGE. Default off in periodic, forced on by "Run all". New PCs default to `monitor_enabled = adsync.default_monitor_enabled` (default `true`)
  - **Eventlog collector** — pulls Warning/Error/Critical events
  - **Disk + PC-info collector** — pulls Win32_LogicalDisk, Win32_ComputerSystem (current logged-in user), Win32_NetworkAdapterConfiguration (primary IPv4) via a single DCOM session. PC info populates `computers.current_user`, `current_user_seen_at`, `ip_address`, `pc_info_collected_at`. User is only overwritten when non-null (last-seen persists); IP is always overwritten.
  - **Services collector** — checks Auto + non-running Windows services and drift policy
  - **Perf-events collector** — pulls slow boot/shutdown/standby/resume records from the `Microsoft-Windows-Diagnostics-Performance/Operational` channel; parses EventData XML for TotalTime / DegradationTime / culprit
  - **Retention purge** — `sp_purge_old_events @retention_days = 90` daily

### Database (MSSQL on the SQL host — `SQL_HOST` / `SQL_INSTANCE`, DB `SQL_DATABASE`)
Tables:
- `computers` — name, fqdn, os_version, last_seen, enabled (AD presence), monitor_enabled (operator intent), last_collected_at, last_error, consecutive_failures, distinguished_name, ou_path, last_status, `disk_email_monitor` (per-PC opt-in to disk-critical email alerts) + `disk_email_drives` (optional per-PC drive-letter scope)
- `events` — raw events with unique idx `(computer_id, event_id, log_name, time_created)` for idempotency
- `event_daily_agg` — daily aggregates per (computer, log_name, event_id, level), kept forever
- `disks` — per-drive snapshot (replaces row on each scan)
- `perf_events` — slow boot/shutdown/standby/resume records with parsed culprit + total/degradation timings; dedupe on `(computer_id, time_created, event_id)`
- `service_problems`, `service_policy` — services collector state + drift rules
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
`checks.interval_sec` causes immediate scheduler reschedule on save — no service restart. The day/time window and check enable flags (`checks.run_eventlog`, `checks.run_disk`, `checks.run_services`, `checks.run_perf`, `checks.run_adsync`) are read on every scheduled run, so toggles apply to the next cycle.

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

**Config & routes.** Configuration lives entirely in Settings (DB `settings` table, `alerts.*` keys) plus the per-PC columns — nothing in `.env`, consistent with the portability model. Routes: `PATCH /computers/:id/disk-email-monitor` `{ enabled?, drives? }` and `POST /alerts/disk/test` (sends the current state ignoring enable/throttle, backing the Settings test button); `GET /computers` now returns `disk_email_monitor` + `disk_email_drives`. The Dashboard shows a "Watched disks" tile (criticalPcs/monitoredPcs + alerts on/off).

This stays on the right side of **Observer, not executor**: it emails the operator about a stale-derived threshold breach, it does not act on the target.

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
- **API → desktop:** currently HTTP on port 4000. The dashboard UI is gated frontend-side: on mount, `App.tsx` calls `GET /access-check` which returns `{ ip, allowed }`; if not allowed, the app renders an "access not configured" screen instead of the dashboard. The Windows Firewall rule "ITDashboard API (4000)" provides the whitelist source of truth — its `RemoteAddress` field is cached in memory and refreshed on PUT. **The JSON API itself, the bundle, and `/docs` are intentionally open** — the server is on an internal domain network and the API is intentionally reachable by anyone in the domain. This is a UX gate, not a security boundary; bypass via DevTools is acceptable for the threat model (incidental UI discovery, not adversarial access). TLS termination + auth tokens planned if the API needs to become a real security boundary.
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
