-- Per-PC monitor flag separate from `enabled` (which reflects AD presence).
-- Operators can untick a PC to stop polling it, without losing inventory or events.
-- AD sync intentionally does NOT touch this column.
IF COL_LENGTH('computers', 'monitor_enabled') IS NULL
  ALTER TABLE computers ADD monitor_enabled BIT NOT NULL DEFAULT 1;
