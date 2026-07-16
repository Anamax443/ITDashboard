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

  it('má regex na cestu k doplňku s escapovaným backslashem (regex escape, ne cesta)', () => {
    expect(ps).toContain('[A-Za-z]:\\\\.*?\\.(dll|xll|xlam|ocx|exe|vsto)');
  });

  it('hledá čitelné běhy znaků přes kontrolní znaky, ne přes doslovné NUL', () => {
    expect(ps).toContain('[^\\x00-\\x1F]{4,}');
    expect(ps).not.toContain('\x00');          // doslovný NUL = špatně přeložený escape
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
