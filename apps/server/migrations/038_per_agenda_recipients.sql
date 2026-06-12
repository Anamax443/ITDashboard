-- Per-agenda recipient overrides. Each alert agenda (disk / services / ports)
-- can route to its own recipient list; when an agenda's list is empty it falls
-- back to the shared alerts.recipients. SMTP relay / From / dashboard URL stay
-- shared. All empty by default so existing single-list behaviour is unchanged.
MERGE settings AS t
USING (VALUES
  -- Disk-critical alert recipients. Empty = use shared alerts.recipients.
  ('alerts.disk.recipients', ''),
  -- Critical-service (state) alert recipients. Empty = shared fallback.
  ('alerts.services.recipients', ''),
  -- Port-check alert recipients. Empty = shared fallback.
  ('alerts.ports.recipients', '')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
