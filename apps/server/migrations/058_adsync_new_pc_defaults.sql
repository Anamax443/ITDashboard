-- Per-flag defaults a newly AD-discovered PC gets, configurable in Settings
-- (alongside the existing adsync.default_monitor_enabled). Applied only on INSERT
-- by ad-sync; existing PCs keep the operator's intent. All default OFF.
--   disk_email_monitor   — disk-critical email alerts opt-in
--   service_monitor      — broad service drift monitoring opt-in
--   service_email_monitor— critical-service email alerts opt-in
--   excluded             — exclude from the inventory/counts

MERGE settings AS t USING (VALUES
  ('adsync.default_disk_email_monitor', 'false'),
  ('adsync.default_service_monitor', 'false'),
  ('adsync.default_service_email_monitor', 'false'),
  ('adsync.default_excluded', 'false')
) AS s([key], [value])
  ON t.[key] = s.[key]
  WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
