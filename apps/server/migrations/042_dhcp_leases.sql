-- MikroTik DHCP lease inventory + operator device categories.
--
-- A collector pulls active DHCP leases from each configured MikroTik router
-- (RouterOS v7 REST API) and upserts them here. Each lease is paired with an AD
-- `computers` row at read time (by host_name, fallback IP) — matched devices
-- reuse the reachability collector's online/offline, so only UNMATCHED devices
-- (printers, phones, IoT not in AD) are pinged by the DHCP collector and are the
-- ones the operator categorizes.
--
-- Router list + credentials are read from server env (MIKROTIK_ROUTERS,
-- MIKROTIK_USER, MIKROTIK_PASSWORD) — no secrets in the DB. With no routers
-- configured the collector is a no-op.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'dhcp_leases')
  CREATE TABLE dhcp_leases (
    site             NVARCHAR(64)  NOT NULL,   -- logical site (router) name, e.g. "Brno"
    mac_address      NVARCHAR(32)  NOT NULL,   -- normalized upper-case MAC
    ip_address       NVARCHAR(64)  NULL,
    host_name        NVARCHAR(255) NULL,
    server           NVARCHAR(128) NULL,       -- DHCP server / pool name on the router
    comment          NVARCHAR(255) NULL,
    status           NVARCHAR(32)  NULL,       -- bound / waiting / …
    dynamic          BIT           NULL,
    expires_after    NVARCHAR(64)  NULL,       -- router's lease countdown string
    router_last_seen NVARCHAR(64)  NULL,       -- router's own "last-seen" string
    first_seen       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),  -- first time WE pulled it
    last_seen        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),  -- last time WE pulled it
    reachable        BIT NULL,                 -- ping result for UNMATCHED devices (matched use computers.reachable)
    last_reachable_at DATETIME2 NULL,
    reach_checked_at  DATETIME2 NULL,
    CONSTRAINT PK_dhcp_leases PRIMARY KEY (site, mac_address)
  );

-- Operator-assigned device category, keyed by MAC so it persists across reloads
-- and across sites (a device keeps its category even if its lease/IP changes).
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'device_categories')
  CREATE TABLE device_categories (
    mac_address NVARCHAR(32) NOT NULL PRIMARY KEY,
    category    NVARCHAR(32) NOT NULL,   -- e.g. printer_canon, printer_zebra, phone, pc…
    note        NVARCHAR(255) NULL,
    updated_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
