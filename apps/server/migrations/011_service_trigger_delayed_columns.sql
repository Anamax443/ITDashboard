-- 010 was applied before the trigger_start / delayed_start columns existed.
-- Migration runner skips re-application of files with same name, so add columns here.
IF COL_LENGTH('service_problems', 'delayed_start') IS NULL
  ALTER TABLE service_problems ADD delayed_start BIT NOT NULL DEFAULT 0;

IF COL_LENGTH('service_problems', 'trigger_start') IS NULL
  ALTER TABLE service_problems ADD trigger_start BIT NOT NULL DEFAULT 0;
