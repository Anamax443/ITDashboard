-- Close the two unbounded-growth gaps found in the retention audit: perf_events
-- (slow boot/shutdown events) and ad_sync_runs (AD sync run log) had no retention
-- and grew forever. Add purge procs + settings; wired into the daily retention
-- runner alongside the events / activity_log / pc_user_history purges.

IF NOT EXISTS (SELECT 1 FROM sys.procedures WHERE name = 'sp_purge_old_perf')
EXEC('
CREATE PROCEDURE sp_purge_old_perf @retention_days INT = 180 AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM perf_events WHERE time_created < DATEADD(DAY, -@retention_days, SYSUTCDATETIME());
END
');

IF NOT EXISTS (SELECT 1 FROM sys.procedures WHERE name = 'sp_purge_ad_sync_runs')
EXEC('
CREATE PROCEDURE sp_purge_ad_sync_runs @retention_days INT = 90 AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM ad_sync_runs WHERE started_at < DATEADD(DAY, -@retention_days, SYSUTCDATETIME());
END
');

MERGE settings AS t USING (VALUES
  ('perf.retention_days', '180'),
  ('adsync.runs_retention_days', '90')
) AS s([key], [value])
  ON t.[key] = s.[key]
  WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
