-- Operator-editable device name. Auto-resolution (DHCP host-name / NetBIOS) often
-- comes up empty for printers/IoT, so let the operator type a friendly name. It
-- lives in device_categories (keyed by MAC, like the category) so it persists
-- across reloads, IP changes and collector overwrites — the collector only ever
-- touches dhcp_leases.host_name, never this.
--
-- category becomes optional: a row may carry just a name, just a category, or
-- both. The GET /devices read prefers the operator name over the discovered one.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('device_categories') AND name = 'name')
  ALTER TABLE device_categories ADD name NVARCHAR(255) NULL;

-- Allow category to be empty/NULL so a name-only row is valid.
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('device_categories') AND name = 'category' AND is_nullable = 0)
  ALTER TABLE device_categories ALTER COLUMN category NVARCHAR(32) NULL;
