-- Snapshot of services where StartMode = Auto AND State != Running.
-- Replaced fresh on each scan (operator sees current state, not history).
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'service_problems')
CREATE TABLE service_problems (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  computer_id     INT NOT NULL,
  service_name    NVARCHAR(255) NOT NULL,
  display_name    NVARCHAR(512) NULL,
  start_mode      NVARCHAR(32) NOT NULL,
  state           NVARCHAR(32) NOT NULL,
  delayed_start   BIT NOT NULL DEFAULT 0,
  trigger_start   BIT NOT NULL DEFAULT 0,
  collected_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_service_problems_computer FOREIGN KEY (computer_id) REFERENCES computers(id),
  CONSTRAINT uq_service_per_pc UNIQUE (computer_id, service_name)
);

-- Backfill columns if table existed without them (idempotent re-migration)
IF COL_LENGTH('service_problems', 'delayed_start') IS NULL
  ALTER TABLE service_problems ADD delayed_start BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('service_problems', 'trigger_start') IS NULL
  ALTER TABLE service_problems ADD trigger_start BIT NOT NULL DEFAULT 0;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_service_problems_collected' AND object_id = OBJECT_ID('service_problems'))
CREATE INDEX ix_service_problems_collected ON service_problems (collected_at DESC);

-- Default scan interval
MERGE settings AS t
USING (VALUES ('services.interval_sec', '900')) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
