-- Per-PC opt-in for disk-critical email monitoring + alert settings.
--
-- An operator marks a handful of "key" computers (e.g. servers) in the
-- Computers tab; only those participate in email alerting. When a disk scan
-- finds an in-scope drive on a monitored PC below the critical threshold, the
-- alerts service emails a "critical disk state" report — throttled so it goes
-- out at most once per alerts.disk.frequency_hours while the condition holds.
-- Recipients, SMTP relay and cadence are all configured in Settings, so the
-- feature is wired without touching .env.

IF COL_LENGTH('computers', 'disk_email_monitor') IS NULL
  ALTER TABLE computers ADD disk_email_monitor BIT NOT NULL DEFAULT 0;

MERGE settings AS t
USING (VALUES
  -- Master on/off for disk email alerting. Off by default — the operator
  -- enables it once SMTP + recipients are filled in.
  ('alerts.disk.enabled', '0'),
  -- Throttle: minimum hours between disk-critical emails while at least one
  -- monitored disk stays critical. First detection sends immediately.
  ('alerts.disk.frequency_hours', '24'),
  -- Internal SMTP relay (no auth assumed; add alerts.smtp_user/password later
  -- if the relay requires it). Port 25 = typical internal relay.
  ('alerts.smtp_host', ''),
  ('alerts.smtp_port', '25'),
  ('alerts.smtp_from', ''),
  -- Recipients: comma- or newline-separated list of email addresses.
  ('alerts.recipients', '')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
