# Architecture

## Components

### Desktop client (`apps/desktop`)
- Electron + React + Vite + TypeScript.
- Per-PC install (NSIS / portable build via electron-builder) OR run via browser through Vite dev server.
- Renderer talks HTTPS with API on `10.8.2.213:4000`.
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
- Fastify + TypeScript, runs as Windows Service `ITDashboardAPI` (NSSM) on `10.8.2.213`.
- Service account `AXINETWORK\svc-itdashboard`.
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

### Database (`MSSQL 10.8.2.225`, DB `ITDashboard`)
Tables:
- `computers` — name, fqdn, os_version, last_seen, enabled (AD presence), monitor_enabled (operator intent), last_collected_at, last_error, consecutive_failures, distinguished_name, ou_path, last_status
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

### Perf-events: discrete slow records, not continuous CPU history
The perf-events collector subscribes to the `Microsoft-Windows-Diagnostics-Performance/Operational` channel, which contains only the events Windows itself diagnosed as "slow" (boot/shutdown/standby/resume timing degradations) — not a continuous CPU curve. Windows does not natively retain CPU usage history without an opt-in Data Collector Set; SRUM has rough per-process daily data but isn't WMI-accessible. The diagnostics channel was chosen because it is enabled by default on Win10/11 client, gives per-incident attribution (named culprit process / service / driver), and reuses the existing RPC collection path with no agent install. Default channel retention is small (~1 MB ring buffer) so we sweep into SQL to preserve history; cold-start pulls 7 days, then incremental.

**Server SKU gotcha:** the channel is **disabled by default on Windows Server**. Get-WinEvent on a disabled channel returns `"There is not an event log on the X computer that matches"`. The collector detects this pattern, classifies it as `channel-disabled` (separate from `fail`), and skips silently — no per-PC noise in the activity log, one aggregate count at end of run. To enable across the server fleet, push a GPO computer-startup script that runs `wevtutil sl Microsoft-Windows-Diagnostics-Performance/Operational /e:true` (same pattern as the Services GPO script export).

### Activity log is two-tier
Live view: ring buffer of 500 entries, polled by dashboard every 2s. Lost on service restart. Persistent history: every `logActivity()` call is also fire-and-forget INSERT into `activity_log` table (`apps/server/src/services/activity-log.ts`). DB writes are intentionally not awaited so collector cadence isn't tied to DB latency; if persistence fails the live view is unaffected. The Activity tab has a Live/History mode toggle — History queries `activity_log` with filters (time range, level, source, message search) and supports pagination. Retention via `activity.retention_days` setting (default 30) and `sp_purge_old_activity` stored procedure.

### Deploy.yml restart with sc + STOPPED polling
`net stop` returns when service is `STOP_PENDING`, NOT yet `STOPPED`. If `net start` runs immediately, it can race and end up running on the old PID/binary. Workflow uses `sc stop` + cmd loop polling for `STOPPED` state via `sc query | findstr STOPPED`, then `sc start`. Verified by checking topbar SHA after every push.

### Service Control ACL grant
The runner runs as `svc-itdashboard` which by default cannot stop/start the `ITDashboardAPI` service it itself hosts. One-time setup grant via `sc sdset` adds explicit Stop/Start ACE for the SID. Without it deploys succeed at robocopy/build but service keeps running old code.

### AXINETWORK GPO AllSigned ExecutionPolicy
Domain enforces `AllSigned` ExecutionPolicy on Windows servers, blocking unsigned PS scripts including GitHub Actions runner's temp step files. Workflow uses `defaults.run.shell: cmd` (cmd not subject to PS ExecutionPolicy). Service restart in workflow uses `sc stop/start` (cmd), not `Restart-Service`.

## Retention policy

| Data | Retention | Mechanism |
|------|-----------|-----------|
| Raw `events` | 90 days | `sp_purge_old_events @retention_days = 90` daily |
| `event_daily_agg` | navždy | žádné delete |
| `collector_runs` | navždy | žádné delete |
| `ad_sync_runs` | navždy | žádné delete |
| `disks` | jen poslední per (PC, drive) | MERGE replaces |
| `script_runs` | 1 rok (planned) | TODO |

`RETENTION_RAW_DAYS` env / hardcoded → 90.

## Required permissions on target PCs

For both collectors to succeed against a target PC, `AXINETWORK\svc-itdashboard` needs:

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
