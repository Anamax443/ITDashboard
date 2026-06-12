-- Live network-reachability probe, independent of the event-log collector.
--
-- The Status column used to be a by-product of the event-log collector: it only
-- ran on enabled+monitored+non-excluded PCs, classified failures crudely
-- (offline / rpc / access_denied / unknown), and froze once a box exceeded the
-- failure cap. So a box that was up but whose event log we couldn't read showed
-- "Unknown", and an enabled-in-AD box we'd never classified showed a green
-- "Active" fallback — neither reflected whether the machine is actually on the
-- network right now.
--
-- This probe answers ONE question for EVERY enabled, non-excluded PC (regardless
-- of monitoring / failure history): is it reachable on the network now? It is a
-- plain TCP connect to a key port (135 RPC endpoint mapper, falling back to 445
-- SMB) — not ICMP ping, which Windows Firewall blocks by default in a domain.
--   reachable          = result of the last probe (1 = on network, 0 = not)
--   last_reachable_at   = last time it answered (for "down since" context)
--   reach_checked_at    = last time the probe ran against it

IF COL_LENGTH('computers', 'reachable') IS NULL
  ALTER TABLE computers ADD reachable BIT NULL;
IF COL_LENGTH('computers', 'last_reachable_at') IS NULL
  ALTER TABLE computers ADD last_reachable_at DATETIME2 NULL;
IF COL_LENGTH('computers', 'reach_checked_at') IS NULL
  ALTER TABLE computers ADD reach_checked_at DATETIME2 NULL;

MERGE settings AS t
USING (VALUES
  -- Run the reachability probe as part of each periodic checks cycle.
  ('checks.run_reachability', '1'),
  -- Ports tried per PC (TCP connect, first one that answers = reachable).
  ('reachability.ports', '135,445'),
  -- TCP connect timeout per port (ms).
  ('reachability.timeout_ms', '2000')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
