-- Phase 2 of critical-service alerting: outside-in PORT reachability checks.
--
-- Watching State='Running' misses "running but unreachable" (firewall, freeze).
-- For each service_email_monitor PC we TCP-probe key infra ports from the API
-- host, testing the whole path network -> firewall -> OS -> service.
--
-- Flapping/false-positive guards:
--  * baseline learning — a (PC, port) is only alert-eligible once it has been
--    reachable at least once (last_ok_at set). A port that never answers on a
--    given box (e.g. RDP on a server with RDP closed) is never alerted.
--  * whole-PC offline (TCP/135 unreachable) is skipped, so a powered-off box
--    does not fire one alert per port (that is the reachability card's job).
--  * reuses alerts.services debounce_minutes / maintenance_window /
--    frequency_hours so a port outage behaves like a service outage.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'port_check_state')
  CREATE TABLE port_check_state (
    computer_id   INT NOT NULL,
    check_name    NVARCHAR(64) NOT NULL,
    port          INT NOT NULL,
    last_ok_at    DATETIME2 NULL,   -- last time the port answered (baseline)
    first_down_at DATETIME2 NULL,   -- start of the current outage (NULL = up / untracked)
    last_sent_at  DATETIME2 NULL,
    CONSTRAINT PK_port_check_state PRIMARY KEY (computer_id, check_name)
  );

MERGE settings AS t
USING (VALUES
  -- Master on/off for outside-in port checks (sub-feature of service alerts).
  ('alerts.services.port_checks_enabled', '0'),
  -- "Name:Port" list, TCP, comma/newline separated. DNS uses TCP 53 (Windows
  -- DNS listens on TCP too), so every probe is a simple TCP connect.
  ('alerts.services.port_checks', 'LDAP:389,SMB:445,RDP:3389,Kerberos:88,DNS:53'),
  -- TCP connect timeout per probe (ms).
  ('alerts.services.port_timeout_ms', '2000')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
