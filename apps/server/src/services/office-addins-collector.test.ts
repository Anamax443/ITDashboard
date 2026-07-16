import { describe, it, expect } from 'vitest';
import { buildScanScript } from './office-addins-collector.js';

// Escapování TS template literal -> PowerShell -> regex je tady to nejkřehčí místo.
// PowerShell nebere backslash jako escape znak, takže špatně poskládaná cesta
// ("SOFTWARE\\Microsoft") NESPADNE — jen tiše nikdy nic nenajde a sken bude hlásit
// "čisto" na každém PC. Proto se to kontroluje testem, ne okem.
describe('buildScanScript', () => {
  const ps = buildScanScript('PC-TEST');

  it('vloží cílové PC do CIM session', () => {
    expect(ps).toContain("New-CimSession -ComputerName 'PC-TEST'");
  });

  it('používá DCOM, ne WinRM (na doménových PC není nakonfigurované)', () => {
    expect(ps).toContain('New-CimSessionOption -Protocol Dcom');
  });

  it('čte HKEY_USERS, ne HKEY_CURRENT_USER (vzdáleně jiný hive)', () => {
    expect(ps).toContain('$HKU = [uint32]2147483651');
  });

  it('skládá cestu do registru s JEDNÍM backslashem', () => {
    expect(ps).toContain('"$sid\\SOFTWARE\\Microsoft\\Office"');
    expect(ps).toContain('\\Resiliency\\DisabledItems');
    // dvojitý backslash v cestě = tichá chyba, klíč by nikdy nesedl
    expect(ps).not.toContain('SOFTWARE\\\\Microsoft');
  });

  it('má neporušený regex na verzi Office', () => {
    expect(ps).toContain("'^\\d+\\.\\d+$'");
  });

  it('čte REG_BINARY podle délkových prefixů, ne škrábáním regexem', () => {
    // Struktura ověřená na reálné hodnotě: 0x00 DWORD typ, 0x04 cbPath, 0x08 cbName,
    // 0x0C UTF-16 cesta, pak UTF-16 jméno. Scrapování regexem lepilo na jména smetí
    // z hlavičky (dekódovalo se jako CJK) — proto se to už nesmí vrátit.
    expect(ps).toContain('[System.BitConverter]::ToUInt32($bytes, 0)');
    expect(ps).toContain('[System.BitConverter]::ToUInt32($bytes, 4)');
    expect(ps).toContain('[System.BitConverter]::ToUInt32($bytes, 8)');
    expect(ps).toContain('GetString($bytes, 12, $cbPath)');
    expect(ps).toContain('GetString($bytes, 12 + $cbPath, $cbName)');
    expect(ps).not.toContain('[^\\x00-\\x1F]{4,}');   // starý scraping
  });

  it('ověří délky proti velikosti hodnoty a neznámou variantu radši zahodí', () => {
    expect(ps).toContain('if ((12 + $cbPath + $cbName) -gt $bytes.Count) { continue }');
  });

  it('odliší doplněk od dokumentu podle přípony cesty', () => {
    // DisabledItems drží i dokumenty, na kterých Office spadl (.pdf/.doc) — počítat je
    // jako doplňky nafukovalo čísla.
    expect(ps).toContain("$kind = 'document'");
    expect(ps).toContain('(dll|xll|xlam|xla|xll|ocx|vsto|wll|exe|olb|tlb)$');
    expect(ps).toContain("$kind = 'addin'");
  });

  it('filtruje jen reálné uživatele a přeskakuje _Classes hive', () => {
    expect(ps).toContain("-notlike 'S-1-5-21-*'");
    expect(ps).toContain("-like '*_Classes'");
  });

  it('prochází všechny sledované aplikace Office', () => {
    expect(ps).toContain("$apps = @('Excel','Word','Outlook','PowerPoint')");
  });

  it('vrací kompaktní JSON (Node ho parsuje)', () => {
    expect(ps).toContain('ConvertTo-Json -Compress');
  });

  it('uklidí CIM session i při chybě', () => {
    expect(ps).toContain('finally');
    expect(ps).toContain('Remove-CimSession $session');
  });
});
