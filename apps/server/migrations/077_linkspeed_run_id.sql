-- "Otisk" of each batch run: all targets measured in one batch share a run_id (the
-- batch start timestamp), so the UI/report can show the last run, or the last N runs,
-- each as its own snapshot. Per-PC ad-hoc tests leave run_id NULL.
IF COL_LENGTH('link_speed_results', 'run_id') IS NULL
  ALTER TABLE link_speed_results ADD run_id NVARCHAR(40) NULL;
