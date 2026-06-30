-- Live WAN-link monitor: pings each branch router (mikrotik.routers) and one
-- public internet target from the app server, keeping only the current snapshot
-- in memory. These settings tune cadence, the internet target and the
-- latency/loss "degraded" thresholds used for colour-coding on the dashboard.
MERGE settings AS t USING (VALUES
  ('wan.enabled', '1'),
  ('wan.interval_sec', '60'),
  ('wan.internet_target', '1.1.1.1'),
  ('wan.ping_count', '5'),
  ('wan.latency_warn_ms', '80'),
  ('wan.loss_warn_pct', '5')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
