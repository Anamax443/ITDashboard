-- MikroTik collection moves to DB-driven config + a master enable/interval, and
-- a new "printer offline" email alert agenda.
--
-- Until now the MikroTik DHCP collector read its router list / credentials from
-- MIKROTIK_* env vars and ran whenever those were set. This migration makes the
-- whole thing UI-driven from Settings (mikrotik.routers / .user / .password_enc,
-- already written by the Settings page) and adds:
--   * mikrotik.enabled      — master on/off for the in-app collector
--   * mikrotik.interval_sec — its own standalone probe cadence (like reachability)
-- Only MIKROTIK_SECRET stays in env (the key that decrypts mikrotik.password_enc).
--
-- It also collapses the per-vendor printer categories (printer_canon / _kyocera /
-- _zebra / _hp / _other) into one generic `printer`, preserving any assignment
-- the operator already made (kept by MAC in device_categories), and seeds the
-- "printer offline" alert agenda + its per-device debounce state table.

-- 1) Collector enable + cadence (default ON: the app server already reaches the
--    routers, so collection should run straight away after deploy).
MERGE settings AS t
USING (VALUES
  ('mikrotik.enabled', '1'),
  ('mikrotik.interval_sec', '300')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);

-- 2) Printer-offline alert agenda. Mirrors the disk / service / port agendas:
--    own enable, debounce (flapping guard), reminder cadence, maintenance window
--    and a recipient override (empty = fall back to the shared alerts.recipients).
MERGE settings AS t
USING (VALUES
  ('alerts.printers.enabled', '0'),
  ('alerts.printers.debounce_minutes', '10'),
  ('alerts.printers.frequency_hours', '24'),
  ('alerts.printers.maintenance_window', ''),
  ('alerts.printers.recipients', '')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);

-- 3) Per-(printer) outage clock + last-sent, keyed by MAC (category persists by
--    MAC, so the alert state does too). Recovery deletes the row so the next
--    outage starts a fresh debounce window.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'printer_alert_state')
  CREATE TABLE printer_alert_state (
    mac_address   NVARCHAR(32) NOT NULL PRIMARY KEY,
    first_down_at DATETIME2 NULL,
    last_sent_at  DATETIME2 NULL
  );

-- 4) Collapse per-vendor printer categories into one generic `printer`. Operator
--    assignments are kept by MAC, so this just relabels them — nothing is lost.
UPDATE device_categories
SET category = 'printer', updated_at = SYSUTCDATETIME()
WHERE category LIKE 'printer[_]%';
