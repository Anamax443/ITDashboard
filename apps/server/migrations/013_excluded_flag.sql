-- Operator-controlled hard exclude. Computers marked excluded are:
-- - skipped by collectors
-- - not counted in dashboard summary cards
-- - hidden from Computers list by default
-- - preserved across AD syncs (operator intent)
IF COL_LENGTH('computers', 'excluded') IS NULL
  ALTER TABLE computers ADD excluded BIT NOT NULL DEFAULT 0;
