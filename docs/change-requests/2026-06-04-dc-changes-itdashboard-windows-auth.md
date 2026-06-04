# Change Request: DC-side přípravy pro ITDashboard Windows Authentication

**Datum:** 2026-06-04
**Předkládá:** trnka_admin
**Cíl změny:** Domain Controllers v `axinetwork.loc` (B-S-W-DC-01 / -02 / -03)
**Související projekt:** ITDashboard (Anamax443/ITDashboard, server B-S-W-MIKOS 10.8.2.213)
**Schvaluje:** _(podpis IT/Security)_

---

## 1. Shrnutí (TL;DR)

Připravujeme zavedení **integrované Windows autentizace (Negotiate / Kerberos)** pro interní nástroj ITDashboard. To umožní:

- Přihlášení do edit tieru dashboardu **přes native Windows credential dialog** místo custom webové loginky.
- **Server (MIKOS) nikdy nedrží uživatelské heslo** — to si vyřeší prohlížeč přímo s KDC (DC).
- Audit trail s konkrétní AD identitou pro každou edit akci.

Tento change request **nemodifikuje žádné existující objekty, neovlivňuje produkční systémy ani uživatele**. Pouze:

- Přidává **1 nový DNS A record** v zóně `axinetwork.loc`.
- Registruje **2 nové HTTP SPN** na existující servisní účet `svc-itdashboard`.

Žádné GPO, žádné policy, žádné existing user/computer objekty.

---

## 2. Kontext projektu ITDashboard

ITDashboard je interní IT operations dashboard běžící na `B-S-W-MIKOS` (10.8.2.213), port 4000. Účel: AD insight, eventlog analytika, vzdálené admin akce proti klientským PC + serverům.

**Současný stav auth:** dashboard má dvě úrovně přístupu:
- **Read tier** (otevřený, whitelist IP) — zobrazení dashboardu, vyhledávání, periodické metriky. Běží pod sdíleným servisním účtem `svc-itdashboard`.
- **Edit tier** (osobní AD auth) — Launch admin tools (RDP, MMC, PowerShell Remote, PsExec, admin shares) proti vzdáleným strojům. Vyžaduje členství v AD skupině `ITDashboard-Editors`.

Současné Sprint 1 řešení používá custom HTML modal s polem na uživatelské jméno a heslo, server validuje proti AD přes LDAP bind, drží heslo v paměti 8 h.

**Důvod změny:** IT admin tým si vyhradil, že chce **native Windows credential prompt** (perception trust) a **zero password storage na ITDashboard serveru**. Standardní Windows Server pattern je IIS reverse proxy s Windows Authentication před aplikací.

---

## 3. Cílový stav po této změně

Browser → `https://itdashboard.axinetwork.loc` → IIS na MIKOS (port 443) → Windows Authentication (Negotiate / Kerberos) → identity předaná Node aplikaci přes HTTP header → ITDashboard vytvoří session vázanou na konkrétního uživatele.

Pro toto je potřeba:

1. **DNS:** `itdashboard.axinetwork.loc` musí rezolvovat na 10.8.2.213 (IP serveru MIKOS).
2. **SPN:** Kerberos klient v prohlížeči potřebuje SPN registrovaný na servisní účet IIS App Poolu, aby získal service ticket pro tento web. Bez SPN by Kerberos padal na NTLM fallback (méně bezpečné, někdy blokované GPO).

---

## 4. Detail změny — DNS

### 4.1 Nový A record `itdashboard.axinetwork.loc`

**Command (spustit jako Domain Admin na kterémkoliv DC v doméně `axinetwork.loc`):**

```powershell
Add-DnsServerResourceRecordA `
  -ZoneName 'axinetwork.loc' `
  -Name 'itdashboard' `
  -IPv4Address '10.8.2.213' `
  -TimeToLive 01:00:00
```

**Co to dělá:**

- Přidá nový resource record typu A do AD-integrated DNS zóny `axinetwork.loc`.
- Záznam: `itdashboard.axinetwork.loc.  IN  A  10.8.2.213`
- TTL: 1 hodina (běžný default).
- Replikuje se na všechny DC v doméně standardním AD DNS replikačním mechanismem (`DomainDnsZones` partition).

**Cíl IP:** 10.8.2.213 = B-S-W-MIKOS, kde poběží IIS reverse proxy s Windows Authentication a za ním Node aplikace ITDashboard.

**Dopady:**
- Žádné existující DNS záznamy nejsou modifikovány ani odstraněny.
- Žádný stávající uživatel ani služba `itdashboard.axinetwork.loc` adresu neresolvuje (je to nový hostname pro nový web).
- Pokud by takový A record už existoval (jiná IP), command selže — netřeba ošetřovat overwrite case.

**Verify:**
```powershell
Resolve-DnsName itdashboard.axinetwork.loc
# Mělo by vrátit: itdashboard.axinetwork.loc  IN  A  10.8.2.213
```

**Rollback:**
```powershell
Remove-DnsServerResourceRecord `
  -ZoneName 'axinetwork.loc' `
  -RRType A `
  -Name 'itdashboard' `
  -Force
```

---

### 4.2 Volitelně: PTR record (reverse lookup)

Reverse lookup není pro Kerberos / Negotiate **vyžadovaný** (Kerberos používá forward lookup + SPN). Některé Windows komponenty ale reverse lookup používají pro logování a audit. Pokud máš reverse zónu nakonfigurovanou, doporučujeme přidat.

```powershell
Add-DnsServerResourceRecordPtr `
  -ZoneName '2.8.10.in-addr.arpa' `
  -Name '213' `
  -PtrDomainName 'itdashboard.axinetwork.loc'
```

(Předpokládá reverse zónu `2.8.10.in-addr.arpa` — uprav podle toho, jak máš reverse zóny nakonfigurované.)

Pokud reverse zóna není nakonfigurována, tento krok **přeskoč** — nemá dopad na funkci.

---

## 5. Detail změny — SPN registration

### 5.1 Co je SPN

Service Principal Name (SPN) je identifikátor služby v Kerberos infrastruktuře. Když prohlížeč žádá Kerberos ticket pro přístup k `https://itdashboard.axinetwork.loc`, žádá KDC o ticket pro SPN `HTTP/itdashboard.axinetwork.loc`. KDC tento SPN dohledá v AD a vrátí ticket zašifrovaný klíčem účtu, na kterém je SPN registrován. Pokud SPN registrován není, KDC neví, komu ticket adresovat → klient padá na NTLM nebo selhává úplně.

### 5.2 Registrace HTTP SPN na servisní účet

**Cílový účet:** `svc-itdashboard` (již existující servisní účet v doméně, pod kterým běží služba ITDashboardAPI na MIKOS). Bude i identitou IIS App Poolu pro nový dashboard web.

**Commandy:**

```cmd
setspn -S HTTP/itdashboard.axinetwork.loc svc-itdashboard
setspn -S HTTP/itdashboard svc-itdashboard
```

**Co to dělá:**

- Příkaz `setspn -S` je defenzivní varianta `setspn -A` — před zápisem ověří, že stejný SPN není už registrován na jiný objekt v AD. Pokud byl by konflikt, příkaz selže (ochrana proti účtu hijack).
- Přidá hodnotu do atributu `servicePrincipalName` na objektu `svc-itdashboard`:
  - `HTTP/itdashboard.axinetwork.loc` (FQDN forma — primární, pro Kerberos s plnou DNS resolvenou adresou)
  - `HTTP/itdashboard` (NetBIOS forma — fallback pro klienty bez DNS suffix konfigurace, např. starší IE konfigurace)
- Žádné jiné atributy `svc-itdashboard` se nemění (heslo, group memberships, popisy, atd.).

**Dopady:**

- Žádný jiný účet, který by měl tento SPN, by neexistoval — pokud ano (např. omylem před), `setspn -S` selže a my CR musíme analyzovat předtím než pokračujeme.
- Po registraci může KDC vystavovat Kerberos tickety pro `HTTP/itdashboard.*` směřující na klíč účtu `svc-itdashboard`.
- Existující SPN na účtu (např. služby `ITDashboardAPI` z dřívějška) zůstávají beze změny.

**Verify:**

```cmd
setspn -L svc-itdashboard
```

Výstup by měl obsahovat oba nové HTTP SPN + cokoliv co tam bylo dříve (např. interní service SPN).

**Detekce konfliktu** (pokud bys chtěl zkontrolovat preventivně):
```cmd
setspn -Q HTTP/itdashboard.axinetwork.loc
setspn -Q HTTP/itdashboard
```
Před registrací musí vrátit `No such SPN found.` Pokud najde, je potřeba zjistit kde ten SPN visí a vyřešit konflikt předtím.

**Rollback:**
```cmd
setspn -D HTTP/itdashboard.axinetwork.loc svc-itdashboard
setspn -D HTTP/itdashboard svc-itdashboard
```

---

## 6. Souhrn dopadů — kontrolní seznam

| Aspekt | Dopad | Reverzibilní |
|---|---|---|
| DNS zóna `axinetwork.loc` | +1 nový A record `itdashboard` | ✅ Remove-DnsServerResourceRecord |
| DNS reverse zóna (volitelné) | +1 nový PTR | ✅ Remove-DnsServerResourceRecord |
| AD objekt `svc-itdashboard` (atribut `servicePrincipalName`) | +2 hodnoty (HTTP/itdashboard.*) | ✅ `setspn -D` |
| Existující objekty / účty / GPO / policies | **Žádné modifikace** | n/a |
| Replikace na DC | Standardní AD DNS + AD replication | n/a |
| Uživatelský dopad | **Nulový do okamžiku, než se IIS site uvede do provozu** | n/a |

---

## 7. Sequence diagram — co se po Kerberos straně bude dít po dokončení change

```
Browser                  DNS                KDC (DC)         IIS (MIKOS)
   |                      |                    |                 |
   |--Resolve              |                    |                 |
   |  itdashboard.----->   |                    |                 |
   |<------- 10.8.2.213 ---|                    |                 |
   |                                            |                 |
   |---HTTPS GET--------------------------------------->          |
   |<--401 WWW-Authenticate: Negotiate------------------          |
   |                                            |                 |
   |--TGS-REQ                                   |                 |
   |  HTTP/itdashboard.----------------------> |                 |
   |  (s mým TGT)                              |                 |
   |<---TGS-REP (service ticket pro              |                 |
   |    HTTP/itdashboard.* na klíč               |                 |
   |    svc-itdashboard) ---------------------- |                 |
   |                                            |                 |
   |--HTTPS Authorization: Negotiate <token>----------->          |
   |                                            |                 |
   |                                            |   IIS dekóduje token
   |                                            |   pomocí svého App Pool
   |                                            |   identity (svc-itdashboard).
   |                                            |   Získá user identity.
   |                                            |                 |
   |<--200 OK + session cookie--------------------------          |
```

---

## 8. Časový plán

| Fáze | Kdy | Kdo | Co |
|---|---|---|---|
| **Tento CR** (DC-side) | po schválení | trnka_admin | DNS A + SPN (2 commands na DC) |
| **MIKOS-side** (separate CR) | po dokončení DC | trnka_admin | IIS install + Windows Auth site config + reverse proxy na Node :4000 |
| **Code release** | mezitím (probíhá) | trnka_admin | Node aplikace dostane support pro X-Forwarded-User header z IIS |
| **Smoke test** | po MIKOS + code | trnka_admin | Otevřít https://itdashboard.axinetwork.loc, ověřit SSO / credential prompt |

---

## 9. Risk register

| Riziko | Pravděpodobnost | Dopad | Mitigace |
|---|---|---|---|
| SPN konflikt (HTTP/itdashboard.* už existuje na jiném účtu) | Nízká | Změna selže, žádný dopad | `setspn -S` to detekuje preventivně |
| DNS jméno `itdashboard` je už použité | Nízká | `Add-DnsServerResourceRecordA` selže | Před vykonáním ověř `Resolve-DnsName itdashboard.axinetwork.loc` |
| Replikace DNS A recordu na ostatní DC | n/a | n/a | AD-integrated DNS replikuje standardně do 15-60 min |
| Replikace AD atributu na ostatní DC | n/a | n/a | Standardní AD replication (15-60 min) |
| Rollback nutný | Nízká | Plný rollback je dostupný okamžitě | viz rollback commandy výše |

---

## 10. Bezpečnostní úvahy

Změna **rozšiřuje** auth povrch (přidává Kerberos auth cestu k novému internímu webu), ale **nezavádí žádné nové oprávnění ani access** pro existující uživatele:

- Přístup k edit tieru ITDashboard zůstává gated AD skupinou `ITDashboard-Editors` (přístup do skupiny řízen separátně).
- Read tier (zobrazení dashboardu) zůstává whitelist-only podle IP, neautentizovaný.
- DC-side nezavádíme novou doménu trust ani delegaci.
- Servisní účet `svc-itdashboard` nedostává žádné nové permission (jen SPN registrace = identity claim, ne permission grant).
- Po dokončení této změny ALONE (bez MIKOS + code release) **nezačne nic nového fungovat** — `itdashboard.axinetwork.loc` bude rezolvovat, ale na 10.8.2.213 ještě nebude poslouchat IIS, takže klient dostane connect refused / timeout.

Pro **delegaci** (S4U2Proxy, abychom mohli "in name of user" volat na vzdálené stroje) se v této fázi NEKONFIGURUJE nic. Pokud bychom v budoucnu chtěli silent SSO end-to-end (Sprint 1.6b), bude to **separátní CR** s detailní analýzou constrained delegation policy.

---

## 11. Schválení a audit

| Role | Jméno | Datum | Podpis |
|---|---|---|---|
| Předkládá | trnka_admin | 2026-06-04 | _________ |
| Schvaluje | _____________ | __________ | _________ |
| Vykonal | _____________ | __________ | _________ |

**Po vykonání archivovat do repa:** tento dokument + výstup `Resolve-DnsName itdashboard.axinetwork.loc` + výstup `setspn -L svc-itdashboard` (post-change).

---

**Reference:**
- ITDashboard repo: https://github.com/Anamax443/ITDashboard
- HANDOFF: [HANDOFF.md](../../HANDOFF.md)
- Architektura: [docs/ARCHITECTURE.md](../ARCHITECTURE.md)
- Související CR (MIKOS-side IIS install): TBD
