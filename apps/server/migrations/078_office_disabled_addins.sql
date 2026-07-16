-- Zakázané doplňky Office (Excel/Word/Outlook/PowerPoint) na klientech.
--
-- Proč to existuje: Office si doplněk po pádu (nebo po násilném ukončení aplikace)
-- sám zakáže a zapíše ho do Resiliency\DisabledItems. Uživatel o tom neví — aplikace
-- se tváří zdravě, jen tiše nedělá to, co má. Konkrétní případ, kvůli kterému to
-- vzniklo: zakázaný "Microsoft Dynamics NAV Excel Add-in" => export z NAVu do Excelu
-- se otevře prázdný (NAV posílá jen .xltx šablonu s připojením, data doplní doplněk
-- přes OData). Nešlo to poznat z Event Logu — Office zakázání nikam nehlásí.
--
-- Klíčové omezení modelu: DisabledItems žije v HKEY_CURRENT_USER, tedy PER UŽIVATEL.
-- Vzdáleně jde přes HKEY_USERS číst jen hive PŘIHLÁŠENÝCH uživatelů; NTUSER.DAT je
-- za běhu exkluzivně zamčený, takže offline cesta přes C$ (jako u crash dumpů) tady
-- nefunguje. Proto se stav dozvíme jen u živých stanic a scans.status to rozlišuje.

-- Stav skenu na PC — jeden řádek na počítač, přepisuje se (současný stav, ne historie).
-- Existuje i pro zdravé PC (disabled_count = 0), aby šlo odlišit "ověřeno, čisté"
-- od "nikdy neskenováno" (řádek chybí) — stejná tri-state logika jako computers.reachable.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'office_addin_scans')
CREATE TABLE office_addin_scans (
  computer_id     INT NOT NULL PRIMARY KEY,
  computer_name   NVARCHAR(255) NOT NULL,
  scanned_at      DATETIME2 NOT NULL CONSTRAINT DF_office_scans_at DEFAULT SYSUTCDATETIME(),
  status          NVARCHAR(32) NOT NULL,        -- 'ok' | 'no_users' (nikdo přihlášen) | 'error'
  error           NVARCHAR(512) NULL,
  users_seen      INT NOT NULL CONSTRAINT DF_office_scans_users DEFAULT 0,
  disabled_count  INT NOT NULL CONSTRAINT DF_office_scans_cnt DEFAULT 0,
  nav_disabled    BIT NOT NULL CONSTRAINT DF_office_scans_nav DEFAULT 0,
  CONSTRAINT fk_office_scans_computer FOREIGN KEY (computer_id) REFERENCES computers(id)
);

-- Detail: jeden řádek na (PC, uživatel, aplikace, zakázaná položka).
-- Při každém úspěšném skenu se řádky daného PC smažou a zapíšou znovu — je to
-- současný stav, ne append log. Doplněk se dá povolit zpátky a řádek musí zmizet.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'office_disabled_addins')
CREATE TABLE office_disabled_addins (
  id             INT IDENTITY(1,1) PRIMARY KEY,
  computer_id    INT NOT NULL,
  computer_name  NVARCHAR(255) NOT NULL,        -- denormalizované, ať výpis nepotřebuje join
  user_sid       NVARCHAR(128) NOT NULL,
  user_account   NVARCHAR(255) NULL,            -- DOMENA\login, když jde SID přeložit
  office_app     NVARCHAR(32) NOT NULL,         -- Excel | Word | Outlook | PowerPoint
  office_version NVARCHAR(16) NOT NULL,         -- 16.0, 15.0, …
  value_name     NVARCHAR(64) NOT NULL,         -- název REG_BINARY hodnoty (např. E11D806)
  addin_path     NVARCHAR(512) NULL,            -- cesta k .dll/.xll vytažená z binárky
  addin_name     NVARCHAR(255) NULL,
  is_nav         BIT NOT NULL CONSTRAINT DF_office_addins_isnav DEFAULT 0,   -- NAV/BC doplněk = náš původní případ
  detected_at    DATETIME2 NOT NULL CONSTRAINT DF_office_addins_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_office_addins_computer FOREIGN KEY (computer_id) REFERENCES computers(id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_office_addins_computer')
CREATE INDEX IX_office_addins_computer ON office_disabled_addins (computer_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_office_addins_nav')
CREATE INDEX IX_office_addins_nav ON office_disabled_addins (is_nav, detected_at);

-- Výchozí nastavení. Vypnuto (jako každá nová per-PC úloha) — operátor zapne v Nastavení.
-- Interval 6 h: zakázaný doplněk je stav, který se mění po pádu aplikace, ne po minutách;
-- častější sken by jen zbytečně zatěžoval DCOM na klientech.
MERGE settings AS t
USING (VALUES
  ('officeaddins.enabled', '0'),
  ('officeaddins.interval_sec', '21600')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
