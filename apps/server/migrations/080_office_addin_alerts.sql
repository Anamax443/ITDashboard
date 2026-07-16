-- E-mailové alerty pro zakázané doplňky Office.
--
-- Vlastní agenda se svými příjemci: doplňky Office typicky řeší někdo jiný než disky
-- nebo tiskárny (helpdesk/aplikační správce vs. serverový admin). Proto samostatný klíč
-- alerts.officeaddins.recipients — když je prázdný, spadne se na sdílený alerts.recipients,
-- takže jednoduchá instalace s jedním seznamem funguje dál beze změny (stejný vzor jako
-- alerts.disk / alerts.services / alerts.ports / alerts.printers).

-- Stav alertování na nález. Klíč je stabilní identita nálezu (PC | aplikace | doplněk),
-- ne value_name — ten je hash a nemusí přežít reinstalaci doplňku. Vzor: printer_alert_state.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'office_addin_alert_state')
CREATE TABLE office_addin_alert_state (
  alert_key     NVARCHAR(450) NOT NULL PRIMARY KEY,   -- computer_name|office_app|addin_name (lower)
  first_seen_at DATETIME2 NULL,
  last_sent_at  DATETIME2 NULL
);

-- Výchozí nastavení. Vypnuto (jako každá nová agenda) — operátor zapne v Nastavení.
--
-- frequency_hours = 168 (týden): zakázaný doplněk je STAV, ne výpadek. Nikdo ho neopraví
-- do hodiny a připomínat ho denně jako spadlou tiskárnu by z alertů udělalo šum, který
-- lidi přestanou číst. Týdenní připomínka, dokud to někdo nespraví, stačí.
--
-- debounce_minutes = 0: u tiskárny debounce filtruje krátké výpadky, tady není co
-- filtrovat — sken běží po 6 h a nález je buď v registru, nebo není. Falešně pozitivní
-- "krátkodobě zakázaný doplněk" neexistuje.
MERGE settings AS t
USING (VALUES
  ('alerts.officeaddins.enabled', '0'),
  ('alerts.officeaddins.recipients', ''),
  ('alerts.officeaddins.frequency_hours', '168'),
  ('alerts.officeaddins.debounce_minutes', '0'),
  ('alerts.officeaddins.maintenance_window', '')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
