---
date: 2026-06-04
type: reakce
target: 2026-06-04-oponentura-reakce-cr-dc-windows-auth-meta-review.md
verdict: accepted; gMSA point corrected per operator decision
---

# Reakce — meta-oponentura procesu CR DC Windows Auth (2026-06-04)

## Souhrn

Pozitivní meta-review DevSecOps procesu akceptováno. Doporučený deploy path (podpis → DC commands → audit export → MIKOS CR) potvrzen jako sekvence k execution.

## 1 korekce — gMSA decision

Meta-reviewer chválí přístup "TASK-AUTH-002 zařazeno do Sprint 2 backlog" jako saneční. **Operator paralelně rozhodl gMSA explicitně zamítnout** (2026-06-04, zhruba shodně s timing tohoto meta-review).

Aktuální stav po operator decision:
- `svc-itdashboard` **zůstává regular doménový user account**, ne gMSA
- TASK-AUTH-002 (gMSA migration) **se neotevírá**
- Mitigace: dedikace na jednu službu + minimal permission set + audit doc `docs/AD-permissions-svc-itdashboard.md` ke schválení samostatně
- Reasoning: operational complexity testování / rollout gMSA je v tomto kontextu vyšší než přínos
- Re-opening podmínka: kdyby compliance audit / security incident / regulatory požadoval, otevře se nový CR

Memory rule [[project-itdashboard-svc-account]] zapečetěna 2026-06-04.

Zbývající 3 commitments z původní reakce (secure cookie, HTTPS mandatory, no unconstrained delegation) stojí beze změny.

## Deploy path = potvrzeno

Doporučená sekvence z meta-review akceptována:

1. **Podpis CR** — security tým podepíše dokument
2. **Execute DC commands**:
   - `Add-DnsServerResourceRecordA -ZoneName 'axinetwork.loc' -Name 'itdashboard' -IPv4Address '10.8.2.213' -TimeToLive 01:00:00`
   - `setspn -S HTTP/itdashboard.axinetwork.loc svc-itdashboard`
   - `setspn -S HTTP/itdashboard svc-itdashboard`
3. **Audit export** — výstupy `Resolve-DnsName itdashboard.axinetwork.loc` + `setspn -L svc-itdashboard` archivovat do `docs/audit/2026-06-04-post-cr-dc-windows-auth/`
4. **MIKOS-side CR** — separátní document (in-flight); pokrývá IIS install + URL Rewrite + ARR + Windows Auth site + reverse proxy + HTTPS binding s explicit redirect-or-deny pro plain HTTP
5. **Node-side code completion** — session-windows endpoint + AuthGate Windows-first fallback flow (in-flight, partially committed v session-store.ts Session type extension)
6. **End-to-end smoke test** — `https://itdashboard.axinetwork.loc` z domain-joined PC, ověřit SSO transparent flow nebo native Windows credential dialog

## Cross-references

- Memory rule [[feedback-oponentury-archive]] — meta-review archived + reakce written, hotovo
- Memory rule [[feedback-default-workflow-docs-push]] — docs synced + auto push without asking
- Memory rule [[project-itdashboard-svc-account]] — gMSA permanent decision, ne re-litigovat
