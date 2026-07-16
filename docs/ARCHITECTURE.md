# Architecture

> **Document state:** 2026-07-16 · live commit `4783787` · migrations 001–078.

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

Navigation tabs (Dashboard, Events, Computers, Services, Critical Services, Ports, Devices, **Printer status**, **Link speed**, Database, Perf, Activity, Settings):
- **Dashboard** — collector status, summary cards (clickable drill-down, incl. a "Critical services" tile → opens the Critical Services tab, and a "🖨 Náplně/Supplies" tile → opens Printer status pre-filtered to low/empty, and a **"⚡ Linky" tile** (latest-per-target ok/slow/offline/error + slowest link → opens the Link speed tab)), a **"Komunikace / Comms" tile** (overall comms ok/degraded/down) that toggles a collapsible **CommsHealth** panel, an always-visible **WanHealth** strip (per-site WAN/internet RTT + loss chips), the "Problem PCs" and "📊 Operating systems" tiles (now first-class grid tiles whose detail tables expand below), timeline chart, top noisy PCs chart, top event IDs, computers summary. **Customizable layout** — an ✏️ edit mode places every tile by column-letter + row-number at full/half size, stacks two halves per cell (upper/lower slot), and adds optional per-row headings; persisted in `dashboard.tile_layout` / `dashboard.row_titles` (see **### Customizable dashboard tile layout**)
- **Printer status** — card per printer with coloured ink/toner/maintenance-box/drum/belt bars + % (SNMP Printer-MIB + HTTP fallback); whole-card click opens the printer EWS via the cert-bypass proxy, a bottom-row link opens the raw `http://IP` (see **### Printer supply collection — SNMP Printer-MIB + HTTP fallback**)
- **Link speed (⚡)** — measured up/down throughput per target over the C$ channel: a live console (running batch progress), a sortable + per-column-filter results grid with exports, and single-test / run-batch / stop controls. Backed by `LinkSpeedPage.tsx` (see **### Link-speed measurement**)
- **Events** — full-width events table with search + filters (Computer, Source, Level, Time range)
- **Computers** — inventory with status chips, monitor checkboxes, bulk all/none, AD sync, disk scan, sync history. **Monitor and Exclude are mutually exclusive** — the server clears one when the other is set, on both the per-row PATCH endpoints and the bulk endpoints. The 📧 Disk / 🔔 Services / 🛡 Critical services / Exclude column headers each carry a "✓ all / ✗ none" control that sets that flag for all currently visible (filtered) rows in one shot, via `POST /computers/bulk-flag { ids, flag, value }` (server whitelists the `flag` column name). An **"✉ Email report"** toolbar button emails a fleet-overview report scoped to the **currently visible (filtered)** machines — same "applies to what you see" model as the bulk toggles (see **### Structured fleet overview report + on-demand email**)
- **Services** — Auto + non-Running detection with policy/drift, by-PC + by-service views, GPO PS script export. The default "Only ExitCode != 0" filter is **off** and exit-code classification goes through the shared `isServiceCrash` predicate so the tab matches the dashboard tile + the broad alert (see **### Services tab — exit-code-agnostic drift, shared `isServiceCrash`**)
- **Critical Services** — sortable service×machine table of the configured critical services in their real state (Running/Stopped colour, offline machine = stale amber, "only not-running" filter); confirms the critical services actually run, not just flags stopped ones
- **Perf** — Diagnostics-Performance channel: summary cards, top culprits, most-affected PCs, recent slow boot/shutdown/standby/resume events
- **Pády / Crashes (💥)** — a collector **status strip** (last/next run + last SQL write, from `GET /crashes/status`), collected kernel minidumps with their parsed analysis (STOP code, bug-check name, hot function, offending process/module) and a dump-derived plain-language explanation (nt-kernel vs third-party driver, with corruption-class special cases), fleet aggregations (STOP breakdown / top culprit / repeat offenders), per-crash detail with the full cdb output + `.dmp` download, and a **light-by-default** printable "crash analysis" report with a light/dark toggle + UTF-8-BOM save (see **### Crash-dump collection & analysis**)
- **Activity** — terminal-style live log (filter, pause, copy)
- **Settings** — periodic check frequency + enabled checks + disk thresholds (applied live, no restart). Email config is restructured into a standalone **"Email setup (SMTP)"** section holding the shared relay/From/recipients/dashboard URL; each agenda below (disk / services / ports / reports) carries only its own enable/throttle + an optional per-agenda recipient-override field (see **### Per-agenda email recipients with shared fallback**)

### API + collectors (`apps/server`)
- Fastify + TypeScript, runs as Windows Service `ITDashboardAPI` (NSSM) on the API host.
- Runs under a domain service account (suggested name `svc-itdashboard`).
- Endpoints organised by feature (see `routes/*.ts`):
  - `health`, `version`, `docs`
  - `system` (`routes/system.ts`, registered as `registerSystemRoutes`) — `GET /system/comms` (one aggregated ok/degraded/down view over six communication channels — database, mikrotik_rest, ftp, collector, email, unifi — derived from existing data, no new probing), `GET /system/wan` (live WAN-link snapshot per branch + internet, thresholds, `nextRunAt`, optional speed), the **link-speed** methods `POST /system/linkspeed/test` (single target), `POST /system/linkspeed/run` (background batch), `POST /system/linkspeed/stop`, `GET /system/linkspeed/status` (live progress + results), `GET /system/linkspeed/history`, `GET /system/linkspeed/summary` (latest-per-target ok/slow/offline/error + slowest — see **### Link-speed measurement**), the **service restart** `POST /system/service/restart` (detached `net stop`/`net start` outside the NSSM tree, service name from `ITDASHBOARD_SERVICE_NAME` — see **### Restart service (`POST /system/service/restart`)**), and the **PARKED** `GET /system/service-ports` + `POST /system/service-discovery` (per-branch service-port matrix + discovery; route content present, nav tab hidden, scheduler idle — see **### Per-branch service-port matrix + service discovery (PARKED)**). See **### Communication-channels health (`GET /system/comms`)** and **### Live WAN-link monitor**
  - `events` — list, summary, top-ids, timeline, top-computers, pc-health (reinstall-candidate scoring)
  - `computers` — list, sync, sync/last, sync/history, :id/monitor (PATCH), monitor/bulk (POST)
  - `collector` — status, run, stop
  - `services` — problems list, critical (`GET /services/critical` — real state of configured critical services, joined to `computers`; the response now also carries each PC's `critical_service_exceptions` so the tab/tile honour the same per-PC excepted-service list the email does)
  - `reports` — `GET /reports/overview` (structured fleet-overview JSON, no live probing) + `POST /reports/email` (`{ machines?: string[] }`, on-demand overview email); both share one generator so UI and email never drift
  - `reachability` — `POST /reachability/run` (manual probe trigger, backs Settings "Run now")
  - `port-status` — `GET /port-status` (latest per-port verdict joined to `computers`, filtered to the currently configured check names), `POST /port-status/run` (manual probe), `POST /computers/:id/probe` (live ICMP-ping + ports console for one PC) — see **### Ports availability subsystem**
  - `devices` — `GET /devices` (DHCP-lease inventory joined to `device_categories` + best-match computer, with a computed `suggested` category), `PATCH /devices/category` (upsert/clear a category by MAC), `POST /devices/run` (manual DHCP pull), `POST /devices/probe` (live per-row ping console) — see **### MikroTik DHCP device inventory**. The cert-bypass EWS proxy `GET /devices/web/:ip[/*]` (Settings `devices.web_proxy`, on by default) lives here too — see **### Device web-UI proxy (cert bypass)**
  - `printer-supplies` — `GET /printer-supplies` (per-printer ink/toner/maintenance levels via SNMP Printer-MIB + HTTP fallback, grouped per printer and joined to the device inventory), `POST /printer-supplies/run` (manual collect) — see **### Printer supply collection — SNMP Printer-MIB + HTTP fallback**
  - `disks` — list, collect
  - `activity` — log
  - `settings` — get all, put bulk
  - `scripts` — list (run endpoint pending)
- Background tasks:
  - **Periodic checks scheduler** — every `checks.interval_sec` (default 900) within `checks.days` + `checks.window_start/end` runs selected checks from Settings: eventlog, disk, services, perf, adsync, reachability (adsync default OFF in periodic)
  - **AD sync** — registered as the first check; `Get-ADComputer -Filter *` + MERGE. Default off in periodic, forced on by "Run all". New PCs default to `monitor_enabled = adsync.default_monitor_enabled` (default `true`)
  - **Reachability probe** — a standalone timer (independent of the checks window); marks every enabled, non-excluded PC reachable if any of TCP 135 / TCP 445 / ICMP ping answers, recording live network presence in `computers.reachable` independently of the data collectors. See **### Live network reachability probe drives the Status column**.
  - **Eventlog collector** — pulls Warning/Error/Critical events
  - **Disk + PC-info collector** — pulls Win32_LogicalDisk, Win32_ComputerSystem (current logged-in user), Win32_NetworkAdapterConfiguration (primary IPv4) via a single DCOM session. PC info populates `computers.current_user`, `current_user_seen_at`, `ip_address`, `pc_info_collected_at`. User is only overwritten when non-null (last-seen persists); IP is always overwritten.
  - **Services collector** — one `Get-CimInstance Win32_Service` enumeration per PC derives two outputs: Auto + non-running services (drift policy) and the configured critical services in any state (see **### Critical-service status collection**)
  - **Perf-events collector** — pulls slow boot/shutdown/standby/resume records from the `Microsoft-Windows-Diagnostics-Performance/Operational` channel; parses EventData XML for TotalTime / DegradationTime / culprit
  - **Port-status collector** — a standalone timer (independent of the checks window) that probes every enabled, non-excluded PC's configured ports and records the latest open/closed + connect-latency verdict in `port_status`. See **### Ports availability subsystem**
  - **MikroTik DHCP collector** — pulls bound DHCP leases from each configured RouterOS v7 router via the REST API, upserts them into `dhcp_leases`, pairs each lease to an AD computer, and pings only the unmatched (non-AD) devices. Also runs the active subnet scan, the long-term-loss windowing (`device_ping_samples`), the scan-site reconciliation, and the stale-lease prune. See **### MikroTik DHCP device inventory**
  - **UniFi collector** — a standalone timer that logs in to a UniFi controller over `node:https` (cookie session, self-signed cert accepted), reads `/api/s/<site>/stat/sta`, and merges every connected client into `dhcp_leases` by MAC (`source='unifi'`). Resolves the real MAC for hosts the scan could only key as synthetic `IP-<ip>` (then `dedupSyntheticByIp()`); `dynamic=NULL` (the controller doesn't report static-vs-DHCP). DB-driven config; password encrypted via `secret-crypto`. Migration 053.
  - **Shared-printers collector** — enumerates printer-type SMB shares via `net view \\<pc>` on reachable PCs (works where WMI is denied) and stores them as `source='share'` device rows.
  - **Printer supplies collector** — a standalone timer that probes printer-categorized devices over SNMP Printer-MIB (+ a Brother/Epson HTTP fallback) and records ink/toner/maintenance/drum/belt levels in `printer_supplies`. See **### Printer supply collection — SNMP Printer-MIB + HTTP fallback**
  - **Crash-dump collector** (`crash-dump-collector.ts`) — own timer (`crash.interval_sec`); reads `\\PC\C$\Windows\Minidump\*.dmp` from monitored reachable PCs (TCP/445 pre-flight, dedup by computer+filename), stores each new minidump as a blob in `crash_dumps` (status='pending'). Off by default (`crash.enabled`). See **### Crash-dump collection & analysis**
  - **Crash analyzer worker** (`crash-analyzer-worker.ts`) — separate timer (`crash.analyzer_interval_sec`); takes `pending` dumps, materializes the blob to a temp file, runs cdb, stores the parsed result + full output, deletes the temp
  - **WAN monitor** (`wan-monitor.ts`) — own self-rescheduling timer (`startWanMonitorSchedule`, same DB-driven enable/interval pattern as the crash collector). Every `wan.interval_sec` (default 60) it pings each branch router IP (parsed from `mikrotik.routers`) + one internet target (`wan.internet_target`, default `1.1.1.1`) from the app server via Windows `ping.exe`, parsing avg RTT + packet loss locale-independently from the `TTL=`/`[<=]NNms` lines. Holds **only the current snapshot in memory** — no DB table, no history. Optionally runs a central download speed test on its own slower `wan.speedtest_interval_sec` cadence. See **### Live WAN-link monitor**
  - **Service-port matrix** (`service-port-matrix.ts`, **PARKED**) — own self-rescheduling timer (`startServicePortsSchedule`, the same DB-driven enable/interval pattern as the other standalone collectors). For each `svcports.checks` entry it TCP-probes that port (reusing the now-exported `tcpProbeTimed()` from `port-status-collector.ts`) on every categorized device of that category at each site, **from `.213` over the WAN**; in-memory snapshot only. Currently **idle** (`svcports.enabled=0`, migration 070). See **### Per-branch service-port matrix + service discovery (PARKED)**
  - **Link-speed measurement** (`link-speed.ts`, **PARKED-capable**) — own self-rescheduling timer (`startLinkSpeedSchedule` in `index.ts`, the same DB-driven enable/interval/restart-safe pattern as the WAN monitor). For each target it caches an N-MB random source file on `.213` (`ensureSource`) and then per cycle **pipelines it up to `\\PC\C$\tmp\itdash-speedtest\<filename>` and back down**, timing each direction, keeping the **BEST** up/down over `linkspeed.cycles` cycles, and pings RTT for latency; the client dir is removed afterwards. Reuses `tcpProbeTimed` (445 precheck) + Windows `ping.exe`. Writes each result to `link_speed_results` and logs the batch to `activity_log` (source `linkspeed`). See **### Link-speed measurement**
  - **Retention purge** — a daily runner (`retention-runner.ts`) executes the `sp_purge_*` procs (events / activity_log / pc_user_history / perf_events / ad_sync_runs + events de-dup) at the configured hour. The Settings "Retenční politika" table now also offers a **per-row manual run** (▶ per row + Označit/Odznačit/Spustit označené); the 3 device-inventory tables (`dhcp_leases` ghosts, `device_ip_history`, `device_ping_samples`) — pruned inline by the collector — are exposed here as discrete steps that replicate the collector's exact DELETE queries (`POST /api/retention/run { steps }`)

### Database (MSSQL on the SQL host — `SQL_HOST` / `SQL_INSTANCE`, DB `SQL_DATABASE`)
Tables:
- `computers` — name, fqdn, os_version, last_seen, enabled (AD presence), monitor_enabled (operator intent), last_collected_at, last_error, consecutive_failures, distinguished_name, ou_path, last_status, `reachable` (live TCP reachability, set by the reachability probe) + `last_reachable_at` (last successful connect) + `reach_checked_at` (last probe attempt), `disk_email_monitor` (per-PC opt-in to disk-critical email alerts) + `disk_email_drives` (optional per-PC drive-letter scope), `service_monitor` (per-PC opt-in to the **broad** "every Auto service not Running" email level) + `service_exceptions` (per-PC ignore-list for the broad level), `service_email_monitor` (per-PC opt-in to the **critical** service email level) + `critical_service_exceptions` (per-PC ignore-list for the critical level) — see **### Two-level service monitoring with per-PC exceptions**
- `events` — raw events with unique idx `(computer_id, event_id, log_name, time_created)` for idempotency
- `event_daily_agg` — daily aggregates per (computer, log_name, event_id, level), kept forever
- `disks` — per-drive snapshot (replaces row on each scan)
- `perf_events` — slow boot/shutdown/standby/resume records with parsed culprit + total/degradation timings; dedupe on `(computer_id, time_created, event_id)`
- `service_problems`, `service_policy` — services collector state + drift rules
- `critical_service_status` — real state (any state, not just stopped) of the configured critical services per machine; `(computer_id, service_name)` PK, columns `service_name`, `display_name`, `state`, `start_mode`, `collected_at`. Populated from the same single Win32_Service enumeration as `service_problems`; consumed by `GET /services/critical`
- `service_alert_state` — per-(PC, service) flapping-debounce state for critical-service email alerts (`first_down_at`); row cleared on service recovery
- `port_check_state` — per-(PC, port) state for service port reachability checks: baseline `last_ok_at` (a port becomes alert-eligible only once it has answered) + flapping-debounce state; row cleared on port recovery
- `port_status` — the **latest** per-port verdict for the ports-availability grid (migration 041): `computer_id`, `check_name`, `port`, `is_open`, `latency_ms`, `checked_at`; PK `(computer_id, check_name)`. Distinct from `port_check_state` (which is the phase-2 ALERT state machine) — this holds only the current open/closed + latency snapshot the grid renders. See **### Ports availability subsystem**
- `dhcp_leases` — network devices, merged from **five sources** by MAC: DHCP leases (migration 042), router ARP + active subnet scan (migration 044), UniFi clients (migration 053), shared/USB printers (`source='share'`); PK `(site, mac_address)`, columns `ip`, `host_name`, `server`, `comment`, `status`, `dynamic` (nullable — UniFi rows are NULL, unknown static/dynamic), `expires_after`, `first_seen`, `last_seen`, `reachable`, `last_reachable_at`, `reach_checked_at`, `source` (`dhcp`/`arp`/`scan`/`unifi`/`share`), `packet_loss` + `latency_ms` (now a **24h rolling** loss %/avg latency, migration 045 + 052). Stale "ghost" rows are pruned by `devices.lease_retention_days` (migration 054). See **### MikroTik DHCP device inventory**, **### Multi-source device discovery**, **### Per-device packet loss + latency**
- `device_categories` — operator-assigned device category (migration 042) + operator-editable device name + note (migration 046, `category` nullable so a name/note-only row is valid); PK `mac_address` so all persist by MAC across sites/router reloads, independently of the lease lifecycle
- `device_ping_samples` — rolling per-device ping history (`mac_address`, `sample_at`, `sent`, `recv`, `latency_ms`, migration 052) powering the long-term (windowed) loss/latency figure; online cycles only, pruned to the window
- `eventlog_snooze` — temporary per-PC "PC v problémech" snooze (`computer_id` PK, `snoozed_until` hard expiry, signature; migration 050); FK→computers ON DELETE CASCADE
- `printer_alert_state` — per-MAC debounce/throttle state for the printer-offline email agenda (migration 043); mirrors `service_alert_state`. See **### Printer-offline email alert agenda**
- `printer_supplies` — per-printer supply levels (migration 048); PK `(mac_address, supply_key)` (`K`/`C`/`M`/`Y`/`MAINT`/`DRUM`/`BELT`/…), columns `description`, `colorant`, `supply_type`, `level_pct`, `level_raw`, `max_raw`, `part_code`, `model`, `source` (`snmp`/`http`), `collected_at`. Populated by the printer-supplies collector (SNMP Printer-MIB + HTTP fallback), which prunes supplies that disappear from a device. See **### Printer supply collection — SNMP Printer-MIB + HTTP fallback**
- `site_data_status` — per-site FTP freshness snapshot (migration 056): the two export-file header timestamps, parsed lease/ARP counts, `fetched_at`, `last_error`, and `file_changed_at` (real-UTC, moved only when the newest file timestamp increases). Drives the data-freshness alert + `GET /devices/site-status`. See **### MikroTik FTP file source + per-site data-freshness alert**
- `data_freshness_alert_state` — per-site debounce/throttle state for the data-freshness / availability email agenda (migration 057); mirrors `printer_alert_state`.
- `crash_dumps` — collected kernel minidumps + analysis (migration 061): `computer_id`, `computer_name`, `source_filename` (e.g. `062226-13765-01.dmp`), `occurred_at` (dump mtime ≈ crash time), `size_bytes`, `status` (`pending`/`analyzed`/`failed`), parsed `stop_code` / `bugcheck_name` / `hot_function` / `culprit_process` / `culprit_module`, `analyze_text` (full cdb output), `analyze_error`, `dmp_blob` (VARBINARY(MAX) — the raw minidump), `ingested_at`, `analyzed_at`; UNIQUE `(computer_id, source_filename)` is the dedup key, `status` is the work queue between collector and analyzer. See **### Crash-dump collection & analysis**
- `link_speed_results` — per-target link-speed measurements (migration 071, `latency_ms` added 073, `cycles` added 074, `ip_address` + `host_name` added 075, `nic_mbps` / `nic_name` / `robo_up_mbps` / `robo_down_mbps` added 076, `run_id` added 077): `target`, `ip_address`, `host_name`, `up_mbps`, `down_mbps`, `up_ms`, `down_ms`, `latency_ms`, `nic_mbps`, `nic_name`, `robo_up_mbps`, `robo_down_mbps`, `size_mb`, `cycles`, `run_id`, `error`, `measured_at`. Populated by the link-speed service (best up/down over N cycles), consumed by `GET /system/linkspeed/history` + `/summary`. See **### Link-speed measurement**
- `settings` — key-value, edited via Settings tab
- `collector_runs` — eventlog collector run audit
- `ad_sync_runs` — AD sync audit
- `scripts`, `script_runs` — catalog + history
- `credentials` — DPAPI-encrypted blobs
- `schema_migrations` — migration tracking

## Configuration & portability

All environment-specific configuration is fully externalized — the source tree carries **no IPs, hostnames, or domain names**. To stand the project up in a different environment you change config only, never code:

- **`apps/server/.env`** is the single place for runtime config (SQL host/instance/database, AD/LDAP settings, edit-group DN, retention overrides, etc.). The committed **`.env.example`** is the template and the single source of truth for what knobs exist — copy it to `.env` and fill in access/values. **`MIKROTIK_SECRET`** is the AES key material for reversibly encrypting the MikroTik router password in `settings` (see **### Secret encryption for settings**) — it lives **on the application host only**, since DHCP collection runs **in-process there** (see **### MikroTik collection deployment model**). It is the **only** MikroTik-related env value: enable / interval / routers / user / encrypted password all live in the DB `settings` (migration 043), not in `MIKROTIK_*` env vars.
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

### Eventlog collector resilience to provider-template errors

`Get-WinEvent` raises a `"%1 could not be found"` formatting error when an event references a provider whose message template is missing on the collecting host. Under `-ErrorAction Stop` that single bad event **aborted the whole PC batch**, so a run could collect **zero** events from ~16 PCs. The collector now:
- runs `Get-WinEvent` with `-ErrorAction SilentlyContinue -ErrorVariable` (a per-event template failure no longer terminates the pipeline),
- wraps the per-event `.Message` render in try/catch with a raw `$_.Properties` fallback, so an unformattable event still yields a usable row, and
- treats an **empty result as a failure only when `$gwErr` holds a real connection/access error** — "no events" and the `%1` template noise are not failures.

Effect: collector failures dropped from 20 → 1.

### Reachability probe — per-PC state-change logging + manual run

The reachability probe (see **### Live network reachability probe drives the Status column**) logs each PC that **flips** `reachable` with its name + IP (commit `03a9ad5`): warn on down, success on up. The first-ever observation is silent (no flip to report), and the run-summary line is emitted only when the reachable count actually changes — so a steady fleet produces no log churn. A manual run endpoint `POST /reachability/run` (commit `392bd6d`) is wired to a Settings **"Run now"** button so the operator can force an immediate probe outside the standalone timer.

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

> **UI surface removed (this session).** The PcActions launcher / remote-management UI (MMC / RDP / PsExec / PS Remote / admin shares / copy / installer banner) has been **removed** from the client — only single-PC refresh remains in the Computers tab. The `/actions/*` server routes and the install-handler scripts described below are **retained server-side but unused from the UI**; the rest of this section documents that retained (now dormant) mechanism.

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

**Transport.** nodemailer to an internal SMTP relay (`alerts.smtp_host`/`alerts.smtp_port`, default port 25), opportunistic TLS with cert validation disabled (internal self-signed relays), no client auth assumed. Sender is `alerts.smtp_from`, recipients default to `alerts.recipients` (comma/newline list). As of 2026-06-12 each agenda may override recipients via its own key with fallback to this shared list — see **### Per-agenda email recipients with shared fallback**.

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

Built as a direct mirror of disk alerting (2026-06-11), for the small set of servers where a stopped service is an incident, not a footnote. The operator ticks key servers in the Computers tab; a status chip + a "service monitored" filter list which PCs are opted in. Opt-in is stored per-PC in `computers.service_email_monitor`. (As of 2026-06-12 / migration 040 this is the **critical** level of a two-level model — a broad "every Auto service not Running" level was added alongside it; see **### Two-level service monitoring with per-PC exceptions**.) Same rationale as disk alerts: alerting on every monitored PC would be noise, so the model is "a handful of PCs that matter get email, everything else stays on the dashboard". It shares the transport, sender, recipients and dashboard URL with disk alerts (see **Disk email alerting** above) — only the evaluation logic and flapping guard are new.

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

### Ports availability subsystem (migration 041)

A read-only **ports-availability grid** that shows, per PC, the **current** open/closed state and TCP connect latency of each configured port. This is the *observability* counterpart to the phase-2 port **alerting** above: the alert path (`port_check_state`) is a baseline-learning state machine that decides when to email; this subsystem (`port_status`) is just "what is the latest verdict for every port on every box", surfaced as a grid the operator can scan.

**Storage.** Table `port_status` holds the latest verdict only — `(computer_id, check_name)` PK, columns `port`, `is_open`, `latency_ms`, `checked_at`. One row per (PC, configured check); each probe overwrites it. Kept deliberately distinct from `port_check_state` so the grid snapshot and the alert state machine never interfere.

**Service.** `apps/server/src/services/port-status-collector.ts` runs on its **own standalone scheduler** (gated by `checks.run_port_status`, interval `port_status.interval_sec`, default 300 s), the same independent-timer pattern as the reachability probe — *not* a member of the checks-runner array. It **reuses the configured port list + timeout** from the alert config (`alerts.services.port_checks` / `alerts.services.port_timeout_ms`) so the grid and the alerts probe the same ports. For every enabled, non-excluded PC it TCP-connects each port and measures connect latency; it **skips PCs with `computers.reachable = 0`** (a powered-off box isn't re-probed per-port). It **prunes `port_status` rows whose `check_name` is no longer configured**, so the grid follows Settings — removing a port from the list removes its column rather than leaving stale rows.

**Exports.** `runPortStatusProbeOnce` (full-fleet probe), `probeOnePcPorts` (single-PC, reused by refresh-single-pc), `probeComputerNow` (ICMP ping + ports, returns a cmd-like console transcript via `cmd /c chcp 65001 & ping -n 4 …` for the per-PC live console), and `configuredCheckNames` (the active check-name set used by the grid filter).

**Routes.** `GET /port-status` joins `computers` (OUTER APPLY-style best match) and filters to the configured check names; `POST /port-status/run` triggers a manual probe; `POST /computers/:id/probe` runs the live ping + ports console for one PC.

**Single-PC refresh integration.** `refresh-single-pc.ts` gained a **5th step** that calls `probeOnePcPorts`, so a manual "Aktualizovat teď" also refreshes that machine's port-status row alongside the other collectors.

### MikroTik DHCP device inventory (migration 042)

Discovers the **non-AD** devices on the network — printers, phones, IoT — by reading the bound DHCP leases off the MikroTik routers, and builds the authoritative **IP ↔ MAC ↔ hostname** map. AD computers are already richly tracked (and have reachability), so the value here is precisely the devices that *aren't* in AD.

**Storage.** Two tables (migration 042):
- `dhcp_leases` — PK `(site, mac_address)`; the lease itself (`ip`, `host_name`, `server`, `comment`, `status`, `dynamic`, `expires_after`), `first_seen` / `last_seen` lifecycle, and reachability columns (`reachable`, `last_reachable_at`, `reach_checked_at`) for the unmatched devices the collector pings itself.
- `device_categories` — PK `mac_address`; the operator-assigned category, keyed by MAC so it persists across sites and router reloads regardless of the lease's churn.

**Service.** `apps/server/src/services/mikrotik-collector.ts` pulls bound leases from each configured **RouterOS v7** router via the **REST API** (`GET /rest/ip/dhcp-server/lease`, HTTP Basic auth) and upserts each lease per `(site, mac)`. It then **pairs each lease to an AD computer** by `host_name` (falling back to IP), and **pings ONLY the unmatched devices** — matched ones already have reachability from the reachability collector, so re-pinging them would be redundant. `suggestCategory(hostname, mac)` is a UI hint only: a printer-vendor OUI map (Zebra / Canon / Kyocera) plus hostname keywords (HP / Epson / etc., phones). `probeDeviceNow` backs the per-row live-ping console.

**Routes.** `GET /devices` LEFT JOINs `device_categories` and OUTER APPLY-best-matches a computer by `host_name` then IP, adding a computed `suggested` category; `PATCH /devices/category` upserts or clears a category by MAC; `POST /devices/run` triggers a manual DHCP pull; `POST /devices/probe` runs the per-row live ping console.

**Pairing rationale.** Matched devices already have rich data + reachability — "a lot is already handled" by the existing collectors. The inventory's payoff is twofold: discovering the **non-AD** devices (printers / phones / IoT) that nothing else sees, and the authoritative **IP ↔ MAC ↔ hostname** mapping that the lease table provides.

### Multi-source device discovery (migration 044)

The DHCP lease table alone misses devices that never take a DHCP lease (static IPs, ARP-only appliances), so the inventory now **merges three discovery sources, keyed by MAC**:
- **DHCP leases** — kept when `status='bound'` **OR** the lease is a static reservation (`dynamic=false`), so a statically-reserved device stays in the inventory **even while offline** rather than ageing out with its dynamic lease.
- **Router ARP table** — `GET /rest/ip/arp` off each configured router, so anything the router has resolved an L2 address for shows up regardless of how it got its IP.
- **Active subnet scan** from the application server — a ping-sweep of the configured ranges.

`dhcp_leases` gained a **`source` column** (`dhcp` / `arp` / `scan`) recording how each row was discovered.

**Active scan ranges (`mikrotik.scan_ranges`).** Configured one range per line, either CIDR (`10.8.2.0/24`) or a wildcard (`10.8.2.*`), with an optional `Site=` tag. A leading **`!`** or **`<>`** marks an **exclude** that drops a whole subnet from the inventory — including its DHCP rows — so an operator can carve out a noisy or out-of-scope network entirely.

**How MACs are resolved during a scan.** The scan ping-sweeps the range from the application host, then reads MACs from **two** ARP sources: the **app host's LOCAL ARP cache** (`arp -a`) for the app server's own subnet, and **each router's ARP** for remote subnets — the last-hop router populates its ARP for the target the moment the app server pings it, so a remote device resolves without an agent on that segment.

**Discover-once, cache-forever (MAC is the key).** The scan only pings **UNKNOWN IPs** — a stored IP↔MAC pairing is cached and **never re-discovered**, so steady fleets cost almost nothing. Because **MAC is the key**, a static device that reappears at a **new IP** **moves its existing row** to the new IP and **releases the old IP back into the scan pool** rather than leaving a duplicate. A separate **light up/down re-ping** keeps the reachability of already-known static devices fresh without re-running discovery.

### NetBIOS name resolution

Scanned / ARP-discovered devices arrive with **no host name** (ARP yields only IP↔MAC), so the collector resolves a name via **`nbtstat -A <ip>`** — a peer-to-peer NetBIOS node-status query that works where the application host **cannot do a DNS PTR** lookup. The resolved name then feeds `suggestCategory`, which can now spot **printers** by NetBIOS prefix: **NPI / BRN / BRW / RNP / KMBT** are recognized as printer names.

Operators can also **manually edit a device's name**, stored per-MAC in `device_categories` (**migration 046**). The `category` column was made **nullable** by that migration so a **name-only row** (a custom name with no category) is valid.

### MikroTik FTP file source + per-site data-freshness alert (migrations 056–057)

The REST pull is live but fragile (it depends on the router's API being reachable at the exact moment of a collect) and it cannot dump the active **ip-scan** to a file. So the inventory gained a second, **file-based** transport that is the **primary** lease/ARP source, with REST kept as a **supplement** (for ip-scan NETBIOS names) until explicitly retired.

**Router side.** A RouterOS scheduler (`ipscan-export`, every 15 min) writes two text files, deleting the old one first: `IP_scan.txt` = `/ip dhcp-server lease print detail file=IP_scan` and `ARP_scan.txt` = `/ip arp print detail file=ARP_scan`. The read-only `dhcp-reader` account is granted the **`ftp` policy** on its group (the FTP service itself was already up — WinBox file download uses it).

**Service (`mikrotik-ftp.ts`).** A **dependency-free** FTP client (minimal passive-mode `RETR` over `node:net` — no lockfile/CI churn) pulls both files each collect for the sites in `mikrotik.ftp_sites`. Two parsers turn the `print detail` output into rows: the **lease** parser reads host-name / class-id / status, the **ARP** parser keeps only **`complete`** (`C`-flag) entries carrying a MAC and **drops `failed`/incomplete probes**. Both **join the ~72-char wrapped continuation lines** the router emits, or fields like `status`/`vrf` on the second line are lost. Parsed rows merge into the **same per-cycle `byMac` map** as the REST sources — filling a still-missing name and adding net-new statics (e.g. a hand-set IP seen only in ARP, never in DHCP). Because everything keys on `(site, mac)` (in-memory merge + the `dhcp_leases` PK + the COALESCE upsert), **no source can create a duplicate**.

**Freshness signal (migration 056, table `site_data_status`).** Per site it records the two file header timestamps, parsed counts, `fetched_at`, `last_error`, and — crucially — **`file_changed_at`**: a **real-UTC** stamp moved **only when the newest file timestamp actually increases** (`recordSiteStatus` compares a `last_file_sig`). This is the key to being **timezone-safe**: the router prints its *local* wall-clock into the file, so comparing that to UTC `now` would read hours into the future; instead the alert measures how long since `file_changed_at` last *moved*, which is frame-independent. `GET /devices/site-status` exposes the table.

**Availability alert (migration 057, `alerts.freshness.*`).** Mirrors the printer agenda (debounce / throttle / maintenance window / per-agenda recipients; state in `data_freshness_alert_state`). A **monitored** site (listed in `mikrotik.ftp_sites`, **not** in `alerts.freshness.muted_sites`) is **stale** when its files stop advancing past `threshold_minutes` (default 45), can't be fetched (`last_error`), or never produced data. Evaluated at the end of each MikroTik collect. **Branches are muted by default** so they don't scream while only Brno produces the files; un-muting a branch = give its router the `ftp` policy + export script + scheduler, add it to `mikrotik.ftp_sites`, and remove it from `muted_sites`. `POST /alerts/freshness/test` sends the current state on demand. Settings section: **"Notifikace — aktuálnost dat / dostupnost lokalit"**.

### Routers page + per-router communication view

A dedicated **"Routery / Routers"** page (`NetworkPage.tsx`) makes the otherwise invisible
**router → FTP → DB → page** round-trip explicit, one card per configured router so it scales to
any count. `GET /network/routers` joins the configured `mikrotik.routers` with `site_data_status`
(FTP freshness) and per-site `dhcp_leases` counts, returning per router: ftp/muted flags, the file
timestamps, minutes since `file_changed_at`, parsed lease/ARP counts, last error, device count by
source. **`POST /network/ftp-fetch`** (`runFtpFetchOnce`) forces an FTP pull of the FTP sites NOW,
**merges the parsed rows into `dhcp_leases`** (so the inventory updates immediately, not only on the
next collect), records `site_data_status`, and returns a per-site **communication log** — surfaced in
a collapsible terminal console, so a branch whose router has no `ftp` policy / export shows its real
`530 Login incorrect` instead of a blank "stale" card. Under the cards, **`GET /network/db-rows`** is a
read-only listing straight from `dhcp_leases` (newest write first, optional `?site`) — the page renders
it with a full-text filter across all columns, click-to-sort headers (IP numeric, last_seen by date),
client-side pagination, and CSV export (semicolon + BOM). A **📡 Routers homepage tile** counts stale
monitored routers (REST-only don't count) and links here; it and the other device-inventory tiles are
fetched on the dashboard's 30s refresh (previously once-only, which let them go stale until a reload).

### Data authority model (router → AD → operator)

Conflict-resolution hierarchy, **per-field**: **Router / DHCP = 1st authority** for what it assigns and
observes on the live wire — IP address, MAC, network presence, online/offline (a router IP beats a stale
AD/DNS one). **AD = 2nd authority** for what the router can't know — name, OS, type (pc/server), account
state. **Operator comment / manual edit = override** on top (name/category/note keyed by MAC, never
overwritten by a collector). Today the device inventory already follows this (it IS the router data, and
manual edits win); surfacing a **router-authoritative IP + a "router ≠ AD/DNS" mismatch flag on the
Computers tab** is the open item.

### New-PC defaults on AD sync (migration 058)

When ad-sync discovers a **new** computer it seeds a set of per-row flags from Settings (`adsync.default_*`):
monitor (default on), disk-email monitoring, broad service monitoring, critical-service monitoring, and
excluded (the rest default off). These apply **only on the INSERT branch** of the `MERGE computers` — an
existing PC keeps the operator's per-row intent across syncs. The "AD sync default" Settings section
exposes each as a checkbox.

### Device history (searchable) + retention policy (migrations 059–060)

The live inventory (`dhcp_leases`) stays **unique / current** (one row per device, upserted) — that's the right pattern; making it append-only would force every read to find "latest" and dedupe. **History lives in dedicated append tables**: `device_ip_history` keeps one `(mac, ip)` row per address a device was ever seen at, with a `first_seen → last_seen` window, fed by every observation (incl. router data). Migration 059 added `host_name` + IP/host indexes, so `GET /devices/history?q=` can match **IP / MAC / hostname** and answer "what was on IP X and for how long" / "where has machine Y been" — surfaced as a search panel on the Routers page. (It's a deduplicated archive, not a per-poll event log or per-session gap tracker — "how long" = first→last span.)

**System-wide retention.** Every table that grows has a purge; snapshot tables (`port_status`, `service_problems`, `critical_service_status`, `site_data_status`) are overwritten in place and don't grow. The daily `retention-runner` (at `retention.run_at_hour`, default 02:00) purges `events` (`events.retention_days` 90), `activity_log` (30), `pc_user_history` (90), and — after a retention audit closed two unbounded gaps — `perf_events` (`perf.retention_days` 180) and `ad_sync_runs` (`adsync.runs_retention_days` 90), plus the event de-dup. The collector prunes `dhcp_leases` ghosts (`devices.lease_retention_days` 14), `device_ip_history` (`devices.history_retention_days` 365) and `device_ping_samples` (`devices.loss_window_hours` 24h). Settings exposes them all in one **"🗂 Retenční politika" overview table** (`#sec-retention`) with a reusable deep-link from the data sections.

### Per-device packet loss + latency (migrations 045, 047)

The reachability ping for a device is `ping ×N` and the result is **parsed locale-independently** — it does **not** rely on localized summary text. Loss % is computed by **counting `TTL=` reply lines** (vs the number of requests), and latency by **averaging the per-reply `[<=]NNms`** figures. Both are stored in `dhcp_leases.packet_loss` / `latency_ms`, **only while the device is online** (offline → `NULL`).

**Important nuance — gateway ICMP errors are not partial loss.** `"Destination host unreachable"` and `"Request timed out"` lines carry **no `TTL=`**, so a host whose only responses are gateway-sourced ICMP errors is correctly classified **offline** rather than miscounted as a partially-reachable host with high loss.

**Operator-tunable "problem" thresholds.** `devices.problem_loss_pct` and `devices.problem_latency_ms` define when a device counts as having a problem. A Dashboard **"Loss / latency"** tile and an **"issues only"** filter on the Devices tab both key off these thresholds.

### Configurable device categories

Device categories are now **operator-defined in Settings** rather than a fixed list: `devices.categories` holds one `key=Label` per line. The per-MAC `device_categories.category` validation was correspondingly **relaxed to accept any string ≤ 32 chars** (was a fixed enum). The generic **`printer`** key is special — it drives the printer features (the printer tile, printer-offline alerts, and the printer auto-suggest from NetBIOS prefixes / OUI).

### Printer-offline email alert agenda (migration 043)

A printer-offline email agenda mirrors the existing service-alert model. `alerts.printers.*` settings (enable / debounce / throttle / recipients-override) plus a new **`printer_alert_state`** table (per-MAC debounce + throttle state, the same shape as `service_alert_state`) drive it. Evaluation runs **at the end of each collect cycle**: a printer-category device that goes offline debounces, alerts, and throttles exactly like the service alerts, and recovery clears its state row. It reuses the shared transport / sender / dashboard-URL and the per-agenda-recipient fallback (see **### Per-agenda email recipients with shared fallback**).

### Device web-UI proxy (cert bypass)

Printers (and similar appliances) frequently force **HTTPS with a self-signed certificate**, so a plain browser link to the device lands on an un-skippable certificate warning. A **server-side proxy** `GET /devices/web/:ip[/*]` (Settings `devices.web_proxy`, **on by default** — migration 049) fetches the device **ignoring TLS validation** and serves it from the **trusted dashboard origin**, so the operator opens the device UI without a cert warning. It is **scoped to IP targets** (limits the SSRF surface; the dashboard is itself access-gated). Making a printer's own JS-heavy embedded web server (EWS) actually render through a reverse proxy took several layered fixes — it now **buffers and returns the upstream body** (an earlier async `reply.send` resolved the handler with `undefined`, so Fastify sent an empty 200 first), injects a **`<base>` at the directory of the *current* document** (not the proxy root — else a relative `SCRIPT.JS` on `…/COMMON/TOP` resolves to the root and 404s), **rewrites root-absolute `href`/`src`/`action="/…"` URLs** through the proxy (a `<base>` only fixes relative URLs; HP's `/hp/device/jquery.js` would otherwise hit the dashboard root), sets a **permissive CSP and drops `X-Content-Type-Options: nosniff`** for proxied content (the dashboard's global Helmet `script-src 'self'` + nosniff blocked the printer's inline scripts), **corrects `Content-Type` from the path extension** (printers ship `.js` as `text/js`/`text/plain`, which the browser refuses to execute), and **bounces upstream redirects back to the browser** as proxied paths (following them server-side left the document URL — and thus relative-link resolution — wrong). Verified live across **Epson** (EM-C7100, WF-C5790/C5890), **HP** (M401dne, M451dn, Color M552) and **Brother** (MFC-L8690CDW) EWS. Still best-effort for the most interactive JS that builds URLs at runtime.

### Printer supply collection — SNMP Printer-MIB + HTTP fallback (migration 048)

The **Printer status** tab / **🖨 Náplně** dashboard tile read per-printer **ink / toner / maintenance-box / drum / belt** levels straight from the printers. The design was settled by **probing the real fleet live before building any UI** (the project rule: verify the core first).

**Primary source — SNMP Printer-MIB.** `prtMarkerSupplies` is uniform across HP / Epson / Brother / Kyocera: per supply it walks **description** (`1.3.6.1.2.1.43.11.1.1.6`), **max capacity** (`.8`) and **level** (`.9`), and computes `percent = level / max` (the negative sentinels −1/−2/−3 → unknown). `sysDescr` (`1.3.6.1.2.1.1.1.0`) gives the model; HP descriptions also carry cartridge **part-numbers**, and lasers expose **drum/belt life**. SNMP is read with a **self-contained SNMP v1 client over `node:dgram`** (`services/snmp.ts`) — hand-rolled BER GET/GETNEXT, **no external dependency**, matching the rest of the app's zero-library device I/O; the BER encode/decode is pure and unit-tested.

**HTTP fallback — two live-found gaps** (`services/printer-supplies-http.ts`, cert-ignoring GET). **Brother** reports toner over SNMP only as `−3` ("some remaining", no number), so the numeric % is scraped from its web status page (`/general/status.html`, toner bar image height /50); SNMP still gives Brother drum/belt %. **Epson** omits the maintenance (waste) box over SNMP, so it is read from the Web Config product page (olive `#636311` gradient or `Ink_Waste.PNG` height). These parsers (plus the supply classification `classifyDescription` / `extractPartCode` / `computeLevelPct`) are pure and unit-tested.

**Collector + storage.** `services/printer-supplies-collector.ts` resolves its config from Settings, probes **only devices the operator categorized `printer`**, merges the SNMP rows with the per-vendor HTTP supplement, and **upserts/prunes** the `printer_supplies` table (MERGE by `(mac, supply_key)`; a supply that disappears from the device is pruned). It runs on its **own self-rescheduling timer** (the same idle-while-disabled pattern as the other standalone collectors) and never throws. Settings (seeded by migration 048): `printer_supplies.enabled` (default ON), `.interval_sec` (900), `.snmp_community` (`public`), `.low_pct` (15), `.http_fallback` (ON) — DB-tunable; a Settings UI panel for them is an open follow-up. Routes: `GET /printer-supplies` (grouped per printer, joined to `dhcp_leases`/`device_categories`, returns the `lowPct` threshold), `POST /printer-supplies/run` (manual). The page is a card per printer (colour supply bars + %, badge OK / Dochází / Prázdná, part-codes, drum/belt); the whole card opens the printer EWS via the cert-bypass proxy and a bottom-row link opens the raw `http://IP`; the tile drills in pre-filtered to problems; a light supply flag (● NN%) shows on confirmed-printer rows in the Devices tab.

This stays on the right side of **Observer, not executor** — it reads and shows supply levels, it does not act on the printer.

### Crash-dump collection & analysis (migration 061)

Turns "PC crashed" into "PC crashed because X" across the fleet, agentless, from data
the service already has access to. **Off by default** (`crash.enabled='0'`).

**Pipeline (two decoupled timers + a worker queue):**
1. **Collector** (`crash-dump-collector.ts`) — lists `\\PC\C$\Windows\Minidump\*.dmp` on
   monitored, reachable PCs (a TCP/445 pre-flight fails fast on unreachable boxes). It reads
   each NEW minidump (dedup by `(computer_id, source_filename)`) straight into a buffer and
   INSERTs it into `crash_dumps` as a `VARBINARY(MAX)` blob with `status='pending'`. It only
   touches the small `Minidump\*.dmp` files — never `C:\Windows\MEMORY.DMP` — caps absurd sizes
   (>64 MB) out, and **leaves the on-client file** for Windows to clean (the DB is the durable
   store; dedup stops re-ingest on the next cycle).
2. **Analyzer worker** (`crash-analyzer-worker.ts`) — a SEPARATE timer so a slow cdb never
   stalls collection. Takes `pending` rows, **materializes the blob to a temp file** under the
   OS temp dir, runs cdb, parses, UPDATEs the row (`analyzed`/`failed`), and **deletes the temp**.
   The `crash_dumps.status` column is the queue between the two.
3. **cdb wrapper + parser** (`crash-analyze.ts`).

**cdb invocation — DON'T use `!analyze`.** The newest cdb (10.0.28000, installed via the Win11
SDK Debugging Tools) has a **broken headless `!analyze`** (the Extensions-Gallery analyze runs
async and emits nothing through `-c` / stdin / `-logo`). The sync commands work and are enough:
```
cdb -z <dump> -y "srv*C:\symbols*https://msdl.microsoft.com/download/symbols" \
    -c ".bugcheck; kc 100; lm 1m; !dpcwatchdog; .thread; !thread; !process -1 0; q"
```
The parser extracts: **STOP code** (`Bugcheck code …`), **bug-check name** (lookup table),
**hot function** (`!dpcwatchdog` "functions that exist often" — the long-running DPC),
**offending process** (`!thread`/`!process` → `Image: …`), and the first non-nt/hal module in
the stack. Proven live on a real 0x133 (DPC_WATCHDOG_VIOLATION): process `msedgewebview2.exe`
closing a large memory section → `nt!MiDeleteSubsectionPages` 97/97 → no third-party driver.

**Routes** (`routes/crashes.ts`): `GET /crashes` (list, no blob), `GET /crashes/:id` (detail
incl. `analyze_text`), `GET /crashes/:id/dmp` (download the raw `.dmp`), `POST /crashes/run`
(on-demand collect+analyze — NOT gated by `crash.enabled`, for manual testing), and **`GET /crashes/status`**
— the collector's own `getCrashCollectStatus()` (`lastRunAt` / `nextRunAt` computed by the scheduler from the
live `crash.interval_sec` / `lastResult`) joined with the last SQL writes (`MAX(crash_dumps.ingested_at)`,
`MAX(analyzed_at)`), plus `enabled` / `intervalSec` / `pending`. The CrashesPage renders this as a status
strip so the operator can see "is collection actually running, and when next".

**Report is light-by-default + dump-derived explanation.** The printable "Analýza pádu / Crash analysis"
report is now **light-themed by default with a light/dark toggle** and writes with a **UTF-8 BOM** on save
(same diacritics fix as **### Export encoding — UTF-8 BOM on all text formats**). The report/detail
explanation is generated from the parsed dump by **`buildExplanation`**, which distinguishes an **nt-kernel**
fault from a **third-party-driver** fault and applies **special handling for corruption-class bugchecks**
(`0x13A` / `0x19` / `0xC2` / `0x139` / `0x1A`).

**Settings** (seeded by migration 061): `crash.enabled` (0), `crash.interval_sec` (3600),
`crash.analyzer_interval_sec` (300), `crash.cdb_path`, `crash.symbol_path`,
`crash.blob_retention_days` (180).

**Rebuild prerequisites:** (a) **Debugging Tools for Windows** (`cdb.exe`) on the app server —
no winget on the server, so install via the Win11 SDK:
`winsdksetup.exe /features OptionId.WindowsDesktopDebuggers /quiet /norestart`; (b) the service
account (`svc-itdashboard`) must be able to read client `C$` — it already is via the **Server
Admins** AD group (member of clients' local Administrators). The app server reaches `msdl.microsoft.com:443`
for symbols. UI = `CrashesPage.tsx` (Pády tab: aggregations + table + detail + white printable
"Analýza pádu" report via the Manager-Summary serialiser) + a 💥 dashboard tile + a Settings
section. **Verify-core** (transport, blob write+readback, analysis, full attribution) was done
live end-to-end before building.

### Communication-channels health (`GET /system/comms`) (2026-06-30)

A single **"is all communication working"** view that the dashboard can read at a glance, instead of the operator inferring it from six scattered tiles. `routes/system.ts` (`registerSystemRoutes`, wired in `index.ts`) exposes **`GET /system/comms`**, which aggregates **six channels** into one **`overall` = `ok` / `degraded` / `down`** plus an `okCount` / `total` and a per-channel breakdown:

- **`database`** — a **live `SELECT 1`** with measured latency. If the DB itself is down the route short-circuits to `overall='down'` (nothing else can be read without it).
- **`mikrotik_rest`** — the MikroTik REST API.
- **`ftp`** — per-site FTP **freshness** read from the `site_data_status` table (the strongest signal; reuses the `alerts.freshness.threshold_minutes` staleness line); a missing/stale/errored site degrades it.
- **`collector`** — the EventLog DCOM collector (last `collector_runs` success ratio).
- **`email`** — SMTP / M365; alert **sends are logged in `activity_log` under source `'alerts'`** (sent=warn, fail=error), so the channel reads its health from there.
- **`unifi`** — the UniFi controller.

**Health is derived from data that already exists — no new probing** (apart from the one `SELECT 1`). For `mikrotik` / `unifi` / `collector` / `email` the channel takes the **latest `activity_log` row per source** and is **OK unless that last row's `level='error'`** (per-PC offline `warn`s don't flip a channel); for `ftp` it is `site_data_status` freshness. **Unconfigured channels are excluded** from the verdict (a channel with its feature toggle off reports `enabled:false` and doesn't count toward `degraded`). Frontend: a **"Komunikace / Comms"** tile in `SummaryCards` plus a collapsible **`CommsHealth.tsx`** panel; `api.comms()` is fetched on mount and on the **30 s dashboard refresh loop**.

### Live WAN-link monitor (migrations 062–064, 2026-06-30)

Answers "is the link to each branch — and to the internet — up right now, and how fast", from the app server, with **no agent and no history table**. `services/wan-monitor.ts` runs on its **own self-rescheduling timer** (`startWanMonitorSchedule` in `index.ts`, the same DB-driven enable/interval pattern as the crash collector). Every **`wan.interval_sec`** (default 60) it pings, from the application host via Windows **`ping.exe`**:

- **each branch router IP** (parsed out of `mikrotik.routers`), and
- **one internet target** (`wan.internet_target`, default `1.1.1.1`).

RTT + packet loss are parsed **locale-independently** from the `TTL=` / `[<=]NNms` lines (same technique as the device-loss parser), giving an **avg RTT + loss %** per probe. The monitor keeps **only the CURRENT snapshot in memory — there is deliberately no DB table and no time-series**; the dashboard reads the live snapshot. **`GET /system/wan`** (in `system.ts`) returns `branches`, the `internet` probe, the `latency_warn_ms` / `loss_warn_pct` colour thresholds, `nextRunAt`, and the optional `speed`. Frontend **`WanHealth.tsx`** is an always-visible dashboard strip with one chip per site.

**Optional central download speed test (off by default).** When `wan.speedtest_enabled` is on, the monitor runs a download speed test on its **own slower** `wan.speedtest_interval_sec` cadence (default 1800 s): it downloads `wan.speedtest_url` (default Cloudflare `__down`, 25 MB) over **`wan.speedtest_streams` PARALLEL fetch streams** (default 6), **timed from the first byte**, and carries the resulting **Mbps in the snapshot**. Parallel streams + first-byte timing exist because a single TCP stream and a cold-start clock both **underestimate** a fast link (the fix that landed in `e0db733`).

**Settings & migrations.** A new **WAN** Settings section exposes the knobs. Migration **062** seeds the WAN-monitor settings (`wan.enabled`, `wan.interval_sec`, `wan.internet_target`, `wan.ping_count`, `wan.latency_warn_ms`, `wan.loss_warn_pct`), **063** seeds the speed-test settings (`wan.speedtest_enabled` off, `wan.speedtest_url`, `wan.speedtest_interval_sec`), and **064** adds `wan.speedtest_streams` (6) and bumps the default sample to 25 MB **only for installs still on the original 10 MB URL** (never clobbering an operator's custom URL).

**Rejected approach — per-branch speed via the router.** Measuring per-branch download speed with MikroTik `/tool/fetch` was evaluated and **not built**: the router is CPU/TLS-bound and tops out around **~3.9 Mbps**, so it measures the router, not the link. The central app-server speed test was built instead; per-branch throughput is intentionally out of scope.

### Per-branch service-port matrix + service discovery (PARKED) (migrations 065–070, 2026-06-30)

Built to answer "does every branch reach the services it needs — chiefly **do branches print to the HQ printer segment?**" as a per-branch × per-category port matrix, then **PARKED** the same day because the central vantage point can't measure what the question actually asks. The **code and endpoints stay**; the nav tab is hidden and `svcports.enabled=0` (migration 070) so the scheduler **idles**.

**Service-port matrix (`services/service-port-matrix.ts`).** Started by `startServicePortsSchedule()` in `index.ts` (DB-driven enable/interval, the same self-rescheduling pattern as the other collectors). For each `svcports.checks` entry (`Label:port:category`, default printers `9100`/`515`/`631`) it TCP-probes that port — reusing **`tcpProbeTimed()`, now EXPORTED from `port-status-collector.ts`** — on every device of that category at each site (`mikrotik.routers`), **from `.213` over the WAN**. **In-memory snapshot only** (no table). Each cell counts **open / online**, with **offline counted separately**. It is **OUI-aware**: `svcports.voip_ouis` promotes Yealink / VoIP-OUI devices to an effective category `'voip'`. `GET /system/service-ports` returns the matrix; the frontend `ServicePortsMatrix.tsx` renders it, and a **cell click lists the actual devices** (open / closed / offline).

**Service discovery (`services/service-discovery.ts`).** A **user-triggered** `POST /system/service-discovery` scans a **broad TCP port set** (1–1024 + common highs, or full 1–65535) on a **sample of reachable devices per category** to learn the real open-port profile (VoIP split out by OUI). **Read-only.**

**Migrations 065–070** are **all settings seeds, no new tables**: **065** `service_port_matrix`, **066** drops the phone default, **067** `service_discovery` + `svcports.voip_ouis`, **068** voip web check, **069** drops the voip check, **070** **PARK** (`svcports.enabled=0`).

**Why parked — central-vantage limit (a rejected-vantage decision, mirrors the WAN speed test).** The matrix probes **from the central `.213`**, so it measures **central → device** reachability, **not branch → device**. The real question ("do branches print to HQ / the printer segment?") requires measuring **from the branch router** (MikroTik `netwatch type=tcp` / REST ping), not from `.213` — the **same central-vantage limit** as the WAN speed test. Cross-site rows (HQ IPs appearing under a branch) are **expected** (branches route into HQ for printing). The org is **mid SD-WAN redesign** separating the printer network; **revive after the segment exists, measured from the branch routers**. Caveat: the `dhcp-reader` API user is **read-only** (`netwatch`/`test` needs a higher router policy).

**VoIP out of scope from `.213`.** The IP phones are **Yealink** (OUI `24:9A:D8`) on a **T-Mobile cloud PBX (BroadWorks)**; they are **not in `dhcp_leases`** (separate voice network) and **unreachable from `.213`**, so VoIP monitoring is out of scope from the central server.

### Link-speed measurement (migrations 071–077, 2026-07-01)

Answers "how fast is the link to each PC/server, up and down, right now" by measuring the **real** end-to-end throughput over the existing **admin-share (C$) channel** — no agent, no router involvement. `services/link-speed.ts` runs on its **own self-rescheduling timer** (`startLinkSpeedSchedule` in `index.ts`, DB-driven and restart-safe like the WAN monitor).

**Rolling scheduler (not a one-shot sweep).** The scheduler is **continuous**: on every **tick** (`linkspeed.tick_min`, default 20 min) it measures just a **few of the stalest due PCs** (`linkspeed.batch_size`, default 6) — the ones whose last measurement is older than the refresh window. `linkspeed.interval_hours` (default 24) no longer means "run one big `all` sweep every X h"; it now means **"refresh each PC every X h"** (a per-PC freshness target, and it may be **< 1 h**). The load is therefore **spread out** — something is always being measured a little at a time instead of one hourly burst — and when every PC is fresh the scheduler simply **idles**. `pickDueTargets` picks the stalest-N due targets; **freshness is read from the DB** (`MAX(measured_at)` over `COALESCE(ip_address, target)`), so it is **robust across service restarts** — the older boot-reset of `lastSchedRunMs` on every deploy used to keep the sweep from ever firing. Run conditions: `linkspeed.enabled` + targets configured + inside the hour window.

**Three measurement methods (independently toggleable).** Each target can be measured by up to three methods, each gated by its own setting (`linkspeed.method.smb` / `.robocopy` / `.nic`):

- **SMB single-stream (the verdict method).** For each target the service caches an **N-MB random source file on `.213`** (`ensureSource`, sized by `linkspeed.size_mb`), then per cycle **pipelines it up to `\\PC\C$\tmp\itdash-speedtest\<filename>`** (`linkspeed.filename`) and **back down** as a single stream, timing each direction independently, and keeps the **BEST up/down over `linkspeed.cycles` cycles** (the fastest cycle is the link's real ceiling, filtering out transient contention). This is the throughput number the summary classifies (ok/slow/…). When done the **whole client `itdash-speedtest` dir is removed**.
- **Robocopy `/MT` multi-file (informational only).** `ensureChunkSource` builds a directory of many chunk files on `.213`; `roboMeasure` runs `robocopy /MT` (multi-threaded, many parallel files) up and down and reports `robo_up_mbps` / `robo_down_mbps`. **CAVEAT — the read-back is cache-inflated:** the files were just written to the client and come back out of the SMB/OS cache, so the down figure overstates the link. It is therefore surfaced as **informational only**, never as the verdict.
- **NIC link speed (`readNicSpeed`).** Reads the negotiated adapter link rate over **DCOM `CimSession`** (same DCOM stack as the other collectors): it maps the target IP to the adapter via `Win32_NetworkAdapterConfiguration` (IP→interface index) and reads that `Win32_NetworkAdapter`'s reported speed → `nic_mbps` / `nic_name`. A **wireless or non-standard rate is labelled as wifi**. This is the link *capacity* (what the NIC negotiated), independent of the throughput a copy actually achieves.

It also pings the target for **RTT (latency)**. Reuses **`tcpProbeTimed`** (TCP/445 precheck) and Windows **`ping.exe`**.

**Run fingerprint (`run_id`, migration 077).** Every result carries a `run_id` = the **start time of its batch**, so all rows from one "run all" share an id and can be grouped/compared as one pass. A **batch generates** the id; a **single-target test writes `run_id = null`** (it is not part of a batch).

**Reachability gate (method-aware).** SMB and robocopy need **TCP/445** (a share); NIC-only needs just a **ping**. So a host that **blocks 445 but is alive** still yields a NIC reading — the NIC speed is read for 445-blocked-but-reachable hosts, while SMB/robocopy are skipped for them. A wholly unreachable box is recorded as such rather than blocking on a share timeout.

**Non-destructive reset + summary dedup.** "Reset" does **not** delete rows — it stamps a baseline setting `linkspeed.baseline_at`. The **summary endpoint filters** results to those newer than the baseline and **dedups by identity** (LEFT JOIN `computers` so multiple IPs/names for one machine collapse to one), giving a clean latest-per-target view without destroying history.

**Pause between targets.** `linkspeed.pause_ms` inserts a delay between consecutive targets in a batch (throttle so a big "run all" doesn't saturate the app server's own uplink).

**Targets.** `expandTargets()` (shared by the route and the scheduler) resolves the target spec. **`"all"`** expands to the **`computers` table (AD)** — the machines where `reachable=1` **OR** (`reachable IS NULL` **AND** `consecutive_failures < 10`) (i.e. live, or not-yet-probed-and-not-chronically-failing). Explicit exceptions go through **`parseTargets`** (IP / range / wildcard / hostname); `ignoreExclusions` optionally bypasses `linkspeed.exclude_hosts`.

**Storage.** Table `link_speed_results` (migration 071, extended 073–077) records every measurement: `target`, `ip_address` + `host_name` (075), `up_mbps`, `down_mbps`, `up_ms`, `down_ms`, `latency_ms`, `nic_mbps` + `nic_name` + `robo_up_mbps` + `robo_down_mbps` (076), `size_mb`, `cycles`, `run_id` (077), `error`, `measured_at`. Unlike the WAN monitor (snapshot only), link-speed keeps **history**.

**Routes** (`system.ts`): `POST /system/linkspeed/test` (single target, foreground, `run_id=null`), `POST /system/linkspeed/run` (background batch), `POST /system/linkspeed/stop`, `GET /system/linkspeed/status` (live progress + partial results while a batch runs), `GET /system/linkspeed/history`, and `GET /system/linkspeed/summary` (baseline-filtered + identity-deduped, latest-per-target classified **ok / slow / offline / error** + the **slowest** link).

**Logging.** The background batch logs to `activity_log` under source **`linkspeed`**: a start line, a per-result line (**warn** on a slow link, **error** on a hard failure), and a finish line.

**Frontend.** `LinkSpeedPage.tsx` renders a **live console** (running batch progress), a **sortable + per-column-filter results grid** with exports, and the single-test / run-batch / stop controls; a **"⚡ Linky" SummaryCards tile** on the dashboard surfaces the summary (ok/slow/offline/error + slowest) and opens the tab.

**Settings & migrations.** Migration **071** creates `link_speed_results` and seeds `linkspeed.size_mb` + `linkspeed.ok_mbps`; **072** seeds the schedule (`linkspeed.enabled`, `linkspeed.interval_hours`, `linkspeed.targets`, `linkspeed.exclude_hosts`; note `interval_hours` is now the **per-PC refresh window**, not a sweep period); **073** adds the `latency_ms` column plus the `linkspeed.cycles` / `linkspeed.window_start` / `linkspeed.window_end` / `linkspeed.filename` settings; **074** adds the `cycles` column to `link_speed_results`; **075** adds `ip_address` + `host_name`; **076** adds `nic_mbps` / `nic_name` / `robo_up_mbps` / `robo_down_mbps`; **077** adds `run_id`. The per-method toggles (`linkspeed.method.smb` / `.robocopy` / `.nic`), the non-destructive `linkspeed.baseline_at`, `linkspeed.pause_ms`, and the rolling-scheduler keys `linkspeed.tick_min` (default 20) / `linkspeed.batch_size` (default 6) are plain settings keys with code defaults (no migration).

**Why this measures the REAL link (a vantage decision, unlike the parked matrix / WAN speed test).** Both the parked service-port matrix and the WAN `/tool/fetch` speed test suffer the central-vantage / router-CPU limit — they measure `.213`→device or a CPU-bound router, not the real link. Link-speed avoids both: **both endpoints are real machines** (the app server and the client) exchanging bytes over the **existing C$ channel**, so there is **no router-CPU bottleneck and no central-vantage problem** — the number is the actual link throughput between the two hosts.

### Per-host lock (2026-07-01)

Heavy per-PC operations (a link-speed copy, a crash-dump pull) must not run against the **same machine** concurrently — two link-speed batches, or a link-speed copy racing a crash-dump collect on the same box, would contend for the same C$ channel and mangle each other's timing. `services/host-lock.ts` serializes them **per identity**.

**Keyed on identity, not IP.** The lock key is **`pc:<id>`** (the `computers.id`), deliberately **not the IP** — a PC's IP is dynamic (DHCP), so locking on IP would let the same machine be hit twice under two addresses, or needlessly block two different machines that transiently share a recycled IP. An **ip↔name resolver** maps whatever a caller has (IP or hostname) to the stable computer id via the DB, cached with a **30 s TTL** so the resolve doesn't hit SQL on every acquire.

**Two acquire modes.**
- **`withHostLock`** — a **blocking FIFO** wait: the caller queues and runs when the host is free. Used by **link-speed** (a batch should wait its turn rather than skip a host).
- **`tryWithHostLock`** — **skip if busy**: returns immediately without running when the host is already locked. Used by the **crash-dump** collector (if that box is mid-measurement, just try it next cycle — no point queueing).

**Scope limit.** The lock serializes work **on a given target host**; it deliberately does **not** cover the **shared uplink of `.213`** itself — two operations against two *different* hosts still both consume the app server's single link, which is what `linkspeed.pause_ms` (above) throttles instead.

### Disabled Office add-ins (2026-07-16, migration 078)

Office **silently disables an add-in after it crashes** — it records it in `Resiliency\DisabledItems` and reports it **nowhere**: no Event Log entry, no dialog on next start. The application then looks perfectly healthy while quietly not doing its job. This is invisible to every other collector we have, because there is no event to collect.

It surfaced through Navision: "export to Excel" started opening an **empty workbook**. NAV does not build the table — it writes a bare **`.xltx` template** containing only the connection (`Server`, `ClientServicesPort`, `ServerInstance`, `CompanyName`) in `CustomProperty*.bin`, and the **NAV Excel add-in fetches the rows over OData** once Excel opens it. With the add-in disabled, the template opens and stays empty. It worked for a colleague on identical Microsoft 365 because **`DisabledItems` is in `HKEY_CURRENT_USER` — per user, not per Office version**. (Office bitness, the `.xltx` association, `LoadBehavior` and the PIAs are all red herrings; each was checked.)

`services/office-addins-collector.ts` therefore reports **any** disabled Office add-in across **Excel, Word, Outlook, PowerPoint** — the same single read finds them all, and NAV is merely flagged separately (`is_nav`) because its consequence is known and invisible.

**Transport: HKEY_USERS over DCOM.** Because the data is in HKCU, a remote read means **`HKEY_USERS`** (hDefKey `2147483651`) through **WMI `StdRegProv` in a DCOM CimSession** — the same shape as `services-collector.ts`, for the same reason (plain `Get-CimInstance` needs WinRM, which domain PCs don't have). Cheap **TCP/135** pre-flight before the lock, then **`tryWithHostLock(pc:<id>)`** — a PC busy with a link-speed run is skipped and retried next cycle rather than stalling the sweep.

**The constraint that shaped the model: only logged-on users are readable.** `HKEY_USERS` holds hives of **logged-on users only**, and **`NTUSER.DAT` is exclusively locked** while the profile is loaded — so the **offline `C$` route that crash-dump collection uses does not work here** (verified, not assumed). A powered-on but logged-off PC yields nothing.

That is why `office_addin_scans.status` is **`ok` | `no_users` | `error`**, and why **`no_users` is not `ok`**: it means *unknown*, not *clean*. The Computers column renders five distinct states (`—` never scanned · `· nikdo` nobody logged on · `✗` scan failed · `●` scanned and clean · `⚠ N` disabled count), and the homepage tile counts **only `status='ok'`** PCs, pushing unknowns into a badge. Same tri-state discipline as `computers.reachable` — an unknown must never be presented as a healthy result. Coverage fills in gradually as people sit at their machines, which is a different freshness profile from inventory data and is deliberately visible in the UI.

**Storage is current state, not history.** Each successful scan **deletes and rewrites** that PC's detail rows: an add-in can be re-enabled, and it must then disappear from the view. `office_addin_scans` keeps one row per PC (including clean ones, so "verified clean" is distinguishable from "never scanned" — a missing row).

**Decoding.** The `DisabledItems` value is `REG_BINARY` in an undocumented layout (header + UTF-16 strings). Rather than guess the structure, readable character runs are extracted and the `.dll`/`.xll` path plus add-in name pulled out of them — verified against a real captured value (330 bytes → correct path, name, and NAV detection). The PowerShell is generated in a TS template literal, which makes escaping (TS → PS → regex) a **silent** failure mode: PowerShell does not treat `\` as an escape, so a malformed registry path never throws — it just never matches, and every PC would cheerfully report "clean". `buildScanScript()` is therefore exported and unit-tested for exactly that.

Settings: `officeaddins.enabled` (**off by default**, like every new per-PC sweep) and `officeaddins.interval_sec` (**6 h** — this state changes when an application crashes, not by the minute; scanning more often would only load client DCOM for nothing).

### Restart service (`POST /system/service/restart`)

A Settings action restarts the API service (`ITDashboardAPI`) from the UI — but the service **hosts the very process** handling the request, so it can't `net stop` itself inline (the stop would kill the handler mid-response). The route therefore **spawns a detached process outside the NSSM tree** (`spawn` of `cmd start …`, so it is **not** a child of the service and survives the service dying) that runs `net stop` then `net start` on the service. The service name is configurable via **`ITDASHBOARD_SERVICE_NAME`** env (defaults to `ITDashboardAPI`), so a differently-named install restarts correctly. This mirrors the deploy workflow's `sc stop`/`sc start` sequencing (see **### Deploy.yml restart with sc + STOPPED polling**) but is operator-triggered rather than CI-triggered.

### Database overview route

`GET /database` returns a whole-DB size breakdown (**data / log / used**) plus **per-table** `rows` / `reserved` / `data` figures, read from the SQL system catalog. A new **"Database"** tab renders it, giving the operator a storage-growth view without touching SSMS.

Some settings (the MikroTik router password) must be stored **reversibly** because HTTP Basic auth needs the real password back at request time — a one-way hash is deliberately **not** used here. `apps/server/src/services/secret-crypto.ts` implements reversible **AES-256-CBC**: the key is `SHA-256(env MIKROTIK_SECRET)`, and ciphertext is stored in the format `enc:v1:base64(iv || ciphertext)`. When `MIKROTIK_SECRET` is unset, it falls back to a `plain:` prefix with a logged warning rather than failing — so a misconfigured host still works, loudly, instead of silently breaking.

**Settings route hooks.** `mikrotik.password` is **never persisted in plaintext**: on PUT the route encrypts it into `mikrotik.password_enc`; on GET it **masks** the value and **omits the ciphertext** from the response. Submitting the mask back means "unchanged" (the existing ciphertext is kept); submitting empty clears it.

### MikroTik collection deployment model

**Strict two-tier model (operator decision, 2026-06-16).** The **application server (`10.8.2.213`)** performs **ALL operativa** — every collector and probe runs **in-app** — and the **database host (`10.8.2.225`) is storage only**. There are deliberately **no additional scripts on any other server**. MikroTik DHCP collection therefore runs **in-process on the application server** via the existing `mikrotik-collector.ts` scheduler (`startMikrotikSchedule`), exactly like the other collectors: the dashboard (API) writes `dhcp_leases` itself and reads them back via `GET /devices`. This keeps the system to **one place for operations**, **config in the UI**, and **one secret on one host** (`MIKROTIK_SECRET` on the application host). The **only** infrastructure requirement is the router **allowed-address** entry for the application host (below).

The earlier **external scheduled PowerShell job on the SQL server** that wrote `dhcp_leases` directly to the DB is **retired and must not be resurrected** — it violated the two-tier model (operativa belongs on the application server, not the DB host).

**Fully DB-driven now (migration 043).** The in-process collector is **wired to read its whole configuration from the DB `settings`** — `mikrotik.enabled` (master toggle), `mikrotik.interval_sec`, `mikrotik.routers`, `mikrotik.user`, and `mikrotik.password_enc` (decrypted via `decryptSecret`). It **no longer reads any `MIKROTIK_*` env var** for routers / user / password; the **only** env value that remains is `MIKROTIK_SECRET` (the AES key for `secret-crypto.ts`), which stays on the application host. This matches the UI-config-driven model the other collectors use. `startMikrotikSchedule` **re-reads Settings each cycle** so enable / interval / router / credential changes apply **live, with no restart**. While the feature is disabled or unconfigured the scheduler **idles** (re-checking every 60 s) instead of attempting a pull, so it never **401-spams** a router that has not yet been opened to the application host.

**Prerequisite (PENDING).** The RouterOS read-only account `dhcp-reader` is **source-IP restricted to `10.8.2.225`**, so the application host `10.8.2.213` currently gets **HTTP 401**. The fix is to add `10.8.2.213` (or `10.8.2.0/24`) to `dhcp-reader`'s **allowed-address** on **both** routers (Brno `10.8.2.207`, Zastávka `10.10.181.2`) — pending a colleague. Until then MikroTik collection is **INACTIVE**: the feature, tables and UI are deployed, but no leases are pulled yet.

### Critical-service status collection

Until this feature (2026-06-12, commit `7ac0962`, migration `037`) the services collector only ever *saw* problems: `fetchServices()` fetched `StartMode='Auto' AND State<>'Running'` and stored those in `service_problems`. A critical service that was **running** was therefore invisible to the tool — `alerts.services.critical_names` existed only inside the email-alert evaluator, so there was no way to confirm a configured critical service was actually *up*. The goal here is the inverse of problem-detection: **confirm the configured critical services actually RUN**, not just flag the stopped ones.

**One enumeration, two outputs.** `fetchServices()` (`apps/server/src/services/services-collector.ts`) now runs a single `Get-CimInstance Win32_Service` enumeration per PC in the **same DCOM session** and derives two outputs from it:
- the **Auto + non-`Running` problems** (unchanged — same registry TriggerInfo / DelayedAutoStart logic feeds `service_problems`), and
- the **configured critical services** matched by `name`/`displayName` `-like` against the `alerts.services.critical_names` patterns, **in any state**.

`replaceCritical()` stores the second set in the new `critical_service_status` table (`computer_id`, `service_name`, `display_name`, `state`, `start_mode`, `collected_at`; PK `(computer_id, service_name)`).

**Only services that exist on a machine are stored.** A DC-only service like `NTDS` lands rows only on the DCs that actually run it, so "servers vs PCs" sorts itself out by presence — no separate role mapping needed. Offline machines are **not** rescanned, so their rows **persist as last-known (stale)** rather than vanishing. `refresh-single-pc` also populates the table, so a manual refresh updates one machine's critical-service rows.

**Endpoint + client.** `GET /services/critical` joins `computers` (`reachable` / `ip_address` / `os_version`). The client adds a `CriticalServiceStatus` type + `api.criticalServices()`, a new **Critical Services** tab (sortable service×machine table; Running/Stopped colour; an offline machine renders its last-known state as **stale amber**; "only not-running" filter), and a Dashboard tile — `SummaryCards` gains props `criticalServicesDown` / `criticalServicesTotal` / `onClickCriticalServices` that open the tab.

**Design caveat.** A host whose CIM scan fails (`New-CimSession: Access is denied` on hardened DCs/servers) yields **no rows** until the service account is granted WMI/DCOM rights there — the table reflects only machines the collector can actually enumerate, so an absent service×machine cell can mean "not present" *or* "couldn't scan that box". This is the usual **Observer, not executor** ambiguity: absence of signal is not proof of absence.

**Status note (2026-06-12).** The DC/server CIM "Access is denied" blocker is **infrastructure, not code** — re-confirmed live: `B-S-W-DC-01/02/03` all fail `New-CimSession`, and only the legacy `DOMENA01` still returns service data. Granting the service account WMI/DCOM rights on the hardened boxes (GPO) is the fix; no code change unblocks it.

### Per-agenda email recipients with shared fallback (2026-06-12)

Disk, services, ports and the new overview report previously all mailed the one shared `alerts.recipients` list. The 2026-06-12 batch (migrations 038–039) splits **recipients per agenda** while keeping the relay shared. `sendMail(settings, payload, recipientsKey?)` reads a per-agenda key — `alerts.disk.recipients`, `alerts.services.recipients`, `alerts.ports.recipients`, `alerts.reports.recipients` — and **falls back to the shared `alerts.recipients`** when that key is empty. The SMTP host/port/From and the dashboard URL stay shared (one relay, one sender identity). Migration **038** seeds the disk/services/ports keys empty, migration **039** seeds the reports key empty — so existing deployments keep mailing everyone via the shared fallback until the operator narrows a specific agenda.

**Settings UI restructure.** A standalone **"Email setup (SMTP)"** section now holds the shared relay / From / recipients / dashboard URL. Each agenda section below (disk, services, ports, reports) keeps only its own enable/throttle controls plus an optional **recipient-override** field; left blank, the agenda inherits the shared recipients. This makes "everyone gets everything" the zero-config default and per-agenda targeting an opt-in.

### Structured fleet overview report + on-demand email (2026-06-12)

A new `apps/server/src/services/reports.ts` builds a **structured fleet-overview report from the `computers` table alone — no live probing** (it reads the last-collected state, so it is cheap and never blocks on offline boxes). `buildOverviewReport()` derives: **PCs vs servers** (a machine counts as a server when `os_version` matches `/server/i`), **offline machines** with their down-since, and **collection-health** counts. **Disabled machines are included** (rendered with status `'disabled'`) so the report's machine set matches what the Computers tab shows.

**One generator, two consumers.** `GET /reports/overview` (JSON for the UI) and `POST /reports/email` (`{ machines?: string[] }`, the on-demand email) both call the **same** `buildOverviewReport()` — so the on-screen view and the emailed report can never drift. The overview email carries a **green/red status banner** (mirrors the subject prefix, below).

**UI placement — toolbar button, not a tab.** A separate **"Reporting" tab was briefly added then removed** — it duplicated the Computers tab. The capability now lives as an **"✉ Email report"** button in the **Computers toolbar** that emails the **currently visible (filtered)** machines — the same "applies to what you see" model as the bulk flag toggles. So filtering the Computers tab and clicking the button reports exactly the rows on screen.

### Machine-readable email subjects (2026-06-12)

Every report/alert subject now leads with `subjectPrefix(hasProblems, manual)`:
- **`[OK]`** vs **`[CHYBA]`** — does this mail actually carry a problem. This is the tag a mailbox auto-file rule keys on (file `[CHYBA]` to an action folder, let `[OK]` heartbeats settle elsewhere).
- **`[RUČNĚ]`** when the mail was triggered manually (a test or an on-demand report); **absent** means the mail fired automatically from a scheduled scan.

The overview email additionally renders the matching **green/red status banner** in the body. `subjectPrefix` is a pure helper (extracted to `alerts-util.ts`, see the test section) shared by every mail path so the convention can't diverge per agenda.

### Two-level service monitoring with per-PC exceptions (2026-06-12, migration 040)

Service email monitoring is now **two independent levels**, each surfaced as a per-PC checkbox + an ignore-list field in the Computers tab:
- **Broad — "Služby"** (`service_monitor`): emails on **every Auto service that is not Running** on that PC.
- **Critical — "Critical services"** (`service_email_monitor`): emails only on services in the configurable `alerts.services.critical_names` set (the existing critical-service alerting, see **### Critical-service email alerting**).

Each level has its own per-PC **ignore list** — `service_exceptions` (broad) and `critical_service_exceptions` (critical) — a comma/newline list with `*` `?` wildcards, matched against the service **name OR display name**. An excepted service is suppressed for that PC's level.

**Overlap rule — never emailed twice.** A critical service is reported **only by the critical level**: the broad level **skips any name that matches the critical-names set**, so a stopped `NTDS` pages once (as critical), never twice.

**IMPORTANT design finding — the broad level is exit-code-agnostic.** The broad level reports the collector's **"real" set** of down Auto services and **excludes trigger-start / delayed-start (on-demand) services** (which legitimately sit Stopped). It deliberately does **not** gate on `exit_code`: live data shows **413 of 454** genuine Auto-service-down problems report exit `0`/null and only **19** are exit `≠0`, so `exit_code` is not a useful discriminator of "real" drift. An earlier attempt to gate the broad level on `exit_code <> 0` was **reverted** because it dropped the overwhelming majority of real problems.

### Services tab — exit-code-agnostic drift, shared `isServiceCrash` (2026-06-12)

The Services-tab filters tested `exit_code === 0`, but most stopped services carry `exit_code = null`, so trigger/null rows **leaked through** the filter. The fix introduces a single shared predicate `isServiceCrash(exitCode)` = `exit != null && exit !== 0` — i.e. **`0` OR `null` both count as a graceful stop**, only a non-zero exit is a crash. The default **"Only ExitCode != 0" toggle was flipped OFF**, so the tab shows real drift by default and **matches the dashboard "Stopped services" tile and the broad alert** rather than a narrow exit-code-crash subset. This is the same exit-code-agnostic stance as the broad alert level above; `isServiceCrash` is one of the helpers covered by the new desktop test suite.

### Critical-service exceptions honoured in the tab + dashboard tile (2026-06-12)

The per-PC `critical_service_exceptions` list was first introduced for the email; it is now honoured **everywhere the critical services are surfaced**, so the screen and the mail agree. `GET /services/critical` returns each PC's exceptions; an excepted non-running service is **excluded from the "N not running" count**, **sinks to the bottom** of the table, and renders **greyed with an "exception" tag**. The Dashboard **🛡 Critical services tile** excludes excepted services from its count too. Single source of truth: the same per-PC exception list drives the alert, the tab, and the tile.

### Dashboard tile colours reflect severity (2026-06-12)

Dashboard tile numbers are now **green when zero** and turn **red/orange only when there is an actual problem** (new `.card.ok` style). Previously a "0 problems" tile could still read as alarming; the colour now carries the severity so a clean fleet reads green at a glance.

### First automated test suites + CI gate (2026-06-12)

The earlier oponentura reviews flagged "no automated tests" as the standout gap; this batch closes it. **Vitest** is added to **both apps**. To make the server logic testable without loading the DB / native ODBC driver, the **pure helpers were extracted** from `alerts.ts` into `apps/server/src/services/alerts-util.ts` (no DB, no native-driver load). **54 cases** total:
- **desktop `api.test.ts`** — service crash/exception classification (`isServiceCrash`, whitelist/exception globbing), disk threshold + drive-scope, `osBucket`, `levelName`.
- **server `alerts-util.test.ts`** — `subjectPrefix`, recipient + glob parsing, maintenance-window matching, `shouldAlertNow` debounce/throttle.

**CI gate.** `deploy.yml` now runs `npm test` **after typecheck** in both apps, so a failing test **stops the deploy** before any service restart. This directly answers the "no automated tests" critique from the oponentura reviews.

### Academic review/defence document

A ~90-page Czech technical + academic review/defence document was added at `docs/oponentura.md`.

### Live network reachability probe drives the Status column

Until this feature (2026-06-12, commit `a12ad36`) the Computers "Status" column was a **by-product of the event-log collector** rather than a measure of network presence. That coupling produced three wrong answers: the collector only ran on `enabled && monitor_enabled && !excluded` PCs (so anything unmonitored had no fresh status); failures were classified crudely from the PS error text (`offline` / `rpc_unavailable` / `access_denied` / `unknown`), so a perfectly reachable box whose event log simply couldn't be read showed **"Unknown"**; and — worst — once a PC passed the failure cap (`consecutive_failures >= MAX_FAILURES_BEFORE_SKIP`, at which point `listTargets` skips it) its status **froze**, so an AD-enabled box that was never successfully classified kept showing a green "Active" fallback forever. No live presence signal existed; there was no ICMP ping anywhere.

**New collector — decoupled from event-log health.** `runReachabilityProbeOnce()` in `apps/server/src/services/reachability-collector.ts` lists **every `enabled && !excluded` computer** — deliberately **not** gated by `monitor_enabled` and **not** subject to the failure cap, so it sees PCs the event-log collector has given up on. Each PC counts as reachable if **any** of three answers: a **TCP connect** to port 135 (RPC endpoint mapper), a TCP connect to 445 (SMB), or — as a fallback when both are silent — an **ICMP ping** (`reachability.ping`, on by default, migration 036). TCP is tried first (a cheap socket); the ping spawns `ping.exe -n 1` and is accepted only if the output contains `TTL=` (a genuine echo reply, and `TTL=` is not localized, so it survives a Czech-locale Windows and rejects router-sourced "Destination host unreachable" lines that can still exit 0). The ping fallback exists precisely because a hardened host can block RPC/SMB yet still answer ping. Concurrency is 16. The probe is self-contained: it never throws, and returns `null` only if a run is already in flight. It persists `reachable` (BIT), `last_reachable_at` (bumped **only** on a successful connect, so it preserves "last seen alive" across later failures), and `reach_checked_at` (every attempt).

**Wiring into the checks runner.** Registered in `apps/server/src/services/checks-runner.ts` as a new `CHECKS` entry `'reachability'` (`settingKey` `checks.run_reachability`, `defaultEnabled true`), ordered **after `adsync` and before `eventlog`** so the Status reflects current reachability regardless of whether the data collectors succeed in the same cycle. `RunChecksResult` / `CheckSelection` are extended for it and `loadSelection` picks it up automatically, so the Settings "enabled checks" toggle works with no extra plumbing. `refresh-single-pc` also sets `reachable = 1` on a successful single-PC refresh (a successful collect implies the box answered).

**Migration `032_reachability.sql`** adds the three columns and seeds `checks.run_reachability = '1'`, `reachability.ports = '135,445'`, and `reachability.timeout_ms = '2000'`.

**Client — the Status cell is redefined.** `GET /computers` returns the new columns; `ComputerItem` (`apps/desktop/src/api.ts`) gains `reachable` / `last_reachable_at` / `reach_checked_at`. The ComputersPage Status cell now reads from live reachability rather than collector health:
- **Disabled** — not `enabled` in AD.
- **Active** — `reachable` now true, with a secondary **"logs"** marker when event-log collection is unhealthy (derived from `last_status` ∈ `access_denied | rpc_unavailable | unknown`, or `consecutive_failures > 0`). The box is up; its log path may not be.
- **Offline** — `reachable` is false. A new `'offline'` status filter selects `enabled && !excluded && reachable === false`.
- **— not probed** — `reachable` is `null`, a transitional state before the first probe has run.

The key design split is that three previously-conflated signals are now distinct: **reachability** (live, this probe) vs **event-log collection health** (`last_status`) vs **AD inactivity** (`last_seen` / `inactive.threshold_days`). A box can be Active-but-"logs", reachable-but-AD-inactive, etc., and the UI no longer flattens those into one column.

**Scheduling.** The probe runs on its **own standalone timer** (`startReachabilitySchedule` in `reachability-collector.ts`, kicked off in `index.ts`), every `reachability.interval_sec` (default 300 s, migration 035), **independent of the periodic-checks window** — so presence stays fresh 24/7 while the heavier collectors stay windowed. The self-rescheduling loop re-reads the enable flag (`checks.run_reachability`) and the interval each cycle, so Settings changes apply without a restart. It is therefore **not** a member of the `checks-runner` CHECKS array.

### Computers tab sorting (reliability)
Sorting is locale-aware with numeric chunking, so IPs order naturally (`10.8.2.9` < `10.8.2.10`), hostnames order naturally (`PC2` < `PC10`), accented names collate correctly, and nulls sort last. The "Status" column sorts by the displayed reachability status, now derived from the live `computers.reachable` probe (see **### Live network reachability probe drives the Status column**) rather than the `enabled` flag. Closing the Per-PC Actions modal after a manual refresh re-syncs the list so the row reflects the latest scan.

### Dashboard OS breakdown chart (live/stale split + drill-down)

A homepage **second-row tile** (`apps/desktop/src/components/OsBreakdownChart.tsx`, rendered after `SummaryCards` in `apps/desktop/src/App.tsx`) shows the fleet's OS distribution as one horizontal bar per OS bucket. The tile ("📊 Operating systems", count of buckets) **toggles the bar chart inline on click** (local `open` state, mirroring `HealthCards`) — it is no longer an always-visible full-width panel. It is **pure client-side aggregation over the already-loaded `computers` array** — no new endpoint, no DB column. Scope is the **live managed fleet**: `enabled && !excluded`.

**Normalizing the free-text OS column.** AD gives us a single free-text `os_version` string (the AD `OperatingSystem` attribute), which we never want to chart raw — too many near-duplicate spellings. `osBucket(os_version)` in `apps/desktop/src/api.ts` collapses it into a small canonical set: `Windows 11/10/8.1/8/7`, `Windows Server <year>[ R2]`, `Windows Vista`/`Windows XP`, a generic `Windows Server` fallback, `Other` for anything else, and `Unknown` for null/blank. `summarizeOs(computers, thresholdDays)` walks the scoped fleet and returns per-bucket `{ total, stale, live }`, sorted by size.

**"Stale" reuses the inactivity model — single source of truth.** A bucket's stale count is the subset of machines that are inactive by the existing definition: `isStaleComputer(c, thresholdDays)` = `!excluded && (last_seen null || older than inactive.threshold_days)` (default 90, migration 022). This is the *same* predicate that drives the Dashboard "Inactive PCs" card and the Computers tab inactive filter, so the OS chart's stale figures can't drift from the rest of the UI. Each bar renders as a solid **live** segment plus a hatched **stale** segment (live = total − stale).

**Drill-down into Computers.** Clicking a segment selects an OS drill-down filter (`{ bucket, staleness }`) that `App.tsx` passes to `ComputersPage` via `initialOsFilter`; the page consumes it into local `osFilter` state and applies it in the filter predicate, mirroring the chart's scope exactly — `enabled && !excluded && osBucket(c.os_version) === bucket && requested staleness`. It surfaces as a removable chip and is mutually exclusive with the status filter chips. Because the chart and the filter predicate both call `osBucket()` and `isStaleComputer()`, the segment count and the drilled-in list **agree by construction** — there is no separate query that could return a different number.

### Faulty-PC / reinstall-candidate detection

Surfaces **"problem PCs"** (the UI label; the endpoint/settings keep the `faulty.*` / `pc-health` names) — PCs whose event log shows chronic, *broad*, *persistent* problem accumulation, the systemic-rot signature that a single noisy provider can't fake. The intent is a triage shortlist ("which boxes are sick enough that a reinstall is cheaper than chasing individual errors") rather than another per-event view. The heavy lifting is server-side: a new endpoint **`GET /events/pc-health`** (`apps/server/src/routes/events.ts`) reads every knob from `settings`, runs a single CTE query over the `events` table, scores and classifies each computer, and returns only the ones above the watch line — the client renders, it does not compute.

**The scoring query (one CTE, three stages).** All within a `faulty.window_days` (default 14) lookback:
- **`sig`** — `GROUP BY computer_id, level, event_id, provider_name` to get a per-*signature* count. A signature is one distinct (level, event id, provider) tuple on one PC.
- **`agg`** — per computer, `SUM(min(cnt, @cap) × weight)` where `@cap` is `faulty.signature_cap` (default 20) and weight is `faulty.weight_critical` (level 1, default 10) / `faulty.weight_error` (level 2, default 3) / `faulty.weight_warning` (level 3, default 1). Also computes `signatures` = count of distinct level-1/2 signatures (breadth), plus the raw critical/error/warning totals for display.
- **`dys`** — per computer, `COUNT(DISTINCT CAST(time_created AS DATE))` over level 1/2 events = `active_days` (persistence: how many separate days the box was throwing problems).

Final `score = weighted + signatures·@wb + active_days·@wp` where `@wb` is `faulty.weight_breadth` (default 5) and `@wp` is `faulty.weight_persistence` (default 3). Scope is `enabled && !excluded`. Classification is **server-side**: `score >= faulty.threshold_risk` (default 600) → `'risk'`, `>= faulty.threshold_watch` (default 400) → `'watch'`, anything below is dropped. The response is `{ windowDays, thresholdWatch, thresholdRisk, items[] }`, sorted worst-first.

**Why the per-signature cap is the whole idea.** The dedup pass only removes *exact* duplicates, so a single wedged driver emitting thousands of *distinct-timestamp* errors would otherwise dominate the score and flag an otherwise-healthy box. Capping each signature's contribution at `@cap` defangs the one-chatty-provider case, and then the breadth (`signatures`) and persistence (`active_days`) terms explicitly reward the opposite shape — **many different problems across many different days**, which is what "systemically sick, reinstall it" actually looks like. Weights stay DB-tunable (no Settings UI) precisely so the operator can retune the shape of "sick" without a redeploy; window / cap / thresholds are the knobs exposed in Settings.

**Client — a second tile row with an inline expand table.** `PcHealth` / `PcHealthResult` types and `api.pcHealth()` live in `apps/desktop/src/api.ts`. Because the 14-day `GROUP BY` is markedly heavier than the 30 s dashboard refresh, `App.tsx` fetches it on a **separate slow 5-minute interval** and re-pulls whenever any `faulty.*` setting changes. A new `apps/desktop/src/components/HealthCards.tsx` renders a **single second-row tile** ("Problem PCs", the risk tier) below `SummaryCards`; the `Card` component is now **exported from `SummaryCards.tsx`** for reuse. (A `watch` tile was briefly added then removed at operator request — only the risk tier is surfaced; the endpoint still returns the watch tier, it just isn't shown.) The breakdown table (score · crit · err · warn · types · days) is **not shown by default** — clicking the tile toggles an inline expand of the table (local `open` boolean in `HealthCards`), and each table row jumps to that PC via the existing `jumpToComputer` (search prefill). The operator explicitly didn't want a permanent table on the dashboard; an earlier set-based "drill into the Computers tab" (`computersIdFilter` / `initialIdFilter`) was removed in favour of this. A new Settings block exposes window / cap / thresholds.

**Migration `033_faulty_pc.sql`** seeds the settings: `faulty.window_days` (14), `faulty.signature_cap` (20), `faulty.weight_critical` (10) / `weight_error` (3) / `weight_warning` (1), `faulty.weight_breadth` (5), `faulty.weight_persistence` (3), `faulty.threshold_watch` (60), `faulty.threshold_risk` (150). **Migration `034_faulty_thresholds.sql`** then recalibrates the two thresholds to `watch=400` / `risk=600` (guarded to the 60/150 seed) — live data showed active Win11 boxes carry a high event baseline, so 60/150 flagged ~42% of the fleet; 400/600 keeps `risk` to the worst ~10.

This stays on the right side of **Observer, not executor**: it ranks boxes for the operator's attention and drills into the inventory, it does not touch the target.

### Export encoding — UTF-8 BOM on all text formats

`ExportMenu` now prepends a **UTF-8 BOM** to its TXT/TSV output (commit `563a147`); CSV already carried one. Without the BOM, Excel and Notepad open the file in the legacy console codepage (Windows-1250 in this deployment) and mangle Czech diacritics — the same root cause the **### UTF-8 PowerShell output** decision addresses on the collector side, now closed on the download side too.

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

### Deploy robocopy /MIR excludes `dist`

The deploy's `robocopy /MIR` (mirror) now **excludes `dist`**. `dist` is gitignored and **built later in the same job**, so mirroring the checkout (which has no `dist`) was **deleting the running service's frontend** mid-deploy — the source of the transient **"frontend build not found"** between the file sync and the rebuild step. Excluding `dist` from the mirror leaves the live frontend in place until the fresh build overwrites it.

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
| 034_faulty_thresholds | recalibrate faulty.threshold_watch → 400, faulty.threshold_risk → 600 (guarded to the 60/150 seed; live-tuned so "risk" is the worst ~10, not ~42% of the fleet) |
| 035_reachability_interval | reachability.interval_sec (300) seed — the reachability/Status probe now runs on its own standalone timer, independent of the periodic-checks window |
| 036_reachability_ping | reachability.ping (1) seed — ICMP ping fallback so a host that blocks TCP 135/445 but answers ping still counts as reachable |
| 037_critical_service_status | critical_service_status table (computer_id + service_name PK; service_name, display_name, state, start_mode, collected_at) — the real state of the configured critical services in **any** state, consumed by `GET /services/critical` |
| 038_per_agenda_recipients | `alerts.disk.recipients` / `alerts.services.recipients` / `alerts.ports.recipients` settings seed (empty) — per-agenda recipient override with fallback to the shared `alerts.recipients`; SMTP host/port/From + dashboard URL stay shared |
| 039_reports_recipients | `alerts.reports.recipients` settings seed (empty) — per-agenda recipient override for the fleet-overview report, same shared-fallback model as 038 |
| 040_service_two_level | computers.service_monitor BIT (broad "every Auto service not Running" level) + service_exceptions NVARCHAR (broad per-PC ignore list) + critical_service_exceptions NVARCHAR (critical per-PC ignore list) — two-level service monitoring with per-PC exceptions; the existing service_email_monitor now denotes the critical level |
| 041_port_status | port_status table (PK `(computer_id, check_name)`; port, is_open, latency_ms, checked_at) — latest per-port open/closed + latency verdict for the ports-availability grid; distinct from the port_check_state alert state machine. Consumed by `GET /port-status`, populated by the standalone port-status collector (`checks.run_port_status` / `port_status.interval_sec` default 300) |
| 042_mikrotik_dhcp | dhcp_leases table (PK `(site, mac_address)`; ip, host_name, server, comment, status, dynamic, expires_after, first_seen, last_seen, reachable, last_reachable_at, reach_checked_at) + device_categories table (PK `mac_address`; operator-assigned category, persists by MAC) — MikroTik RouterOS DHCP device inventory, consumed by `GET /devices` |
| 043_mikrotik_settings_printer_alerts | seeds `mikrotik.enabled` + `mikrotik.interval_sec` (routers/user/password are written by the Settings UI, not seeded) — MikroTik collection becomes fully DB-driven (no more `MIKROTIK_*` env vars except the `MIKROTIK_SECRET` AES key); `alerts.printers.*` settings + printer_alert_state table (per-MAC debounce/throttle) for the printer-offline email agenda; collapses the per-vendor `printer_*` device categories into the generic `printer` |
| 044_device_source_arp | dhcp_leases.source column (`dhcp`/`arp`/`scan`) + `mikrotik.scan_enabled` / `mikrotik.scan_ranges` settings — multi-source device discovery merging DHCP leases, router ARP, and an active app-server subnet scan, keyed by MAC |
| 045_device_packet_loss | dhcp_leases.packet_loss column — per-device packet loss % from the reachability ping (online only; parsed locale-independently by counting `TTL=` reply lines) |
| 046_device_operator_name | device_categories.name column (operator-editable device name, stored per-MAC) + `category` relaxed to nullable so a name-only row is valid |
| 047_device_latency | dhcp_leases.latency_ms column — per-device average round-trip (ms) from the reachability ping (online only). NOTE: the "problem" thresholds (`devices.problem_loss_pct` / `devices.problem_latency_ms`) and the operator-defined `devices.categories` list are plain settings with code defaults — NOT seeded by a migration |
| 048–061 | Documented in their feature sections above (printer supplies, web-proxy default, eventlog snooze, faulty-notebook suppress, device ping history, UniFi, lease retention, device IP history, MikroTik FTP source, data-freshness alert, AD-sync new-PC defaults, IP-history search, perf/adsync retention, crash dumps) — see the migration IDs called out in **### MikroTik FTP file source…**, **### Device history…**, **### Printer supply collection…**, **### Crash-dump collection & analysis** and the related sections |
| 062_wan_monitor | `wan.*` settings seed for the live WAN-link monitor: `wan.enabled` (1), `wan.interval_sec` (60), `wan.internet_target` (`1.1.1.1`), `wan.ping_count` (5), `wan.latency_warn_ms` (80), `wan.loss_warn_pct` (5) — branch + internet ping from the app server, current snapshot only (no history table). See **### Live WAN-link monitor** |
| 063_wan_speedtest | optional central download speed test (OFF by default): `wan.speedtest_enabled` (0), `wan.speedtest_url` (Cloudflare `__down`), `wan.speedtest_interval_sec` (1800) — its own slow cadence, result Mbps carried in the WAN snapshot |
| 064_wan_speedtest_streams | `wan.speedtest_streams` (6) — parallel fetch streams timed from first byte (a single stream / cold clock underestimates fast links); also bumps the default sample 10 MB → 25 MB **only** for installs still on the original default URL |
| 065_service_port_matrix | `svcports.*` settings seed for the per-branch service-port matrix (`svcports.enabled`, `svcports.interval_sec`, `svcports.checks` default printers `9100`/`515`/`631` as `Label:port:category`) — central `.213`→device TCP probe per category per site, in-memory snapshot only (no table). See **### Per-branch service-port matrix + service discovery (PARKED)** |
| 066_svcports_drop_phone | drops the phone default from `svcports.checks` (phones are off the central network / unreachable from `.213`) |
| 067_service_discovery | `svcports.voip_ouis` seed (Yealink/VoIP OUI list for the OUI→`voip` category promotion) + service-discovery settings — backs the user-triggered `POST /system/service-discovery` broad-port scan; settings only, no table |
| 068_svcports_voip_web | adds a VoIP web check to `svcports.checks` |
| 069_svcports_drop_voip | drops the voip check (VoIP phones are out of scope from `.213` — separate voice network, not in `dhcp_leases`) |
| 070_svcports_park | **PARK**: `svcports.enabled=0` — scheduler idles, nav tab hidden; code + endpoints retained. Central vantage measures `.213`→device, not branch→device (same limit as the WAN speed test); revive after the SD-WAN printer-segment split, measured from the branch routers |
| 071_link_speed_results | `link_speed_results` table (`target`, `up_mbps`, `down_mbps`, `up_ms`, `down_ms`, `size_mb`, `cycles`, `error`, `measured_at`) + `linkspeed.size_mb` / `linkspeed.ok_mbps` settings seed — per-target link-speed measurements over the C$ channel (best up/down, real link, no router). See **### Link-speed measurement** |
| 072_linkspeed_schedule | `linkspeed.enabled` / `linkspeed.interval_hours` / `linkspeed.targets` / `linkspeed.exclude_hosts` settings seed — DB-driven, restart-safe **rolling** scheduler (`startLinkSpeedSchedule`): each tick measures the stalest-N due PCs (`linkspeed.tick_min` / `linkspeed.batch_size`, both code-default settings), where `interval_hours` = **per-PC refresh window** (not a sweep period); `targets` supports `"all"` (active reachable PC/server IDs) + ranges minus the exclude list |
| 073_linkspeed_latency | `link_speed_results.latency_ms` column (RTT from the ping) + `linkspeed.cycles` / `linkspeed.window_start` / `linkspeed.window_end` / `linkspeed.filename` settings seed |
| 074_linkspeed_cycles | `link_speed_results.cycles` column — how many up/down cycles the best result was chosen from |
| 075_linkspeed_identity | `link_speed_results.ip_address` + `host_name` columns — record the resolved IP and hostname per result so the summary can dedup by machine identity (LEFT JOIN `computers`) instead of by raw target string. See **### Link-speed measurement** |
| 076_linkspeed_methods | `link_speed_results.nic_mbps` / `nic_name` / `robo_up_mbps` / `robo_down_mbps` columns — the NIC negotiated link speed (`readNicSpeed` over DCOM `CimSession`; wireless/non-standard rate flagged as wifi) and the robocopy `/MT` multi-file figures (informational only — the read-back is cache-inflated), alongside the SMB single-stream verdict. Methods are independently toggled by `linkspeed.method.smb` / `.robocopy` / `.nic` settings |
| 077_linkspeed_run_id | `link_speed_results.run_id` column — a per-batch fingerprint (= batch start time) shared by every row of one "run all" pass; a single-target test writes `run_id=null`. Groups a run for comparison/dedup |

> `alerts.dashboard_url` (added 2026-06-11 for the redesigned disk alert email report) is a runtime settings key created on first save — it has **no migration** of its own (it was added alongside the 029→030 work but is not part of any migration).
