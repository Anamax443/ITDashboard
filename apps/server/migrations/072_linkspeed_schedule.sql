-- Scheduled link-speed measurement + per-hostname exclusions. OFF by default and
-- with empty targets, so nothing runs until the operator configures it. exclude_hosts
-- = hostnames that are never measured (comma/space/newline separated).
MERGE settings AS t USING (VALUES
  ('linkspeed.enabled', '0'),
  ('linkspeed.interval_hours', '24'),
  ('linkspeed.targets', ''),
  ('linkspeed.exclude_hosts', '')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
