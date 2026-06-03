-- Threshold (in days) for flagging a PC as inactive based on AD LastLogon.
-- A PC counts as inactive when computers.last_seen is older than this many
-- days back from now. Used by the Dashboard "Inactive (Nd+)" card and the
-- Computers tab "inactive" filter chip.
MERGE settings AS t
USING (VALUES ('inactive.threshold_days', '90')) AS s([key], [value])
ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
