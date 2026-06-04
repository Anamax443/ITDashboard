---
date: 2026-06-04
type: oponentura
target: docs/change-requests/2026-06-04-dc-changes-itdashboard-windows-auth.md
reviewer: external (security / AD review)
verdict: schválit
followup: 2026-06-04-reakce-cr-dc-windows-auth.md
---

# Oponentura — CR DC-side přípravy pro ITDashboard Windows Auth (2026-06-04)

Externí review change-request dokumentu pro DC-side změny (DNS A record + 2 SPN registrace) jako přípravu na Sprint 1.6 Windows Authentication přes IIS reverse proxy.

Paste verbatim z chat session 2026-06-04.

---

Z pohledu Active Directory (AD) infrastruktury a síťové bezpečnosti je tento Change Request **velmi bezpečný a napsaný podle best practices**. Změna má minimální poloměr dopadu (blast radius) a v podstatě jen připravuje půdu pro standardní implementaci zabezpečeného přihlašování.

Zde je detailní analýza toho, proč je to bezpečné, na co si dát pozor a jaká rizika se mohou objevit v další fázi.

---

## Proč je tento návrh bezpečný?

* **Zvyšuje celkovou bezpečnost aplikace:** Přechod z vlastního HTML formuláře (kde server drží hesla uživatelů v paměti po dobu 8 hodin) na **Kerberos (Windows Authentication)** je obrovský krok vpřed. Hesla se vůbec nedostanou k aplikaci, ověření řeší přímo Domain Controller (KDC) pomocí šifrovaných lístků (tickets).
* **Defenzivní příkazy (Fail-Safe):** Použití `setspn -S` namísto `-A` je správná volba. Pokud by dané SPN už omylem viselo na jiném účtu, příkaz selže, místo aby vytvořil duplicitu, která by rozbila Kerberos autentizaci v celé doméně.
* **Nedochází k udělování oprávnění:** Registrace SPN a vytvoření DNS záznamu neuděluje servisnímu účtu `svc-itdashboard` ani uživatelům žádná nová přístupová práva v Active Directory.
* **Čistý a okamžitý rollback:** Pokud by se cokoliv pokazilo, autor dokumentu připravil přesné příkazy pro smazání změn, které vrátí AD do původního stavu.

---

## Na co si dát pozor při realizaci (Doporučení pro schvalovatele)

I když je samotný skript bezpečný, jako schvalovatel byste měl prověřit následující body:

### 1. Kdo kontroluje účet `svc-itdashboard`?

Ujistěte se, že servisní účet `svc-itdashboard` je dedikovaný pouze pro tuto aplikaci a nemá v doméně zbytečně vysoká oprávnění (např. Domain Admin – což by sice fungovalo, ale porušuje to princip minimálních oprávnění). Měl by to být běžný doménový uživatel nebo ideálně **gMSA** (Group Managed Service Account), i když z dokumentu se zdá, že jde o klasický uživatelský účet.

### 2. HTTPS/TLS je kritickou podmínkou

V diagramu se správně počítá s `HTTPS`. Kerberos sice chrání samotné přihlašovací tokeny, ale pokud by následný provoz (session cookie) běžel po nešifrovaném HTTP, mohl by kdokoli na síti relaci unést. IIS proxy **musí** mít platný TLS certifikát (např. z interní PKI).

### 3. Pozor na budoucí fázi: Delegace (Kerberos Double-Hop)

V sekci 10 autor zmiňuje, že aplikace bude časem spouštět admin nástroje proti vzdáleným serverům a že se v budoucnu možná bude řešit **constrained delegation**.

> ⚠️ **Důležité upozornění:** Tato první fáze je bezpečná. Až ale přijde další Change Request na konfiguraci delegace (S4U2Proxy / Unconstrained Delegation), buďte **extrémně přísní**. Nikdy neschvalte *Unconstrained Delegation*. Trvejte výhradně na **Resource-Based Constrained Delegation (RBCD)** nebo klasické *Constrained Delegation*, aby účet `svc-itdashboard` mohl impersonovat uživatele pouze a jen na konkrétní cílové servery.

---

## Shrnutí

Změna **neohrožuje** produkční prostředí, nemění politiky (GPO) a nemá vliv na stávající uživatele. **Z technického hlediska je změna bezpečná a doporučuji ji schválit.**
