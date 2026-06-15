-- Live per-port availability snapshot for the new "Ports" tab.
--
-- This is INDEPENDENT of the phase-2 port ALERTS (alerts.ts / port_check_state),
-- which only track outages for emailing. Here a standalone probe TCP-connects
-- each configured port of every monitored PC, measures connect latency, and
-- upserts the latest verdict. The tab reads this table so it shows the
-- last-known state immediately on open; "Probe now" / the per-PC refresh
-- refresh it on demand.
--
-- The port LIST + timeout are REUSED from the existing settings
-- (alerts.services.port_checks / alerts.services.port_timeout_ms) — no duplicate
-- config. Only the on/off flag and the probe cadence are new, so the grid runs
-- even when phase-2 alert emails are disabled.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'port_status')
  CREATE TABLE port_status (
    computer_id INT NOT NULL,
    check_name  NVARCHAR(64) NOT NULL,   -- e.g. "SMB", "RDP" (label from the config)
    port        INT NOT NULL,            -- e.g. 445, 3389
    is_open     BIT NOT NULL,            -- last probe: 1 = TCP connect accepted
    latency_ms  INT NULL,                -- connect latency when open; NULL when closed
    checked_at  DATETIME2 NOT NULL,      -- when this (PC, port) was last probed
    CONSTRAINT PK_port_status PRIMARY KEY (computer_id, check_name)
  );

MERGE settings AS t
USING (VALUES
  -- Master on/off for the Ports availability grid probe — separate from the
  -- phase-2 alert flag (alerts.services.port_checks_enabled), so you can watch
  -- ports in the tab without enabling alert emails.
  ('checks.run_port_status', '1'),
  -- Standalone probe cadence, seconds (mirrors reachability.interval_sec).
  ('port_status.interval_sec', '300')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
