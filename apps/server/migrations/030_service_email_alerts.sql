-- Per-PC opt-in for critical-service email alerting + alert state for flapping
-- protection.
--
-- The operator marks "key" servers (DCs, backup/file servers) with
-- service_email_monitor. When a service whose name is in the configurable
-- critical list is Auto + non-Running on a monitored PC, it is alerted — but
-- only after it has been down for at least alerts.services.debounce_minutes
-- (so a nightly patch-reboot blip does not page anyone), and never during an
-- optional maintenance window. service_alert_state tracks, per (PC, service),
-- when the outage started and when we last emailed about it.

IF COL_LENGTH('computers', 'service_email_monitor') IS NULL
  ALTER TABLE computers ADD service_email_monitor BIT NOT NULL DEFAULT 0;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'service_alert_state')
  CREATE TABLE service_alert_state (
    computer_id   INT NOT NULL,
    service_name  NVARCHAR(255) NOT NULL,
    first_down_at DATETIME2 NOT NULL,
    last_sent_at  DATETIME2 NULL,
    CONSTRAINT PK_service_alert_state PRIMARY KEY (computer_id, service_name)
  );

MERGE settings AS t
USING (VALUES
  -- Master on/off for service email alerting. Off by default.
  ('alerts.services.enabled', '0'),
  -- Flapping guard: a critical service must be down at least this many minutes
  -- before the first alert fires.
  ('alerts.services.debounce_minutes', '10'),
  -- Reminder cadence while the service stays down (hours).
  ('alerts.services.frequency_hours', '24'),
  -- Optional maintenance window "HH:MM-HH:MM" (server local time) during which
  -- service alerts are suppressed. Empty = always on. Supports a window that
  -- crosses midnight (e.g. 22:00-04:00).
  ('alerts.services.maintenance_window', ''),
  -- Comma/newline-separated list of critical Windows service NAMES to alert on
  -- (matched case-insensitively; * and ? wildcards supported). Seeded with the
  -- common infra set.
  ('alerts.services.critical_names',
   'NTDS,DNS,Kdc,Netlogon,W32Time,VMTools,VeeamBackupSvc,VeeamBrokerSvc,ekrn,DHCPServer,LanmanServer'),
  -- Never alert on these service NAMES even if they match the critical list
  -- (case-insensitive; * and ? wildcards). For noisy updaters etc. Empty by
  -- default; e.g. 'gupdate*,GoogleUpdater*,edgeupdate*,MozillaMaintenance'.
  ('alerts.services.whitelist', '')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
