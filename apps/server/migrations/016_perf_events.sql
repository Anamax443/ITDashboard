-- Diagnostics-Performance event log channel collection.
-- Boot / shutdown / standby / resume slow-event records with attribution
-- (culprit process / service / driver / device) and total/degradation timings.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'perf_events')
CREATE TABLE perf_events (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  computer_id     INT NOT NULL,
  time_created    DATETIME2 NOT NULL,
  event_id        INT NOT NULL,
  level           TINYINT NOT NULL,
  category        NVARCHAR(16) NOT NULL,   -- boot | shutdown | standby | resume | other
  total_time_ms   BIGINT NULL,
  degradation_ms  BIGINT NULL,
  culprit_name    NVARCHAR(512) NULL,
  culprit_friendly NVARCHAR(512) NULL,
  message         NVARCHAR(MAX) NULL,
  collected_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_perf_events_computer FOREIGN KEY (computer_id) REFERENCES computers(id),
  CONSTRAINT uq_perf_events_dedupe UNIQUE (computer_id, time_created, event_id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_perf_events_time' AND object_id = OBJECT_ID('perf_events'))
CREATE NONCLUSTERED INDEX ix_perf_events_time ON perf_events (time_created DESC) INCLUDE (category, total_time_ms);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_perf_events_computer_time' AND object_id = OBJECT_ID('perf_events'))
CREATE NONCLUSTERED INDEX ix_perf_events_computer_time ON perf_events (computer_id, time_created DESC) INCLUDE (category);

MERGE settings AS t
USING (VALUES ('checks.run_perf', 'true')) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
