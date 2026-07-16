-- Rozlišení doplňku od dokumentu v Resiliency\DisabledItems.
--
-- První živý sken (2026-07-16) ukázal, že Office do DisabledItems zapisuje nejen zakázané
-- DOPLŇKY, ale i zakázané DOKUMENTY — soubory, na kterých aplikace spadla (reálně nalezeno
-- c:\mail\*.pdf a *.doc z cache Wordu). Původní verze je počítala jako doplňky, čímž
-- nafoukla čísla: z "22 z 65 PC má zakázaný doplněk" byla část jen PDF, které kdysi
-- rozhodilo Word. Dokument v seznamu není provozní problém, jen historie jednoho pádu.
--
-- Klasifikuje se podle přípony cesty (ověřitelná), ne podle hlavičkového typu (jehož
-- význam známe jen pro type=1). raw_type se ukládá, ať je z čeho vyjít, kdyby se ukázalo,
-- že přípona nestačí.
--
-- Pozn. k zápisu: runner pouští každý soubor jako JEDEN batch přes tx.request().batch(),
-- takže tu NESMÍ být `GO` (to je konstrukt SSMS/sqlcmd, ne T-SQL — server by ho odmítl;
-- žádná jiná migrace v repu ho taky nemá). Celý batch se ale parsuje PŘED spuštěním, takže
-- UPDATE nového sloupce ve stejném batchi selže na "Invalid column name". Proto jdou příkazy
-- závislé na čerstvě přidaných sloupcích přes EXEC — ten se kompiluje až za běhu.

IF COL_LENGTH('office_disabled_addins', 'item_kind') IS NULL
  ALTER TABLE office_disabled_addins ADD item_kind NVARCHAR(16) NULL;   -- 'addin' | 'document'

IF COL_LENGTH('office_disabled_addins', 'raw_type') IS NULL
  ALTER TABLE office_disabled_addins ADD raw_type INT NULL;             -- hlavičkový DWORD, zatím jen k pozorování

-- Řádky z prvního skenu (před touhle migrací) klasifikaci nemají. Dopočítat ji z cesty
-- stejným pravidlem, jaké používá kolektor — ať výpis nemá díru do prvního přeskenování.
EXEC('
UPDATE office_disabled_addins
SET item_kind = CASE
      WHEN addin_path IS NULL THEN ''document''
      WHEN LOWER(addin_path) LIKE ''%.dll''  OR LOWER(addin_path) LIKE ''%.xll''
        OR LOWER(addin_path) LIKE ''%.xlam'' OR LOWER(addin_path) LIKE ''%.xla''
        OR LOWER(addin_path) LIKE ''%.ocx''  OR LOWER(addin_path) LIKE ''%.vsto''
        OR LOWER(addin_path) LIKE ''%.wll''  OR LOWER(addin_path) LIKE ''%.exe''
        OR LOWER(addin_path) LIKE ''%.olb''  OR LOWER(addin_path) LIKE ''%.tlb''
      THEN ''addin''
      ELSE ''document''
    END
WHERE item_kind IS NULL;
');

-- disabled_count v office_addin_scans nově znamená POČET DOPLŇKŮ, ne všech položek.
-- Přepočítat ze skutečnosti, ať dlaždice, sloupec a manažerské KPI nelžou do prvního
-- přeskenování (to je při 6h intervalu klidně za půl dne).
EXEC('
UPDATE s
SET disabled_count = ISNULL(a.n, 0),
    nav_disabled   = CASE WHEN ISNULL(v.n, 0) > 0 THEN 1 ELSE 0 END
FROM office_addin_scans s
LEFT JOIN (
  SELECT computer_id, COUNT(*) AS n FROM office_disabled_addins
  WHERE item_kind = ''addin'' GROUP BY computer_id
) a ON a.computer_id = s.computer_id
LEFT JOIN (
  SELECT computer_id, COUNT(*) AS n FROM office_disabled_addins
  WHERE item_kind = ''addin'' AND is_nav = 1 GROUP BY computer_id
) v ON v.computer_id = s.computer_id
WHERE s.status = ''ok'';
');

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_office_addins_kind')
CREATE INDEX IX_office_addins_kind ON office_disabled_addins (item_kind, is_nav);
