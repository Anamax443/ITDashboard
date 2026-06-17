# ITDashboard Handoff

Last updated: 2026-06-17 (LIVE `62c9f26`; full doc sweep done — README, ARCHITECTURE, dashboard.html CS+EN, project-status.html, i18n all current). Big device-platform batch: MikroTik DHCP collection LIVE + fully DB-driven (no MIKROTIK_* env except MIKROTIK_SECRET); multi-source inventory merged by MAC = DHCP (dynamic+static reservations) + router ARP + active app-server subnet scan (configurable ranges CIDR/wildcard, `!` excludes a subnet, discovery cache, remote subnets via router ARP); NetBIOS (nbtstat) device names → printer auto-suggest (NPI/BRN/BRW/RNP/KMBT); Static/Dynamic Type column; operator-editable device name (mig 046); generic + configurable categories; per-device packet loss + latency (mig 045/047) as `ms/%` column with tunable problem thresholds, "Loss/latency" tile + "issues only" filter; printer-offline alert agenda (mig 043); 🖨 Printers tile; printer IP→web-UI with optional cert-bypass server proxy; new Database tab; deploy robocopy `/MIR` excludes `dist` (frontend-window fix). Migrations 043–047. — prior 2026-06-16: (decision: MikroTik DHCP collection simplified to IN-APP on the application server — external .225 sync-script model retired; pending one router allowed-address change · docs/i18n deployment-model corrected) — prior 2026-06-15: Ports availability tab + per-port latency · per-PC refresh now probes ports too · cmd-like ping console · Per-PC Actions trimmed to refresh-only · dashboard Ports tile + tile-click filter pre-select · Devices tab = MikroTik DHCP inventory paired with AD by hostname/IP · device categories by MAC + vendor suggestion · MikroTik config in Settings with AES-encrypted password · migrations 041–042

> The values in **Current Live State** are this deployment's actual endpoints,
> kept here as the operator handoff record. They are **no longer hardcoded in
> code** — the source tree carries no IPs/hostnames/domain. To stand the project
> up elsewhere you change `apps/server/.env` (+ GitHub Actions repository
> Variables) only, never code. See [Config externalization (2026-06-11)](#config-externalization-2026-06-11)
> below and `.env.example` (single source of truth).

## Session 2026-06-17 (batch 2) — G2 printer supplies (ink/toner levels) LIVE

New **"Stav tiskáren" / "Printer status"** tab + dashboard tile: per-printer ink /
toner / maintenance-box / drum / belt levels, read **straight from the printers**.
Core was verified live against real printers BEFORE building (rule: verify core
before building): probed the whole printer fleet (Epson EM-C7100 + WF series, HP
LaserJet NPI, Brother MFC) over SNMP and the printers' own web UIs.

**Architecture decision (verified by live probing): SNMP Printer-MIB primary +
targeted HTTP fallback.** SNMP `prtMarkerSupplies` (desc `.6` / max `.8` / level
`.9`; % = level/max) is uniform across HP/Epson/Brother/Kyocera and also yields
HP cartridge part-numbers + laser drum/belt life + sysDescr model. Two live-found
gaps are filled from the printer's own web page:
- **Brother** SNMP reports toner only as `-3` "some remaining" (no %) → numeric %
  from `/general/status.html` (`tonerremain` image height /50). SNMP still gives
  Brother drum/belt %.
- **Epson** SNMP omits the maintenance (waste) box → % from the Web Config page
  `/PRESENTATION/ADVANCED/INFO_PRTINFO/TOP` (olive `#636311` gradient or
  `Ink_Waste.PNG` height). Epson Web Config has 3 markup variants (EM-C gradient /
  WF image-height / WF-C5890 vertical gradient) handled in the full-page fallback.

**Implementation (migration 048).**
- `services/snmp.ts` — self-contained SNMP v1 client (GET/GETNEXT walk) over
  `node:dgram`; pure BER encode/decode (NO external dependency — matches the
  app's hand-rolled ethos). Unit-tested.
- `services/printer-supplies-http.ts` — pure parsers (Brother toner, Epson maint,
  Epson full ink) + classification (`classifyDescription` / `extractPartCode` /
  `computeLevelPct` / `colorKey`) + an insecure (cert-bypass) GET. Unit-tested.
- `services/printer-supplies-collector.ts` — `resolveConfig` (DB-driven) →
  `runPrinterSuppliesOnce` (SNMP walk + classify + vendor HTTP supplement, merged)
  → upsert into **`printer_supplies`** (MERGE by mac+supply_key, prunes vanished
  supplies) → `startPrinterSuppliesSchedule` (own timer, re-reads enable/interval).
  Probes ONLY devices the operator categorized `printer`.
- `routes/printer-supplies.ts` — `GET /printer-supplies` (grouped per MAC + joined
  to dhcp_leases/categories, returns `lowPct`), `POST /printer-supplies/run`.
- Settings seeded: `printer_supplies.enabled` (default **1**), `.interval_sec`
  (900), `.snmp_community` (public), `.low_pct` (15), `.http_fallback` (1).
- Frontend: **`PrinterSuppliesPage.tsx`** (card per printer, colour supply bars +
  %, badge OK/Dochází/Prázdná, two explicit per-card links — **"přes dashboard"**
  (cert-bypass proxy) and **"přímo na IP"** (raw `http://IP`) so the operator
  chooses), dashboard **🖨 Náplně** tile + nav entry, and a
  light **supply-flag** (●NN%) on confirmed-printer rows in the Devices tab that
  jumps to the page. i18n CS+EN.

Live-verified (the shipped Node code, not just the probe): SNMP+HTTP returns
correct levels for Epson/HP/Brother incl. part-numbers + Epson maint box +
Brother HTTP toner. Typecheck clean both apps; **74 tests pass** (was 54: +8 SNMP
BER, +12 supply parse/classify). No new env var (community is a DB setting).

**Follow-up fix (`1a726a4`): device web proxy returned an empty body.** The
cert-bypass proxy (`routes/device-web-proxy.ts`, used by the printer card click +
the Devices IP link when `devices.web_proxy` is on) accumulated the upstream HTML
in an async `res.on('end')` and called `reply.send` there — but the async handler
had already resolved `undefined`, so Fastify sent an empty 200 first. Every
printer EWS proxied as a blank page. Fixed by buffering the full upstream body and
`return`ing it from the handler (decompressing gzip/deflate/br). Verified live:
Brother/HP/Epson now proxy their real pages (8 KB / 12 KB / Epson JS-bootstrap
that chains through the injected `<base>`). NB the proxy is OFF by default; enable
`devices.web_proxy` in Settings to route the card click through it.

**Follow-up fix 2 (`f3f2965`): the injected `<base>` pointed at the proxy ROOT,
breaking frame-based EWS.** A relative resource on a sub-page (e.g. `SCRIPT.JS` on
`…/COMMON/TOP`) resolved to `/devices/web/IP/SCRIPT.JS` (root → 404) instead of
`…/COMMON/SCRIPT.JS`, so Epson's frameset Web Config rendered blank (its
iframe-loader script never loaded). Now `<base>` is the directory of the current
document (`/devices/web/IP/<dir>/`).

**Follow-up fix 3 (`43f4938`): global Helmet CSP blocked the EWS inline scripts.**
The dashboard's `script-src 'self'` CSP also applied to the same-origin proxied
content and blocked the printer's inline scripts (Epson bootstrap meta-refresh +
jQuery) → blank page (visible in the browser console). The proxy now sets a
permissive CSP for `/devices/web/*` only (`'unsafe-inline'`/`'unsafe-eval'`;
sub-resources are same-origin under `/devices/web/IP/`) + `Cache-Control:
no-store`. After this, Epson WF-C5790/C5890 Web Config renders fully through the
proxy (ink tank graphics, status, cartridge codes).

**Follow-up fix 4: root-absolute resources bypassed the proxy.** `<base>` only
fixes RELATIVE URLs; HP's EWS loads `/hp/device/jquery.js` etc. by ABSOLUTE path,
which hit the dashboard origin root (404 / wrong MIME → `$ is not defined`). The
proxy now rewrites `href|src|action="/…"` → `/devices/web/IP/…` (skipping `//host`
and already-proxied paths) so absolute resources route through too.

**Follow-up fix 5 (`c92d840`): client-side redirects + MIME correction (Brother).**
(a) Redirects were followed server-side, so the browser stayed at the pre-redirect
URL — Brother's `/` → `/general/status.html` left the doc at root, so its relative
`../common/images/black.gif` lost the IP (`/devices/web/common/…` → 400). Now a 3xx
is bounced back to the BROWSER as a proxied path (`reply.redirect` to
`/devices/web/IP/<loc>`), keeping the document URL — and relative resolution —
correct. (b) Printers serve assets with wrong MIME (Brother `.js` as
`text/js`/`text/plain`, `.css` as `text/plain`); with Helmet `nosniff` the browser
refused them. The proxy now sets Content-Type from the path extension
(`correctContentType`), so JS/CSS/images apply correctly. Verified live across
Epson (EM-C7100, WF-C5790/C5890), HP (M401dne, M451dn, Color M552) and Brother
(MFC-L8690CDW). The benign console warnings that remain (Cross-Origin-Opener-Policy
ignored, Origin-Agent-Cluster) are from the dashboard's HTTP origin and harmless.

Default ON (migration 049, `devices.web_proxy=1`); operator can disable in Settings.

> Open follow-ups: Settings UI section for the supply collector (works on the
> seeded defaults today, but enable/community/threshold are DB-only until a
> Settings panel is added); optional low-supply email alert under the printer
> agenda; non-SNMP HP fallback (`/DevMgmt/ConsumableConfigDyn.xml`) for the one
> old HP that lacks SNMP supplies.

## Current Live State

- Project: ITDashboard
- Repo: `https://github.com/Anamax443/ITDashboard`
- Local path: `D:\git\ITDashboard`
- Runtime server: `10.8.2.213` / `B-S-W-MIKOS`
- Runtime path on server: `C:\Apps\ITDashboard`
- SQL server: `10.8.2.225`
- Database: `ITDashboard`
- Live commit: `62c9f26`
- Browser URL: `http://10.8.2.213:4000/`
- Docs URL: `http://10.8.2.213:4000/docs`

## Session 2026-06-17 — MikroTik collection LIVE + printer focus + Database tab

The blocker from 2026-06-16 is **cleared**: the operator had `10.8.2.213` (and
`.181`) added to the RouterOS `dhcp-reader` **allowed-address** on both routers
(Brno `10.8.2.207`, Zastávka `10.10.181.2`). Verified live this session — the
REST pull returns OK from `.213` (Brno 95 leases / 91 bound, Zastávka 47 / 46);
it still 401s from a non-allowed host, confirming the restriction is just the
allowed-address list. **In-app DHCP collection is now LIVE.**

**Collector rewired to DB-driven config (migration 043).** `mikrotik-collector.ts`
no longer reads `MIKROTIK_*` env. `resolveConfig()` reads everything from Settings:
`mikrotik.enabled` (master toggle, seeded **ON**), `mikrotik.interval_sec` (own
standalone timer, default 300s, like reachability), `mikrotik.routers`,
`mikrotik.user`, and the password via `decryptSecret(mikrotik.password_enc)`. The
scheduler re-reads enable+interval every cycle (no restart needed) and idles
(re-checking every 60s) while disabled/unconfigured, so it never 401-spams. The
ONLY MikroTik value left in env is `MIKROTIK_SECRET` (the encryption key, on .213).
`.env.example` updated — the legacy `MIKROTIK_ROUTERS/USER/PASSWORD/INTERVAL_SEC`
lines are gone.

**Generic "Tiskárna" category.** The per-vendor printer categories (`printer_canon`
/ `_kyocera` / `_zebra` / `_hp` / `_other`) collapse to a single `printer`
("Tiskárna" / "Printer"). Migration 043 relabels any already-assigned `printer_*`
rows to `printer` (kept by MAC, nothing lost). `suggestCategory` keeps the OUI /
hostname detection but now suggests the generic `printer`. Server enum
(`routes/devices.ts` CATEGORIES) + client dropdown + i18n all updated.

**AD-derived pc/server pre-select (operator: "jako předvýběr").** `GET /devices`
now joins `computers.os_version`; a device matched to an AD computer gets its
`suggested` set to `server` (os_version `/server/i`) or `pc` from AD, instead of
the OUI/hostname heuristic (which still drives unmatched devices). The Devices
dropdown shows the suggestion **pre-selected but dimmed/italic** until the
operator confirms it (a "✓ potvrdit předvýběr" affordance applies it); the
operator override always wins and persists by MAC in `device_categories` (it
already did — confirmed this session, storage = DB).

**Printer-offline email alert agenda (migration 043).** New `alerts.printers.*`
settings (enable default OFF, debounce, frequency, maintenance window, recipient
override) + a `printer_alert_state` table (per-MAC debounce/throttle). In
`alerts.ts`: `loadDownPrinters` (category='printer' whose effective reachability
— matched=AD computer's, unmatched=lease ping — is false; NULL is NOT down),
`evaluateAndSendPrinterAlerts` (recovery / debounce / maintenance / throttle,
mirrors the service agenda), `sendPrinterAlertTest`, `renderPrinterAlert`. It runs
on the **collector's own cadence** (called at the end of each collect). Route
`POST /alerts/printers/test`. Settings page gained a "Email alerty — tiskárny"
section with a test button.

**🖨 Printers dashboard tile (online/offline).** New `SummaryCards` tile counts
**only operator-confirmed printers** (`category='printer'`), shows offline/total,
green when all online / red when any offline (same severity pattern as the other
tiles). Click → Devices tab with "only printers" pre-checked. `App.tsx` fetches
`/devices` for the count.

**Printer IP → web UI.** On the Devices tab a printer-ish device's IP is now a
link to `http://{ip}` (the printer's embedded web page) for a quick manual status
check. (Roadmap G2, not built yet: pull toner/supply levels + status via SNMP
Printer-MIB — to be prototyped against a real printer first.)

**New "Databáze" / "Database" tab.** `GET /database` returns the whole-DB size
(data + log + used) and a per-table breakdown (rows, reserved KB, data KB) from
the system catalog (`sys.tables`/`partitions`/`allocation_units` + `database_files`).
New `DatabasePage` renders summary cards + a sortable-by-size table with a usage
bar, so the operator sees which tables eat the space. Read-only; loads on demand.
Nav entry between Devices and Perf.

Typecheck clean across all workspaces; 54/54 tests pass. Deployed `9726302`
(migration 043 applied; deploy green; smoke test = running binary SHA matches).
Live-verified: `/version`=9726302, `/devices`=161 rows (leases persisted in
`dhcp_leases`), `/database` works (DB 656 MB, 23 tables, `events` ≈ 295 MB the
largest — candidate for the retention review).

> Router data persistence (operator Q): yes — the collector upserts every pulled
> lease into **`dhcp_leases`** (MERGE by site+mac); operator categories live in
> **`device_categories`** (by MAC). The Devices tab + Printers tile read from
> `dhcp_leases` via `GET /devices`.

### Multi-source device discovery + active scan (migration 044)

Follow-up the same session: the Devices inventory now merges **three sources** so
it shows **static + dynamic** addresses, not just bound DHCP leases. Driven by a
real case — printer `10.8.2.100` is alive (MAC `64:C6:D2:73:08:70`) but has a
**static IP set on the device itself**: it has no DHCP lease, no static DHCP
reservation, and isn't even in the router's ARP (same-subnet host the router
doesn't route for), so no router API can return it. Verified live.

- **DHCP leases** — now keeps **bound OR static reservations** (`dynamic=false`,
  even when offline), not bound-only. (Brno has 24 static reservations; 2 were
  being dropped.)
- **Router ARP** (`/rest/ip/arp`) — merged in by MAC (lease wins); ARP-only =
  static device the router has resolved.
- **Active scan from `.213`** (`mikrotik.scan_enabled` + `mikrotik.scan_ranges` =
  `Site=CIDR` list, Settings textarea) — the app server ping-sweeps each range's
  IPs **that the routers don't already account for**, reads its **own ARP cache**
  (`arp -a`) for the MAC, and registers responders as `source='scan'`,
  `dynamic=false`. This is the ONLY way to see same-subnet static devices like
  `.100`. It progressively covers the whole network (skips already-known IPs) and
  marks previously-scanned non-responders offline so the printer alert still fires.

`dhcp_leases` gained a **`source`** column (`dhcp`/`arp`/`scan`, migration 044).
The Devices tab shows a **Typ** column (Statická/Dynamická + source). `GET /devices`
returns `source`; `runMikrotikCollectOnce` returns `scanned`.

Default: scan is **OFF** (it's active network probing) — operator enables it and
enters the ranges (`10.8.2.0/24` + Zastávka) in Settings → MikroTik DHCP.

**Live-verified after deploy `37a5cf2`:** scan enabled for `Brno=10.8.2.0/24`, a
collect run pulled `leases=154`, `scanned=98`, 0 errors in 15.6s. The inventory
grew 161 → **269 devices** (`dhcp=163 · arp=8 · scan=98`), and the static printer
**`10.8.2.100`** now appears (`source=scan`, `dynamic=false`, reachable). **TODO
for operator:** add the Zastávka CIDR(s) to `mikrotik.scan_ranges` in Settings —
only the Brno `/24` is configured so far (Zastávka spans several subnets:
10.10.181 / 10.90.181 / 10.130.181 — confirm the exact ranges before adding).

### Scan refinements — exclude ranges + packet loss (migration 045)

- **Exclude ranges**: a `!` (or `<>`) prefix on a `scan_ranges` line marks it an
  EXCLUDE — those IPs are skipped even if an include range covers them (same
  `!`/`<>` convention as the disk-scope syntax). E.g. `!Zastavka=10.150.181.*`.
- **Wildcards + optional Site=** (from the prior commit): `10.8.2.*` = /24,
  `10.8.*.*` = /16; `Site=` is optional.
- **Discovery cache**: discovery only pings UNKNOWN IPs; a stored IP↔MAC is never
  re-discovered. MAC is the key — a static device reappearing at a NEW IP moves
  its `(site,mac)` row, freeing the OLD IP back into the discovery pool. A
  separate light up/down re-ping keeps known static reachability fresh.
- **Packet loss (migration 045)**: `dhcp_leases.packet_loss` (0–100). Reachability
  pings are now `ping ×4` and store the loss % (locale-independent — counts `TTL=`
  replies). A device can answer yet drop most echoes (degraded link); the Devices
  tab Status shows `● online · NN% ztráta` (amber, red ≥ 50%). Verified live with
  Brno+Zastávka ranges: 269 devices (Brno 200 / Zastávka 69), `source` dhcp/arp/scan.

## Session 2026-06-16 — MikroTik collection model simplified to in-app (decision, docs only)

No code/runtime change this session — an **architecture decision** plus a docs/i18n
correction. The operator set a guiding principle: keep the system **simple, two-tier**
— the **application server `10.8.2.213` performs ALL operativa** (every collector/probe
runs in-app), the **DB `10.8.2.225` is storage only**, and there are **no extra
PowerShell scripts on other servers**.

Consequence for MikroTik DHCP: the **external `.225` sync-script** model documented in
the 2026-06-15 session (a scheduled PowerShell job on the SQL host that pulled leases
and wrote `dhcp_leases` directly) is **retired** — do not resurrect it. MikroTik
collection will run **in-process on `.213`** like every other collector.

**The one blocker (pending a colleague):** the RouterOS read-only account `dhcp-reader`
is **source-IP restricted to `10.8.2.225`**, so the app on `.213` (and the operator's
workstation `.181`) gets **HTTP 401**; from `.225` it returns OK (~92/33 bound). Fix =
add `10.8.2.213` (or `10.8.2.0/24`) to `dhcp-reader`'s **allowed-address on BOTH routers**
(Brno `10.8.2.207`, Zastávka `10.10.181.2`): `/user set dhcp-reader address=10.8.2.225,10.8.2.213`.
Until then **MikroTik collection is INACTIVE** — the Devices tab, tables (`dhcp_leases`,
`device_categories`), routes and the Settings → "MikroTik DHCP" config are all deployed,
but **no leases are collected yet**, and nothing is actively erroring (the in-process
collector is idle; the `.225` script is not scheduled).

**Remaining code work once the routers allow `.213`** (open follow-up):
- Refactor `apps/server/src/services/mikrotik-collector.ts` to read routers/user/password
  from **DB Settings** (`mikrotik.routers`, `mikrotik.user`, `mikrotik.password_enc` →
  `decryptSecret`) instead of the legacy `MIKROTIK_*` **env** vars.
- Add a **master enable toggle** in Settings so the collector doesn't 401-spam before the
  routers are open.
- `MIKROTIK_SECRET` stays only on `.213` (already in `apps/server/.env`); drop any `.225`
  script / scheduled task / `setx` if it was created.

Docs/i18n corrected this session to the in-app model: `README.md`, `docs/ARCHITECTURE.md`
(deployment-model section + `MIKROTIK_SECRET` scope), `docs/dashboard.html` (CS+EN MikroTik
settings chapter), `docs/project-status.html` (config row + new 2026-06-16 note), and the
`settings.field.mikrotikHelp` i18n string (CS+EN).

## Session 2026-06-15 — Ports tab, MikroTik DHCP "Devices" tab, refresh-trim, encrypted secrets

A feature session. Migrations **041–042**. Commits `dcac10b` → `604f8f4` (current
live before this docs sweep). Two new tabs (Ports, Devices), a cmd-like ping
console, dashboard tile + tile-click filters, the Per-PC Actions modal trimmed to
refresh-only, and MikroTik DHCP config moved into Settings with an AES-encrypted
password.

### Ports availability tab (migration 041)

A live per-port reachability grid, distinct from the phase-2 port ALERTS
(`port_check_state` is the alert state machine; this is the display snapshot).

- **Migration 041** adds table **`port_status`** (PK computer_id+check_name:
  is_open, latency_ms, checked_at) + settings `checks.run_port_status` (default 1)
  and `port_status.interval_sec` (default 300). The probe **reuses** the existing
  port list + timeout (`alerts.services.port_checks`, `alerts.services.port_timeout_ms`)
  so the grid works even with phase-2 alert emails off.
- **`port-status-collector.ts`** — standalone scheduler (mirrors reachability),
  TCP-probes each enabled/non-excluded PC's configured ports, measures connect
  latency, **skips** PCs flagged offline (`computers.reachable = 0`), and **prunes**
  rows for ports removed from the config so the grid always follows Settings.
  Exports `runPortStatusProbeOnce`, `probeOnePcPorts` (used by single-PC refresh),
  `probeComputerNow` (ICMP ping + ports → cmd-like console transcript), and
  `configuredCheckNames` (used by the route to filter the grid to current config).
- **Routes**: `GET /port-status` (grid feed; LEFT JOIN + OUTER APPLY-style match to
  `computers`, filtered to currently-configured check names), `POST /port-status/run`
  (probe fleet now), `POST /computers/:id/probe` (live ICMP ping + per-port TCP).
- **Desktop `PortsPage`**: grid PC × port (● open + latency / ○ closed / — offline),
  "only issues" filter, "Refresh" button (renamed from "Probe now"), per-row "📡 Ping".

### Per-PC refresh now covers ports + cmd-like ping console

- **`refresh-single-pc.ts`** gained a 5th step calling `probeOnePcPorts`, so the
  per-row **🔄 Aktualizovat** in Computers refreshes everything monitored: disk,
  services, eventlog, perf, **and ports** (operator: "aktualizovat vše … prostě vše
  co se sleduje").
- The per-row **Ping** (Ports + Devices tabs) opens a **console modal** showing the
  real `ping.exe` output. The server runs it via `cmd /c chcp 65001 & ping -n 4`
  so the localized (Czech) output returns as UTF-8 and renders correctly, plus
  per-port open/closed/latency lines.

### Per-PC Actions trimmed to refresh-only

The ⚡ Akce modal's launcher / remote-management content was **removed** at operator
request ("ponecháme jen aktualizovat teď"): Remote MMC (compmgmt/services/eventvwr/
taskschd), Remote access (RDP/PsExec/PS Remote), Admin shares, Copy helpers, and the
URL-handler installer banner — plus all the dead helper code. The modal now contains
only the single-PC refresh; the button is renamed **🔄 Aktualizovat**. The
launcher-only `actions.*` i18n keys were deleted (CS+EN). The server `/actions/*`
install-handler routes + scripts are **retained but unused** from the UI.

### Dashboard Ports tile + tile-click filter pre-select

- New **"🔌 Porty"** tile in `SummaryCards` (PCs with a closed port / total) → opens
  the Ports tab.
- Clicking a tile now **pre-checks the relevant filter** (one-shot, via an
  `initial*`/`on*Consumed` prop pair so the top-nav entry is unaffected): Ports tile →
  "only issues"; Critical-services tile → "only down (not Running)"; Stopped-services
  tile → "only ExitCode != 0".

### Devices tab — MikroTik DHCP inventory (migration 042)

Operator wanted the dashboard to pull device info (IP, name, MAC, online state) from
the MikroTik routers — "například tiskárny". The core (RouterOS REST reachable +
field shape) was verified live before building.

- **Migration 042** adds **`dhcp_leases`** (PK site+mac_address: ip, host_name, server,
  comment, status, dynamic, expires_after, first_seen/last_seen, reachable/
  last_reachable_at/reach_checked_at) and **`device_categories`** (PK mac_address —
  operator-assigned category, **persists by MAC** across reloads and sites).
- **`mikrotik-collector.ts`** pulls bound DHCP leases from each configured RouterOS v7
  router (`/rest/ip/dhcp-server/lease`, HTTP Basic), upserts per (site, mac), pairs each
  lease to an AD computer by **host_name (fallback IP)**, and pings **only the unmatched**
  devices (matched ones reuse the reachability collector — "máme spoustu pořešeno").
  `suggestCategory(hostname, mac)` is a UI hint (printer-vendor OUI map for Zebra/Canon/
  Kyocera + hostname keywords for HP/Epson/… + phones); operator override wins.
  `probeDeviceNow` powers the per-row live ping console.
- **Routes**: `GET /devices` (leases + best-match computer via OUTER APPLY by host_name
  then IP + category + computed `suggested`), `PATCH /devices/category` (set/clear by
  MAC), `POST /devices/run`, `POST /devices/probe`.
- **Desktop `DevicesPage`**: site/IP/hostname/MAC grid, per-row **category dropdown**
  (Canon/Kyocera/Zebra/HP/other printer, phone, pc, server, network, iot, other) with a
  clickable **suggestion**, online/offline (matched = AD computer's reachable, unmatched =
  lease ping), AD link, filters (site / "not in AD only" / "printers only"), Refresh,
  per-row Ping console.

### MikroTik config in Settings + AES-encrypted password

- **Settings → "MikroTik DHCP"** section: routers (`Site=IP` comma list), RouterOS user,
  and password. No hardcoding in any script (operator: "nechci to mít natvrdo … ve scriptu").
- **`secret-crypto.ts`** — reversible **AES-256-CBC** (key = SHA-256 of env
  **`MIKROTIK_SECRET`**), format `enc:v1:base64(iv||ct)`, with a marked `plain:` fallback +
  warning if the key is unset. A one-way **hash is intentionally NOT used** — Basic auth
  needs the real password back (operator asked for "zahešované"; corrected to encrypted).
- Settings route hooks: `mikrotik.password` is never stored in plaintext — PUT encrypts to
  **`mikrotik.password_enc`**, GET masks it (`••••`) and omits the ciphertext. Submitted
  mask = leave unchanged; empty = clear.

### MikroTik collection deployment model (important for ops)

The RouterOS read-only account (`dhcp-reader`) is **source-IP restricted** — allowed from
the SQL host **10.8.2.225** but **not** the API host **10.8.2.213** (the in-process
collector on .213 gets HTTP 401). Operator chose **not** to touch the routers. So the
reference deployment runs the DHCP pull as an **external scheduled PowerShell job on
10.8.2.225** (`C:\Scripts\itd-dhcp-sync.ps1`, every 5 min) that:
- reads the router list + user from the DB `settings` (`mikrotik.routers`, `mikrotik.user`),
- decrypts `mikrotik.password_enc` with the same **`MIKROTIK_SECRET`** (machine env on .225),
- pulls bound leases and writes `dhcp_leases` **directly to the local DB**, then
- pings the unmatched devices and writes `reachable`.

The dashboard (API on .213) just **reads** `dhcp_leases` via `GET /devices` — no server
change is needed for the external-sync model. `MIKROTIK_SECRET` must be **identical** on
the API host (`apps/server/.env`, so the UI can encrypt on save) and on the sync host
(so the script can decrypt). `.env.example` documents it. **Alternative**: allow .213 on
the routers and use the built-in in-process collector (`startMikrotikSchedule`, env-driven).

> Open follow-up: the built-in in-process collector still reads routers from the
> `MIKROTIK_*` **env** vars, not from the new DB settings. If the operator ever allows the
> API host on the routers, wire `mikrotik-collector` to read the Settings config +
> `decryptSecret` so the in-process path becomes fully UI-driven (no script).

## Session 2026-06-12 (batch 2) — recipients, reporting, two-level services, exit_code, tests

A large feature + fix batch. Everything below is live on `b7e03e2`. Migrations
**038–040**. First **automated test suites** + CI gate added.

### Per-agenda + report email recipients, standalone Email/SMTP settings (mig 038, 039)

All alerts used to share `alerts.recipients`. Now each agenda can route to its
own list with fallback to the shared one: `sendMail(settings, payload,
recipientsKey?)` reads the per-agenda key (`alerts.disk.recipients`,
`alerts.services.recipients`, `alerts.ports.recipients`, `alerts.reports.recipients`)
and falls back to `alerts.recipients` when empty. SMTP host/port/From and the
dashboard URL stay shared. Migration **038** seeds the disk/services/ports keys,
**039** the reports key — all empty, so existing single-list behaviour is
unchanged. Settings UI was **restructured** per operator: SMTP relay/port/From +
shared recipients + dashboard URL moved into a standalone **"Nastavení e-mailu
(SMTP)"** section; the disk / service / port / report agendas sit below it, each
with only its own enable/throttle + a recipient-override textarea. CS/EN strings.

### Structured fleet report + on-demand email (from the Computers tab)

New `apps/server/src/services/reports.ts` — `buildOverviewReport()` over the
`computers` table (no probing): PC vs servers (os_version `/server/i`), offline
machines with down-since, collection-health counts (active/offline/disabled/
monitored/failing). `GET /reports/overview` (JSON) + `POST /reports/email`
(`{ machines?: string[] }`) share one generator so UI and email never drift.
**Disabled machines are included** (status `disabled`) so the report matches what
the Computers tab shows. A first iteration added a separate **Reporting tab**;
per operator ("vždyť máme záložku Počítače") it was **removed** and the capability
folded into Computers as an **"✉ Report e-mailem"** button that emails the
currently visible (filtered) machines — same "applies to what you see" model as
the bulk toggles. Recipients = `alerts.reports.recipients` → shared fallback.

### Machine-readable email subjects + status banner

Every report/alert subject now leads with `subjectPrefix(hasProblems, manual)`:
`[OK]` vs `[CHYBA]` (does the mail carry a problem — the filter target for an
auto-file mail rule) and `[RUČNĚ]` when manually triggered (test / on-demand),
absent = automatic. Applied to disk, service and port alerts plus the overview
report. The overview email also gained a green/red status banner + a `STAV:` line
in the text part + a manual/auto footer.

### Two-level service monitoring with per-PC exceptions (mig 040)

Computers tab now has **two** per-PC service columns, each a checkbox + an
exceptions (ignore) field, like the disk drive-scope:

- **🔧 Služby** (`service_monitor`) — broad: every Auto service not Running.
- **🛡 Krit. služby** (`service_email_monitor`) — the key set from
  `alerts.services.critical_names`.

Per-PC ignore lists: `service_exceptions` / `critical_service_exceptions`
(comma/newline, `*`/`?` wildcards; match name OR display name via the same glob as
the whitelist). A demoted DC can suppress `NTDS,Kdc` locally without muting them
fleet-wide. Migration **040** adds the columns. Routes: `PATCH
/computers/:id/service-monitor` and an extended `…/service-email-monitor` (both
take `{ enabled?, exceptions? }`); `bulk-flag` accepts `service_monitor`.

Alert logic (`loadDownServices` in `alerts.ts`, parametrised by gate /
exceptions column / critical): **overlap rule** — a critical service is reported
only by the critical level (broad skips critical names), never twice. The service
alert email/test merge both levels, **critical first**, each card colour-coded +
badged. The broad level reports the collector's **"real" set** — it excludes
**trigger-start and delayed-start** services (on-demand, legitimately idle),
matching the collector log's "N real". The footer wording was generalised for the
two-level model.

> Important nuance found via live data: **exit_code is NOT a useful discriminator**
> — 413 of 454 genuine "Auto service down" problems report exit 0/null, only 19
> are exit ≠ 0. An earlier attempt to gate the broad alert on `exit_code <> 0`
> (crashes only) was reverted; the broad level is exit-agnostic and uses
> trigger/delayed exclusion instead.

### Services tab filter fix — null exit_code = graceful (+ default change)

The Services-tab filters tested `exit_code === 0`, but most stopped services have
`exit_code = null` (Windows reports no code for a normal stop), so trigger/null
rows leaked through with "Hide trigger-start" ticked and "Only ExitCode != 0"
still showed null rows. Fixed: shared `isServiceCrash(exitCode)` = `exit != null
&& exit !== 0`; 0 OR null both count as graceful. The **"Only ExitCode != 0"
default flipped to OFF** so the tab shows real drift (matching the dashboard
stopped-services tile and the broad alert, both exit-agnostic); crashes stay
visible in the EXIT column and one tick away.

### Critical-service exceptions honoured in the tab + dashboard tile

Per-PC `critical_service_exceptions` previously suppressed only the email. Now
`GET /services/critical` returns the per-PC exceptions; the **Critical services
tab** excludes excepted non-running services from the "N mimo Running" count,
sinks them to the bottom, and renders them greyed with an **"výjimka"** tag
instead of red. The **dashboard 🛡 tile** (`critDown` in `App.tsx`) excludes them
too. New shared `serviceMatchesExceptions(name, displayName, raw)` in `api.ts`.

### Dashboard tile colours reflect severity

Tile numbers turn **green (`--ok`) when zero** and only go red/orange when there's
an actual problem: disk-critical / critical-services / unreachable / problem-PCs →
red when > 0; disk-warning / slow boot-shutdown / inactive / stopped-services →
orange/red when > 0; the 30-day event counts colour by their own count. Added a
`.card.ok` style; loading/empty states stay neutral (`info`).

### First automated tests + CI gate

The gap all three oponentura reviews flagged. **Vitest** added to both apps:

- **Desktop** (`apps/desktop/src/api.test.ts`, 34 cases): `isServiceCrash`,
  `serviceMatchesExceptions` / whitelist glob, `parseDriveScope` (+ `!`/`<>`),
  `parseDiskThresholds`, `evaluateDiskWithScope` (pct/gb/either + per-tier scope),
  `osBucket`, `isStaleComputer`, `levelName`.
- **Server** (`apps/server/src/services/alerts-util.test.ts`, 20 cases): pure
  helpers extracted into `alerts-util.ts` (no DB/native-driver load) —
  `subjectPrefix`, recipient/list parsing, glob matching, `inMaintenanceWindow`
  (incl. cross-midnight), `shouldAlertNow` (debounce/throttle), drive scope.
- CI `deploy.yml` runs `npm test` after typecheck → a failing test stops the
  deploy before build/migrate. Root `npm test` runs both suites (54 cases).

A test even documented real behaviour: exception patterns are whitespace-split,
so multi-word phrases must use wildcards.

### Oponentura document

`docs/oponentura.md` — a ~90-page (rendered) Czech technical+academic document for
review/defence (architecture, data model, backend/frontend, security incl. STRIDE,
CI/CD, performance, ops, appendices: API ref, data dictionary, settings, migration
list, glossary, use cases, alternatives). Rendered HTML/PDF were handed to the
operator's Downloads.

### Known still-open (see "Still open" below)

DC/server CIM `Access denied` remains the blocker (infra, not code) — broad
service monitoring confirmed it again (only the old `DOMENA01` returns service
data; `B-S-W-DC-01/02/03` fail `New-CimSession: Access is denied`).

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
- Reachable if **any** of these answers: **TCP 135** (RPC endpoint mapper),
  **TCP 445** (SMB), or an **ICMP ping fallback** (commit below, `reachability.ping`,
  default on). TCP is tried first (cheap socket); ping (`ping.exe -n 1`, accepted
  only if the output contains `TTL=` — a real echo reply, locale-independent) is a
  fallback that catches hosts which block RPC/SMB but are alive. Concurrency 16,
  self-contained (never throws).
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

**Scheduling (updated):** the probe now runs on its **own standalone timer**
(`startReachabilitySchedule` in `reachability-collector.ts`, started in
`index.ts`), every `reachability.interval_sec` (default 300 s, migration 035),
**independent of the periodic-checks window** — so Status stays fresh 24/7
including overnight / weekends, while the heavier collectors stay windowed. The
loop self-reschedules and re-reads the enable flag (`checks.run_reachability`) and
the interval each cycle, so Settings changes apply without a restart. It was
removed from the `checks-runner` CHECKS array. New **Settings** section
"Dostupnost na síti (Status)" exposes the enable, the ICMP-ping-fallback toggle,
the interval, and a **"Spustit teď" / "Run now"** button (`POST /reachability/run`
→ `runReachabilityProbeOnce`, returns `{pcs, reachable, unreachable, durationMs}`)
for an on-demand probe (CS+EN).

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
  server-side: `>= faulty.threshold_risk` (600) → **risk** (reinstall candidate),
  `>= faulty.threshold_watch` (400) → **watch**, else dropped. Returns worst-first.

**Migration `033_faulty_pc`** seeds all nine knobs as settings (window / cap / the
three severity weights / breadth / persistence / watch / risk) — fully tunable, no
redeploy. **Migration `034_faulty_thresholds`** then recalibrated the two
thresholds from the 60/150 first guess to **watch=400 / risk=600** (guarded to the
seed so it won't clobber operator tuning) — live data showed active Win11 boxes
carry a high event baseline, so 60/150 flagged ~42% of the fleet (96/228) as
"risk"; 400/600 keeps "risk" to the worst ~10 and watch+risk to ~35.

**Dashboard**: new component `HealthCards.tsx` renders a **single tile** in a
second row below `SummaryCards` — "🩺 PC v problémech" (red, count of PCs at/above
the risk threshold). (A second "Sledovat"/watch tile was added then removed at
operator request — only the worst, risk-level boxes are surfaced; the endpoint
still computes the watch tier but it's no longer shown.) The breakdown table
(score + critical/error/warning + distinct error types + active days) is **hidden
by default and expands inline only when the tile is clicked** (click again / ✕ to
collapse) — the operator didn't want a permanent table on the dashboard. In the
table: the **PC name** jumps to Computers; the **score** cell opens the Events tab
filtered to that PC over the window (all levels) and its hover tooltip explains the
formula (built from the live `scoring` params the endpoint now returns); the
**crit / err / warn** cells open Events filtered to that PC **and** that level
(`onOpenEvents(name, level)` → `setFilterComputer/Level/Hours` → Events view). `Card` is now exported from
`SummaryCards.tsx` for reuse. Cards were also shrunk ~12% (`.card` padding 16→13,
`.value` 32→28, label 11→10, gap 12→10) — the top row read as oversized.

> Naming note: the tile/feature was renamed from "Kandidáti na přeinstalaci"
> (reinstall candidates) to "PC v problémech" (problem PCs) per operator
> preference — these are PCs in trouble, not necessarily reinstall-bound. The
> internal endpoint/setting names (`/events/pc-health`, `faulty.*`) are unchanged.
> The earlier set-based "drill into the Computers tab" behaviour was dropped in
> favour of the inline expand table.

**Client cadence**: `api.pcHealth()` is fetched on its OWN slow 5-min interval (the
14-day GROUP BY is heavier than the 30 s dashboard refresh) and re-pulled when any
`faulty.*` setting changes. New **Settings** block "PC v problémech (skórování
eventů)" exposes window / cap / watch / risk; weights stay DB-tunable. CS+EN.

Tuning note: 400/600 are live-tuned but still coarse — watch the panel for a week
and nudge `faulty.threshold_*` (and the weights) so the "risk" tile holds the
genuinely-sick boxes.

### Critical-service status — real state in ANY state (commit `7ac0962`, migration 037)

Operator: the configured critical services (`alerts.services.critical_names` —
NTDS, DNS, Kdc, Netlogon, W32Time, VMTools, Veeam*, ekrn, DHCPServer,
LanmanServer) were **invisible when Running** — the services collector only
stored Auto + non-Running "problems", and `critical_names` was used only in the
email-alert eval. So you couldn't confirm the critical services *actually run*.

- **Collection**: `fetchServices()` (was `fetchProblems`) now does ONE
  `Get-CimInstance Win32_Service` enumeration per PC in the same DCOM session and
  derives two outputs: the Auto+non-Running problems (unchanged registry
  TriggerInfo / DelayedAutoStart logic → `service_problems`) AND the configured
  critical services matched by name/display `-like` against the patterns, **in any
  state** → `replaceCritical()` → new table **`critical_service_status`**
  (computer_id, service_name, display_name, state, start_mode, collected_at; PK
  computer_id+service_name). Only services that EXIST on a box are stored
  (DC-only services land only on DCs → servers vs PCs sorts itself out). Offline
  boxes aren't rescanned, so rows persist as last-known (UI flags stale).
  `refresh-single-pc` also populates it.
- **Endpoint** `GET /services/critical` joins `computers` (reachable / ip_address
  / os_version). Client: `CriticalServiceStatus` + `api.criticalServices()`, a new
  **"Kritické služby" tab** (`CriticalServicesPage`, sortable service×machine table:
  Running green / Stopped red, start mode, IP, last check; offline=amber/stale;
  only-not-running filter + search + export; click computer → Computers), and a
  **dashboard tile** "🛡 Kritické služby" (`SummaryCards` props
  `criticalServicesDown`/`criticalServicesTotal`/`onClickCriticalServices`, red when
  any down) → opens the tab.
- **Verified live**: 438 instances / 9 services / 105 machines collected. ⚠️
  **DCs are still blank** — `B-S-W-DC-01/02/03` fail the services CIM scan with
  `New-CimSession : Access is denied`, so their NTDS/Kdc/DNS never get rows. The
  service account needs **WMI/DCOM rights on the DCs** (same gap as disk/services
  scans on hardened servers) — infrastructure, not code. The NTDS/Kdc/DHCPServer
  shown "Stopped+Disabled" are on `DOMENA01` (a demoted/retired DC → legitimate).
- Note: `Dnscache` was NOT in the live `critical_names` at the time (seed list
  lacks it) — add it in Settings to track the DNS Client everywhere.

### Eventlog collector — one bad event no longer drops the PC batch (commit `e6d5851`)

`Get-WinEvent` throws "The description string for parameter reference (%1) could
not be found" for events whose provider message template is missing; under
`-ErrorAction Stop` that aborted the **whole** batch, so **NO events** were
collected from ~16 PCs. Now `Get-WinEvent` uses `-ErrorAction SilentlyContinue
-ErrorVariable gwErr`, the per-event `.Message` render is wrapped in try/catch
with a raw `$_.Properties` fallback (`[unrendered] …`), and an empty result is
only reported as a failure when `$gwErr` holds a real connection/access error
(not "no events" or %1 noise). **Live: failures dropped 20 → 1, +16 PCs now
collect** (and feed the problem-PC scoring, which previously saw them as 0).

### OS breakdown is now an expandable tile (commit `1767c39`)

`OsBreakdownChart` changed from an always-visible full-width panel to a
second-row tile **"📊 Operační systémy"** (count of OS buckets) that toggles the
bar chart inline on click — mirroring the problem-PCs tile. Segment drill-through
to Computers unchanged.

### Reachability — per-PC log, manual run, ping fallback (commits `03a9ad5`, `392bd6d`, `903ae07`)

- **Per-PC logging** (`03a9ad5`): the activity log now logs each PC that **flips**
  reachable with its **name + IP** ("PESEKJW11N (10.8.2.140) → Offline", warn down
  / success up); first-time classification is silent; the summary line logs only
  when the count changed (no more repeated identical heartbeat).
- **Manual run** (`392bd6d`): Settings → "Dostupnost na síti (Status)" has a
  **"Spustit teď"** button → `POST /reachability/run` (`runReachabilityProbeOnce`),
  with result feedback.
- **ICMP ping fallback** (`903ae07`, migration 036): a PC counts as reachable if
  **any** of TCP 135 / TCP 445 / ICMP ping (`ping.exe -n 1`, accepted only on
  `TTL=`) answers — catches hosts that block RPC/SMB but live. Toggle
  `reachability.ping` (default on) + Settings checkbox.

### Misc (commit `563a147`)

TXT (Tab) export now prepends a UTF-8 BOM (CSV already did) so `→ / ✓ / —` don't
render as `â` mojibake in an ANSI-default editor.

## Still open (next thread)

- **DC/server CIM perms** *(top blocker, infrastructure)* — grant `svc-itdashboard`
  WMI/DCOM rights on the DCs and the "Access is denied" servers so disk / services
  / **critical services** can be collected there. Re-confirmed live this session:
  `B-S-W-DC-01/02/03` (+ TRITON, WEB-SERVIS, B-S-W-HAM…) fail the CIM scan, so the
  real AD critical services (NTDS/DNS/Kdc on the actual DCs) are never seen — only
  the old `DOMENA01` returns data. Needs DCOM (Remote Activation) + WMI namespace
  (`Root\CIMV2`: Remote Enable + Enable Account) for the service account via GPO on
  the Domain Controllers + locked servers. *Offered next: a ready GPO/PS delegation
  script + verify collection then flows; and/or a UI "CIM blocked" indicator on
  machines where the disk/service scan fails on Access denied (today only visible
  indirectly via empty disks).*
- **Port-checks → structured report (phase 2)** — per-port state isn't persisted
  into the overview report yet (the report is computers-table only). Either persist
  per-port status or run an on-demand probe for the report.
- **More tests** — server-side `subjectPrefix`/maintenance-window/`shouldAlertNow`
  now covered; still uncovered: the SQL-side faulty score (needs a DB integration
  test) and the alert *send* path. Consider a watchdog (collector freshness →
  critical mail on a separate channel) and structured `client_ip` in `activity_log`
  (both raised in the oponentura responses).

> **Done this batch** (was open): per-agenda email recipients (✅ mig 038/039) and
> the structured PC-vs-server / offline reporting (✅ `reports.ts`, email from
> Computers). Two-level service monitoring + per-PC exceptions (✅ mig 040).

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
