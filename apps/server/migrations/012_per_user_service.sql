-- Per-user service instances (e.g. CDPUserSvc_d666212) have a LUID suffix that
-- changes per session. They're legitimately stopped when the user logs off, so
-- they're noise rather than real problems.
IF COL_LENGTH('service_problems', 'per_user_start') IS NULL
  ALTER TABLE service_problems ADD per_user_start BIT NOT NULL DEFAULT 0;
