-- Configurable lookback window for the Dashboard event summary tiles
-- (Critical / Errors / Warnings). Default 1 day = current 24h behavior.
-- Operator can raise to e.g. 3 or 7 days to surface persistent issues
-- that fell off the rolling 24h window.
MERGE settings AS t
USING (VALUES
  ('events.summary_window_days', '1')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
