-- Recipient list for the on-demand fleet overview report (Reporting tab → "Send
-- by email"). Empty by default → falls back to the shared alerts.recipients,
-- consistent with the per-agenda disk/services/ports overrides (migration 038).
MERGE settings AS t
USING (VALUES
  ('alerts.reports.recipients', '')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
