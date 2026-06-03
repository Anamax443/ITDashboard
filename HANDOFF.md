# ITDashboard Handoff

Last updated: 2026-06-03 (P0 oponentura batch)

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

## Dashboard UI access (whitelist)

The dashboard UI gate is **frontend-side, not API-side**. When the React app loads on
the browser, `App.tsx` calls `GET /access-check` which returns
`{ ip: req.ip, allowed: bool }`. If `allowed=false`, the app renders
`<AccessDenied ip={...} />` instead of the dashboard layout.

The **JSON API endpoints, the bundle, and `/docs` are not gated** — the server lives on
an internal domain network and is intentionally domain-wide reachable. This is a UX
gate ("you're not on the operator list, here's who to ask"), not a security boundary.
Bypass via DevTools is possible and considered acceptable for the threat model
(incidental UI discovery by non-IT users browsing the LAN). If you need a true API
security boundary, that's a separate feature (auth tokens, mTLS, …).

Source of truth for the whitelist is the Windows Firewall rule "ITDashboard API (4000)".
The server caches the rule contents in memory (`apps/server/src/services/ip-guard.ts`):
loaded at boot via `getAllowedIPs()`, refreshed after every PUT to `/firewall/whitelist`.
Loopback `127.0.0.1` / `::1` is always allowed regardless of cache state so the service
can self-call.

Known operational gotcha: the Windows Firewall rule may be **inert** if the Domain
profile is `Enabled=False` (often set by GPO). Check with:
`Get-NetFirewallProfile | Format-Table Name, Enabled`.
The frontend gate does not depend on the OS firewall being active — it just reads the
rule contents as the whitelist source — so the UI is still gated correctly even with
the OS firewall disabled.

## One-click "Launch" via URL protocol handlers (NEW since 2026-06-03)

The browser cannot run native commands directly. For true 1-click
launch from the Actions modal, the operator runs a small `.cmd`
installer **once per workstation** that registers custom URL protocol
handlers under `HKCU\Software\Classes\itd-*`. After install:

- `itd-mmc://NAME` → `mmc.exe compmgmt.msc /computer=NAME`
- `itd-services://NAME` → `mmc.exe services.msc /computer=NAME`
- `itd-eventvwr://NAME` → `mmc.exe eventvwr.msc /computer=NAME`
- `itd-taskschd://NAME` → `mmc.exe taskschd.msc /computer=NAME`
- `itd-rdp://NAME` → `mstsc /v:NAME`
- `itd-psexec://NAME` → `cmd /k psexec /accepteula \\NAME cmd.exe`
- `itd-explorer://NAME/LETTER` → `explorer.exe \\NAME\LETTER$`

Installer at `apps/server/scripts/install-itd-handlers.cmd`, served as
download via `GET /actions/install-handlers.cmd`. The Actions modal
shows a banner with the download link the first time it's opened.

Each ActionRow in the modal renders both the **🚀 Launch** button
(protocol URL) and the **Copy command / Download .bat / .rdp** fallback
so the same UI works whether handlers are installed or not.

Install puts launcher .cmd files in `%LOCALAPPDATA%\ITDashboard\launchers\`
and registry entries in HKCU. No admin privileges required.

PsExec needs to be on PATH (Sysinternals typically deployed via GPO).

## Per-PC actions menu (NEW since 2026-06-03)

Computers tab gains a per-row "⚡ Actions" button that opens a modal
exposing common remote-admin operations. Since the browser cannot
launch native commands directly, every action is one of:
- **Copy-to-clipboard** — operator pastes into Win+R / cmd
- **File download** — operator double-clicks the downloaded .rdp / .bat
  in Downloads to launch

Sections in the menu:
1. **Remote MMC management** — copy commands for `compmgmt.msc`,
   `services.msc`, `eventvwr.msc`, `taskschd.msc` with `/computer=NAME`
2. **Remote access** — `.rdp` file download (mstsc auto-launches);
   `.bat` with `psexec \\NAME cmd.exe`
3. **Admin shares** — enumerated from the `disks` table for that PC.
   For each known drive (C, D, ...), a `.bat` download that runs
   `start explorer.exe \\NAME\<letter>$` plus a "Copy UNC" button
4. **Copy** — hostname / FQDN / current IP

Future enhancement: custom `itd-launch://` URL protocol handler
installed via small `.reg` file would give true one-click experience.

## PC user history click moved to NAME (UPDATED 2026-06-03)

The User cell tooltip stayed but the click handler is on the **Name**
cell now (dotted-underline accent color). The history modal also gained
an "IP at that time" column populated from `pc_user_history.ip_address`
(migration 024) — the IP the PC had when the session was first observed.
Helps trace roaming notebooks.

## PC user history (NEW since 2026-06-03)

For shared workstations (`ZAST*` etc.) where multiple operators rotate
through one machine, the disk collector now also records interactive
login history into `pc_user_history`. On each scan:
- If `Win32_ComputerSystem.UserName` is null → skip (nobody logged in)
- If the most recent row for this PC has the same user → bump `last_seen`
  (same session continuing)
- Otherwise INSERT a new row (user change observed since last sweep)

API: `GET /computers/:id/user-history?days=N`. UI: clicking the User
cell in Computers tab opens a modal showing user, first_seen, last_seen,
duration per recorded session.

Retention via `pcUserHistory.retention_days` setting (default 90),
purged nightly by `sp_purge_pc_user_history` in the retention runner.

The IP cell in Computers tab now also has a tooltip showing
`Collected Nm ago` so the operator can see when the value was last
captured — both IP and current_user persist across offline states
(we only update them on successful scans).

## Inactive PCs feature (NEW since 2026-06-03)

Dashboard gets an **Inactive PCs (Nd+)** summary card mirroring the
operator's `AD-Get-InactiveADComputers04.ps1` report. A PC counts as
inactive when `computers.last_seen` is older than
`inactive.threshold_days` setting (default 90) OR is NULL. Excluded
PCs are skipped. The card shows total count with subtitle `N enabled ·
M disabled`; clicking drills to Computers tab with the `inactive`
status chip pre-applied.

- API: `GET /computers/inactive-stats` returns
  `{ thresholdDays, enabledInactive, disabledInactive, totalEnabled,
    totalDisabled }` in one query
- Computers tab: new `inactive Nd+` status chip + dropdown option;
  threshold read from inactiveStats prop so the chip label reflects
  the live setting value
- Settings: new "Inactive PC threshold" section
- Migration 022 + CS/EN i18n keys

## /docs translation status (2026-06-03)

`docs/dashboard.html` now has CS/EN parallel content across all major
sections. TOC links, all H2 / H3 headings, intro paragraphs, all callouts,
the Settings table, the Required Permissions section, all Troubleshooting
items, and the Security model table all have CS translations alongside EN.
Detailed reference tables (API endpoint list, DB schema column lists,
SQL/code snippets) stay EN — keywords like `Win32_Service`, `Get-WinEvent`,
`computer_id` are universal and don't translate. Each major collector
section has a CS "shrnutí" callout that summarizes the technical content
in Czech for readers who don't want to parse code-heavy English.

## i18n + theme (NEW since 2026-06-03)

`apps/desktop/src/i18n.tsx` provides two React context providers mounted in
`main.tsx`:

- **I18nProvider** — `useI18n()` returns `{ lang: 'cs' | 'en', setLang, t(key) }`.
  Initial pick: `localStorage['itd-lang']` → `navigator.language` (cs/sk → cs)
  → `en` fallback. Dictionary covers top-level UI (nav tabs, summary cards,
  status bar, common buttons). HelpBoxes and per-page text are still
  English-only this iteration — translation will roll in per-page so PRs
  stay reviewable.
- **ThemeProvider** — `useTheme()` returns `{ theme: 'dark' | 'light', setTheme }`.
  Toggles `body.theme-light` / `body.theme-dark` class. Light theme CSS
  variables live in `styles.css` next to the `:root` dark defaults.

Topbar has a CS|EN segmented control + ☀/☾ toggle. Clicking the
"ITDashboard" logo (h1) jumps to Dashboard view.

`/docs` page has its own CS/EN switcher driven by inline JS (no React there).
Pre-paint script in `<head>` sets `html[data-lang]` before content renders so
the opposite-language siblings never flash. Initial pick: `?lang=` query
→ `localStorage['itd-docs-lang']` → `navigator.language` → `en`. The React
app's Docs link forwards the current React lang via `?lang=` so the docs page
opens in the same language as the dashboard.

## Deploy diagnostic — topbar SHA is now load-bearing

Since commit `ae399cb`, `/version` returns the SHA captured at npm-build
time (`scripts/build-info.mjs` emits `src/build-info.ts`, gitignored).
Previously `/version` read `.git/refs/heads/main` at request time, so
the topbar could update on every `git pull` step in the deploy even if
later steps (migrate, service restart) failed. That history is why we
had 3 invisible half-deploys in a row on 2026-06-03 (current_user
reserved word, GO separator, regex escape) — topbar said the new SHA,
Node ran old code.

Deploy.yml now ends with a `Smoke test` step that curls
`/version/sha` up to 15 times (~30s) and fails the job if the running
SHA doesn't match `%GITHUB_SHA:~0,7%`. If that step fails, the deploy
run is RED — no more silent half-failures.

## Retention scheduler (NEW since 2026-06-03)

`services/retention-runner.ts` schedules a daily purge at
`retention.run_at_hour` (default 02:00 local server time) that calls:
- `sp_purge_old_events @retention_days = events.retention_days` (default 90)
- `sp_purge_old_activity @retention_days = activity.retention_days` (default 30)

Both stored procedures existed since migration 002 / 020 but nothing
was calling them — `events` and `activity_log` were growing forever.
Now purges run at 02:00 every day. Result logged via `logActivity` so
it appears in both live ring and `/activity/history`.

Manual trigger: `POST /activity/retention/run` (fire-and-forget).
Next scheduled run: `GET /activity/retention/status` returns `{ nextRunAt }`.

## `/health` (UPDATED since 2026-06-03)

Returns `{ status, ts, buildSha, builtAt, db: { ok, latencyMs, error? } }`.
HTTP 503 when DB is unreachable so Centreon (or any HTTP probe) can alert
specifically on `db_down`. The legacy `/health/db` endpoint is preserved
for existing callers.

## Windows Firewall Domain warning (NEW since 2026-06-03)

When the server's Windows Firewall Domain profile is disabled
(`Get-NetFirewallProfile -Profile Domain` → `Enabled=False`), the
dashboard shows a warning banner under the topbar with the fix command.
Dismissable per browser session (sessionStorage). The 'ITDashboard
API (4000)' allow rule is inert in that state and the frontend gate
is the only thing in front of the dashboard — which is the deliberate
operator-chosen model (no API auth, whoever connects is admin), but
operator should know the OS-level layer is off.

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
- Computers tab with AD sync, monitor toggle, exclude toggle, disk status, reachability status, current IP + logged-in user (collected piggyback on disk scan via the same DCOM session).
- Services tab with stopped auto-service detection, policy/drift classification, by-PC and by-service views, GPO script export.
- Perf tab with Diagnostics-Performance event data (slow boot/shutdown/standby/resume) — summary cards, top culprits, most affected PCs, recent events table.
- Activity tab with two modes: **Live** (in-memory ring buffer 500 entries, 2s poll) and **History** (DB-backed, filters: time range / level / source / text search, paginated). Every `logActivity` call is fire-and-forget persisted to `activity_log` table (retention `activity.retention_days`, default 30).
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
- `checks.run_perf`
- `checks.run_adsync` (default `false` in periodic — fleet AD MERGE is overkill every 15 min)
- `adsync.default_monitor_enabled` (default `true`) — applied to newly INSERTed PCs by AD sync. Existing PCs keep their current `monitor_enabled` flag (operator intent persists).
- `perf.cold_start_days` (default `30`) — how far back the perf-events collector reaches on the very first sweep of a PC. Subsequent sweeps go incrementally from the last collected event. Range 1–365.

Behavior:
- Scheduled checks run only inside the selected day/time window.
- Manual `Run all checks` runs even outside the window AND forces every check on, including AD sync — regardless of the `checks.run_*` selection. So clicking "Run all" always refreshes inventory from AD even if periodic AD sync is off.
- The checks runner uses a registry pattern so future checks can be added as new entries rather than new independent schedulers.
- AD sync is registered as the first check in the run order so subsequent collectors see fresh inventory in the same run.

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
enabled by default on Windows 10/11 (off by default on Server SKU, see below).
The collector pulls slow-event records via `Get-WinEvent -ComputerName ...`
(same RPC path as eventlog collector — needs Event Log Readers + RPC).
EventData is parsed from XML to extract `TotalTime`, `DegradationTime`,
`Name`, `FriendlyName`.

Cold-start window: configurable via `perf.cold_start_days` setting (default
30). Workstations are typically rebooted infrequently — events are sparse —
so a short window risks missing the previous reboot's events. After the first
successful sweep per PC, subsequent runs go incrementally since
`MAX(time_created)` for that computer.

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
