---
date: 2026-06-04
type: reakce
target: 2026-06-04-oponentura-cr-dc-windows-auth.md
verdict: accepted; 3 follow-up commitments
---

# Reakce — oponentura CR DC-side Windows Auth (2026-06-04)

## Souhrn

Schvalovací verdikt **doporučuji schválit** přijat. Pozitivní hodnocení principů (Kerberos místo password storage, `setspn -S` jako defensive default, žádné nové permission grants, čistý rollback) bere reakce bez komentáře — souhlas.

Tři follow-up varování přijímáme jako **závazné požadavky** pro další fáze, ne jako volitelná doporučení.

## 3 varování → závazné commitments

### 1. Účet `svc-itdashboard` — princip minimálních oprávnění (gMSA explicitně NE)

**Stav dnes (2026-06-04):** `svc-itdashboard` je klasický doménový uživatelský účet, vytvořený jako dedikovaný service account pouze pro ITDashboard. Není Domain Admin ani Enterprise Admin. Má jen permission pro:
- Logon as a service na B-S-W-MIKOS (10.8.2.213)
- Read přístup do AD (default pro authenticated users) — pro Get-ADComputer queries
- WinRM connect na cílové stroje pro eventlog / disk / services collectory
- ACL ke spuštění/zastavení vlastní služby `ITDashboardAPI` přes sc sdset

**Audit ke kontrole:** přidám do `docs/AD-permissions-svc-itdashboard.md` výpis aktuálních membership + delegated rights. Ke schválení samostatně před production rollout Sprint 1.6.

**gMSA migrace: ZAMÍTNUTO operatoru 2026-06-04.** Operator explicitně rozhodl ponechat `svc-itdashboard` jako klasický doménový uživatelský účet — gMSA nebude. Důvod: dodržení minimálních oprávnění + dedikace na jednu službu je z pohledu operatora dostatečná mitigace; benefit gMSA (auto-managed password, žádný operator-known password) je v tomto kontextu menší než operační complexity testování / rollout. Žádný `TASK-AUTH-002` se neotvírá. Pokud by se v budoucnu situace změnila (např. compliance audit požaduje), bude se otevírat nový CR.

### 2. HTTPS/TLS = kritická podmínka, ne nice-to-have

**Akceptováno bezvýhradně.** Dokument explicitně označuje HTTPS:443 v sequence diagramu v sekci 7. Pro vyhnutí ambiguity přidám do **MIKOS-side CR (separátní document, in-flight)** explicitní:

- IIS site **MUSÍ** mít vázaný HTTPS binding na port 443 s platným certifikátem
- HTTP binding na port 80 buď úplně chybí, nebo dělá hard redirect na HTTPS (status 301 + HSTS header)
- Certifikát: prefer interní AD CS (auto-enrollment podle template `WebServer` nebo dedicated `IntranetServers`); fallback na self-signed s ručním pinningem v browser GPO pro pilot phase
- Cookie `itd-session` má `Secure` flag (přidám do auth.ts COOKIE_OPTS jako prereq pro Sprint 1.6 deploy)
- Session cookie + token URL přes plain HTTP odmítnuto: server vrátí 403 pokud `X-Forwarded-Proto: http` nebo connection není TLS

**Code change required:** auth.ts COOKIE_OPTS musí mít `secure: true` v production. Aktuálně je secure flag NEDOSTANUT (HTTP-only deployment dnes), takže by se cookie pod TLS deployment přestala posílat až by se to flipnulo. Zajistím podmíněně: `secure: NODE_ENV === 'production'`. To je standard Express pattern.

### 3. Delegace = ONLY constrained / RBCD, nikdy unconstrained

**Akceptováno bezvýhradně.** Tato podmínka je vepsaná do roadmapy:

- **Sprint 1.6a (současný)**: Windows auth pro session attribution + per-launch ask mode (žádná delegace, žádný S4U). Launcher prompts for credentials at each Launch — operator's original requirement. Žádná AD-side delegation policy.
- **Sprint 1.6b (later, optional)**: pokud bude operator chtít silent launches end-to-end:
  - Trvat na **Resource-Based Constrained Delegation (RBCD)** — konfigurace na cílovém objektu (Computer object), ne na svc-itdashboard
  - Alternativa: classic **Constrained Delegation s msDS-AllowedToDelegateTo** na svc-itdashboard, kde explicitně vyjmenujeme SPNy targetů, nikdy "any service"
  - **Unconstrained Delegation = NIKDY** — vepsáno do code review checklist + sem do reakce jako historický záznam
- Sprint 1.6b CR bude obsahovat detail: which targets, why each one needs delegation, what abuse paths exist, what monitoring (Event ID 4769/4624 with delegation flags) is in place.
- Bez schválení Sprint 1.6b zůstane permanentně ask-mode per launch — bezpečné, jen méně comfortable UX.

## Co se po této oponentuře okamžitě mění v kódu

- `auth.ts` COOKIE_OPTS dostane `secure: process.env.NODE_ENV === 'production'` flag (chrání cookie před HTTP transit)
- `HANDOFF.md` dostane novou sekci pinning těchto 3 commitments jako security guardrails
- `docs/AD-permissions-svc-itdashboard.md` (nový) — audit aktuálních permission svc-itdashboard k schválení samostatně
- **CR document NEZMĚNĚN** — schvalovací verdikt přijatý, dokument zůstává v původní formě pro auditní archiv

## Cross-references

- Pozor na principy z [[feedback-solo-operator-review-governance]]: auth/cookie změny vyžadují external review → tato oponentura naplnila požadavek pro Sprint 1.6 DC-side prereqs.
- Memory rule [[feedback-oponentury-archive]] — archive doc + reakce, hotovo.
- Memory rule [[feedback-go-to-market-standard]] — všechny commitments shippnu jako pro paying customer, ne jako solo-dev shortcut.

## Deploy path

1. Operator submituje CR k formálnímu schválení security tým (paper trail)
2. Po podpisu spustí 2 commandy na DC + verify
3. Pošle výstupy zpět; archivujeme do `docs/audit/` jako post-CR evidence
4. Mezitím se shipne Node-side code (auth.ts secure cookie + session-windows endpoint, in-flight)
5. Pak MIKOS-side CR pro IIS install + Windows Auth + reverse proxy
6. End-to-end smoke test
