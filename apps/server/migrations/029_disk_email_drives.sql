-- Optional per-PC drive-letter scope for disk email monitoring.
--
-- When a PC is opted into disk email monitoring (disk_email_monitor = 1) the
-- operator can narrow which drives count by typing letters here, e.g. 'C' or
-- 'C,F'. Empty = monitor all of that PC's in-scope drives (the previous
-- behavior). Same syntax as disk.crit_drives: 'C', 'C,D', '<>C'/'!C', '*'.
IF COL_LENGTH('computers', 'disk_email_drives') IS NULL
  ALTER TABLE computers ADD disk_email_drives NVARCHAR(64) NOT NULL DEFAULT '';
