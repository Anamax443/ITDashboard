-- Make the reachability (Status) probe run on its OWN cadence, independent of
-- the main periodic-checks scan and its work-hours window. Previously it ran as
-- a check inside runChecksOnce, so Status was only refreshed Mon-Fri 06:00-18:00
-- (it went stale overnight / weekends). Now a standalone timer probes every
-- `reachability.interval_sec` regardless of the checks window. The existing
-- `checks.run_reachability` key stays as the on/off flag.
MERGE settings AS t
USING (VALUES
  ('reachability.interval_sec', '300')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
