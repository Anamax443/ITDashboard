-- Cold-start lookback window for perf-events collector.
-- Applied only on the very first sweep per PC (when perf_events has no rows
-- for that computer). Subsequent sweeps go incrementally since the last
-- collected event. Default 30 days because workstations are typically
-- rebooted infrequently, so 7 days would miss the previous boot's events.
MERGE settings AS t
USING (VALUES ('perf.cold_start_days', '30')) AS s([key], [value])
ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
