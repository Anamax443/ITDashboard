-- Retention job — daily roll-up + raw delete past RETENTION_RAW_DAYS.
-- Invoked by API on schedule (not SQL Agent — Express may not have it).

IF NOT EXISTS (SELECT 1 FROM sys.procedures WHERE name = 'sp_rollup_yesterday')
EXEC('
CREATE PROCEDURE sp_rollup_yesterday AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @d DATE = CAST(DATEADD(DAY, -1, SYSUTCDATETIME()) AS DATE);

  MERGE event_daily_agg AS tgt
  USING (
    SELECT
      CAST(time_created AS DATE) AS day,
      computer_id, log_name, event_id, level,
      COUNT(*) AS cnt
    FROM events
    WHERE time_created >= @d AND time_created < DATEADD(DAY, 1, @d)
    GROUP BY CAST(time_created AS DATE), computer_id, log_name, event_id, level
  ) AS src
  ON tgt.day = src.day
     AND tgt.computer_id = src.computer_id
     AND tgt.log_name = src.log_name
     AND tgt.event_id = src.event_id
     AND tgt.level = src.level
  WHEN MATCHED THEN UPDATE SET count = src.cnt
  WHEN NOT MATCHED THEN INSERT (day, computer_id, log_name, event_id, level, count)
       VALUES (src.day, src.computer_id, src.log_name, src.event_id, src.level, src.cnt);
END
');

IF NOT EXISTS (SELECT 1 FROM sys.procedures WHERE name = 'sp_purge_old_events')
EXEC('
CREATE PROCEDURE sp_purge_old_events @retention_days INT AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @cutoff DATETIME2 = DATEADD(DAY, -@retention_days, SYSUTCDATETIME());
  DELETE FROM events WHERE time_created < @cutoff;
END
');
