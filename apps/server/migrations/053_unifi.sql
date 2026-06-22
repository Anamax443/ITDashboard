-- UniFi controller as a device source.
--
-- A UniFi controller (legacy self-hosted, :8443) knows every CONNECTED client —
-- wired and wireless, across ALL its networks — with the real MAC, IP, hostname
-- and operator alias. That fills the biggest gap in the inventory: same-subnet /
-- remote Wi-Fi devices the router ARP and the app-server scan can't see or can't
-- key (no MAC). The collector logs in (cookie session), reads
-- /api/s/<site>/stat/sta, and upserts each client into dhcp_leases (source
-- 'unifi'), keyed by MAC like every other source so it merges, not duplicates.
--
-- Config is DB-driven from the Settings page; nothing is hardcoded in the repo
-- (no IPs / secrets in the source tree — same principle as MikroTik). The
-- password is stored encrypted (unifi.password_enc, secret-crypto / MIKROTIK_SECRET
-- key) and never returned to the client in the clear. Seeded empty + disabled, so
-- the collector idles until the operator fills it in.
--
--   unifi.enabled        — master on/off (default 0)
--   unifi.url            — controller base URL, e.g. https://10.8.2.229:8443
--   unifi.site           — UniFi site id (default 'default')
--   unifi.user           — read-only API account
--   unifi.password_enc   — AES-encrypted password (set via Settings, never plain)
--   unifi.interval_sec   — standalone poll cadence (default 300s)

MERGE settings AS t
USING (VALUES
  ('unifi.enabled', '0'),
  ('unifi.url', ''),
  ('unifi.site', 'default'),
  ('unifi.user', ''),
  ('unifi.password_enc', ''),
  ('unifi.interval_sec', '300')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
