# ITDashboard Handoff

Last updated: 2026-06-03 (perf-events)

## Current Live State

- Project: ITDashboard
- Repo: `https://github.com/Anamax443/ITDashboard`
- Local path: `D:\git\ITDashboard`
- Runtime server: `10.8.2.213` / `B-S-W-MIKOS`
- Runtime path on server: `C:\Apps\ITDashboard`
- SQL server: `10.8.2.225`
- Database: `ITDashboard`
- Live commit: `0925d4d`
- Browser URL: `http://10.8.2.213:4000/`
- Docs URL: `http://10.8.2.213:4000/docs`

## Deployment Model

- Local edit in `D:\git\ITDashboard`
- Commit locally
- Push to `main`
- GitHub Actions self-hosted runner on `10.8.2.213` deploys to `C:\Apps\ITDashboard`
- The workflow mirrors source, installs dependencies, typechecks, builds server + browser UI, applies migrations, then restarts `ITDashboardAPI`.

Important:
- Push to `main` requires explicit operator authorization: `Autorizuj push do main`
- After every commit, report the commit hash in chat.
- Local branch may be `scaffold/initial`; push explicitly with `git push origin HEAD:main`.

## Runtime Services

- API service: Windows Service `ITDashboardAPI` managed by NSSM
- Runner service: `actions.runner.Anamax443-ITDashboard.B-S-W-MIKOS`
- Service account: `AXINETWORK\svc-itdashboard`
- API port: `4000`
- Firewall rule: `ITDashboard API (4000)`
- API access is controlled by the whitelist in Settings -> Network access.

## Important Windows/Domain Gotchas

- AXINETWORK servers enforce PowerShell `AllSigned` via GPO.
- GitHub Actions workflow must use `shell: cmd`.
- Service restart must use `sc stop` + polling until `STOPPED`, then `sc start`.
- `net stop` alone can race and leave the old Node process in memory.
- SQL uses `msnodesqlv8` for real Windows Integrated Auth. Do not switch to `tedious`.
- GitHub Actions repo variable `SQL_INSTANCE` uses `_` as sentinel for default SQL instance.

## Current Features

- Dashboard tab with summary cards and drill-downs.
- Events tab for Warning/Error/Critical eventlog data.
- Computers tab with AD sync, monitor toggle, exclude toggle, disk status, reachability status.
- Services tab with stopped auto-service detection, policy/drift classification, by-PC and by-service views, GPO script export.
- Perf tab with Diagnostics-Performance event data (slow boot/shutdown/standby/resume) — summary cards, top culprits, most affected PCs, recent events table.
- Activity tab with live in-memory log, pause, filter, copy.
- Settings tab with:
  - Periodic checks frequency
  - Periodic checks day selection: Po, Ut, St, Ct, Pa, So, Ne
  - Periodic checks time window, default `06:00` to `18:00`
  - Check selection: Eventlog collector, Disk scan, Services scan, Perf events
  - Network firewall whitelist
  - Disk thresholds

## Periodic Checks

Implemented in:
- `apps/server/src/services/checks-runner.ts`
- `apps/server/migrations/015_periodic_checks.sql`
- `apps/desktop/src/pages/SettingsPage.tsx`

Settings keys:
- `checks.interval_sec`
- `checks.days`
- `checks.window_start`
- `checks.window_end`
- `checks.run_eventlog`
- `checks.run_disk`
- `checks.run_services`

Behavior:
- Scheduled checks run only inside the selected day/time window.
- Manual `Run all checks` runs even outside the window.
- The checks runner uses a registry pattern so future checks can be added as new entries rather than new independent schedulers.

## Last Important Commits

- `0925d4d` - schedule window settings for periodic checks
- `536da3c` - configurable periodic checks scheduler
- `92f5f22` - allow HTTP dashboard assets by disabling CSP upgrade-insecure-requests
- `b528b48` - serve browser dashboard at root `/`
- `bfad652` - services scan progress, by-service view, GPO PS script export, docs update
- `3816eff` - HelpBox on every tab + service policy/drift detection
- `113f9ff` - excluded flag per PC

## Verification Commands

```powershell
cd D:\git\ITDashboard
npm run typecheck
npm run build --workspace @itdashboard/server
npm run build --workspace @itdashboard/desktop
```

After deploy:

```powershell
Invoke-RestMethod http://10.8.2.213:4000/version
Invoke-WebRequest http://10.8.2.213:4000/ -UseBasicParsing
Invoke-RestMethod http://10.8.2.213:4000/settings
```

Expected:
- `/version` shows the latest pushed commit hash.
- `/` returns `200 text/html`.
- `/settings` contains `checks.*` keys after migration.

## If Deploy Looks Green But UI Is Old

1. Check topbar hash vs latest commit.
2. Check `http://10.8.2.213:4000/version`.
3. If hash is old, service restart likely failed.
4. Check GitHub Actions deploy logs, especially the service restart step.
5. Historical fix is in workflow: `sc stop` + wait for `STOPPED` + `sc start`.

## Backlog Ideas

- Per-PC detail page: timeline, disks, services, perf events, last errors.
- Alerting through Resend email or Teams webhook.
- Daily auto AD sync.
- Setup guide/checklist in UI for GPO and permissions rollout.
- Future checks should plug into the checks registry, not create standalone timers.

## Design notes

- ITDashboard is an **observer, not an executor** — the loop is
  `observe → compare with threshold → show to operator`, never
  `observe → act → re-observe`. Remediation is delegated to the human
  at the screen. The Services tab "GPO script export" follows this rule
  (we export a script, we don't execute it). Future backlog items like
  "Direct fix button per service-PC" would cross that line and should
  be evaluated against this principle before being implemented.
- Absence of signal is ambiguous: an OFFLINE PC could mean the PC is
  down, the network is down, or the monitor itself is blind. A
  self-health indicator ("monitor sees X/Y targets, last sweep N sec
  ago") would help disambiguate during incidents — currently missing.

## Perf events (Diagnostics-Performance channel)

Implemented in:
- `apps/server/src/services/perf-collector.ts`
- `apps/server/src/routes/perf-events.ts`
- `apps/server/migrations/016_perf_events.sql`
- `apps/desktop/src/pages/PerfPage.tsx`

Source channel: `Microsoft-Windows-Diagnostics-Performance/Operational`,
enabled by default on Windows 10/11 and Server. The collector pulls slow-event
records via `Get-WinEvent -ComputerName ...` (same RPC path as eventlog
collector — needs Event Log Readers + RPC). EventData is parsed from XML to
extract `TotalTime`, `DegradationTime`, `Name`, `FriendlyName`.

Event ID ranges:
- 100–199 = boot (101 app-caused, 102 driver, 103 service, 108/109 slow service/device, 150 degradation)
- 200–299 = shutdown
- 300–399 = standby
- 400–499 = resume

Limitations:
- Not a continuous CPU graph — only discrete slow-event records when Windows
  itself flagged them as slow. Default channel retention is small (~1 MB ring
  buffer), so we sweep into SQL to preserve history.
- "Slow" threshold is Windows' opinion, not configurable.
- **Channel is disabled by default on Windows Server SKU.** Get-WinEvent
  on a disabled channel returns `"There is not an event log on the X
  computer that matches"`. The collector matches this pattern and
  classifies it as `channel-disabled` (separate counter, not a failure)
  with no per-PC noise — one aggregate count at end of run. To enable
  across the server fleet, push a GPO computer-startup script:
  `wevtutil sl Microsoft-Windows-Diagnostics-Performance/Operational /e:true`.

Setting key: `checks.run_perf` (default `true`).
