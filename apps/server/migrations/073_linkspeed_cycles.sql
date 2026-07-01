-- Link-speed: per-measurement latency (ping ms), N cycles per measurement (keep the
-- best), a scheduling hour-window, and the configurable test file name (so it can be
-- added to AV exclusions). ping latency mirrors the old PowerShell script's column.
IF COL_LENGTH('link_speed_results', 'latency_ms') IS NULL
  ALTER TABLE link_speed_results ADD latency_ms INT NULL;

MERGE settings AS t USING (VALUES
  ('linkspeed.cycles', '4'),
  ('linkspeed.window_start', ''),
  ('linkspeed.window_end', ''),
  ('linkspeed.filename', 'itdash-speedtest.tmp')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
