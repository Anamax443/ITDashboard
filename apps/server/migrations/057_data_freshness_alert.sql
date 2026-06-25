-- Per-site data-freshness / availability alert.
--
-- Watches the FTP file source: a site is "stale" when its export files stop
-- advancing (router scheduler / script / FTP broke) or can't be fetched at all
-- (router down). Timezone-safe: we don't compare the router's local file
-- timestamp to UTC now — we track file_changed_at (real UTC, set whenever the
-- newest file timestamp actually moves) and alert when it stops moving past the
-- threshold, or when last_error persists.

-- file_changed_at = when the newest of (lease_file_time, arp_file_time) last
-- increased; last_file_sig = that newest timestamp, to detect movement.
IF COL_LENGTH('site_data_status', 'file_changed_at') IS NULL
  ALTER TABLE site_data_status ADD file_changed_at DATETIME2 NULL;
IF COL_LENGTH('site_data_status', 'last_file_sig') IS NULL
  ALTER TABLE site_data_status ADD last_file_sig NVARCHAR(40) NULL;

-- Per-site debounce/throttle state for the alert (mirrors printer_alert_state).
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'data_freshness_alert_state')
  CREATE TABLE data_freshness_alert_state (
    site          NVARCHAR(64) NOT NULL PRIMARY KEY,
    first_stale_at DATETIME2 NULL,
    last_sent_at   DATETIME2 NULL
  );

-- Settings (mirror the other alert agendas). Branches are muted by default — only
-- Brno currently produces the export files, so the others would otherwise always
-- read as "stale" and scream. They un-mute once their routers are set up.
MERGE settings AS t USING (VALUES
  ('alerts.freshness.enabled', '1'),
  ('alerts.freshness.threshold_minutes', '45'),
  ('alerts.freshness.frequency_hours', '24'),
  ('alerts.freshness.debounce_minutes', '10'),
  ('alerts.freshness.recipients', ''),
  ('alerts.freshness.maintenance_window', ''),
  ('alerts.freshness.muted_sites', 'Zastavka,Svitavy,Jihlava')
) AS s([key], [value])
  ON t.[key] = s.[key]
  WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
