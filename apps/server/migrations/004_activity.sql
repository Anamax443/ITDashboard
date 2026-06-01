-- AD sync history (persistent — collector_runs is for eventlog collection)
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ad_sync_runs')
CREATE TABLE ad_sync_runs (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  started_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  finished_at     DATETIME2 NULL,
  fetched         INT NULL,
  inserted        INT NULL,
  updated         INT NULL,
  removed         INT NULL,
  error           NVARCHAR(MAX) NULL,
  trigger_source  NVARCHAR(32) NULL
);
