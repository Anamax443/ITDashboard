---
date: 2026-06-03
type: reakce
target: 2026-06-03-oponentura-4-installer-v2-review.md
verdict: accepted; fix applied in same commit
---

# Reakce — oponentura 4 (installer v2 post-0cc27a3)

## Souhrn

Pozitivní hodnocení revize (delayed expansion, centralizovaný footer, persistent
log) akceptováno bez výhrad. Jediná otevřená položka — **console reflected
injection přes `echo URL: "!url!"`** — uznána a opravena ve stejném commitu,
NE shippnuta as-is.

## Rozhodnutí: fix, ne ship as-is

Reviewer správně označil riziko jako „spíše teoretické" (interní doménový
nástroj, threat model = incidentální discovery non-IT uživatelem, ne
adversarial — viz `docs/dashboard.html` security model + memory rule
`feedback_corp_network_probe_explicit_only`). Přesto fix shippujeme protože:

1. **Náklady jsou minimální** — vyhození jednoho `echo` řádku + komentář, žádný
   dopad na funkcionalitu, žádná regrese.
2. **Memory rule `feedback_go_to_market_standard`** — všechny aplikace stavět
   ve standardu go-to-market, žádné „solo-operator stačí" zkratky.
3. **Eliminuje celou třídu issue** — místo „attacker by musel vymyslet payload,
   který projde URL parserem a zároveň obsahuje ANSI escape" je odpověď „URL
   se na konzoli nikdy nevypisuje".
4. **Diagnostická hodnota zůstává** — `!url!` se pořád zapisuje do
   `%LOCALAPPDATA%\ITDashboard\launchers\last-itd-*.log`. File write není
   subject to terminal escape interpretation; helpdesk má pořád to, co
   potřebuje.

## Aplikovaný diff

V `apps/server/scripts/install-itd-handlers.cmd`, `:append_common_footer`:

```diff
+:: Console echoes intentionally print only validated/derived fields (!reason!,
+:: !host!, !letter!) — all regex-allowlisted to [a-zA-Z0-9._-] or a single
+:: letter. The raw !url! is NEVER echoed to the console because an attacker-
+:: controlled URL could contain ANSI escape sequences or other control chars
+:: that manipulate the operator's terminal (console reflected injection).
+:: The raw !url! is still recorded in the log file (file write is not subject
+:: to terminal escape interpretation, and ops needs the original input for
+:: helpdesk diagnosis).
 >>"%~1" echo goto :eof
 >>"%~1" echo :fail
 >>"%~1" echo echo.
 >>"%~1" echo echo ITDashboard launcher failed: !reason!
-​>>"%~1" echo echo URL: "!url!"
 >>"%~1" echo if defined host echo Host: "!host!"
 >>"%~1" echo if defined letter echo Drive letter: "!letter!"
 ...
 >>"%~1" echo ^>^>"%%log%%" echo [%%date%% %%time%%] failed %%~nx0 reason=!reason! url="!url!" host="!host!" letter="!letter!"
-​>>"%~1" echo echo Wrote log: %%log%%
+>>"%~1" echo echo Full URL recorded in: %%log%%
 >>"%~1" echo pause
 >>"%~1" echo exit /b 1
```

Změny:
- **Drop console echo of `!url!`** — primární surface eliminován.
- **Inline komentář v installeru** — zdůvodnění proč `!url!` chybí, aby si
  budoucí maintainer (já za 3 měsíce) nemyslel „to chybí omylem, přidám zpět".
- **Změna message `Wrote log:` → `Full URL recorded in:`** — operátorovi je
  jasné, kam jít, když chce vidět původní URL.

## Co se NEZMĚNILO (proč ne)

- **Log file zápis `url="!url!"`** ponechán. Soubor `.log` se neinterpretuje
  jako terminal output. Editor (Notepad, VSCode) ANSI escape sekvence
  zobrazí jako literal text. Jediný způsob jak by se daly „aktivovat" je
  kdyby helpdesk `type last-itd-*.log` v cmd.exe — i tam je modern Windows
  ConHost už defaultně dělá `ESC[*` parsing jen pro skutečné terminal
  control, ne pro libovolné bajty. Riziko: malé. Diagnostická hodnota
  původního URL pro helpdesk: vysoká. Trade-off ve prospěch keep.

- **Striktní allowlist regex `[a-zA-Z0-9._-]`** ponechán beze změny —
  reviewer to chválí jako neprůstřelné, žádný důvod sahat.

- **`!host!` a `!letter!` na konzoli ponecháno** — obě prošly findstr regex
  validací, takže garantovaně neobsahují ANSI escape (ESC `0x1B` není v
  allowlistu). Echo bezpečný.

## Cross-references

- Předchozí oponentury cyklu: `2026-06-03-oponentura-3-protocol-handlers-followup.md`
- Memory rules invokované: `feedback_go_to_market_standard`,
  `feedback_oponentury_archive`, `feedback_solo_operator_review_governance`
  (verifikováno: tento fix NENÍ auth/cookie/CORS topology change, takže
  nevyžaduje externí pre-deploy oponentura — interní launcher escape
  sanitization).

## Deploy path

1. Commit fix + tyto dva docs soubory.
2. Push na `origin/main` → self-hosted runner deploy → nový installer na
   `http://10.8.2.213:4000/actions/install-handlers.cmd`.
3. **Každá stanice s old launchery musí znovu spustit installer** — HKCU
   launchery se samy neaktualizují (per `0cc27a3` + `08ee00c` pattern,
   teď platí i pro tento fix).
4. Verify: po reinstall na test PC zkusit `itd-mmc://invalid$$host` — okno
   zůstane otevřené, ukáže `reason=invalid_host_chars`, NE vypíše původní
   URL. Log file pořád obsahuje plný URL string.
