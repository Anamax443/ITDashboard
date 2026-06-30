-- Real link-speed / connection-quality test: .213 writes an N-MB file to a PC's C$
-- over SMB and reads it back, computing up/down Mb/s. Results archived here for
-- trends (and to spot bad cables / 100-Mb ports). The default file size is 100 MB.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'link_speed_results')
CREATE TABLE link_speed_results (
  id          INT IDENTITY PRIMARY KEY,
  target      NVARCHAR(255) NOT NULL,      -- IP or hostname tested
  up_mbps     FLOAT NULL,                  -- .213 -> client (write)
  down_mbps   FLOAT NULL,                  -- client -> .213 (read)
  up_ms       INT NULL,
  down_ms     INT NULL,
  size_mb     INT NOT NULL,
  error       NVARCHAR(255) NULL,          -- null = OK
  measured_at DATETIME2 NOT NULL CONSTRAINT DF_lsr_measured DEFAULT SYSUTCDATETIME()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_lsr_target_time')
CREATE INDEX IX_lsr_target_time ON link_speed_results (target, measured_at DESC);

-- size_mb = test file size; ok_mbps = threshold (the WORSE of up/down) below which
-- the link is flagged as a problem. We run a 1 Gb network, so a healthy wired link
-- sits well above this and a 100-Mb port / bad cable (~90 Mb/s) falls under it.
MERGE settings AS t USING (VALUES
  ('linkspeed.size_mb', '100'),
  ('linkspeed.ok_mbps', '200')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
