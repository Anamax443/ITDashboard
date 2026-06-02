# Architecture

## Components

### Desktop client (`apps/desktop`)
- Electron + React + Vite + TypeScript.
- Per-PC install (NSIS / portable build via electron-builder) OR run via browser through Vite dev server.
- Renderer talks HTTPS with API on `10.8.2.213:4000`.
- `contextIsolation: true`, `nodeIntegration: false` — renderer has no direct Node.js access.
- Scripts don't execute locally — client calls `POST /scripts/:slug/run` and API spawns them on the server.

5 navigation tabs:
- **Dashboard** — collector status, 7 summary cards (clickable drill-down), timeline chart, top noisy PCs chart, top event IDs, computers summary
- **Events** — full-width events table with search + filters (Computer, Source, Level, Time range)
- **Computers** — inventory with status chips, monitor checkboxes, bulk all/none, AD sync, disk scan, sync history
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
  - **Periodic checks scheduler** — every `checks.interval_sec` (default 900) within `checks.days` + `checks.window_start/end` runs selected checks from Settings: eventlog, disk, services
  - **Eventlog collector** — pulls Warning/Error/Critical events
  - **Disk collector** — pulls Win32_LogicalDisk via DCOM
  - **Services collector** — checks Auto + non-running Windows services and drift policy
  - **Retention purge** — `sp_purge_old_events @retention_days = 90` daily

### Database (`MSSQL 10.8.2.225`, DB `ITDashboard`)
Tables:
- `computers` — name, fqdn, os_version, last_seen, enabled (AD presence), monitor_enabled (operator intent), last_collected_at, last_error, consecutive_failures, distinguished_name, ou_path, last_status
- `events` — raw events with unique idx `(computer_id, event_id, log_name, time_created)` for idempotency
- `event_daily_agg` — daily aggregates per (computer, log_name, event_id, level), kept forever
- `disks` — per-drive snapshot (replaces row on each scan)
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
`computers.monitor_enabled` is the operator's intent. AD sync explicitly does **not** touch this column — it only updates `fqdn`, `os_version`, `last_seen`, `enabled` (AD presence). When a PC is removed from AD it gets soft-disabled (`enabled = 0`) but its events stay. If it reappears, `enabled = 1` again and the original `monitor_enabled` state persists.

### Settings live-reschedule
`checks.interval_sec` causes immediate scheduler reschedule on save — no service restart. The day/time window and check enable flags (`checks.run_eventlog`, `checks.run_disk`, `checks.run_services`) are read on every scheduled run, so toggles apply to the next cycle.

### Activity log is in-memory only
Ring buffer of 500 entries, polled by dashboard every 2s. Lost on service restart. For permanent audit, the relevant info is also written to DB tables (`collector_runs`, `ad_sync_runs`, `script_runs`). This avoids DB writes for every log line (~thousands per collector run).

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
- **API → desktop:** currently HTTP on port 4000. Firewall whitelist limits to specific IT-operator IPs. TLS termination planned (Caddy / IIS reverse proxy).
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
