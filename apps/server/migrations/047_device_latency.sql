-- Per-device average round-trip time (ms) from the reachability ping, alongside
-- packet loss. High latency on a LAN device flags a slow/congested/distant link
-- even when loss is 0. Only meaningful while online → NULL when offline.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dhcp_leases') AND name = 'latency_ms')
  ALTER TABLE dhcp_leases ADD latency_ms INT NULL;
