-- Per-PC telemetry collected alongside the disk scan over the same DCOM session.
--   current_user      = Win32_ComputerSystem.UserName (interactive logged-on user).
--                       Only overwritten when scan returns a non-null value, so the
--                       last seen user persists across "nobody logged in" gaps.
--   current_user_seen_at = timestamp of the last non-null user observation.
--   ip_address        = primary IPv4 from Win32_NetworkAdapterConfiguration
--                       (first adapter with IPEnabled=true and a routable IPv4).
--                       Always overwritten with the current scan result so
--                       roaming notebooks reflect their current network.
--   pc_info_collected_at = timestamp of the most recent successful PC-info scan.
IF COL_LENGTH('computers', 'current_user') IS NULL
  ALTER TABLE computers ADD current_user NVARCHAR(255) NULL;

IF COL_LENGTH('computers', 'current_user_seen_at') IS NULL
  ALTER TABLE computers ADD current_user_seen_at DATETIME2 NULL;

IF COL_LENGTH('computers', 'ip_address') IS NULL
  ALTER TABLE computers ADD ip_address NVARCHAR(64) NULL;

IF COL_LENGTH('computers', 'pc_info_collected_at') IS NULL
  ALTER TABLE computers ADD pc_info_collected_at DATETIME2 NULL;
