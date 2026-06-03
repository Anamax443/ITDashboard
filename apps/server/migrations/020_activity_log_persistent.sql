-- Persistent activity log — every logActivity() call is also fire-and-forget
-- INSERTed here in addition to the in-memory ring buffer that powers the live
-- view. Lets the operator search history across restarts.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'activity_log')
CREATE TABLE activity_log (
  id        BIGINT IDENTITY(1,1) PRIMARY KEY,
  ts        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  level     NVARCHAR(16) NOT NULL,    -- info | warn | error | success
  source    NVARCHAR(64) NOT NULL,    -- collector | disk | services | perf | ad-sync | checks | firewall | access-check | ...
  message   NVARCHAR(MAX) NOT NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_activity_log_ts' AND object_id = OBJECT_ID('activity_log'))
CREATE NONCLUSTERED INDEX ix_activity_log_ts ON activity_log (ts DESC) INCLUDE (level, source);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_activity_log_level_ts' AND object_id = OBJECT_ID('activity_log'))
CREATE NONCLUSTERED INDEX ix_activity_log_level_ts ON activity_log (level, ts DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_activity_log_source_ts' AND object_id = OBJECT_ID('activity_log'))
CREATE NONCLUSTERED INDEX ix_activity_log_source_ts ON activity_log (source, ts DESC);

-- Retention. Default 30 days. Operator can override from Settings.
MERGE settings AS t
USING (VALUES ('activity.retention_days', '30')) AS s([key], [value])
ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);

-- EXEC('CREATE PROCEDURE …') sidesteps the requirement that CREATE PROCEDURE
-- be the first statement in a batch (msnodesqlv8 .batch() doesn't split on GO).
IF NOT EXISTS (SELECT 1 FROM sys.procedures WHERE name = 'sp_purge_old_activity')
EXEC('
CREATE PROCEDURE sp_purge_old_activity @retention_days INT = 30 AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM activity_log
  WHERE ts < DATEADD(DAY, -@retention_days, SYSUTCDATETIME());
END
');
