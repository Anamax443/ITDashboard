-- Track the IP the PC had at the moment a given login session was first
-- observed. Useful on roaming notebooks — operator looking at history
-- can see "user X was logged on from 10.8.2.180 last Tuesday". Updated
-- alongside the session-aware INSERT/UPDATE in disk-collector.
IF COL_LENGTH('pc_user_history', 'ip_address') IS NULL
  ALTER TABLE pc_user_history ADD ip_address NVARCHAR(64) NULL;
