# Post-execution evidence — CR DC-side Windows Auth (2026-06-04)

CR document: [`docs/change-requests/2026-06-04-dc-changes-itdashboard-windows-auth.md`](../../change-requests/2026-06-04-dc-changes-itdashboard-windows-auth.md)

Reviews:
- [`docs/oponentury/2026-06-04-oponentura-cr-dc-windows-auth.md`](../../oponentury/2026-06-04-oponentura-cr-dc-windows-auth.md) — security review, verdict: approve
- [`docs/oponentury/2026-06-04-oponentura-reakce-cr-dc-windows-auth-meta-review.md`](../../oponentury/2026-06-04-oponentura-reakce-cr-dc-windows-auth-meta-review.md) — DevSecOps meta-review, verdict: approve, recommend deploy path

Executor: trnka_admin
Execution timestamp: 2026-06-04 (around CR submission day)

---

## 1) DNS A record

### Command executed
```powershell
Add-DnsServerResourceRecordA `
  -ZoneName 'axinetwork.loc' `
  -Name 'itdashboard' `
  -IPv4Address '10.8.2.213' `
  -TimeToLive 01:00:00
```

### Verify — direct zone read on DC-01
```
HostName     RecordType  Type  Timestamp  TimeToLive  RecordData
--------     ----------  ----  ---------  ----------  ----------
itdashboard  A           1     0          01:00:00    10.8.2.213
```

### Per-DC replication state (immediately after execution)

| DC | State |
|---|---|
| B-S-W-DC-01 | ✅ has record |
| B-S-W-DC-02 | ⏳ pending replication |
| B-S-W-DC-03 | ⏳ pending replication |

Pre-execution: `Resolve-DnsName itdashboard.axinetwork.loc` returned `DNS name does not exist` (the operator's initial verify hit a DC that hadn't yet received the record — standard AD-DNS replication interval is 15-60 min). Post-execution `Resolve-DnsName ... -Server 10.8.2.254` (DC-01) returned `10.8.2.213` as expected.

### Forced replication via repadmin /syncall /AdeP

To accelerate propagation, operator ran `repadmin /syncall /AdeP` from DC-01. SyncAll completed across all relevant partitions:
- `DC=ForestDnsZones,DC=axinetwork,DC=loc`
- `DC=DomainDnsZones,DC=axinetwork,DC=loc`
- `CN=Schema,CN=Configuration,DC=axinetwork,DC=loc`
- `CN=Configuration,DC=axinetwork,DC=loc`
- `DC=axinetwork,DC=loc`

All five partitions synced from B-S-W-DC-01 to both B-S-W-DC-02 and B-S-W-DC-03 with no errors.

### DNS-server-process zone reload caveat

After repadmin success, `Get-DnsServerResourceRecord -ComputerName 'B-S-W-DC-02' -ZoneName 'axinetwork.loc' -Name 'itdashboard'` still returned empty. This is the DNS server process's in-memory view, which is decoupled from AD partition state — AD-integrated zones are reloaded from AD on the DsPollingInterval (default 180s) or on `Restart-Service DNS`.

Practical mitigation: client lookups (Resolve-DnsName) against each DC IP are the meaningful test, not the local zone scan. If a Resolve fails against a specific DC after the AD partition has replicated, force-reload via `Restart-Service DNS` on that DC.

---

## 2) SPN registrations on svc-itdashboard

### Commands executed
```cmd
setspn -S HTTP/itdashboard.axinetwork.loc svc-itdashboard
setspn -S HTTP/itdashboard svc-itdashboard
```

### setspn output
```
Checking domain DC=axinetwork,DC=loc

Registering ServicePrincipalNames for CN=svc-itdashboard,CN=Users,DC=axinetwork,DC=loc
        HTTP/itdashboard.axinetwork.loc
Updated object

Checking domain DC=axinetwork,DC=loc

Registering ServicePrincipalNames for CN=svc-itdashboard,CN=Users,DC=axinetwork,DC=loc
        HTTP/itdashboard
Updated object
```

Both SPNs were successfully registered. `setspn -S` defensive variant pre-check found no conflicting registrations on other accounts.

### Account DN
`CN=svc-itdashboard,CN=Users,DC=axinetwork,DC=loc`

(Account is in default `Users` container, not in a dedicated OU. Per memory rule `project-itdashboard-svc-account`, this remains a regular domain user account by operator decision — no gMSA migration planned.)

---

## 3) Outstanding (NOT done as part of this CR — separate runbooks)

- AD replication catch-up to DC-02 and DC-03 (passive, will complete within ~60 min OR `repadmin /syncall /AdeP` to force)
- MIKOS-side: install IIS + URL Rewrite + ARR, configure Windows Authentication site, reverse-proxy to `http://localhost:4000` (Node), HTTPS binding with cert from AD CS — separate CR doc TBD
- Node-side code: `/api/auth/session-windows` endpoint, AuthGate frontend with Windows-first flow + password modal fallback — in-flight (`apps/server/src/auth/session-store.ts` Session.authMethod + createWindowsSession already merged)
- `auth.ts` COOKIE_OPTS already wired with `secure: process.env.ITD_COOKIE_SECURE === '1'` — env var to be flipped to `1` simultaneously with IIS+TLS rollout on MIKOS
- AD `docs/AD-permissions-svc-itdashboard.md` audit document — pending (operator decision per oponentura 2026-06-04 reakce commitment 1)

---

## 4) Rollback (kept for reference, not invoked)

```powershell
# DNS A record
Remove-DnsServerResourceRecord `
  -ZoneName 'axinetwork.loc' `
  -RRType A `
  -Name 'itdashboard' `
  -Force

# SPN
setspn -D HTTP/itdashboard.axinetwork.loc svc-itdashboard
setspn -D HTTP/itdashboard svc-itdashboard
```

---

## 5) Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Executor | trnka_admin | 2026-06-04 | _________ |
| Witness / verifier | _____________ | __________ | _________ |
