-- Printer supply levels (G2): per-printer ink/toner/maintenance levels read from
-- the network printers themselves. Primary source is SNMP Printer-MIB
-- (prtMarkerSupplies — uniform across HP / Epson / Brother / Kyocera); two
-- vendor gaps are filled by a best-effort HTTP scrape of the printer's own web
-- UI (Brother numeric toner %, Epson maintenance box) — see
-- printer-supplies-collector.ts. Read-only; no secret beyond the SNMP community.
--
-- One row per (printer MAC, supply) — keyed by a normalized supply_key
-- (K/C/M/Y/MAINT/DRUM/BELT/...). The collector replaces a printer's rows each
-- cycle, so a supply that disappears from the device disappears here too.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'printer_supplies')
  CREATE TABLE printer_supplies (
    mac_address  NVARCHAR(32)  NOT NULL,
    supply_key   NVARCHAR(32)  NOT NULL,   -- normalized: K/C/M/Y/MAINT/DRUM/BELT/FUSER/OTHER
    supply_index INT           NOT NULL DEFAULT 0,  -- ordering within the printer
    description  NVARCHAR(255) NULL,        -- raw device description (e.g. "Black Toner Cartridge HP CE505X")
    colorant     NVARCHAR(32)  NULL,        -- black/cyan/magenta/yellow/none
    supply_type  NVARCHAR(16)  NULL,        -- ink/toner/maintenance/waste/drum/belt/fuser/other
    level_pct    INT           NULL,        -- 0..100 (NULL = unknown / "some remaining")
    level_raw    INT           NULL,        -- raw SNMP level (may be negative sentinel)
    max_raw      INT           NULL,        -- raw SNMP max capacity
    part_code    NVARCHAR(64)  NULL,        -- order code when the device exposes it (HP/Epson)
    model        NVARCHAR(128) NULL,        -- printer model (from sysDescr / web UI title)
    source       NVARCHAR(16)  NULL,        -- 'snmp' | 'http'
    collected_at DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_printer_supplies PRIMARY KEY (mac_address, supply_key)
  );

-- Settings: master enable + cadence + SNMP community + the "low" threshold and
-- the HTTP-fallback toggle. Default ON — the collector only probes devices the
-- operator has already categorized as `printer`, and SNMP/HTTP reads are
-- harmless. Community defaults to the conventional read-only "public".
MERGE settings AS t
USING (VALUES
  ('printer_supplies.enabled', '1'),
  ('printer_supplies.interval_sec', '900'),
  ('printer_supplies.snmp_community', 'public'),
  ('printer_supplies.low_pct', '15'),
  ('printer_supplies.http_fallback', '1')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
