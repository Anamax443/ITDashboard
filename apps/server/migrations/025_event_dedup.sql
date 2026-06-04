-- Event-table duplicate cleanup.
--
-- The collector uses a time-based watermark (last_collected_at = run start
-- time) and Get-WinEvent StartTime is inclusive (>=), so events that land in
-- the overlap window between two runs are inserted twice. The `events` table
-- has no UNIQUE constraint on the natural key (computer_id, log_name,
-- event_id, time_created, provider_name) — PK is on identity id — so the DB
-- accepts the duplicates silently. Noisy drivers (e.g. Brother BrLog firing
-- ~1 event/sec on PLUSKALPW10NTB) accumulate hundreds of duplicate rows per
-- collection cycle.
--
-- Mitigation: daily dedup pass alongside retention purge. Keeps the first
-- (lowest id) row of each duplicate group, deletes the rest. Lookback
-- window is configurable so the proc does not have to scan the full table
-- on every run.
--
-- The dedup runs AFTER sp_purge_old_events in retention-runner.ts, so it
-- only operates on rows that survived the retention cut.

IF NOT EXISTS (SELECT 1 FROM sys.procedures WHERE name = 'sp_purge_duplicate_events')
EXEC('
CREATE PROCEDURE sp_purge_duplicate_events @lookback_days INT = 90 AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @cutoff DATETIME2 = DATEADD(DAY, -@lookback_days, SYSUTCDATETIME());
  ;WITH dupes AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY computer_id, log_name, event_id, time_created, ISNULL(provider_name, N'''')
             ORDER BY id ASC
           ) AS rn
    FROM events
    WHERE time_created >= @cutoff
  )
  DELETE FROM dupes WHERE rn > 1;
END
');

MERGE settings AS t
USING (VALUES
  ('events.dedup_enabled', '1'),
  ('events.dedup_lookback_days', '90')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
