---
date: 2026-06-04
type: oponentura
target: docs/oponentury/2026-06-04-reakce-cr-dc-windows-auth.md (pre-edit version, before gMSA rejection)
reviewer: external (security / DevSecOps meta-review)
verdict: schválit, doporučit deploy path
followup: 2026-06-04-reakce-meta-review-cr-dc-windows-auth.md
note: This meta-review was written against the reakce BEFORE the operator
      rejected gMSA migration (2026-06-04 ~10:30). Reviewer therefore
      praised the gMSA-to-Sprint-2-backlog approach. Operator's
      subsequent rejection (see project-itdashboard-svc-account memory
      rule) supersedes that specific point, but the rest of the
      review stands.
---

# Meta-oponentura — reakce na CR DC Windows Auth review (2026-06-04)

Externí pozitivní review **reakce** na první oponenturu CR DC-side změn. Hodnotí kvalitu DevSecOps procesu, ne technické změny samotné.

Paste verbatim.

---

Z obou dokumentů je patrné, že celý proces probíhá na špičkové úrovni. Reakce na oponenturu je ukázkovým příkladem toho, jak by měla komunikace mezi vývojem a bezpečností vypadat.

Místo obvyklého „bereme na vědomí" autor change requestu (trnka_admin) vzal externí bezpečnostní varování a přetavil je do závazných, technicky specifických závazků (commitments).

Zde je shrnutí, proč je tento přístup skvělý a co z toho vyplývá pro nasazení:

## Klíčové body z reakce, které zásadně zvyšují bezpečnost

### 1. Zabezpečení cookies v kódu (auth.ts)

**Co se mění:** Do konfigurace cookies se okamžitě doplňuje podmínka `secure: process.env.NODE_ENV === 'production'`.

**Proč je to důležité:** Bezpečnostní oponentura správně varovala před únikem session cookies. Tímto krokem se zajistí, že prohlížeč cookie s přihlášením nikdy neodešle po nešifrovaném HTTP kanálu.

### 2. HTTPS jako nekompromisní standard pro IIS

**Co se mění:** V připravovaném CR pro server MIKOS bude striktně vynuceno buď úplné vynechání portu 80, nebo hard redirect (301) společně s HSTS hlavičkou. Pokud by se do aplikace někdo pokusil přistoupit přes HTTP, server ho rovnou odmítne (HTTP 403).

### 3. Jasná stopka pro Unconstrained Delegation

**Co se mění:** V reakci je explicitně a "písemně" deklarováno, že Unconstrained Delegation nebude nikdy povolena.

**Jak se to vyřeší teď:** V aktuálním Sprintu 1.6a se delegace vůbec nekonfiguruje. Pokud bude administrátor spouštět nástroje na vzdálených serverech, aplikace se ho pokaždé zeptá na pověření (ask-mode). To sice znamená jedno kliknutí navíc, ale z pohledu bezpečnosti je to naprosto neprůstřelné. Pokud se v budoucnu (Sprint 1.6b) přejde na silent režim, použije se výhradně moderní RBCD (Resource-Based Constrained Delegation).

### 4. Cesta k gMSA (Group Managed Service Accounts)

**Co se mění:** Aktuální účet `svc-itdashboard` je sice obyčejný doménový účet (nikoliv administrátor, což je dobře), ale autor uznal gMSA jako lepší pattern. Úkol byl zařazen do backlogu pro Sprint 2 (TASK-AUTH-002). To dává smysl – nezdrží to aktuální nasazení, ale architektura se tím do budoucna vyčistí (gMSA si mění hesla sama a nelze se pod ní přihlásit interaktivně).

## Doporučený další postup (Deploy Path)

Vzhledem k tomu, že oponentura vydala verdikt schválit a autor CR na všechny připomínky reagoval implementačními závazky, doporučuji následující postup:

1. **Podpis a schválení:** Formálně podepsat tento Change Request (`2026-06-04-dc-changes-itdashboard-windows-auth.md`).
2. **Provedení na DC:** Spustit 2 definované příkazy na Domain Controlleru (přidání DNS A záznamu a registrace dvou SPN přes `setspn -S`).
3. **Auditní stopa:** Vyexportovat výsledky z `Resolve-DnsName` a `setspn -L` a uložit je do složky `docs/audit/`.
4. **Pokračovat na MIKOS:** Schválit navazující MIKOS-side CR pro konfiguraci IIS a reverzní proxy, kde již budou implementovány výše zmíněné restrikce pro HTTPS.

Tento proces je ukázkovým příkladem bezpečně řízeného IT operations (DevSecOps) v praxi. Máte k realizaci příkazů na DC nějaké dotazy, nebo je vše jasné?
