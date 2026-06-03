# Oponentura ITDashboard - URL protocol handlers follow-up

> Archivovano: 2026-06-03
> Zdroj: paste-nuto do session
> Reakce: [2026-06-03-reakce-3-protocol-handlers-followup.md](2026-06-03-reakce-3-protocol-handlers-followup.md)
> Posuzovany commit: `e7a1aaa` (feat(refresh+admin): single-PC refresh endpoint + ITD_ADMIN_USER runas wrapping)

---

Tohle je **prekvapive ciste a bezpecne napsany instalacni skript** pro Custom URL Protocols v systemu Windows (`itd-mmc://`, `itd-rdp://` atd.). V praxi se tyhle veci casto pisou horkou jehlou a oteviraji obrovske bezpecnostni diry (vstrikovani argumentu / Remote Code Execution), ale tady si s tim zjevne dal nekdo praci a myslel na zadni vratka.

Tady je strucny rozbor toho, proc je to dobre, a par veci, na ktere si dat pozor.

---

## Co je skvele (Bezpecnostni plusy)

- **Striktni allowlist (RegEx):** Kontrola pres `findstr /R /X` zajistuje, ze v hostname nesmi byt mezery, uvozovky, ampersandy (`&`) ani jine znaky, kterymi by slo podstrcit dalsi prikazy do prikazove radky.
- **Delkovy limit (63 znaku):** Ochrana proti preteceni nebo podivnemu chovani parseru (`if not "%host:~63,1%"=="" exit /b 1`).
- **Instalace pod uzivatelem (HKCU):** Skript nepotrebuje administratorska prava pro samotnou instalaci handleru, coz je dobre z pohledu principu nejnizsich privilegii.
- **Bezpecne uvozovani:** Vsechny promenne, ktere jdou do externich prikazu, jsou dusledne obalene v uvozovkach, takze nehrozi rozpad argumentu.
- **Volitelny PsExec:** PsExec je defaultne vypnuty a vyzaduje explicitni prepinac `/with-psexec`.
- **Vyuziti `/netonly` u `runas`:** Lokalni nastroj se spusti s interaktivnim kontextem operatora, ale pro sitovou autentizaci muze pouzit credentials z `ITD_ADMIN_USER`.

---

## Na co si dat pozor

### 1. Problem s `runas /netonly` a heslem

`runas` v davkovych souborech neumi automaticky predat heslo. Pokud je definovana promenna `ITD_ADMIN_USER`, vyskoci uzivateli CMD okno s vyzvou k zadani hesla. Pri caste praci to muze byt otravne.

### 2. Validace cesty u `itd-explorer`

`itd-explorer` validuje jen jedno pismeno disku (`[a-zA-Z]`) a vysledny prikaz je `explorer.exe \\%host%\%letter%$`. To je bezpecne, ale umyslne omezuje funkci na administrativni share typu `C$`, `D$`. Libovolna sdilena slozka typu `SdilenaSlozka` tim neprojde.

### 3. Mezera v uvozovkach u `runas`

U MMC launcheru je prikaz ve tvaru:

```cmd
start "" runas /user:"%ITD_ADMIN_USER%" /netonly "mmc.exe %2 /computer=%host%"
```

`%2` je sice tvrde zadratovany na bezpecny snap-in a `%host%` uz prosel allowlistem bez mezer, ale pro cistotu kodu by slo zvazit jeste explicitnejsi vnitrni quoting, pokud to `runas` parser spolehlive snese.

---

## Verdikt

Je to **velmi robustni a profesionalne napsany skript**. Pokud se operator drzi doporuceni v textu a neklika v prohlizeci na "Vzdy povolit", je riziko zneuziti zvenku stazene na minimum.

Stavajici stav lze nasadit. Otevrena produktova volba: podporovat jen admin shares (`C$`, `D$`), nebo rozsirit explorer handler i na delsi nazvy sdilenych slozek.
