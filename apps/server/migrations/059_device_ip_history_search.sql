-- Make device_ip_history searchable by IP / MAC / hostname and add its own
-- retention. It already accumulates one (mac, ip) row per address a device was
-- seen at (first_seen → last_seen window), fed by every observation incl. the
-- router data; this adds the hostname seen at that address + search indexes, so
-- the operator can ask "what was on IP X and for how long" / "history of hostname
-- Z", not just "where has MAC Y been".

IF COL_LENGTH('device_ip_history', 'host_name') IS NULL
  ALTER TABLE device_ip_history ADD host_name NVARCHAR(255) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_device_ip_history_ip')
  CREATE INDEX IX_device_ip_history_ip ON device_ip_history (ip_address, last_seen DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_device_ip_history_host')
  CREATE INDEX IX_device_ip_history_host ON device_ip_history (host_name);

-- History retention (separate from the dhcp_leases ghost prune — history is meant
-- to be kept longer). 0 = keep forever. Default ~1 year.
MERGE settings AS t USING (VALUES ('devices.history_retention_days', '365')) AS s([key], [value])
  ON t.[key] = s.[key] WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
