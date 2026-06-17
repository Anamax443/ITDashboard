-- Device inventory now merges MULTIPLE RouterOS sources, not just bound DHCP
-- leases: dynamic + static DHCP leases AND the router's ARP table (IP↔MAC the
-- router has resolved). This catches statically-addressed devices (printers,
-- servers) that never take a DHCP lease, as far as the router knows them.
--
-- `source` records where a row came from ('dhcp' = DHCP lease, 'arp' = ARP-only
-- device with no lease). Existing rows are DHCP leases by definition.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dhcp_leases') AND name = 'source')
  ALTER TABLE dhcp_leases ADD source NVARCHAR(16) NULL;

-- Backfill existing rows. EXEC() defers compilation so the just-added column
-- resolves (referencing it directly in this same batch = "Invalid column name";
-- the migration runner sends the whole file as ONE batch with no GO support).
EXEC('UPDATE dhcp_leases SET source = ''dhcp'' WHERE source IS NULL');

-- Active subnet scan from the application server (.213): ping-sweeps the
-- configured ranges and reads the local ARP table to learn IP↔MAC for
-- statically-addressed devices the router never sees (same-subnet hosts it
-- doesn't route for). Catches e.g. a printer with a static IP set on the device.
-- Ranges are "Site=CIDR" (same shape as mikrotik.routers); empty/disabled = off.
MERGE settings AS t
USING (VALUES
  ('mikrotik.scan_enabled', '0'),
  ('mikrotik.scan_ranges', '')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
