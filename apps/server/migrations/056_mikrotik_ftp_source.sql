-- MikroTik FTP file source + per-site data-freshness tracking.
--
-- A RouterOS scheduler writes IP_scan.txt (DHCP leases) and ARP_scan.txt (ARP
-- table) on each router; the collector pulls them over FTP and merges them into
-- dhcp_leases by MAC (alongside the REST leases/ARP/ip-scan). The file's own
-- header timestamp is recorded per site as a "data freshness" signal — a file
-- that stops advancing means the router's scheduler / FTP / the box itself broke,
-- which the Phase-2 availability alert watches.
--
-- mikrotik.ftp_sites lists which configured sites currently produce the files
-- (only those are FTP-fetched). Sites NOT listed keep working on REST alone.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'site_data_status')
  CREATE TABLE site_data_status (
    site            NVARCHAR(64) NOT NULL PRIMARY KEY,
    lease_file_time DATETIME2 NULL,   -- header time of IP_scan.txt (router local)
    arp_file_time   DATETIME2 NULL,   -- header time of ARP_scan.txt
    lease_count     INT NULL,         -- rows parsed from the lease file
    arp_count       INT NULL,         -- complete ARP rows parsed
    fetched_at      DATETIME2 NULL,   -- last time WE successfully fetched anything
    last_error      NVARCHAR(255) NULL, -- last fetch error (NULL when OK)
    updated_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );

-- Master toggle for the FTP source (REST stays on regardless).
MERGE settings AS t USING (VALUES ('mikrotik.ftp_enabled', '1')) AS s([key], [value])
  ON t.[key] = s.[key] WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);

-- Sites (router names) that currently have the export script + scheduler. Only
-- Brno is set up so far; branches join once their routers produce the files.
MERGE settings AS t USING (VALUES ('mikrotik.ftp_sites', 'Brno')) AS s([key], [value])
  ON t.[key] = s.[key] WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
