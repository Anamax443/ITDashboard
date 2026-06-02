-- Unified periodic check scheduler.
-- One interval controls selected checks: eventlog, disk, services.
MERGE settings AS t
USING (VALUES
  ('checks.interval_sec', '900'),
  ('checks.days', '1,2,3,4,5'),
  ('checks.window_start', '06:00'),
  ('checks.window_end', '18:00'),
  ('checks.run_eventlog', 'true'),
  ('checks.run_disk', 'true'),
  ('checks.run_services', 'true')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
