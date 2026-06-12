# ITDashboard Handoff

Last updated: 2026-06-12 (whitelist view filter + OS breakdown chart + reachability probe + faulty-PC detection)

> The values in **Current Live State** are this deployment's actual endpoints,
> kept here as the operator handoff record. They are **no longer hardcoded in
> code** — the source tree carries no IPs/hostnames/domain. To stand the project
> up elsewhere you change `apps/server/.env` (+ GitHub Actions repository
> Variables) only, never code. See [Config externalization (2026-06-11)](#config-externalization-2026-06-11)
> below and `.env.example` (single source of truth).

## Current Live State

- Project: ITDashboard
- Repo: `https://github.com/Anamax443/ITDashboard`
- Local path: `D:\git\ITDashboard`
- Runtime server: `10.8.2.213` / `B-S-W-MIKOS`
- Runtime path on server: `C:\Apps\ITDashboard`
- SQL server: `10.8.2.225`
- Database: `ITDashboard`
- Live commit: `7a2931b`
- Browser URL: `http://10.8.2.213:4000/`
- Docs URL: `http://10.8.2.213:4000/docs`

## Session 2026-06-12 — service whitelist as a view filter + OS breakdown chart

Two **client-only** features (apps/desktop). No server / DB / migration
changes — both build on data and settings the browser already holds.

### Service whitelist reused as a global view filter (commit `848af42`)

`alerts.services.whitelist` (Settings → "Email alerty — služby") used to gate
**email alerts only** (server-side eval in `apps/server/src/services/alerts.ts`).
The same string is now also applied **client-side as a view filter**, so a
known-benign service is suppressed everywhere, not just in mail:

- **Dashboard "Zastavené služby" tile** (`SummaryCards.tsx`) — whitelisted
  services are **always** excluded from the affected-PC count and the
  "N services" subtitle.
- **Services tab** (`ServicesPage.tsx`) — new **"Hide whitelisted"** checkbox
  (default **ON**) hides matching rows **and** removes them from the top-line
  counts (total · crashes · drift · OK · unclassified), in both the By-PC and
  By-service views. Folded into the export filter summary too.
- New shared helpers in `apps/desktop/src/api.ts`: `serviceWhitelist(settings)`
  → `RegExp[]` and `isServiceWhitelisted(name, displayName, whitelist)`, reusing
  the existing `svcGlob`/`svcNameList` matcher (case-insensitive, `*`/`?`
  wildcards, matches service name OR display name; empty whitelist = inert).

Motivation: `gupdate*` / `GoogleUpdater*` / `edgeupdate*` were inflating the
drift count and the tile even though they were already whitelisted for alerts.
One whitelist string is now the single source of truth for both "don't email"
and "don't show as noise". The i18n help under the whitelist field (CS+EN)
documents the broadened scope.

### Dashboard OS breakdown chart — live/stale split + drill-down (commit `38ba1c4`)

New homepage panel **"Operační systémy" / "Operating systems"**
(`apps/desktop/src/components/OsBreakdownChart.tsx`), rendered after
`SummaryCards` in `App.tsx`. Pure client-side aggregation over the already-loaded
`computers` array — **no new endpoint**.

- **Scope** = live managed fleet: `enabled && !excluded` (disabled / excluded
  machines are out of the chart).
- **OS normalization**: the single free-text AD `os_version` column is bucketed
  by shared `osBucket()` in `api.ts` → `Windows 11/10/8.1/8/7`,
  `Windows Server <year>[ R2]`, `Windows Vista/XP`, generic `Windows Server`,
  else `Other`; null/empty = `Unknown`. `summarizeOs(computers, thresholdDays)`
  returns per-bucket `{ total, stale, live }`.
- **Stale** reuses the inactivity model: `isStaleComputer(c, thresholdDays)` =
  not excluded AND `last_seen` null or older than `inactive.threshold_days`
  (default 90, migration 022) — the **same** definition as the existing
  "inactive" card/filter. These are the machines that aren't deactivated yet but
  clearly aspire to be.
- **Bars**: one horizontal bar per bucket, split into an active segment +
  a hatched dimmed **stale** segment. Clicking the active segment drills into
  the Computers tab filtered to that OS + **live**; clicking the stale segment
  filters to that OS + **stale**.
- **Drill-down plumbing**: `App.tsx` holds `computersOsFilter` and passes it to
  `ComputersPage` via `initialOsFilter`; the page consumes it into local
  `osFilter` state and applies it in the filter predicate (mirroring the chart
  scope: `enabled && !excluded && bucket match && requested staleness`). It
  renders as a **removable chip** ("OS: Windows 11 · stale ✕") and is mutually
  exclusive with the status chips. Because the chart and the filter both call
  `osBucket()`/`isStaleComputer()`, the segment counts and the drilled list
  agree by construction.
- New i18n keys (CS+EN): `os.title`, `os.stale`, `os.live`, `os.unknown`,
  `os.other`, `os.empty`, `os.clickFilter`, `os.filterLabel`.

Possible follow-ups: extra OS buckets if AD carries non-Windows or unusual
edition strings (they fall into `Other` today); an optional "include disabled"
toggle if the operator ever wants deactivated machines in the chart.

### Live network reachability probe drives the Status column (commit `a12ad36`)

Operator flagged that the Computers **Status** column was unreliable: boxes
unseen for months showed a green **"Active"**, and clearly-offline boxes showed
**"? Unknown"** — sometimes next to an OFFLINE-looking error. Root cause: Status
was a **by-product of the event-log collector**, not a liveness check. The
collector runs only on `enabled = 1 AND monitor_enabled = 1 AND excluded = 0 AND
consecutive_failures < cap`, classifies failures crudely
(offline / rpc_unavailable / access_denied / unknown), and **freezes** once a PC
passes the failure cap (it's skipped, so `last_status`/`last_error` stop
updating). So a reachable box whose event log we can't read showed "Unknown",
and an AD-enabled box never classified showed the green "Active" **fallback**.
There was **no ping** anywhere.

New **standalone reachability probe**
(`apps/server/src/services/reachability-collector.ts`):

- Probes **every `enabled = 1 AND excluded = 0` PC** — deliberately NOT gated by
  `monitor_enabled` or the failure cap, so even parked / unmonitored boxes get a
  live verdict.
- A plain **TCP connect to port 135** (RPC endpoint mapper), falling back to
  **445** (SMB). **Not ICMP ping** — Windows Firewall blocks ping by default in a
  domain, so a TCP port is the reliable "is it on the network" signal. First port
  that answers ⇒ reachable. Concurrency 16, self-contained (never throws).
- Persists `reachable` (BIT), `last_reachable_at` (bumped only on success),
  `reach_checked_at`.
- Wired into `checks-runner.ts` as a new `CHECKS` entry **`reachability`**
  (`settingKey checks.run_reachability`, default **on**), ordered **after adsync,
  before eventlog**, so Status reflects current reachability regardless of whether
  the other collectors succeed. `refresh-single-pc` also sets `reachable = 1` on a
  successful single-PC refresh.
- **Migration `032_reachability`**: adds the three columns + seeds
  `checks.run_reachability='1'`, `reachability.ports='135,445'`,
  `reachability.timeout_ms='2000'`.

**Status column redefined** to the operator's model
(`apps/desktop/src/pages/ComputersPage.tsx`):

- `!enabled` → **Disabled** (AD account disabled).
- `reachable === true` → **● Active** (on the network now). A secondary dim
  **"· ⚠ logs"** marker sits next to it when the box is up but the event-log
  collector is failing (`last_status` access_denied / rpc_unavailable / unknown,
  or `consecutive_failures > 0`) — tooltip shows `last_error`. This is the
  BERANVW11 case: reachable but unreadable.
- `reachable === false` → **○ Offline** (powered off / disconnected); tooltip
  shows "Last on network: …".
- `reachable == null` (not probed yet, transitional) → falls back to the old
  `last_status` chain with a neutral **"— not probed"** instead of the misleading
  green Active.

Also: new **`offline`** filter (status chip + dropdown option, =
`enabled && !excluded && reachable === false`), a **Settings** toggle for the
probe (`settings.check.reachability`, CS+EN), and `reachable` /
`last_reachable_at` / `reach_checked_at` on `ComputerItem` + `GET /computers`.

Three signals are now distinct: **reachability** (live, this probe) vs **event-log
collection health** (`last_status`) vs **AD inactivity** (`last_seen` /
`inactive.threshold_days`).

**Follow-up fix — collectors park on reachability, not a frozen counter
(same commit family).** All four collectors (eventlog / disk / services / perf)
used to skip any PC with `consecutive_failures >= 10`. That permanently
**parked** a box after a transient bad patch: once parked, the scheduled
collectors never retried it, so it stayed frozen (stale `last_seen`, old error,
the "⚠ logs" marker) until someone hit "Aktualizovat teď" (single-PC refresh
ignores the cap and resets the counter). Operator caught a healthy, reachable
server (B-S-W-VEMA-TEST) stuck this way. Each collector's `listTargets` now gates
on the live probe instead:
`(reachable = 1 OR (reachable IS NULL AND consecutive_failures < 10))` — collect
from any box the probe says is on the network regardless of past failures (so a
recovered box un-parks itself next cycle), skip confirmed-offline boxes, and fall
back to the old failure cap only when reachability is unknown (probe disabled /
not yet run). Reachability runs first in the cycle, so the value is fresh when
the collectors query it.

**Caveat:** the probe runs inside the periodic-checks window (`checks.days` /
`checks.window_*`, default Mon–Fri 06:00–18:00), so in the default config Status
is not refreshed overnight / weekends. Making it a window-independent fast timer
is a possible follow-up.

### Faulty-PC / reinstall-candidate detection (commit `31347b0`)

Operator wanted the dashboard to **tip off which PCs are "due for a reinstall"**
based on accumulated eventlog problems, as a second row of tiles.

Naive volume is misleading — one chatty source (the Brother BrLog driver that
spams ~1 event/sec is the canonical example; the dedup pass only removes EXACT
duplicates, so distinct-timestamp spam survives) would flag a healthy box. So the
score is a **damped blend** (`GET /events/pc-health` in `routes/events.ts`), over
a window (default 14 d), per `enabled && !excluded` PC:

- Per distinct **signature** (`provider_name + event_id + level`), occurrences are
  **capped** at `faulty.signature_cap` (20) — a driver screaming 4000× counts as
  20, not 4000.
- Weighted by severity: critical ×10, error ×3, warning ×1
  (`faulty.weight_critical/error/warning`).
- **Breadth** bonus: number of distinct error/critical signatures ×
  `faulty.weight_breadth` (5) — many DIFFERENT problems.
- **Persistence** bonus: distinct days with errors × `faulty.weight_persistence`
  (3) — problems across many DAYS.
- `score = Σ min(cnt, cap)·weight + signatures·5 + active_days·3`. Classified
  server-side: `>= faulty.threshold_risk` (150) → **risk** (reinstall candidate),
  `>= faulty.threshold_watch` (60) → **watch**, else dropped. Returns worst-first.

**Migration `033_faulty_pc`** seeds all nine knobs as settings (window / cap / the
three severity weights / breadth / persistence / watch / risk) — fully tunable, no
redeploy.

**Dashboard**: new component `HealthCards.tsx` renders a **second row of tiles**
below `SummaryCards` — "🩺 Kandidáti na přeinstalaci" (risk count, red) and
"Sledovat" (watch count, amber) — plus a **candidates panel** listing the worst
PCs with score + critical/error/warning + distinct error types + active days, each
row clickable to jump to that PC. `Card` is now exported from `SummaryCards.tsx`
for reuse.

**Drill-down**: clicking a tile sets `App.computersIdFilter = { ids, label }`,
passed to `ComputersPage` via `initialIdFilter` → consumed into local `idFilter`
state → filter predicate keeps only `c.id ∈ ids`. Shown as a removable red chip
("🩺 <label> (N)"); mutually exclusive with the status / OS / search filters.

**Client cadence**: `api.pcHealth()` is fetched on its OWN slow 5-min interval (the
14-day GROUP BY is heavier than the 30 s dashboard refresh) and re-pulled when any
`faulty.*` setting changes. New **Settings** block "Vadné PC / kandidáti na
přeinstalaci" exposes window / cap / watch / risk; weights stay DB-tunable. CS+EN.

Tuning note: thresholds 60/150 are first guesses — watch the panel for a week and
nudge `faulty.threshold_*` so the "risk" tile holds the genuinely-sick boxes.

## Config externalization (2026-06-11)

Goal: the repo can be handed to a third party who only changes access/config,
not code. All site-specific values now live in `apps/server/.env` (template:
`.env.example`, the single, accurate source of truth listing exactly the
variables the code reads).

Code changes (branch `chore/externalize-config`):

- **Browser client uses relative API URLs.** `apps/desktop/src/api.ts` no longer
  falls back to a hardcoded `http://10.8.2.213:4000`. The browser build is served
  by the API itself, so an empty base = same-origin relative requests — portable
  with no rebuild. Only the packaged Electron client still needs `VITE_API_BASE`
  baked at build time.
- **Installer API base injected at download.** `GET /actions/install-handlers.cmd`
  now rewrites the `ITD_API_BASE` line to the URL the browser fetched it from
  (honoring `x-forwarded-proto`/`x-forwarded-host` for reverse-proxy TLS). The
  committed `.cmd` default is a neutral `http://localhost:4000` placeholder.
  `ITD_API_BASE_OVERRIDE` still wins for a custom endpoint.
- **No hardcoded AD domain.** `apps/server/src/auth/ldap.ts` dropped the
  `AD_LDAP_DOMAIN ?? 'AXINETWORK.LOC'` default. When unset, bare usernames pass
  through unchanged (operator supplies full UPN / `DOMAIN\user`) and the
  edit-group filter matches on `sAMAccountName` alone instead of an invalid
  `user@` UPN.
- **Genericized environment-specific examples** in `i18n.tsx` (firewall help text,
  example IPs) and in `ad-bridge` / `ad-sync` / `ip-guard` comments.

Docs synced the same day: `README.md` ("Configuration" section), `.env.example`
(rewritten as the single config surface — documents trusted-only SQL auth and the
GitHub Actions Variables the deploy pipeline reads), `docs/ARCHITECTURE.md`
("Configuration & portability"), `docs/dashboard.html` (CS/EN "Configuration"
chapter + Reference-deployment box), `docs/SETUP-SERVER.md` ("Reference deployment
values" table + parametric runbook), and `docs/project-status.html` (new status
page). Dated historical records (oponentury / audit / change-requests) were left
unchanged — they are point-in-time records.

## Disk-critical email alerting (2026-06-11)

Per-PC opt-in email reports when a "key" PC's disk goes critical. Off by
default; configured entirely in the Settings UI (DB `settings`, `alerts.*`
keys) — nothing in `.env`, consistent with the portability model.

How an operator uses it:

- **Computers tab → "📧 Disk" column** — tick the key PCs. Each ticked PC has a
  small letters field next to the checkbox: type `C` or `C,F` to watch only
  those drives; empty = all in-scope drives. Same scope syntax as
  `disk.crit_drives` (`C`, `C,D`, `<>C`/`!C`, `*`).
- **Settings → "Email alerts — disks"** — master enable, frequency (hours),
  SMTP relay host + port, sender, recipients (one per line / comma), **dashboard
  address** (`alerts.dashboard_url`, e.g. `http://10.8.2.213:4000` — rendered as
  an "Otevřít ITDashboard" button + footer link in the email), and a **Send test
  email** button. The test button now **auto-saves** pending edits before sending
  (no need to click Save first).
- **The report email** is mobile-friendly HTML: one card per critical disk (PC
  name, drive + label, used/free bar, free/total + % free), the affected PC's
  **IP address**, and a **generation timestamp** (Europe/Prague) in the footer.
  Plaintext fallback included.
- **Dashboard** — "Watched disks" tile shows criticalPcs/monitoredPcs + on/off;
  clicking it filters Computers to the monitored PCs.

Behavior: after every disk scan, monitored PCs' in-scope drives are evaluated
against the CRITICAL threshold (from Disks settings). If any is critical, an
email report goes out — throttled to once per `alerts.disk.frequency_hours`
(default 24) while the condition holds. Edge + reminder: first detection sends
immediately, reminders at the cadence, recovery resets the throttle
(`alerts.disk.last_sent_at`) so the next incident alerts promptly.

Implementation (branches `feat/disk-email-alerts` + `feat/disk-email-per-drive`):

- `apps/server/src/services/alerts.ts` — nodemailer SMTP send + server-side
  critical-disk eval (mirrors the dashboard scope/threshold rules) + throttle.
  Hooked at the end of `runDiskCollectorOnce`; self-contained and never throws
  so a mail failure can't fail the scan.
- Routes: `PATCH /computers/:id/disk-email-monitor { enabled?, drives? }`,
  `POST /alerts/disk/test`. `GET /computers` returns `disk_email_monitor` +
  `disk_email_drives`.
- Migrations: `028_disk_email_alerts` (computers.disk_email_monitor BIT +
  alerts.* settings seed), `029_disk_email_drives` (computers.disk_email_drives).
- Adds the `nodemailer` dependency.
- Transport assumes no client auth (opportunistic STARTTLS, cert validation
  disabled). For this deployment that maps to Microsoft 365 Direct Send — see the
  Mail transport section below. Add `alerts.smtp_user`/`password` handling later
  only if a relay ever requires authenticated submission.
- `alerts.dashboard_url` is a plain settings key (no migration) — created on
  first save; empty by default so the email link is simply omitted until set.

**Operator setup checklist:** in Settings → Email alerts fill host
`axima-cz.mail.protection.outlook.com`, port `25`, From an `@axima.cz` address,
recipients, and dashboard address `http://10.8.2.213:4000` → click "Send test
email" (it auto-saves) and confirm it arrives → tick the key PCs (📧 Disk,
optional letters) → flip the master enable on.

### Mail transport — Microsoft 365 Direct Send (verified 2026-06-11)

The `axima.cz` mail domain is Microsoft 365 (MX
`axima-cz.mail.protection.outlook.com`); there is no on-prem Exchange/relay. So
ITDashboard sends via **O365 Direct Send**: host
`axima-cz.mail.protection.outlook.com`, port **25**, STARTTLS, **no password**
(identity by sending IP/SPF), From an `@axima.cz` address. Direct Send delivers
**only to your own domain** (`@axima.cz`) — no external recipients. Verified
landing in the Inbox on 2026-06-11.

- Port options if ever needed: 25 = Direct Send / MX (no auth, own domain only);
  587 = `smtp.office365.com` SMTP AUTH (licensed mailbox + app password due to
  MFA, any recipient); 465 = SMTPS implicit TLS (legacy).
- Deliverability: if mail from the API server `10.8.2.213` gets quarantined /
  Junked, add that server's public/NAT egress IP to the `axima.cz` SPF record.
  Not needed as of 2026-06-11 (Inbox delivery confirmed).

### Reliability / CI fixes (2026-06-11)

- **Access flash on deploy fixed** — the access-check whitelist now loads
  (`refreshIpGuard('boot')`) before `app.listen()`, so the brief
  "Access not configured" window right after each service restart is gone.
- **GitHub Actions** — `actions/checkout` + `actions/setup-node` bumped v4 → v5
  (Node 24; GitHub forces Node 24 onto runners from 2026-06-16).
- **Computers sorting** — comparator is now locale-aware with numeric chunking
  (IPs `10.8.2.9 < 10.8.2.10`, hostnames `PC2 < PC10`, accents; nulls last); the
  "Status" column sorts by the displayed reachability status (`last_status`), not
  the `enabled` flag. Closing the Per-PC Actions modal after a manual single-PC
  refresh re-syncs the main list.

## Critical-service email alerting (2026-06-11)

Mirror of disk alerts for Windows services, with flapping protection. Off by
default; configured in Settings (`alerts.services.*`). Shares SMTP relay /
sender / recipients / dashboard URL with the disk alerts.

How an operator uses it:

- **Computers tab → "🔔 Služby" column** — tick the key servers (DCs, backup /
  file servers). A "🔔 svc" chip + "service monitored" filter list them.
- **Settings → "Email alerty — služby"** — master enable, **debounce** (minutes a
  service must stay down before the first alert — the flapping guard), **reminder**
  (hours), **maintenance window** (`HH:MM-HH:MM`, may cross midnight, suppresses
  alerts), the **critical-services list** (names, `*`/`?` wildcards; seeded with
  NTDS, DNS, Kdc, Netlogon, W32Time, VMTools, VeeamBackupSvc, VeeamBrokerSvc,
  ekrn, DHCPServer, LanmanServer) and a **whitelist** (never alert on these even
  if matched — e.g. `gupdate*`, `GoogleUpdater*`), plus a save-first test button.
- **Dashboard** — "Sledované služby" tile (affectedPcs/monitoredPcs + on/off);
  clicking it filters Computers to the service-monitored PCs.

Behavior: after every services scan, monitored PCs' Auto + non-Running services
matching the critical list (and not whitelisted, excluding per-user services) are
alerted — but only once a service has been down ≥ `alerts.services.debounce_minutes`
(default 10), outside the maintenance window, throttled by
`alerts.services.frequency_hours` (default 24). The per-(PC,service) outage clock
+ last-sent live in the `service_alert_state` table; recovery clears the row so
the next outage starts a fresh debounce.

Implementation: service-alert logic in `apps/server/src/services/alerts.ts`
(glob match critical/whitelist, time-based debounce, maintenance-window
suppression, throttle, mobile report), hooked at the end of `runServicesScanOnce`
(self-contained, never throws). Routes `PATCH /computers/:id/service-email-monitor`,
`POST /alerts/services/test`; `GET /computers` returns `service_email_monitor`.
Migration `030_service_email_alerts` (computers.service_email_monitor +
service_alert_state + alerts.services.* seed).

### Port reachability checks (phase 2, shipped 2026-06-11)

Watching `State='Running'` misses "running but unreachable" (firewall / freeze).
Phase 2 adds outside-in TCP probing: for each `service_email_monitor` PC the API
host TCP-connects key infra ports after each services scan — **LDAP 389, SMB 445,
RDP 3389, Kerberos 88, DNS 53** (all TCP; Windows DNS listens on TCP 53 too) —
testing the whole path network→firewall→OS→service.

- **Baseline learning** (false-positive guard): a (PC, port) is only alert-eligible
  once it has been reachable at least once (`port_check_state.last_ok_at`); a port
  that never answers on a box (e.g. RDP closed) is never alerted. → enable it and
  let one scan run before expecting alerts, so the baseline is learned.
- **Whole-PC-offline skip**: if TCP/135 is unreachable the PC is skipped, so a
  powered-off box doesn't fire one alert per port (that's the reachability card).
- Reuses the service `debounce_minutes` / `maintenance_window` / `frequency_hours`;
  own enable toggle.
- Settings (in the services section): `alerts.services.port_checks_enabled`,
  `alerts.services.port_checks` (seeded `LDAP:389,SMB:445,RDP:3389,Kerberos:88,DNS:53`),
  `alerts.services.port_timeout_ms` (2000) + a "Test ports (live probe)" button.
- Implementation: `evaluateAndSendPortAlerts` in `alerts.ts` (TCP probe, baseline,
  debounce/maintenance/throttle, own mobile report), hooked after the service
  alert eval in `runServicesScanOnce`. Route `POST /alerts/ports/test`. Migration
  `031_service_port_checks` (port_check_state table + the settings seed).

### Bulk column toggles (Computers tab, 2026-06-11)

The 📧 Disk, 🔔 Services and Exclude column headers each have a "✓ all / ✗ none"
control that sets that flag for all currently **visible (filtered)** rows — e.g.
filter to your servers, then ✓ the 🔔 column to enable service alerts on all of
them. Server: `POST /computers/bulk-flag { ids, flag, value }` (whitelisted flag
column: `monitor_enabled` / `disk_email_monitor` / `service_email_monitor` /
`excluded`).

## Protocol handler follow-up oponentura (NEW since 2026-06-03)

Third review of `apps/server/scripts/install-itd-handlers.cmd` archived:
`docs/oponentury/2026-06-03-oponentura-3-protocol-handlers-followup.md`
plus response
`docs/oponentury/2026-06-03-reakce-3-protocol-handlers-followup.md`.
Verdict: current hardened installer is OK to deploy; no new blocker.
Review confirms strict hostname allowlist, HKCU install, PsExec opt-in,
and browser prompt guidance. Three non-blocking notes were recorded:
`runas /netonly` password prompt is accepted UX friction, `itd-explorer`
intentionally supports only admin shares (`C$`, `D$`), and inner quoting
inside the `runas` command string is left unchanged because host/snap-in
inputs are already constrained and changing `runas` quoting risks a
runtime regression without security gain.

Follow-up docs sync completed after the review:
- `README.md` now mentions Per-PC Actions and links both follow-up review docs.
- `docs/ARCHITECTURE.md` has a "Per-PC Actions and URL protocol handlers"
  security/design section.
- `docs/dashboard.html` has a CS/EN `Per-PC Actions` chapter plus Security
  model rows for custom URL handlers.
- `apps/desktop/src/i18n.tsx` + `PcActions.tsx` show the same CS/EN follow-up
  note in the Actions modal warning block.

## Protocol handler installer window-closes fix (NEW since 2026-06-03)

Operator reported: running/launching handler opens a CMD window and it
immediately closes. Root cause found in `apps/server/scripts/install-itd-handlers.cmd`:
the installer was LF-only and `cmd.exe` on Windows parsed it incorrectly
(commands appeared as `etlocal`, `cho`, `all`, etc.). There was also an
unsafe `::` comment containing cmd metacharacters from the security prose.

Fix prepared locally:
- New `.gitattributes` pins `*.cmd` and `*.bat` to CRLF.
- Installer comments are ASCII/cmd-safe.
- Generated launchers now keep the console open only on validation/setup
  failure, print the reason, and write `last-itd-*.log` under
  `%LOCALAPPDATA%\ITDashboard\launchers`.
- Validation uses delayed expansion and `goto :fail`, so malformed URLs do
  not break the batch parser before the allowlist check.

Verified locally with `cmd /c "apps\server\scripts\install-itd-handlers.cmd < nul"`
and generated invalid URL tests:
- `itd-rdp://bad host` -> visible `invalid_host_chars`
- `itd-explorer://PC/ShareName` -> visible `invalid_drive_letter`

Important after deploy: existing operator workstations do not update their
HKCU protocol handlers automatically. Download and run
`/actions/install-handlers.cmd` again on the workstation to overwrite the
old generated launchers.

Docs/UI sync for this fix completed:
- `README.md` documents the `0cc27a3` installer fix and reinstall instruction.
- `docs/ARCHITECTURE.md` records CRLF as load-bearing for `.cmd/.bat` and notes
  that HKCU handlers require manual reinstall after installer changes.
- `docs/dashboard.html` has CS/EN Per-PC Actions callouts and a CS/EN
  Troubleshooting entry for "CMD window flashes and closes".
- `apps/desktop/src/i18n.tsx` + `PcActions.tsx` show the reinstall guidance in
  the Actions modal warning block.

## Installer console reflection hardening (NEW since 2026-06-03, oponentura 4)

Fourth review of `apps/server/scripts/install-itd-handlers.cmd` archived:
`docs/oponentury/2026-06-03-oponentura-4-installer-v2-review.md`
plus response
`docs/oponentury/2026-06-03-reakce-4-installer-v2-review.md`.
Verdict: production enterprise-ready; one minor note accepted and fixed in
the same commit (not shipped as-is).

Issue: generated launcher `:fail` block printed `echo URL: "!url!"` to the
console. The raw URL is attacker-controllable via the protocol handler
invocation, so a crafted URL containing ANSI escape sequences could
manipulate the operator's terminal display (console reflected injection).
Risk in practice is small (internal domain tool, threat model = incidental
discovery, not adversarial), but the fix is trivial and the
`feedback_go_to_market_standard` rule says ship as if for paying customers.

Fix in same commit:
- `apps/server/scripts/install-itd-handlers.cmd` `:append_common_footer` no
  longer emits `echo URL: "!url!"` for the generated launchers. Console echo
  on validation failure prints only `!reason!`, `!host!`, `!letter!` — all
  pre-validated against `[a-zA-Z0-9._-]` (or a single letter for the drive),
  so they cannot contain control bytes.
- Raw `!url!` is still written to `%LOCALAPPDATA%\ITDashboard\launchers\last-itd-*.log`
  — file writes are not subject to terminal escape interpretation, and the
  helpdesk needs the original input for diagnosis.
- The console message after the log path was updated from `Wrote log:` to
  `Full URL recorded in:` so operators know where to look.
- Inline comment in the installer documents the intent so future maintainers
  do not "fix" the missing URL line back into existence.

After deploy: existing operator workstations still need to re-download and
re-run `/actions/install-handlers.cmd` (same HKCU-launcher non-self-updating
behaviour as the previous fix).

Docs/UI sync for this fix completed:
- `README.md` mentions oponentura 4 + console reflection hardening line.
- `docs/ARCHITECTURE.md` notes raw URL is intentionally not echoed to console.
- `docs/dashboard.html` has CS/EN Per-PC Actions callout for the change and
  a CS/EN troubleshooting entry "URL line missing from fail screen".
- `apps/desktop/src/i18n.tsx` + `PcActions.tsx` show a one-line note in the
  Actions modal warning block.

## Session 2026-06-04 — landed features summary

Single big day. Below is the timeline of meaningful changes in order
shipped. Each has its own commit + section further down in this
HANDOFF; this block is the index.

**Auth + governance:**
- Sprint 1.5 — AD edit-group gate (LDAP_MATCHING_RULE_IN_CHAIN
  transitive), `AD_LDAP_STUB=1` refused with `NODE_ENV=production`,
  downloaded `.bat` files for PsExec + admin-share now wrap in
  `set /p adminuser` + `runas /netonly` so a multi-tier-account
  workstation never silently falls back to the basic-tier user.
- Multi-DC LDAP failover via comma-separated `AD_LDAP_URL`.
- Sprint 1.6 prep (CR archived + reakce + meta-review + 2nd reakce):
  DC-side changes already executed (DNS A + 2 SPNs on
  svc-itdashboard); MIKOS-side IIS install + reverse proxy + TLS
  binding still pending separate CR. Server-side env vars
  configured (`NODE_ENV`, `AD_LDAP_URL`, `AD_LDAP_DOMAIN`,
  `AD_LDAP_BASE_DN`, `AD_EDIT_GROUP`); ldapMode reports "ldap".
- gMSA for svc-itdashboard explicitly REJECTED by operator —
  remains regular domain user account.
- ITDashboard-Editors AD group populated with 8 members (4 admin +
  4 pcadmin tier).

**Retention pipeline:**
- Events dedup daily pass via `sp_purge_duplicate_events` alongside
  the existing purges. Settings: `events.dedup_enabled` (default 1),
  `events.dedup_lookback_days` (default 90).
- Settings UI surfaces the full retention block (events / activity /
  pc_user_history retention days + run hour + dedup enabled +
  dedup lookback).
- Manual retention run button + structured run report (per-step
  rows / duration / status). New routes `GET /api/retention/status`
  + `POST /api/retention/run`.
- Per-step checkboxes for the manual run — operator picks what to
  delete; scheduled cron stays as before. UI clearly separates
  "Manual run" from scheduled config.

**Services tab (Sprint 1.7 — alert-fatigue oponentura outcome):**
- Win32ExitCode + ServiceSpecificExitCode now captured by the
  collector. Migration 026 adds `exit_code` + `service_specific_exit_code`
  columns to `service_problems`.
- Services tab gets an "Exit" sortable column + new "⚠ Only
  ExitCode != 0" filter chip (default ON — primary "show only what
  requires action" view).
- Hide trigger-start / Hide delayed-start filters refined: now hide
  ONLY graceful (exit=0). A trigger-start service that actually
  crashed (exit != 0) always surfaces even with these hides on.
- Header tile metrics: "⚠ N crashes" (bold red, primary metric) +
  "N graceful" (dim, informational).
- NIS2 / ISO 27001 monitoring policy section in dashboard.html
  (CS+EN) — what is monitored, what is hidden by default + why,
  ExitCode semantics, known blind spots (no crash-loop detection,
  no state history, per-install whitelist, scan interval gap).

**Per-tab table UX (Sprint 1.8):**
- Export menu on every table tab (Události, Počítače, Služby,
  Aktivita, Výkon) with PDF / HTML / CSV / TXT outputs. Filter
  banner in the exported file when filters are active.
- New per-page filter help: `events.help.filters` rewritten + new
  `Filtrování — vícenásobná kombinace` section in dashboard.html
  (CS+EN) explaining AND combination, clearing, examples.
- Search inputs widened 2x across all tabs (160-200 → 320-400 px).
- Floppy disk emoji ⚠ NEVER for scan — replaced with 🩺
  (diagnostic) in computers.help.actions + Scan disks button +
  dashboard.html. New memory rule
  `feedback_icon_semantics.md` to prevent future regression.
- Events tab: new Event ID filter input — single ("4098"),
  inclusive range ("4000..8000" or "4000-8000"), or comma list
  ("1001, 4098"). Invalid input → red border + filter inactive.
- Cross-tab navigation: clicking a computer name in Events /
  Services / Perf jumps to the Computers tab with the search field
  pre-filled with that hostname (status chip filter cleared so the
  PC always shows).

**Disk evaluation refinements:**
- Per-tier drive-letter scope: separate `disk.crit_drives` and
  `disk.warn_drives` settings instead of one shared list. Negation
  syntax (`<>C` or `!C`) so "everything except C" is concise.
  Default both = "C" (system drive only). Typical multi-drive
  recipe: critical="C", warning="<>C" (data / external = warning,
  never critical). Legacy `disk.eval_drive_letters` still works
  as the fallback for both.
- DiskThresholds API restructured: DriveLetterScope discriminated
  union (`all` / `include` / `exclude`), `evaluateDiskWithScope`
  is the single source of truth used by both summarizeDisks and
  ComputersPage worstDiskByComputer (removes a duplicate inline
  threshold calculation).

**Memory rules saved this session:**
- `feedback_default_workflow_docs_push.md` — never ask about
  updating docs/translations/HANDOFF + push to main; always do.
- `project_itdashboard_svc_account.md` — gMSA rejected, stays
  regular user account.
- `feedback_icon_semantics.md` — floppy disk = SAVE, never scan;
  use 🩺 for diagnostic operations.

**Still in queue (next session):**
- MIKOS-side CR: install IIS + URL Rewrite + ARR + Windows Auth
  site + reverse proxy to Node :4000 + HTTPS binding (AD CS cert).
- Node-side session-windows endpoint + AuthGate Windows-first flow
  (session-store.ts groundwork already merged with `authMethod`
  union + createWindowsSession; auth.ts COOKIE_OPTS wired with
  `ITD_COOKIE_SECURE` env var to flip on TLS rollout).
- AD Users tab (Sprint 2): cron `Get-ADUser` → MSSQL → searchable
  list + click-through detail with reset / unlock / disable
  actions via PS Remoting.
- Services crash-loop detection (Sprint 2 candidate from
  ExitCode reakce).
- Central whitelist tools (GPO/CMDB import + audit log).
- AND / OR / NOT / phrase syntax in Search inputs (operator
  question raised, parser not yet shipped).
- Dashboard.html in-page search (find-in-doc with highlight).
- Per-PC drive-letter override (Sprint 2 candidate — global
  setting works for now).

## Events table dedup (NEW 2026-06-04)

Operator observed Brother BrLog firing ~1 event/sec on PLUSKALPW10NTB,
visible as wall of "FindPushAwareAppName: Invalid Arg" in Recent events.
Beyond the noisy-driver problem itself (separate question), pointed out
the collector design has a duplicate-insertion bug on the watermark
boundary:

- Collector cron uses `last_collected_at` time watermark (run start time)
- `Get-WinEvent -FilterHashtable @{StartTime=$sinceIso}` is inclusive (>=)
- Events landing in the overlap window between two runs are inserted
  TWICE — once in the run that ends at T, once in the run that starts
  at T (same StartTime cutoff)
- `events` table PK is (identity id, time_created), there is NO UNIQUE
  constraint on the natural key, so DB accepts duplicates silently
- For a noisy 1-event/sec driver, ~300 duplicate rows per 20-min cycle

Operator's preferred mitigation: **dedup cleanup pass** (not insert-time
UNIQUE INDEX). Reasoning: ship the cleanup in the same daily retention
pipeline (already runs at 02:00 server time, already proven path), no
INSERT-path change, no migration risk on existing table.

Implementation:
- Migration 025_event_dedup.sql adds `sp_purge_duplicate_events
  @lookback_days INT = 90`. CTE with `ROW_NUMBER() OVER (PARTITION BY
  computer_id, log_name, event_id, time_created, provider_name ORDER BY
  id ASC)`. Deletes rows with rn > 1, keeps lowest id.
- Settings: `events.dedup_enabled` (default '1'), `events.dedup_lookback_days`
  (default '90' = same as `events.retention_days` so dedup covers
  everything not yet purged).
- `retention-runner.ts` adds a `callProc` generic helper (existing
  `callPurge` is now a thin wrapper) so we can pass `@lookback_days`
  instead of `@retention_days`. Dedup call lands after the three purge
  calls (events, activity_log, pc_user_history).
- Operator can flip `events.dedup_enabled = '0'` via settings UI or
  direct DB if they ever want to skip the pass.

Audit trail: `retention` source in `activity_log` gets a new entry per
day like:
  events dedup: 14523 duplicate rows removed within 90d window (8.4s)

The fix does NOT address insert-time prevention. If duplicate inserts
become a hot-path performance problem (unlikely at current scale), a
follow-up could add `CREATE UNIQUE INDEX ... WITH (IGNORE_DUP_KEY=ON)`
on the natural key as defense in depth.

The noisy Brother BrLog driver itself is a separate concern — operator
could either fix it on PLUSKALPW10NTB (drivers/Brother knowledge) or add
a per-PC eventlog source exclusion in the collector (not done here,
Sprint 2 candidate).

## Multi-DC LDAP failover (NEW 2026-06-04)

Operator's environment has 3 domain controllers. `ldapts` does not do
AD's SRV-record DC discovery, so we need to list DCs explicitly.

`AD_LDAP_URL` env var now accepts a comma-separated list of LDAP URLs
(one entry per DC). The bind loop tries them in order; on a connection
or timeout error it tries the next one. On a definitive auth response
(invalid_credentials, not_in_edit_group, or success) it stops
immediately — no point retrying a wrong password against another DC.

Example:
```
AD_LDAP_URL = ldap://10.8.2.254:389,ldap://10.8.2.X:389,ldap://10.8.2.Y:389
```

Or with FQDNs (allows DC name to flip IP without re-deploying):
```
AD_LDAP_URL = ldap://AD1.axinetwork.loc:389,ldap://AD2.axinetwork.loc:389,ldap://AD3.axinetwork.loc:389
```

Single-DC config (`AD_LDAP_URL = ldap://10.8.2.254:389`) still works
unchanged.

Audit log records which DC was hit per session (already part of the
session_created entry in activity_log).

## Sprint 1.5 — edit-tier hardening (NEW 2026-06-04)

Refinement of Sprint 1 after design discussion with operator about the
read-tier / edit-tier split:

**Tier model in operator's environment:**
- Read tier (dashboard view, list, search, filter, "Aktualizovat teď"
  refresh-single-PC) = whitelist IP, no auth, runs under svc-itdashboard.
- Edit tier (Launch buttons opening MMC / Services / Event Viewer /
  Task Scheduler / RDP / PsExec / PowerShell Remote / admin shares
  on remote PC) = requires personal AD admin attribution.

Operator runs Windows with a multi-tier identity model: basic-tier
user (own PC only), admin-tier-PC (client stations), admin-tier-server
(servers), admin-tier-DC (DCs). Sprint 1 forced auth at the dashboard
modal (correct). But three gaps remained:

### 1. AD edit-group gate (`AD_EDIT_GROUP`)

Without group membership check, ANY domain user that knows their own
password could LDAP-bind successfully and unlock the edit tier. Even a
janitor with a domain account would pass. Fixed in
`apps/server/src/auth/ldap.ts:checkEditGroupMembership` using AD's
`LDAP_MATCHING_RULE_IN_CHAIN` OID `1.2.840.113556.1.4.1941` for
transitive group resolution (nested group memberships honored).

New env vars on server:
- `AD_EDIT_GROUP` (distinguishedName, e.g.
  `CN=ITDashboard-Editors,OU=Groups,DC=AXINETWORK,DC=LOC`)
- `AD_LDAP_BASE_DN` (search root, e.g. `DC=AXINETWORK,DC=LOC`)

Behavior matrix:
- Production + `AD_EDIT_GROUP` set → require group membership.
- Production + `AD_EDIT_GROUP` unset → deny by default (operator
  must explicitly configure the gate; cannot accidentally ship open).
- Development + `AD_EDIT_GROUP` unset → allow (iteration without
  group infrastructure).
- Successful bind that's not in the group returns
  `not_in_edit_group` reason, surfaced in modal as a localized
  message asking the user to contact an admin.

### 2. Stub-mode off in production (`AD_LDAP_STUB`)

`AD_LDAP_STUB=1` accepts any non-empty credentials and is for
first-deploy local testing only. Module-init guard in
`apps/server/src/auth/ldap.ts` throws at boot if
`NODE_ENV=production && AD_LDAP_STUB=1`. A forgotten env var cannot
silently open the edit tier in production.

### 3. Downloaded files force admin credential prompt

`.rdp` (already had `prompt for credentials:i:1`), `.bat` for PsExec
and admin-share open both rewritten in
`apps/desktop/src/components/PcActions.tsx` to:
- `set /p adminuser=Admin account (DOMAIN\\user or user@domain): `
- `runas /netonly /user:"%adminuser%" "<tool> <args>"`

Operator who double-clicks a downloaded .bat now ALWAYS sees a CMD
prompt for the admin identity, then a Windows credential dialog for
the password — no silent fallback to current Windows session creds
(which would be the basic-tier user that lacks remote admin and
silently fails Access Denied without explanation).

`Kopírovat příkaz` / `Kopírovat UNC` / `Kopírovat hostname` stay
read-tier (they just put a string on the clipboard; operator chooses
when and how to use it).

### Files touched

- MOD: `apps/server/src/auth/ldap.ts` — production-stub guard +
  `checkEditGroupMembership` + new env vars `AD_LDAP_BASE_DN`,
  `AD_EDIT_GROUP`. New `not_in_edit_group` reason in `LdapBindResult`.
- MOD: `apps/desktop/src/components/AuthGate.tsx` — handle the new
  reason in the modal.
- MOD: `apps/desktop/src/components/PcActions.tsx` — `psexecBat` and
  `shareBat` wrap tool invocation in `set /p adminuser` + `runas
  /netonly`.
- MOD: `apps/desktop/src/i18n.tsx` — CS+EN `auth.notInEditGroup`.
- Docs: HANDOFF / README / ARCHITECTURE / dashboard.html (CS+EN).

### Deployment steps

On the server (MIKOS, NSSM environment for `ITDashboardAPI`), in
addition to the Sprint 1 env vars:

```
AD_LDAP_BASE_DN = DC=AXINETWORK,DC=LOC
AD_EDIT_GROUP   = CN=ITDashboard-Editors,OU=Groups,DC=AXINETWORK,DC=LOC
NODE_ENV        = production
```

Plus create the `ITDashboard-Editors` AD group (or pick an existing
group) and add the IT specialists who should have edit tier access.

After deploy, the modal will reject:
- Anyone whose creds don't bind (invalid_credentials)
- Anyone valid who isn't a member of the edit group
  (not_in_edit_group)

Operator + designated admins go through; unrelated domain users
cannot escalate via the dashboard.

## Auth Gate Sprint 1 — page-load credentials + token mode (NEW since 2026-06-03)

Real deployment scenario: many workstations, many IT specialists. Operator
wanted: "send a link, recipient opens the page, types their admin creds
once, every Launch from that browser session uses those creds — no
per-launch password prompt".

Implemented as a server-mediated short-lived credential vault. New auth
backend stores session creds in MEMORY only (Node Map), per-launch
generates a one-shot redeem token, launchers redeem the token over HTTP
and use the creds via cmdkey (then clean up on tool exit).

### Backend (`apps/server/src/auth/*` + `apps/server/src/routes/auth.ts`)

- `session-store.ts` — in-memory `sessions` and `tokens` Maps with TTLs:
  - Session: 30 min idle, 8 h hard max; sweeper runs every 60 s.
  - Launch token: 30 s TTL, one-shot (redeemed flag).
- `ldap.ts` — `ldapBind(user, pass)` using `ldapts` against `AD_LDAP_URL`.
  - Falls back to stub validation when `AD_LDAP_STUB=1` and no URL set
    (for dev / first-deploy testing).
  - Domain default `AXINETWORK.LOC`; user accepts NetBIOS `DOMAIN\u`,
    UPN `u@domain`, or bare `u` (normalized to UPN).
- 5 routes under `/api/auth/*`:
  - `POST /api/auth/session` — LDAP bind, store creds, set HttpOnly
    `itd-session` cookie with `SameSite=Strict`.
  - `POST /api/auth/logout` — invalidate session + clear cookie.
  - `GET /api/auth/whoami` — session check (returns `authenticated`,
    `user`, `expiresAt`, `ldapMode`).
  - `POST /api/auth/launch-token` — generate one-shot token for a
    target+tool combo; requires active session cookie.
  - `GET /api/auth/redeem?token=X` — consume token, return
    `{user, password, target, tool}`. Called by launcher .cmd.
  - `GET /api/auth/stats` — diagnostic (active session count, pending
    tokens, ldap mode).
- Every state-change route emits to `logActivity` for audit trail
  (session_created / launch_token_created / redeem_ok / redeem_failed /
  LDAP bind failed reasons).

`@fastify/cookie` plugin registered in `apps/server/src/index.ts`.

### Frontend (`apps/desktop/src/components/AuthGate.tsx`)

- `<AuthProvider>` wraps `<App>` in `main.tsx`.
- Exposes `useAuth()` hook with: `state` (authenticated, user,
  expiresAt, ldapMode), `refresh()`, `ensure()` (returns Promise<boolean>
  — pops modal if not authenticated), `signOut()`.
- Modal has user + password fields, submits to `/api/auth/session`,
  shows error message on `invalid_credentials` or other failures.
- `getLaunchUrl(target, tool, baseUrl)` helper POSTs to
  `/api/auth/launch-token`, returns the protocol URL with `?tk=TOKEN`
  appended.

### PcActions integration (`apps/desktop/src/components/PcActions.tsx`)

- `ActionRow` Launch button now calls `launchWithAuth(url, ensure)`:
  1. Parse `itd-<tool>://<target>` to extract tool + target.
  2. Call `ensure()` to make sure session exists (pops auth modal if
     not — operator types creds once per browser session).
  3. Call `getLaunchUrl()` to get tokenized URL.
  4. Navigate to that URL → protocol launcher fires.
- Fallback: if step 3 fails (network down, session expired between
  ensure() and getLaunchUrl()), navigate to the un-tokenized URL —
  launcher falls back to per-launch ask mode (CMD prompt).

### Launchers (`apps/server/scripts/install-itd-handlers.cmd`)

All 5 generated launchers (mmc, rdp, explorer, psexec, ps) now:

1. Extract `?tk=TOKEN` from URL into `!token!`, strip query from `!url!`.
2. Validate host as before.
3. If `!token!` is defined, `goto :token_mode`.
4. Otherwise: existing ask / preset / current dispatch.

`:token_mode` blocks (per tool):
- MMC: `Invoke-RestMethod` redeem → `cmdkey /add:HOST` → `Start-Process
  mmc.exe -ArgumentList 'X.msc /computer=HOST' -PassThru` → wait → `cmdkey
  /delete:HOST`. Hidden PowerShell wrapper (`-WindowStyle Hidden`).
- RDP: same pattern, `cmdkey /add:'TERMSRV/HOST'` (RDP-specific target),
  `Start-Process mstsc.exe /v:HOST`.
- Explorer: `cmdkey /add:HOST`, `Start-Process explorer.exe \\HOST\X$`,
  10 s grace then cleanup (explorer exits immediately so waitForExit is
  meaningless).
- PsExec: `psexec -u USER -p PASS` directly (no cmdkey needed, psexec
  takes creds via args).
- PS: `ConvertTo-SecureString` + `New-Object PSCredential`, then
  `Enter-PSSession -ComputerName HOST -Credential $c`. `-NoExit` keeps PS
  console open for operator.

API base URL templated at install time:
- `set "ITD_API_BASE=http://10.8.2.213:4000"` at the top of installer.
- Override via env: `set ITD_API_BASE_OVERRIDE=https://itd.example.com`
  before running installer.

### Security model

| Asset | Lifetime | Where |
|---|---|---|
| Session creds (user + password) | 30 min idle / 8 h hard max | Server memory only (Map) |
| Session cookie | 8 h (HttpOnly, SameSite=Strict) | Browser |
| Launch token | 30 s, one-shot | Server memory only |
| Token in URL | <1 s (DOM → protocol handler) | Process arg + logs |
| cmdkey cred entry | duration of tool (mmc / rdp / explorer / psexec) | Windows Credential Manager |

- All `redeem` events audit-logged (who, when, target, tool, ip).
- Token can only be redeemed once.
- Server side: passwords NEVER persisted to disk. Process restart =
  all sessions cleared, operators re-auth.

### Deployment notes

- New env vars on server (optional):
  - `AD_LDAP_URL=ldap://10.8.2.X:389` — DC URL for LDAP bind.
  - `AD_LDAP_DOMAIN=AXINETWORK.LOC` — default suffix for bare usernames.
  - `AD_LDAP_STUB=1` — accept any non-empty creds (development only).
  - `AD_LDAP_TIMEOUT_MS=5000` — LDAP timeout.
- Without LDAP env vars and without stub flag, the route returns
  `misconfigured` reason and operator sees an error in the modal.
- Operator should set `AD_LDAP_URL` to the AXINETWORK DC IP and restart
  service after deploy.

### What's next (Sprint 2+)

- AD Users tab (parallel to Computers): cron `Get-ADUser` → MSSQL table,
  searchable list, click-through to detail panel with reset / unlock /
  disable actions via PS Remoting using session creds.
- Click-through cross-linking: Computer detail shows recent
  interactive logins → Click user → User detail; User detail shows
  recent devices → Click computer → Computer detail.

Files touched in Sprint 1:
- NEW: `apps/server/src/auth/session-store.ts`
- NEW: `apps/server/src/auth/ldap.ts`
- NEW: `apps/server/src/routes/auth.ts`
- NEW: `apps/desktop/src/components/AuthGate.tsx`
- MOD: `apps/server/src/index.ts` (register cookie plugin + auth routes)
- MOD: `apps/server/package.json` (`@fastify/cookie`, `ldapts`)
- MOD: `apps/server/scripts/install-itd-handlers.cmd` (token extraction
  + `:token_mode` blocks in all 5 launchers, `ITD_API_BASE` at top)
- MOD: `apps/desktop/src/main.tsx` (wrap App in AuthProvider)
- MOD: `apps/desktop/src/components/PcActions.tsx` (`launchWithAuth`)
- MOD: `apps/desktop/src/i18n.tsx` (CS+EN auth strings + interpolation)
- MOD: docs (README, ARCHITECTURE, dashboard.html CS+EN)

Local sandbox-tested: installer ran clean against temp LOCALAPPDATA,
all 7 generated launchers (4 MMC variants + rdp/explorer/ps/psexec)
verified syntactically — no stray `^|` carets in any PS -Command string.
Token mode dispatch present, fallback to ask mode intact for sessions
without token. Backend + frontend typecheck both green.

## Machine-wide install via /machine flag (NEW since 2026-06-03)

Followup to the default-to-ask change. Operator pointed out the real
friction in a multi-IT-specialist workstation: HKCU registrations and
LOCALAPPDATA launcher files are **per-Windows-user**. Each IT specialist
logging into the same operator workstation as a different Windows account
(operator's regular login + a domain admin account + helpdesk account…)
would each have to run the installer once for their own user. That is
exactly the "ostatní uživatelé to nemusí dělat" friction the operator
wanted to eliminate.

Fix: new `/machine` install flag. When invoked from elevated cmd / PS, the
installer writes launcher files to `C:\ProgramData\ITDashboard\launchers`
and registers the protocol handlers under `HKLM\Software\Classes\itd-*`.
Effect: every Windows account that logs into the workstation immediately
has working `itd-*` handlers — no per-user installer run needed.

Usage:
```
# One-time, elevated PowerShell / cmd on each operator workstation:
Invoke-WebRequest http://10.8.2.213:4000/actions/install-handlers.cmd -OutFile $env:TEMP\install-handlers.cmd
Start-Process cmd -ArgumentList "/c `"$env:TEMP\install-handlers.cmd`" /machine" -Verb RunAs
```

HKCU shadowing caveat: if any Windows user on the workstation previously
ran the per-user installer, their HKCU registration shadows the HKLM one
(HKCU takes precedence in HKEY_CLASSES_ROOT merge). That user's browser
will keep launching the OLD per-user launcher. Two ways to resolve:
- That user runs the new installer per-user (default mode, no flags) so
  HKCU gets refreshed with the new logic. OR
- That user runs `install-handlers.cmd /uninstall-hkcu` (no admin needed)
  which removes their HKCU itd-* registrations and the per-user launcher
  dir under LOCALAPPDATA. HKLM machine handlers then take over.

The `/uninstall-hkcu` flag is the recommended cleanup for the operator's
own existing per-user pollution after switching to `/machine` mode.

Launcher mkdir fix: generated launchers now `mkdir
%LOCALAPPDATA%\ITDashboard\launchers >nul 2>&1` at startup. Critical for
the machine-wide case: a user logging in for the first time after the
admin's /machine install has no per-user launcher dir, so the launcher
would fail to write log/last-admin-user.txt if mkdir wasn't there. The
mkdir is no-op when the dir already exists (per-user install case).

Files touched: `apps/server/scripts/install-itd-handlers.cmd` — flag
parser at top, MACHINE_INSTALL/UNINSTALL_HKCU/REGHIVE/BASE branching,
:register subroutine uses %REGHIVE%, welcome message reflects scope,
generated launcher mkdir line. Plus HANDOFF + README + ARCHITECTURE +
dashboard.html (CS+EN) + i18n docs sync.

After deploy: operator runs `/machine` once elevated. All Windows accounts
on that workstation immediately get the handlers with default-to-ask
behavior. Existing per-user pollution cleaned via `/uninstall-hkcu`.

Local sandbox-tested: per-user mode unchanged (PER-USER scope label,
mkdir line present in generated launcher). /machine mode logic
symmetric — not run against real HKLM to avoid polluting maintainer's
own workstation.

## Default-to-ask: ITD_ADMIN_USER unset behaves as ask (NEW since 2026-06-03)

Followup to the 3-mode dispatch landing earlier the same day. Operator
feedback: requiring every IT specialist to manually `setx ITD_ADMIN_USER ask`
on their Windows account is friction for a tool meant for shared use. Fix:
change the launcher default — when ITD_ADMIN_USER is unset, the launcher
behaves as if it were `ask`. No per-user setup needed; just reinstall the
handlers and Launch works correctly out of the box.

New dispatch order in generated launchers:
```
if not defined ITD_ADMIN_USER set "ITD_ADMIN_USER=ask"
if /i "%ITD_ADMIN_USER%"=="ask" goto :ask_mode
if /i "%ITD_ADMIN_USER%"=="current" goto :no_admin_mode
goto :preset_mode
```

The `set` is inside `setlocal` so it does not leak to the user's actual
environment — only the launcher process sees `ask` as the default.

Behavior matrix:
- **unset** → ask (was: current Windows user / no admin wrap)
- **`ask`** explicit → ask (same as default)
- **`current`** explicit → no admin wrap (new opt-in for the old default)
- **any other value** (e.g. `AXINETWORK\trnka_admin`) → preset, runas /netonly
  with that pre-filled user

Old behavior preserved as `ITD_ADMIN_USER=current` for the rare case someone
wants to run launchers as their normal Windows account.

Files touched: `apps/server/scripts/install-itd-handlers.cmd` — one-line
addition + reordered goto chain in all 5 launcher writers (mmc, rdp,
explorer, psexec, ps). `apps/desktop/src/i18n.tsx` —
`actions.adminUserHint` CS+EN rewritten to lead with default behavior and
present the other modes as overrides. Plus README + ARCHITECTURE +
dashboard.html docs sync.

After deploy: operator workstation reinstalls handlers
(`/actions/install-handlers.cmd`). No `setx` needed. Launch immediately
prompts for admin credentials.

Local sandbox-tested: installer re-ran clean against temp LOCALAPPDATA,
generated itd-mmc.cmd and itd-ps.cmd inspected — dispatch lines correctly
ordered, default-to-ask line present.

## 3-mode ITD_ADMIN_USER dispatch + itd-ps PowerShell Remote (NEW since 2026-06-03)

Operator reported: clicked Launch (Computer Management) for a remote PC, MMC
opened but Shared Folders subtree threw "K zobrazení seznamu sdílených složek
nemáte oprávnění" because MMC ran as the operator's own (non-admin) Windows
account. The pre-existing ITD_ADMIN_USER mechanism only had 2 modes (unset =
current user, or a fixed pre-set value pre-filled into runas), neither of
which fits a multi-admin workstation where several IT specialists share the
same operator PC and each one needs to type their OWN admin login on every
remote-admin session.

New 3rd mode added: `ITD_ADMIN_USER=ask`. When set:
- CMD opens and prompts for the admin account (`Admin account [DOMAIN\user]:`).
- First time: prompt is empty. Specialist types e.g. `AXINETWORK\trnka_admin`.
- Subsequent times: prompt shows `Admin account [Enter = <lastuser>]:` —
  Enter accepts the cached value, typing a different account replaces it.
- The typed account is persisted to
  `%LOCALAPPDATA%\ITDashboard\launchers\last-admin-user.txt` (per-Windows-user
  file, shared across all itd-* launchers so the cache is consistent).
- Password is **never** persisted. `runas /netonly /user:<typed>` opens the
  standard Windows credential dialog for the password on every launch.
- Validation: empty typed user fails with `admin_user_not_entered`; >128 char
  user fails with `admin_user_too_long`. Both go through the existing :fail
  block with the log file + visible reason.

New launcher added: **itd-ps** for remote PowerShell access via Enter-PSSession.
Registers as HKCU URL handler `itd-ps://`. Cmd window opens briefly, then
spawns `powershell -NoExit -Command "..."` with:
- ask mode: `Get-Credential -UserName <lastuser-or-empty> -Message 'Admin
  credentials for <host>'` opens a native Windows credential dialog (both
  fields visible, password masked). Returned UserName is validated against
  `^[A-Za-z0-9._@\\-]+$` before being persisted to the same shared
  last-admin-user.txt cache.
- preset mode: `Get-Credential -UserName '<ITD_ADMIN_USER>' ...` pre-fills the
  fixed user.
- no-admin mode: `Enter-PSSession -ComputerName <host>` with no -Credential
  (current Windows user used implicitly for WinRM).
- Final step: `Enter-PSSession -ComputerName '<host>' -Credential $c`.

PowerShell -Command is used because GPO AllSigned ExecutionPolicy applies to
.ps1 files, not to inline -Command strings.

Files touched:
- `apps/server/scripts/install-itd-handlers.cmd`: 3-mode dispatch added to all
  4 existing launchers (mmc/rdp/explorer/psexec); new `:write_ps_launcher`
  subroutine; wired in main dispatch + HKCU register block.
- `apps/desktop/src/components/PcActions.tsx`: new ActionRow for PowerShell
  Remote in the "access" section, between PsExec and the shares list.
- `apps/desktop/src/i18n.tsx`: new `actions.psRemote` label (CS+EN); expanded
  `actions.adminUserHint` (CS+EN) to describe all 3 modes + multi-admin use
  case.
- `docs/ARCHITECTURE.md`: 3-mode dispatch + itd-ps note in security posture.
- `docs/dashboard.html`: CS+EN row in Per-PC Actions table + CS+EN callout for
  3-mode dispatch + CS+EN troubleshooting entry "no admin prompt on Launch".
- `README.md`: short note pointing at the 3-mode dispatch + itd-ps.

After deploy: operator workstation needs to re-download and re-run
`/actions/install-handlers.cmd` (HKCU launchers are non-self-updating, same
pattern as previous fixes). Then `setx ITD_ADMIN_USER ask` (or `setx
ITD_ADMIN_USER AXINETWORK\trnka_admin` for single-admin) and restart browser
so new env var propagates.

Local sandbox-tested before push: installer ran clean against a temp
LOCALAPPDATA; generated itd-mmc.cmd + itd-ps.cmd inspected for syntax
correctness (no stray `^|` carets in PS -Command string after a v2 fix; goto
labels intact; runas /netonly path uses delayed-expanded !adminuser! from
typed prompt).

## Frontend build not found after green deploy (NEW since 2026-06-03)

Operator screenshot showed `http://10.8.2.213:4000/` returning:
`ITDashboard frontend build not found. Deploy must build apps/desktop first.`
Deploy was green because smoke only checked `/version/sha`.

Root cause: `apps/server/src/routes/frontend.ts` resolved
`FRONTEND_DIST` from `process.cwd()`. Under NSSM/Windows Service, cwd is not
guaranteed to be `C:\Apps\ITDashboard\apps\server`, so the server could look
for `..\desktop\dist\renderer` next to the wrong directory even though
`apps\desktop\dist\renderer` existed.

Fix:
- Resolve frontend dist from `import.meta.url` / module location instead of cwd.
- Extend deploy smoke test to require `/` to serve browser HTML root, not just
  `/version/sha`.

Expected deploy verification: workflow fails if runtime SHA matches but `/`
still returns the fallback text.

## Deployment Model

- Local edit in `D:\git\ITDashboard`
- Commit locally
- Push to `main`
- GitHub Actions self-hosted runner on `10.8.2.213` deploys to `C:\Apps\ITDashboard`
- The workflow mirrors source, installs dependencies, typechecks, builds server + browser UI, applies migrations, then restarts `ITDashboardAPI`.

Important:
- Push to `main` does **not** require per-push authorization anymore (operator revoked
  that rule on 2026-06-12). Push once the work is complete and locally verified
  (server `npm run typecheck` + desktop `npm run build`); always report the commit
  hash and watch the deploy (`gh run watch`).
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

## Single-PC refresh (NEW since 2026-06-03)

Computers tab → ⚡ Actions modal gets a green "🔄 Refresh now" panel at
the top. POST `/computers/:id/refresh` runs all four collectors against
that one PC sequentially (disk+info, services, eventlog incremental,
perf incremental) and returns per-step results. Useful when the
operator is about to work on a specific machine and wants fresh data
without spinning the whole fleet.

In-flight guard per computer_id stops double-clicks; concurrent
refreshes against different PCs are fine.

Per-collector helpers (collectFromPC / insertEvents / fetchPcScan /
upsertDisk / upsertPcInfo / fetchProblems / replaceProblems /
fetchPerfEvents / insertPerfEvents) are now exported from their
respective service files; orchestration lives in
apps/server/src/services/refresh-single-pc.ts.

## Admin-user wrapping for Launch actions (NEW since 2026-06-03)

The protocol-handler launchers now detect `ITD_ADMIN_USER` user env
variable. If set (e.g. `AXINETWORK\trnka_admin`), every Launch wraps
the target tool in `runas /user:%ITD_ADMIN_USER% /netonly "..."` —
Windows prompts for that account's password, then runs the tool with
those credentials for network auth (so MMC sees `trnka_admin` against
the remote PC). Leaving the variable unset keeps the legacy behavior
(runs as currently logged-in operator).

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
