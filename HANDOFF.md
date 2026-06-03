# ITDashboard Handoff

Last updated: 2026-06-03 (Auth Gate Sprint 1 — page-load credentials, session-scoped, server-mediated token mode for launchers)

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
