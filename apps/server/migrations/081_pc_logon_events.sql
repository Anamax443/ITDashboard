-- Precise interactive logon/logoff history straight from the Security event log
-- (4624 logon / 4634 logoff), a complement to the snapshot-based pc_user_history.
-- Where pc_user_history only records "who was logged on at scan time" (WMI
-- Win32_ComputerSystem.UserName sampled every collector cycle), this table holds
-- the exact logon time, logon type, source IP and — once the matching 4634 is
-- seen — the logoff time, so the operator gets real session start/end and
-- duration. Populated by logon-collector.ts, which pulls ONLY interactive logon
-- types (2 console, 7 unlock, 10 RDP, 11 cached) filtered server-side via
-- Get-WinEvent -FilterXPath so the network/service noise (type 3/5, ~99% of
-- 4624 volume) never reaches us. Sessions are paired 4624->4634 by LogonId.
--
-- This source is CONDITIONAL on "Audit Logon = Success" being enabled in GPO and
-- the collector account (svc-itdashboard) being able to read the Security log
-- (Event Log Readers). Where auditing is off, this table stays empty for that PC
-- and the UI falls back to the pc_user_history snapshot — graceful degradation,
-- never an error.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'pc_logon_events')
CREATE TABLE pc_logon_events (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  computer_id INT NOT NULL,
  user_name   NVARCHAR(255) NOT NULL,
  domain      NVARCHAR(255) NULL,
  logon_type  INT NOT NULL,
  ip_address  NVARCHAR(64) NULL,
  logon_id    NVARCHAR(32) NOT NULL,   -- TargetLogonId (hex, e.g. 0x3E7); unique per session since boot
  logon_at    DATETIME2 NOT NULL,      -- 4624 TimeCreated (UTC)
  logoff_at   DATETIME2 NULL,          -- 4634 TimeCreated (UTC), NULL until the logoff is observed
  created_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_pc_logon_events_computer FOREIGN KEY (computer_id) REFERENCES computers(id)
);

-- History listing per PC, newest session first.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_pc_logon_events_computer' AND object_id = OBJECT_ID('pc_logon_events'))
CREATE NONCLUSTERED INDEX ix_pc_logon_events_computer ON pc_logon_events (computer_id, logon_at DESC);

-- De-dup check on re-pull (cursor uses >=, so a boundary event can come back) and
-- 4634->4624 logoff pairing both look up by (computer_id, logon_id).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_pc_logon_events_logonid' AND object_id = OBJECT_ID('pc_logon_events'))
CREATE NONCLUSTERED INDEX ix_pc_logon_events_logonid ON pc_logon_events (computer_id, logon_id, logon_at);

-- Retention age is on the SESSION START (logon_at). Same 90d default as pc_user_history.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_pc_logon_events_logon_at' AND object_id = OBJECT_ID('pc_logon_events'))
CREATE NONCLUSTERED INDEX ix_pc_logon_events_logon_at ON pc_logon_events (logon_at DESC);

-- Per-PC cursor for the logon collector, kept SEPARATE from last_collected_at
-- (which the System/Application eventlog collector owns) so the two don't stomp
-- each other's high-water mark.
IF COL_LENGTH('computers', 'last_logon_collected_at') IS NULL
  ALTER TABLE computers ADD last_logon_collected_at DATETIME2 NULL;

MERGE settings AS t
USING (VALUES
  ('pcLogonHistory.retention_days', '90'),
  -- Periodic-checks toggle (SettingsPage PERIODIC_CHECKS). Default on.
  ('checks.run_logon', '1')
) AS s([key], [value])
ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);

IF NOT EXISTS (SELECT 1 FROM sys.procedures WHERE name = 'sp_purge_pc_logon_events')
EXEC('
CREATE PROCEDURE sp_purge_pc_logon_events @retention_days INT = 90 AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM pc_logon_events
  WHERE logon_at < DATEADD(DAY, -@retention_days, SYSUTCDATETIME());
END
');
