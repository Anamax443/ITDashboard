-- Per-device packet loss. A device can REPLY (so it's "online") yet drop most
-- echoes — a degraded/flaky link (bad cable, congested AP, sleeping device).
-- 75% loss is a very different signal from a clean 0%, so we store the last
-- measured loss percentage (0–100) alongside reachable. NULL = not measured yet.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dhcp_leases') AND name = 'packet_loss')
  ALTER TABLE dhcp_leases ADD packet_loss INT NULL;
