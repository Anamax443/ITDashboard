-- Retention scheduler settings. Daily purge cron in retention-runner.ts reads:
--   events.retention_days   — purge events older than N days (sp_purge_old_events)
--   activity.retention_days — already exists from migration 020 (default 30)
--   retention.run_at_hour   — hour-of-day to run, default 02:00 local server time
MERGE settings AS t
USING (VALUES
  ('events.retention_days', '90'),
  ('retention.run_at_hour', '2')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
