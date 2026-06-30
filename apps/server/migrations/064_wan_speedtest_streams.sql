-- A single TCP stream underestimates fast links; measure with parallel streams
-- (like fast.com). Also bump the default download size for a longer, more accurate
-- sample — but only for installs that still use the original 10 MB default URL
-- (don't clobber a custom URL the operator set).
MERGE settings AS t USING (VALUES ('wan.speedtest_streams', '6')) AS s([key], [value])
  ON t.[key] = s.[key] WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);

UPDATE settings SET [value] = 'https://speed.cloudflare.com/__down?bytes=25000000'
  WHERE [key] = 'wan.speedtest_url' AND [value] = 'https://speed.cloudflare.com/__down?bytes=10000000';
