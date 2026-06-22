-- Per-category eventlog noise suppression for the "PC v problémech" score.
--
-- Notebooks roam off the domain network and routinely emit logon/roaming noise on
-- wake/boot before VPN is up (NETLOGON 5719, GroupPolicy 1129, Time-Service 131,
-- DCOM 10016, Intel Wi-Fi Netwtw*). That is expected behaviour, not a fault — but
-- it inflates the damped-blend score. Desktops on the LAN never emit it, so the
-- operator decision is: monitor PCs the same as servers (full), and suppress this
-- noise ONLY for machines classified as notebooks.
--
-- Classification is by AD: notebooks live in their own OU, so we match the OU path
-- (or DN / name) against an operator-supplied pattern. AD group membership is not
-- synced, so OU/DN is the available signal.
--
--   faulty.notebook_ou       — comma/newline list of patterns identifying notebooks
--                              by ou_path / distinguished_name / name (substring,
--                              `*` wildcard). Empty = nothing classified → inert.
--   faulty.suppress_notebook — comma/newline list of signatures excluded from the
--                              score FOR NOTEBOOKS ONLY. Token forms:
--                                provider/eventid   e.g. NETLOGON/5719
--                                eventid            e.g. 5719  (any provider)
--                                provider           e.g. Netwtw*  (any event id)
--                                provider/*         e.g. Netwtw*/*
--                              `*` is a wildcard in the provider part.

MERGE settings AS t
USING (VALUES
  ('faulty.notebook_ou', ''),
  ('faulty.suppress_notebook',
    'NETLOGON/5719,Microsoft-Windows-GroupPolicy/1129,Microsoft-Windows-Time-Service/131,Microsoft-Windows-DistributedCOM/10016,Netwtw*/*')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
