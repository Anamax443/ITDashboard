# Architecture

## Components

### Desktop client (`apps/desktop`)
- Electron + React + TypeScript.
- Per-PC install pro IT operátory (NSIS installer + portable build).
- Renderer mluví HTTPS s API na `10.8.2.213:4000`.
- `contextIsolation: true`, `nodeIntegration: false` — žádný přímý přístup k Node.js z renderer process.
- Skripty se nespouštějí lokálně z klienta; klient volá `POST /scripts/:slug/run` a API je spustí na serveru.

### API + collector (`apps/server`)
- Fastify + TypeScript, běží jako Windows Service na `10.8.2.213` (NSSM).
- Service account `MICOS\svc-itdashboard` (domain user, member of skupin potřebných pro WinRM + AD read).
- Endpoints (MVP):
  - `GET /health`, `GET /health/db`
  - `GET /events`, `GET /events/summary`, `GET /events/top-ids`
  - `GET /computers`
  - `GET /scripts`, `POST /scripts/:slug/run` (TODO)
- Background jobs:
  - **Collector** — every `COLLECTOR_POLL_INTERVAL_SEC` (default 300s) pulls Warning/Error/Critical z každého enabled PC.
  - **Rollup** — denně 02:00 UTC → `sp_rollup_yesterday` (agregáty do `event_daily_agg`).
  - **Purge** — denně 03:00 UTC → `sp_purge_old_events @retention_days = 90` (smaže events starší než 90 dní).

### Database (`MSSQL 10.8.2.225\BCNEW`, DB `ITDashboard`)
- `computers` — sledované cíle.
- `events` — raw eventy, retention 90 dní. Indexy: `(time_created, level)`, `(computer_id, time_created)`, `(event_id, time_created)`.
- `event_daily_agg` — denní agregáty per (computer, log_name, event_id, level). Retention: napořád.
- `scripts`, `script_runs` — katalog skriptů + run history.
- `credentials` — DPAPI-encrypted blobs (opaque pro SQL, dešifrované jen service accountem).

## Retention policy

| Data | Retention | Mechanism |
|------|-----------|-----------|
| Raw `events` | 90 dní | `sp_purge_old_events @retention_days = 90` daily |
| `event_daily_agg` | navždy | žádné delete |
| `script_runs` | 1 rok | TODO (purge job v iter-2) |
| `credentials.last_used_at` | navždy | součást záznamu |

Změna retention: `RETENTION_RAW_DAYS` env var → restart API service.

## Eventlog collection

Pull model (MVP):
- Pro každý enabled PC: `New-PSSession -ComputerName X -Credential` → `Get-WinEvent -FilterHashtable @{LogName='System','Application','Security'; Level=1,2,3; StartTime=<lastCollected>}` → ConvertTo-Json → upsert do `events`.
- Per-PC `last_collected_at` se trackuje, aby se eventy neduplikovaly.
- Při WinRM failu: PC dostane `last_error` + `consecutive_failures`; po 10× failure se PC pause-uje (alert).

Push model (iter-2 pro NTB):
- Lehký agent jako Windows Service na cílovém PC, periodicky pushuje na `POST /ingest/events` přes mTLS.

## Security

- **API service account:** doménový `svc-itdashboard` (nikdy ne Domain Admin). Member of:
  - `Event Log Readers` na cílových PC (přes GPO)
  - `Remote Management Users` na cílových PC
  - `Read` přes AD (default Authenticated Users sufficient)
- **DB:** Integrated Auth, žádné heslo v configu. `db_owner` na `ITDashboard`, žádný přístup mimo.
- **Credentials vault:** DPAPI CurrentUser scope — encrypt/decrypt funguje jen pod service accountem. Při změně service accountu credentials zneplatní (re-enter).
- **Klient → API:** HTTPS, autentizace přes Windows Integrated Auth (Negotiate/Kerberos) — Fastify plugin `@fastify/passport` + `passport-kerberos` (TODO).
- **Audit log:** každý `script_runs` zachycuje `invoked_by` (Kerberos principal).

## Why MSSQL

- Existující SQL server `10.8.2.225` v doméně, integrated auth, žádné credentials v configu.
- Postgres by přidal +1 deploy unit bez přínosu.
- 10 GB limit Express edition nedostatečný — používáme dedikovanou (Standard/Enterprise) instanci.

## Open questions

- [ ] Edition SQL serveru — Standard? (potřeba pro online index rebuild, partitioning advanced features)
- [ ] AD service account `svc-itdashboard` — zavedený postup nebo ad-hoc?
- [ ] Alerting kanál — Resend email, Teams webhook, oba?
- [ ] mTLS klient↔API — nebo stačí Kerberos?
- [ ] Push agent na NTB — iter-2 nebo později?
