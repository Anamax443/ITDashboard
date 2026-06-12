-- ICMP ping fallback for the reachability (Status) probe. TCP 135/445 can fail
-- on a host that is actually up but blocks RPC/SMB (hardened firewall); a plain
-- ping often still answers, so we fall back to it before declaring a PC Offline.
-- A PC counts as reachable if ANY of {TCP 135, TCP 445, ICMP ping} responds.
-- Toggle here in case ICMP is blocked enterprise-wide and the ping attempts are
-- just wasted work.
MERGE settings AS t
USING (VALUES
  ('reachability.ping', '1')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
