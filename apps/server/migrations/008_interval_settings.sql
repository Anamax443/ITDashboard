-- Default interval settings (in seconds) — UI Settings page lets operator change them.
-- Services on startup read these from settings table (fall back to env, then hardcoded).
MERGE settings AS t
USING (VALUES
  ('collector.interval_sec', '300'),
  ('disk.interval_sec',      '1800'),
  ('adsync.interval_sec',    '86400')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
