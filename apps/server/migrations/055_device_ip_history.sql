-- IP-address archive per device ("MAC = the permanent ID, IP = temporary").
--
-- The MAC address is a device's identity; its IP is transient and always re-read
-- (DHCP, cable↔wifi, roaming). This table keeps the history of every IP a MAC has
-- been observed at — a connection archive — so the operator can see where a device
-- used to live, even after it moved. The CURRENT IP is just the (mac) row with the
-- most recent last_seen; the rest are previous addresses.
--
-- Populated on every device observation (scan/arp/dhcp/unifi/share upserts): the
-- (mac, ip) pair is MERGE-bumped (last_seen) or inserted (first_seen). Keyed by
-- (mac_address, ip_address) so each address a device used is one row with its
-- first/last-seen window.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'device_ip_history')
CREATE TABLE device_ip_history (
  mac_address NVARCHAR(32)  NOT NULL,
  ip_address  NVARCHAR(64)  NOT NULL,
  site        NVARCHAR(128) NULL,
  source      NVARCHAR(16)  NULL,
  first_seen  DATETIME2 NOT NULL CONSTRAINT DF_device_ip_history_first DEFAULT SYSUTCDATETIME(),
  last_seen   DATETIME2 NOT NULL CONSTRAINT DF_device_ip_history_last  DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_device_ip_history PRIMARY KEY (mac_address, ip_address)
);

-- Lookup by MAC, newest first (for the per-device archive view).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_device_ip_history_mac_last')
CREATE INDEX IX_device_ip_history_mac_last
  ON device_ip_history (mac_address, last_seen DESC);
