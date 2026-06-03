-- Wire AD sync into the periodic checks registry + expose the default
-- monitor_enabled value applied to newly discovered PCs.
--
-- Defaults:
--   checks.run_adsync = false  — periodic ticks do NOT include AD sync by default;
--                                fleet-wide AD MERGE is overkill every 15 min.
--                                Operator may flip it on per environment.
--   runAllChecksOnce in code forces this check on regardless of the setting,
--   so the manual "Run all" button always includes AD sync.
--
--   adsync.default_monitor_enabled = true  — newly discovered PCs default to
--                                            monitored. Operator can flip to
--                                            false to require explicit opt-in.
MERGE settings AS t
USING (VALUES
  ('checks.run_adsync', 'false'),
  ('adsync.default_monitor_enabled', 'true')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
