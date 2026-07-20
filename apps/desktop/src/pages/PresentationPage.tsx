import { useRef } from 'react';
import { useI18n } from '../i18n.js';

// The system-overview presentation as a first-class in-app page (CS/EN by the app
// language). Print/PDF + Save HTML reuse the Manager-Summary pattern: one
// standalone, theme-independent document is serialised for both, so what's on
// screen == printed == saved, with a UTF-8 meta so there's no mojibake. All CSS is
// scoped under .deck so the deck's generic class names (.card/.tile/.grid…) can't
// collide with the app's own styles.
const DECK_CSS = `
.deck{--accent:#2563eb;--accent2:#0ea5e9;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--soft:#f1f5f9;--font:'Segoe UI',Roboto,Arial,sans-serif;background:#e8edf3;color:var(--ink);font-family:var(--font);line-height:1.6;padding:8px 0 28px}
.deck *{box-sizing:border-box}
.deck .slide{max-width:980px;margin:24px auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:46px 54px;box-shadow:0 10px 30px rgba(15,23,42,.06);page-break-after:always}
.deck .slide.cover{background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 60%,#2563eb 100%);color:#fff;border:0}
.deck .kicker{text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:700;color:var(--accent)}
.deck .cover .kicker{color:#93c5fd}
.deck h1{font-size:40px;line-height:1.15;margin:10px 0 8px}
.deck h2{font-size:26px;margin:4px 0 18px}
.deck h3{font-size:17px;margin:0 0 6px}
.deck p{margin:0 0 14px}
.deck .lead{font-size:19px;color:#e2e8f0;max-width:70ch}
.deck .muted{color:var(--muted)}
.deck .small{font-size:13px}
.deck .grid{display:grid;gap:16px}
.deck .g2{grid-template-columns:1fr 1fr}
.deck .g3{grid-template-columns:1fr 1fr 1fr}
@media (max-width:760px){.deck .g2,.deck .g3{grid-template-columns:1fr}.deck .slide{padding:30px 24px}}
.deck .card{border:1px solid var(--line);border-radius:12px;padding:18px 20px;background:#fff;border-left:4px solid var(--accent)}
.deck .card.ok{border-left-color:var(--ok)}
.deck .card.warn{border-left-color:var(--warn)}
.deck .card.bad{border-left-color:var(--bad)}
.deck .card.sky{border-left-color:var(--accent2)}
.deck .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;background:var(--soft);color:var(--muted);margin:0 6px 6px 0}
.deck ul.clean{margin:6px 0 0;padding-left:18px}
.deck ul.clean li{margin:4px 0}
.deck .metric{font-size:34px;font-weight:800;color:var(--accent);line-height:1}
.deck .metric.ok{color:var(--ok)}.deck .metric.warn{color:var(--warn)}.deck .metric.bad{color:var(--bad)}
.deck .metric-label{font-size:13px;color:var(--muted);margin-top:4px}
.deck .flow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:14px}
.deck .node{border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:var(--soft);font-weight:600}
.deck .node.src{border-left:4px solid var(--accent2)}
.deck .node.core{border-left:4px solid var(--accent)}
.deck .node.out{border-left:4px solid var(--ok)}
.deck .arrow{color:var(--muted);font-weight:700}
.deck table{border-collapse:collapse;width:100%;font-size:14px}
.deck th,.deck td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
.deck th{color:var(--muted);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.deck .note{font-size:12px;color:var(--muted);border-top:1px solid var(--line);margin-top:22px;padding-top:12px}
.deck .footer-brand{font-weight:700;color:var(--accent)}
.deck .anon{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:10px;padding:10px 14px;font-size:13px}
.deck .ss{border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 6px 18px rgba(15,23,42,.08)}
.deck .ss-bar{background:#0f172a;color:#cbd5e1;padding:8px 14px;font-size:12px;display:flex;gap:8px;align-items:center}
.deck .ss-dot{width:10px;height:10px;border-radius:50%;background:#475569}
.deck .ss-body{padding:16px;background:#f8fafc}
.deck .tile{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.deck .bar{height:8px;border-radius:5px;background:#e5e7eb;overflow:hidden}
.deck .bar>span{display:block;height:100%}
@media print{.deck{background:#fff;padding:0}.deck .slide{box-shadow:none;margin:0 auto;border-radius:0;border:0;max-width:100%;break-after:page}}
`;

const CS_BODY = `
<section class="slide cover">
  <div class="kicker">Monitoring IT infrastruktury</div>
  <h1>IT Dashboard</h1>
  <p class="lead">Jednotný přehled o stavu počítačů, serverů, síťových zařízení a tiskáren — automatický sběr dat, včasné e-mailové výstrahy a manažerské souhrny na jednom místě.</p>
  <div style="margin-top:26px" class="small">Přehledová prezentace systému · anonymizovaná verze</div>
</section>
<section class="slide">
  <div class="kicker">Proč systém vznikl</div>
  <h2>Od ručních kontrol k automatickému přehledu</h2>
  <div class="anon" style="margin-bottom:20px">🔒 Anonymizovaná verze — všechny názvy, IP adresy, jména zařízení a e-maily jsou nahrazeny generickými příklady (např. <em>Pobočka A</em>, <code>10.0.0.x</code>, <code>PC-001</code>).</div>
  <div class="grid g2">
    <div>
      <p>Správa rozsáhlejší IT infrastruktury (desítky až stovky počítačů, několik poboček, síťové prvky, tiskárny) se bez nástroje opírá o ruční kontroly a roztříštěné skripty. To znamená:</p>
      <ul class="clean">
        <li>problémy se zjistí <strong>pozdě</strong> — až je nahlásí uživatel,</li>
        <li>není <strong>jednotný přehled</strong> o tom, co v síti vlastně je,</li>
        <li>opakovaná ruční práce (inventury, kontroly disků, služeb, tiskáren).</li>
      </ul>
    </div>
    <div class="card sky"><h3>Cíl</h3><p class="small">Jeden dashboard, který <strong>sám</strong> sbírá data z více zdrojů, drží je v databázi, vizualizuje stav a <strong>proaktivně upozorní</strong> na problém dřív, než ho někdo nahlásí.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Co systém pokrývá</div>
  <h2>Agendy na jednom místě</h2>
  <div class="grid g3">
    <div class="card"><h3>🖥 Počítače &amp; servery</h3><p class="small muted">Dostupnost, OS, ztrátovost a odezva sítě, operátor a poznámky.</p></div>
    <div class="card sky"><h3>🌐 Síťový inventář</h3><p class="small muted">Zařízení v síti spojená podle MAC adresy z více zdrojů.</p></div>
    <div class="card warn"><h3>💾 Disky</h3><p class="small muted">Volné místo, kritické prahy, e-mailová výstraha u klíčových strojů.</p></div>
    <div class="card bad"><h3>⚙ Služby</h3><p class="small muted">Sledování běhu kritických i běžných systémových služeb.</p></div>
    <div class="card"><h3>🔌 Porty</h3><p class="small muted">Dostupnost klíčových TCP portů zvenčí (síť → firewall → služba).</p></div>
    <div class="card ok"><h3>🖨 Tiskárny</h3><p class="small muted">Stav online/offline, hladiny náplní, výstraha při výpadku.</p></div>
  </div>
  <p class="note">Každá agenda má vlastní sběrač dat, vizualizaci na dashboardu a volitelné e-mailové výstrahy se společným nastavením (prahy, příjemci, okno údržby, throttling).</p>
</section>
<section class="slide">
  <div class="kicker">Jak to funguje</div>
  <h2>Architektura ve zkratce</h2>
  <div class="flow" style="margin:10px 0 22px">
    <div class="node src">Síťové prvky</div><div class="node src">Počítače / AD</div><div class="node src">Tiskárny (SNMP)</div>
    <span class="arrow">→</span><div class="node core">Sběrače dat</div><span class="arrow">→</span><div class="node core">Databáze</div>
    <span class="arrow">→</span><div class="node out">Dashboard (web)</div><div class="node out">E-mailové výstrahy</div>
  </div>
  <div class="grid g3">
    <div class="card"><h3>Sběr dat</h3><p class="small muted">Aplikační server periodicky čte data ze síťových prvků, z adresářové služby, pinguje zařízení a čte SNMP z tiskáren. Vše konfigurovatelné, bez tajemství v kódu.</p></div>
    <div class="card"><h3>Uložení</h3><p class="small muted">Strukturovaná SQL databáze s historií. Inventář je klíčovaný <strong>MAC adresou</strong> (trvalá identita) — IP je jen dočasná „adresa pobytu".</p></div>
    <div class="card"><h3>Prezentace</h3><p class="small muted">Webový dashboard s filtrací a manažerskými souhrny + automatické e-mailové reporty a výstrahy přes firemní SMTP relay.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Klíčová funkce</div>
  <h2>Síťový inventář: sloučení více zdrojů podle MAC</h2>
  <div class="grid g2">
    <div>
      <p>Žádný jediný zdroj nevidí všechno. Systém proto kombinuje několik pohledů a slučuje je podle MAC adresy do jednoho záznamu na zařízení:</p>
      <table>
        <tr><th>Zdroj</th><th>Co přidává</th></tr>
        <tr><td>DHCP záznamy</td><td>dynamická i rezervovaná zařízení + jména</td></tr>
        <tr><td>ARP tabulka</td><td>staticky adresovaná zařízení mimo DHCP</td></tr>
        <tr><td>Aktivní sken</td><td>jména (NETBIOS/DNS) i dosud neviděná zařízení</td></tr>
      </table>
      <p class="small muted" style="margin-top:12px">Duplicity vyloučené z principu: jeden řádek na <code>(lokalita, MAC)</code>, slučování a doplňování dat, nikdy nový duplikát.</p>
    </div>
    <div>
      <div class="card sky"><h3>Robustní sběr</h3><p class="small">Data se čtou jednak živě přes API, jednak ze souborových snímků, které si síťový prvek sám pravidelně vytváří. Snímek funguje i jako <strong>signál aktuálnosti</strong> — když přestane „dýchat", systém pozná, že je něco špatně, a upozorní.</p></div>
      <div class="card ok" style="margin-top:14px"><h3>Identita = MAC</h3><p class="small">Zařízení si drží kategorii, jméno i historii IP adres, i když mu IP změní. „MAC = rodné číslo, IP = dočasná adresa."</p><p class="small" style="margin-top:8px;opacity:.75">🎲 <b>Náhodné MAC</b> (Wi‑Fi ve Windows 11 / mobily) systém <b>pozná a označí</b>, aby se nezaměnily za trvalou identitu. Drátových zařízení se to netýká.</p></div>
    </div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Pohled operátora</div>
  <h2>Dashboard — stav parku na první pohled</h2>
  <div class="ss">
    <div class="ss-bar"><span class="ss-dot"></span><span class="ss-dot"></span><span class="ss-dot"></span>&nbsp; IT Dashboard — Přehled</div>
    <div class="ss-body">
      <div class="grid g3" style="margin-bottom:14px">
        <div class="tile"><div class="metric ok">182</div><div class="metric-label">Počítače online</div></div>
        <div class="tile"><div class="metric">49</div><div class="metric-label">Tiskárny</div></div>
        <div class="tile"><div class="metric warn">3</div><div class="metric-label">Disky v riziku</div></div>
      </div>
      <div class="grid g2">
        <div class="tile"><h3 class="small">Operační systémy</h3>
          <div class="small muted">Windows 11</div><div class="bar"><span style="width:62%;background:var(--accent)"></span></div>
          <div class="small muted" style="margin-top:6px">Windows 10</div><div class="bar"><span style="width:24%;background:var(--accent2)"></span></div>
          <div class="small muted" style="margin-top:6px">Server</div><div class="bar"><span style="width:14%;background:#94a3b8"></span></div></div>
        <div class="tile"><h3 class="small">Pobočky</h3>
          <table><tr><td>Pobočka A</td><td class="muted">128 zařízení</td></tr><tr><td>Pobočka B</td><td class="muted">41 zařízení</td></tr><tr><td>Pobočka C</td><td class="muted">37 zařízení</td></tr><tr><td>Pobočka D</td><td class="muted">22 zařízení</td></tr></table></div>
      </div>
    </div>
  </div>
  <p class="note">Ilustrační rozhraní — vykresleno z neutrálních dat, neobsahuje reálné hodnoty.</p>
</section>
<section class="slide">
  <div class="kicker">Proaktivita</div>
  <h2>E-mailové výstrahy, ne hledání problémů</h2>
  <div class="grid g2">
    <div>
      <p>Místo ručního obcházení systém pošle strukturovaný e-mail, jakmile nastane definovaný stav. Každá výstraha má společný „rozumný" model:</p>
      <ul class="clean">
        <li><strong>Debounce</strong> — nepípne na chvilkový výpadek,</li>
        <li><strong>Throttling</strong> — připomene se v rozumném intervalu, ne zahltí,</li>
        <li><strong>Okno údržby</strong> — během plánovaných prací mlčí,</li>
        <li><strong>Per-lokalita / per-stroj</strong> — výjimky, aby „nekřičelo" to, co se teprve nasazuje.</li>
      </ul>
    </div>
    <div class="card bad"><h3>🔴 Příklad: kritický stav disku</h3><p class="small"><strong>PC-001</strong> · disk C: · <span style="color:var(--bad);font-weight:700">2,1&nbsp;GB volných</span> z 240&nbsp;GB (0,9&nbsp;%)</p><div class="bar" style="margin:6px 0"><span style="width:99%;background:var(--bad)"></span></div><p class="small muted">Doručeno na seznam příjemců dané agendy; opakuje se podle nastavené četnosti, dokud stav trvá.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Novinka</div>
  <h2>Komunikace — stav celého datového toku na první pohled</h2>
  <div class="grid g2">
    <div>
      <p>Celý systém stojí na tom, že jednotlivé kanály dat fungují. Nová dlaždice <strong>Komunikace</strong> to shrne do jednoho světla: <strong>zelená</strong>, když SQL, API síťových prvků, stahování souborů (FTP), sběr z klientů, e-mail i UniFi pracují; <strong>oranžová / červená</strong>, jakmile něco vázne.</p>
      <p>Po kliknutí se rozbalí panel, který přesně ukáže, <strong>který kanál</strong> má problém a <strong>kdy naposledy fungoval</strong> — žádné hádání, kde se data zasekla.</p>
      <p class="small muted">Přínos: okamžitá jistota, že celá „roura" dat žije a dashboard ukazuje aktuální stav.</p>
    </div>
    <div class="card sky"><h3>Kanály pod dohledem</h3><ul class="clean small"><li><strong>SQL databáze</strong> — uložení dat,</li><li><strong>API síťových prvků</strong> — živé čtení,</li><li><strong>Stahování souborů (FTP)</strong> — snímky leasů a ARP,</li><li><strong>Sběr z klientů</strong> — data přímo z počítačů,</li><li><strong>E-mail</strong> — odesílání výstrah,</li><li><strong>UniFi</strong> — bezdrátová síť.</li></ul></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Novinka</div>
  <h2>Komunikace na pobočky a internet — kvalita linek živě</h2>
  <div class="grid g2">
    <div>
      <p>Dashboard průběžně měří <strong>odezvu (latenci)</strong> a <strong>ztrátovost paketů</strong> ke každé pobočce i k internetu. Každá lokalita má vlastní barevný čip, takže <strong>pomalá nebo problikávající linka</strong> je vidět okamžitě — ne až podle stížností uživatelů.</p>
      <p>Volitelně se měří i <strong>rychlost stahování z internetu (Mb/s)</strong>.</p>
      <p class="small muted">Přínos: na první pohled jistota, že každá pobočka jede, jak má.</p>
    </div>
    <div class="card ok"><h3>Stav linek</h3><table><tr><th>Lokalita</th><th>Odezva</th><th>Ztráta</th></tr><tr><td>🟢 Pobočka A</td><td class="muted">8 ms</td><td class="muted">0 %</td></tr><tr><td>🟢 Pobočka B</td><td class="muted">14 ms</td><td class="muted">0 %</td></tr><tr><td>🟠 Pobočka C</td><td class="muted">42 ms</td><td class="muted">3 %</td></tr><tr><td>🟢 Internet</td><td class="muted">11 ms</td><td class="muted">↓ 240 Mb/s</td></tr></table><p class="small muted" style="margin-top:10px">Ilustrační hodnoty — barva čipu shrne stav linky.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Novinka</div>
  <h2>⚡ Měření linky — odhalí pomalé a vadné připojení v celém parku</h2>
  <div class="grid g2">
    <div>
      <p>Server měří rychlost <strong>třemi metodami</strong>: <strong>SMB</strong> (skutečná rychlost zápisem a čtením souboru), <strong>rychlost portu síťové karty</strong> (odhalí port zaseknutý na 100&nbsp;Mb nebo Wi-Fi místo drátu) a <strong>Robocopy</strong> (orientační kontrola). Přesně tak vidíte, <strong>který stroj má špatné připojení a čím to je</strong> — vadný kabel, pomalý port i přetíženou linku.</p>
      <p>Výsledky se navíc <strong>vyhodnotí po sítích (/24)</strong>: systém pozná, jestli je pomalá <strong>celá síť</strong> (pobočka / WAN), nebo jen <strong>jednotlivé PC</strong> — a ukáže i sítě, které se zatím <strong>neměřily</strong>. Pro technika je připravený <strong>report v HTML</strong> „co kontrolovat", seřazený podle IP.</p>
      <p class="small muted">Každý běh má svůj <strong>otisk</strong> — historie měření po bězích, takže je vidět vývoj i to, zda oprava zabrala.</p>
    </div>
    <div class="card warn"><h3>Hned první měření odhalilo problém</h3><p class="small">Jeden běh přes park našel <strong>~25 pomalých připojení</strong> — mezi nimi <strong>server zaseknutý na ~13&nbsp;Mb/s</strong> v gigabitové síti.</p><table style="margin-top:8px"><tr><th>Stroj</th><th>↓ / ↑</th><th>Odezva</th></tr><tr><td>🟢 PC-001</td><td class="muted">940 / 910 Mb/s</td><td class="muted">0,4 ms</td></tr><tr><td>🟢 PC-002</td><td class="muted">920 / 880 Mb/s</td><td class="muted">0,5 ms</td></tr><tr><td>🔴 SRV-007</td><td style="color:var(--bad);font-weight:700">13 / 12 Mb/s</td><td class="muted">2,1 ms</td></tr></table><p class="small muted" style="margin-top:10px">Ilustrační hodnoty — barva shrne stav připojení.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Vylepšeno</div>
  <h2>Pády (BSOD) — report, který předáte manažerovi i dodavateli</h2>
  <div class="grid g2">
    <div>
      <p>Stránka pádů teď jasně ukazuje <strong>kdy se naposledy sbíraly dumpy</strong>, <strong>kdy se zapsaly do databáze</strong> a <strong>kdy proběhne další sběr</strong> — víte, jak čerstvá data koukáte.</p>
      <p>Tiskový report o pádu jsme přepracovali: čistý <strong>světlý vzhled pro tisk</strong> s přepínačem tmavá / světlá, správná <strong>diakritika</strong> a <strong>srozumitelné vysvětlení</strong> — co se stalo, technický detail a doporučené kroky.</p>
    </div>
    <div class="card warn"><h3>Vina poctivě rozlišená</h3><p class="small">Report čestně odliší <strong>chybu Windows</strong> od <strong>vadného ovladače třetí strany</strong> — nehází všechno na operační systém.</p><p class="small muted" style="margin-top:8px">Přínos: report v lidské řeči, který bez překládání předáte vedení nebo výrobci hardwaru.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Pod kapotou</div>
  <h2>Technologie, bezpečnost, provoz</h2>
  <div class="grid g2">
    <div>
      <h3>Technologie</h3>
      <div style="margin:8px 0"><span class="pill">Node.js / TypeScript</span><span class="pill">REST API</span><span class="pill">SQL databáze</span><span class="pill">Webový frontend</span><span class="pill">SNMP</span><span class="pill">Adresářová služba</span><span class="pill">SMTP</span></div>
      <h3 style="margin-top:16px">Provoz</h3>
      <ul class="clean small"><li>běží jako služba na interním serveru,</li><li>automatické nasazení po schválené změně (CI: testy → build → migrace),</li><li>health-check endpoint pro externí monitoring.</li></ul>
    </div>
    <div>
      <h3>Bezpečnost</h3>
      <ul class="clean small"><li><strong>Read-only</strong> servisní účty se síťovými prvky komunikují jen pro čtení,</li><li>přístup omezený na <strong>povolené adresy</strong> (allow-list),</li><li>hesla a tajemství <strong>šifrovaná</strong>, nikdy v kódu ani v repozitáři,</li><li>data zůstávají <strong>uvnitř firemní sítě</strong>.</li></ul>
      <div class="card ok" style="margin-top:14px"><p class="small">Princip nejnižších oprávnění: i kdyby únik, servisní účet umí jen číst a jen z definovaných míst.</p></div>
    </div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Shrnutí</div>
  <h2>Co to přináší</h2>
  <div class="grid g3">
    <div class="card ok"><h3>Dřív víme</h3><p class="small muted">Problémy odhalené automaticky, často dřív, než je zaznamená uživatel.</p></div>
    <div class="card sky"><h3>Jeden přehled</h3><p class="small muted">Počítače, síť, disky, služby a tiskárny na jednom místě, s filtrací.</p></div>
    <div class="card"><h3>Méně ruční práce</h3><p class="small muted">Inventury a kontroly běží samy; člověk řeší jen výjimky.</p></div>
    <div class="card warn"><h3>Manažerské souhrny</h3><p class="small muted">Přehledné reporty stavu parku — i pro netechnické publikum.</p></div>
    <div class="card"><h3>Rozšiřitelné</h3><p class="small muted">Nové agendy a zdroje se přidávají podle stejného vzoru.</p></div>
    <div class="card bad"><h3>Bezpečné</h3><p class="small muted">Read-only, allow-list, šifrovaná tajemství, data uvnitř sítě.</p></div>
  </div>
  <div class="note"><span class="footer-brand">IT Dashboard</span> — přehledová prezentace · anonymizovaná verze. Konkrétní názvy, adresy a data jsou k dispozici pouze v interní verzi.</div>
</section>
`;

const EN_BODY = `
<section class="slide cover">
  <div class="kicker">IT infrastructure monitoring</div>
  <h1>IT Dashboard</h1>
  <p class="lead">A single, unified view of the health of computers, servers, network devices and printers — automatic data collection, timely e-mail alerts and management summaries in one place.</p>
  <div style="margin-top:26px" class="small">System overview presentation · anonymized version</div>
</section>
<section class="slide">
  <div class="kicker">Why the system exists</div>
  <h2>From manual checks to an automatic overview</h2>
  <div class="anon" style="margin-bottom:20px">🔒 Anonymized version — all names, IP addresses, device names and e-mails are replaced with generic examples (e.g. <em>Site A</em>, <code>10.0.0.x</code>, <code>PC-001</code>).</div>
  <div class="grid g2">
    <div>
      <p>Running a larger IT estate (tens to hundreds of computers, several sites, network gear, printers) without a tool relies on manual checks and scattered scripts. That means:</p>
      <ul class="clean"><li>problems are found <strong>late</strong> — once a user reports them,</li><li>there is no <strong>single inventory</strong> of what is actually on the network,</li><li>repetitive manual work (inventories, disk / service / printer checks).</li></ul>
    </div>
    <div class="card sky"><h3>Goal</h3><p class="small">One dashboard that <strong>collects</strong> data from many sources on its own, keeps it in a database, visualizes the state and <strong>proactively warns</strong> about a problem before anyone reports it.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">What the system covers</div>
  <h2>Every agenda in one place</h2>
  <div class="grid g3">
    <div class="card"><h3>🖥 Computers &amp; servers</h3><p class="small muted">Availability, OS, packet loss &amp; latency, owner and notes.</p></div>
    <div class="card sky"><h3>🌐 Network inventory</h3><p class="small muted">Devices on the network merged by MAC address from several sources.</p></div>
    <div class="card warn"><h3>💾 Disks</h3><p class="small muted">Free space, critical thresholds, e-mail alert for key machines.</p></div>
    <div class="card bad"><h3>⚙ Services</h3><p class="small muted">Monitoring of critical and ordinary system services.</p></div>
    <div class="card"><h3>🔌 Ports</h3><p class="small muted">Reachability of key TCP ports from outside (network → firewall → service).</p></div>
    <div class="card ok"><h3>🖨 Printers</h3><p class="small muted">Online/offline state, supply levels, alert on outage.</p></div>
  </div>
  <p class="note">Each agenda has its own collector, a dashboard visualization and optional e-mail alerts with shared settings (thresholds, recipients, maintenance window, throttling).</p>
</section>
<section class="slide">
  <div class="kicker">How it works</div>
  <h2>Architecture in a nutshell</h2>
  <div class="flow" style="margin:10px 0 22px">
    <div class="node src">Network gear</div><div class="node src">Computers / Directory</div><div class="node src">Printers (SNMP)</div>
    <span class="arrow">→</span><div class="node core">Collectors</div><span class="arrow">→</span><div class="node core">Database</div>
    <span class="arrow">→</span><div class="node out">Dashboard (web)</div><div class="node out">E-mail alerts</div>
  </div>
  <div class="grid g3">
    <div class="card"><h3>Collection</h3><p class="small muted">An application server periodically reads from network devices and the directory service, pings hosts and reads SNMP from printers. Fully configurable, no secrets in code.</p></div>
    <div class="card"><h3>Storage</h3><p class="small muted">A structured SQL database with history. The inventory is keyed by <strong>MAC address</strong> (a permanent identity) — the IP is only a temporary "where it lives".</p></div>
    <div class="card"><h3>Presentation</h3><p class="small muted">A web dashboard with filtering and management summaries, plus automatic e-mail reports and alerts via the corporate SMTP relay.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Key capability</div>
  <h2>Network inventory: merging many sources by MAC</h2>
  <div class="grid g2">
    <div>
      <p>No single source sees everything. The system combines several views and merges them by MAC address into one record per device:</p>
      <table>
        <tr><th>Source</th><th>What it adds</th></tr>
        <tr><td>DHCP records</td><td>dynamic and reserved devices + names</td></tr>
        <tr><td>ARP table</td><td>statically addressed devices outside DHCP</td></tr>
        <tr><td>Active scan</td><td>names (NETBIOS/DNS) and not-yet-seen devices</td></tr>
      </table>
      <p class="small muted" style="margin-top:12px">Duplicates are impossible by design: one row per <code>(site, MAC)</code>, merge-and-enrich, never a new duplicate.</p>
    </div>
    <div>
      <div class="card sky"><h3>Robust collection</h3><p class="small">Data is read both live over an API and from file snapshots the network device writes for itself on a schedule. The snapshot doubles as a <strong>freshness signal</strong> — when it stops "breathing", the system knows something is wrong and raises an alert.</p></div>
      <div class="card ok" style="margin-top:14px"><h3>Identity = MAC</h3><p class="small">A device keeps its category, name and IP history even when its IP changes. "MAC = the permanent ID, IP = the temporary address."</p><p class="small" style="margin-top:8px;opacity:.75">🎲 <b>Randomized MACs</b> (Windows 11 / phone Wi‑Fi) are <b>detected and flagged</b> so they aren't mistaken for a permanent identity. Wired devices are unaffected.</p></div>
    </div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Operator's view</div>
  <h2>Dashboard — estate health at a glance</h2>
  <div class="ss">
    <div class="ss-bar"><span class="ss-dot"></span><span class="ss-dot"></span><span class="ss-dot"></span>&nbsp; IT Dashboard — Overview</div>
    <div class="ss-body">
      <div class="grid g3" style="margin-bottom:14px">
        <div class="tile"><div class="metric ok">182</div><div class="metric-label">Computers online</div></div>
        <div class="tile"><div class="metric">49</div><div class="metric-label">Printers</div></div>
        <div class="tile"><div class="metric warn">3</div><div class="metric-label">Disks at risk</div></div>
      </div>
      <div class="grid g2">
        <div class="tile"><h3 class="small">Operating systems</h3>
          <div class="small muted">Windows 11</div><div class="bar"><span style="width:62%;background:var(--accent)"></span></div>
          <div class="small muted" style="margin-top:6px">Windows 10</div><div class="bar"><span style="width:24%;background:var(--accent2)"></span></div>
          <div class="small muted" style="margin-top:6px">Server</div><div class="bar"><span style="width:14%;background:#94a3b8"></span></div></div>
        <div class="tile"><h3 class="small">Sites</h3>
          <table><tr><td>Site A</td><td class="muted">128 devices</td></tr><tr><td>Site B</td><td class="muted">41 devices</td></tr><tr><td>Site C</td><td class="muted">37 devices</td></tr><tr><td>Site D</td><td class="muted">22 devices</td></tr></table></div>
      </div>
    </div>
  </div>
  <p class="note">Illustrative interface — rendered from neutral data, contains no real values.</p>
</section>
<section class="slide">
  <div class="kicker">Proactivity</div>
  <h2>E-mail alerts, not problem hunting</h2>
  <div class="grid g2">
    <div>
      <p>Instead of walking the floor, the system sends a structured e-mail the moment a defined state occurs. Every alert shares a sensible model:</p>
      <ul class="clean"><li><strong>Debounce</strong> — won't fire on a momentary blip,</li><li><strong>Throttling</strong> — reminds at a sensible interval, never floods,</li><li><strong>Maintenance window</strong> — stays quiet during planned work,</li><li><strong>Per-site / per-machine</strong> — exceptions, so what is still being rolled out doesn't "scream".</li></ul>
    </div>
    <div class="card bad"><h3>🔴 Example: critical disk</h3><p class="small"><strong>PC-001</strong> · drive C: · <span style="color:var(--bad);font-weight:700">2.1&nbsp;GB free</span> of 240&nbsp;GB (0.9&nbsp;%)</p><div class="bar" style="margin:6px 0"><span style="width:99%;background:var(--bad)"></span></div><p class="small muted">Delivered to the agenda's recipient list; repeats at the configured frequency while the condition persists.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">New</div>
  <h2>Communication — the whole data pipeline at a glance</h2>
  <div class="grid g2">
    <div>
      <p>The whole system depends on its data channels working. The new <strong>Communication</strong> tile sums that up in one light: <strong>green</strong> when SQL, the network-device API, file downloads (FTP), client collection, e-mail and UniFi are all working; <strong>amber / red</strong> the moment something is off.</p>
      <p>One click opens a panel that shows exactly <strong>which channel</strong> has the problem and <strong>when it last worked</strong> — no guessing where the data got stuck.</p>
      <p class="small muted">Benefit: instant confidence that the whole data "pipe" is alive and the dashboard is current.</p>
    </div>
    <div class="card sky"><h3>Channels watched</h3><ul class="clean small"><li><strong>SQL database</strong> — data storage,</li><li><strong>Network-device API</strong> — live reads,</li><li><strong>File downloads (FTP)</strong> — lease &amp; ARP snapshots,</li><li><strong>Client collection</strong> — data straight from the PCs,</li><li><strong>E-mail</strong> — sending alerts,</li><li><strong>UniFi</strong> — the wireless network.</li></ul></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">New</div>
  <h2>Branch &amp; internet links — live link health</h2>
  <div class="grid g2">
    <div>
      <p>The dashboard continuously measures <strong>latency</strong> and <strong>packet loss</strong> to each branch office and to the internet. Every site gets its own colour-coded chip, so a <strong>slow or flaky link</strong> is visible immediately — not only once users complain.</p>
      <p>Optionally it also measures <strong>internet download speed (Mb/s)</strong>.</p>
      <p class="small muted">Benefit: see at a glance that every branch is running as it should.</p>
    </div>
    <div class="card ok"><h3>Link status</h3><table><tr><th>Site</th><th>Latency</th><th>Loss</th></tr><tr><td>🟢 Site A</td><td class="muted">8 ms</td><td class="muted">0 %</td></tr><tr><td>🟢 Site B</td><td class="muted">14 ms</td><td class="muted">0 %</td></tr><tr><td>🟠 Site C</td><td class="muted">42 ms</td><td class="muted">3 %</td></tr><tr><td>🟢 Internet</td><td class="muted">11 ms</td><td class="muted">↓ 240 Mb/s</td></tr></table><p class="small muted" style="margin-top:10px">Illustrative values — the chip colour sums up each link.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">New</div>
  <h2>⚡ Link speed — reveals slow &amp; faulty connections across the fleet</h2>
  <div class="grid g2">
    <div>
      <p>The server measures speed with <strong>three methods</strong>: <strong>SMB</strong> (real throughput by writing and reading a file), <strong>NIC port speed</strong> (reveals a port stuck at 100&nbsp;Mb or Wi-Fi instead of wired) and <strong>Robocopy</strong> (a rough cross-check). So you see exactly <strong>which machine has a poor connection and why</strong> — a bad cable, a slow port or a congested link.</p>
      <p>Results are also <strong>evaluated per network (/24)</strong>: the system tells whether a <strong>whole network</strong> is slow (a branch / WAN) or just <strong>individual PCs</strong> — and it flags networks <strong>not yet measured</strong>. For the technician there is an <strong>HTML report</strong> of "what to check", sorted by IP.</p>
      <p class="small muted">Every run keeps its own <strong>snapshot</strong> — measurement history per run, so you can see the trend and whether a fix worked.</p>
    </div>
    <div class="card warn"><h3>The very first run found a fault</h3><p class="small">A single fleet run found <strong>~25 slow connections</strong> — including a <strong>server stuck at ~13&nbsp;Mb/s</strong> on a gigabit network.</p><table style="margin-top:8px"><tr><th>Machine</th><th>↓ / ↑</th><th>Latency</th></tr><tr><td>🟢 PC-001</td><td class="muted">940 / 910 Mb/s</td><td class="muted">0.4 ms</td></tr><tr><td>🟢 PC-002</td><td class="muted">920 / 880 Mb/s</td><td class="muted">0.5 ms</td></tr><tr><td>🔴 SRV-007</td><td style="color:var(--bad);font-weight:700">13 / 12 Mb/s</td><td class="muted">2.1 ms</td></tr></table><p class="small muted" style="margin-top:10px">Illustrative values — the colour sums up each connection.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Improved</div>
  <h2>Crashes (BSOD) — a report you can hand to a manager or vendor</h2>
  <div class="grid g2">
    <div>
      <p>The crash page now clearly shows <strong>when dumps were last collected</strong>, <strong>when they were last written to the database</strong> and <strong>when the next collection runs</strong> — so you know how fresh the data is.</p>
      <p>The printable crash report was reworked: a clean <strong>light layout for printing</strong> with a dark / light toggle, correct <strong>diacritics</strong>, and a <strong>plain-language explanation</strong> — what happened, the technical detail and recommended steps.</p>
    </div>
    <div class="card warn"><h3>Blame, told honestly</h3><p class="small">The report honestly distinguishes a <strong>Windows fault</strong> from a <strong>faulty third-party driver</strong> — it doesn't pin everything on the operating system.</p><p class="small muted" style="margin-top:8px">Benefit: a plain-language report you can hand straight to management or the hardware vendor.</p></div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Under the hood</div>
  <h2>Technology, security, operations</h2>
  <div class="grid g2">
    <div>
      <h3>Technology</h3>
      <div style="margin:8px 0"><span class="pill">Node.js / TypeScript</span><span class="pill">REST API</span><span class="pill">SQL database</span><span class="pill">Web frontend</span><span class="pill">SNMP</span><span class="pill">Directory service</span><span class="pill">SMTP</span></div>
      <h3 style="margin-top:16px">Operations</h3>
      <ul class="clean small"><li>runs as a service on an internal server,</li><li>automatic deployment after an approved change (CI: tests → build → migrations),</li><li>a health-check endpoint for external monitoring.</li></ul>
    </div>
    <div>
      <h3>Security</h3>
      <ul class="clean small"><li><strong>Read-only</strong> service accounts talk to network devices for reading only,</li><li>access restricted to <strong>allow-listed addresses</strong>,</li><li>passwords and secrets are <strong>encrypted</strong>, never in code or the repository,</li><li>data stays <strong>inside the corporate network</strong>.</li></ul>
      <div class="card ok" style="margin-top:14px"><p class="small">Least-privilege by design: even on a leak, the service account can only read, and only from defined locations.</p></div>
    </div>
  </div>
</section>
<section class="slide">
  <div class="kicker">Summary</div>
  <h2>What it delivers</h2>
  <div class="grid g3">
    <div class="card ok"><h3>We know sooner</h3><p class="small muted">Problems surfaced automatically, often before a user notices.</p></div>
    <div class="card sky"><h3>One overview</h3><p class="small muted">Computers, network, disks, services and printers in one place, with filtering.</p></div>
    <div class="card"><h3>Less manual work</h3><p class="small muted">Inventories and checks run themselves; people handle only the exceptions.</p></div>
    <div class="card warn"><h3>Management summaries</h3><p class="small muted">Clear estate-health reports — also for a non-technical audience.</p></div>
    <div class="card"><h3>Extensible</h3><p class="small muted">New agendas and sources are added following the same pattern.</p></div>
    <div class="card bad"><h3>Secure</h3><p class="small muted">Read-only, allow-list, encrypted secrets, data inside the network.</p></div>
  </div>
  <div class="note"><span class="footer-brand">IT Dashboard</span> — overview presentation · anonymized version. Specific names, addresses and data are available only in the internal version.</div>
</section>
`;

export function PresentationPage() {
  const { t, lang } = useI18n();
  const deckRef = useRef<HTMLDivElement>(null);
  const body = lang === 'cs' ? CS_BODY : EN_BODY;
  const title = lang === 'cs' ? 'IT Dashboard — přehled systému' : 'IT Dashboard — system overview';

  // One standalone, theme-independent document for both Print and Save (UTF-8 meta
  // → no mojibake). Uses the live deck node so it always matches what's on screen.
  const buildHtml = () =>
    '<!DOCTYPE html>\n<html lang="' + lang + '"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title><style>' + DECK_CSS + '</style></head><body><div class="deck">'
    + (deckRef.current ? deckRef.current.innerHTML : body) + '</div></body></html>';

  const printDoc = () => {
    const w = window.open('', '_blank', 'width=1100,height=850');
    if (!w) { window.print(); return; }
    w.document.write(buildHtml());
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 350);
  };
  const saveHtml = () => {
    const blob = new Blob([buildHtml()], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (lang === 'cs' ? 'IT-Dashboard-prezentace' : 'IT-Dashboard-presentation') + '.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const btn: React.CSSProperties = { font: 'inherit', fontSize: 12, padding: '6px 12px', border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#fff', borderRadius: 6, cursor: 'pointer' };
  const btnSec: React.CSSProperties = { ...btn, background: '#fff', color: '#1d4ed8' };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', overflow: 'auto', background: '#e8edf3' }}>
      <style>{DECK_CSS}</style>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', position: 'sticky', top: 0, zIndex: 5, background: '#0f172a' }}>
        <button style={btn} onClick={printDoc} title={t('summary.print')}>🖨 {t('summary.print')}</button>
        <button style={btnSec} onClick={saveHtml} title={t('summary.saveHtml')}>⬇ {t('summary.saveHtml')}</button>
      </div>
      <div ref={deckRef} className="deck" dangerouslySetInnerHTML={{ __html: body }} />
    </div>
  );
}
