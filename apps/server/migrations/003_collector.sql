-- Collector state per computer
IF COL_LENGTH('computers', 'last_collected_at') IS NULL
  ALTER TABLE computers ADD last_collected_at DATETIME2 NULL;

IF COL_LENGTH('computers', 'last_error') IS NULL
  ALTER TABLE computers ADD last_error NVARCHAR(MAX) NULL;

IF COL_LENGTH('computers', 'consecutive_failures') IS NULL
  ALTER TABLE computers ADD consecutive_failures INT NOT NULL DEFAULT 0;

-- Global collector run log (so dashboard can show "last run: 5 min ago, 1234 events")
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'collector_runs')
CREATE TABLE collector_runs (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  started_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  finished_at     DATETIME2 NULL,
  pcs_total       INT NULL,
  pcs_succeeded   INT NULL,
  pcs_failed      INT NULL,
  events_added    INT NULL,
  trigger_source  NVARCHAR(32) NULL,    -- 'scheduled' | 'manual'
  notes           NVARCHAR(MAX) NULL
);

-- Dedup index: same (computer, event_id, time_created, log_name) musí být unikátní
-- aby opakované Get-WinEvent runs nepřinášely duplicity.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_events_dedup' AND object_id = OBJECT_ID('events'))
CREATE UNIQUE NONCLUSTERED INDEX ux_events_dedup
  ON events (computer_id, event_id, log_name, time_created)
  WITH (IGNORE_DUP_KEY = ON);
