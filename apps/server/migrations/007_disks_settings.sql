-- Disk space tracking per computer + per drive letter
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'disks')
CREATE TABLE disks (
  id            INT IDENTITY(1,1) PRIMARY KEY,
  computer_id   INT NOT NULL,
  drive_letter  NVARCHAR(8) NOT NULL,       -- 'C:', 'D:'
  volume_label  NVARCHAR(255) NULL,
  filesystem    NVARCHAR(32) NULL,           -- 'NTFS', 'ReFS'
  total_bytes   BIGINT NOT NULL,
  free_bytes    BIGINT NOT NULL,
  collected_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_disks_computer FOREIGN KEY (computer_id) REFERENCES computers(id),
  CONSTRAINT uq_disks_per_drive UNIQUE (computer_id, drive_letter)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_disks_collected' AND object_id = OBJECT_ID('disks'))
CREATE INDEX ix_disks_collected ON disks (collected_at DESC);

-- Key/value settings store (thresholds, feature flags, etc)
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'settings')
CREATE TABLE settings (
  [key]      NVARCHAR(128) NOT NULL PRIMARY KEY,
  [value]    NVARCHAR(MAX) NOT NULL,
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Seed default disk thresholds
MERGE settings AS t
USING (VALUES
  ('disk.critical_pct',  '5'),
  ('disk.warning_pct',   '15'),
  ('disk.critical_gb',   '5'),
  ('disk.warning_gb',    '20'),
  ('disk.threshold_mode','pct')  -- 'pct' or 'gb' or 'either' (warning if either threshold tripped)
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
