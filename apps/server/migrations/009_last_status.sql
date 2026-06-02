-- Categorical health status from last collector probe.
-- Values: 'online', 'offline', 'rpc_unavailable', 'access_denied', 'unknown'
IF COL_LENGTH('computers', 'last_status') IS NULL
  ALTER TABLE computers ADD last_status NVARCHAR(32) NULL;
