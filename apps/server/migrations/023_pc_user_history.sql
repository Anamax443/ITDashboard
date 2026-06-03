-- Per-PC interactive login history. On shared workstations (ZAST*, etc.)
-- multiple operators rotate through the same machine; recording each
-- distinct logged-on user lets the operator answer "who used this PC
-- on Friday?" without parsing Security logs. Populated by the disk
-- collector after upsertPcInfo: if the most-recent row for the PC has
-- the same user_name, last_seen is bumped; otherwise a new row is
-- inserted. NULL user observations (nobody logged in) are not stored.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'pc_user_history')
CREATE TABLE pc_user_history (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  computer_id INT NOT NULL,
  user_name   NVARCHAR(255) NOT NULL,
  first_seen  DATETIME2 NOT NULL,
  last_seen   DATETIME2 NOT NULL,
  CONSTRAINT fk_pc_user_history_computer FOREIGN KEY (computer_id) REFERENCES computers(id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_pc_user_history_computer' AND object_id = OBJECT_ID('pc_user_history'))
CREATE NONCLUSTERED INDEX ix_pc_user_history_computer ON pc_user_history (computer_id, last_seen DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_pc_user_history_last_seen' AND object_id = OBJECT_ID('pc_user_history'))
CREATE NONCLUSTERED INDEX ix_pc_user_history_last_seen ON pc_user_history (last_seen DESC);

MERGE settings AS t
USING (VALUES ('pcUserHistory.retention_days', '90')) AS s([key], [value])
ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);

IF NOT EXISTS (SELECT 1 FROM sys.procedures WHERE name = 'sp_purge_pc_user_history')
EXEC('
CREATE PROCEDURE sp_purge_pc_user_history @retention_days INT = 90 AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM pc_user_history
  WHERE last_seen < DATEADD(DAY, -@retention_days, SYSUTCDATETIME());
END
');
