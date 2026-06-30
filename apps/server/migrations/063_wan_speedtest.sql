-- Optional internet download speed test for the WAN monitor. OFF by default — it
-- downloads a real file, so it costs bandwidth; runs on its own long cadence.
-- speedtest_url defaults to Cloudflare's sized-download endpoint (no token, HTTPS);
-- point it at any URL that streams a known-size body.
MERGE settings AS t USING (VALUES
  ('wan.speedtest_enabled', '0'),
  ('wan.speedtest_url', 'https://speed.cloudflare.com/__down?bytes=10000000'),
  ('wan.speedtest_interval_sec', '1800')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
