-- Prune stale device rows ("ghosts") from the Devices inventory.
--
-- When a DHCP IP is reassigned (laptop A leaves, laptop B gets its address) the old
-- (site, mac) row lingers with its last-seen frozen — the router no longer reports
-- it, the scan doesn't re-find it, nothing pings it. Over time these accrete as
-- duplicate-IP "ghosts". This setting prunes any dhcp_leases row that NONE of the
-- collectors has touched for N days (last_seen AND reach_checked_at AND
-- last_reachable_at all older than the cutoff).
--
-- Safe by design: pruning is non-destructive in effect — if the device ever comes
-- back it re-appears, and its operator category/note (keyed by MAC in
-- device_categories) rejoins automatically. Anything still observed or pinged
-- (incl. offline-but-monitored printers, which keep getting pinged → fresh
-- reach_checked_at) is never pruned. 0 disables pruning entirely.

MERGE settings AS t
USING (VALUES ('devices.lease_retention_days', '14')) AS s([key], [value])
  ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
