-- BSOD / kernel crash-dump collection + analysis.
--
-- The crash-dump collector reads \\PC\C$\Windows\Minidump\*.dmp from monitored,
-- reachable PCs (dedup by computer + filename), and stores the raw minidump bytes
-- as a blob with status='pending'. It NEVER touches the client's full MEMORY.DMP
-- (only the small per-crash minidumps) and leaves the on-client file for Windows
-- to clean up — the DB is the durable store.
--
-- A separate analyzer worker runs cdb (Debugging Tools for Windows) on each pending
-- dump and fills the parsed result (STOP code, bugcheck name, hot function, the
-- offending process/module) + the full cdb output for the report. It materializes
-- the blob to a temp file, analyzes it, then deletes the temp.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'crash_dumps')
CREATE TABLE crash_dumps (
  id              INT IDENTITY PRIMARY KEY,
  computer_id     INT NOT NULL,
  computer_name   NVARCHAR(255) NULL,
  source_filename NVARCHAR(255) NOT NULL,   -- e.g. 062226-13765-01.dmp
  occurred_at     DATETIME2 NULL,           -- dump file mtime (~ crash time)
  size_bytes      BIGINT NULL,
  status          NVARCHAR(16) NOT NULL CONSTRAINT DF_crash_dumps_status DEFAULT 'pending',  -- pending | analyzed | failed
  stop_code       NVARCHAR(16) NULL,        -- e.g. 0x133
  bugcheck_name   NVARCHAR(64) NULL,        -- e.g. DPC_WATCHDOG_VIOLATION
  hot_function    NVARCHAR(255) NULL,       -- e.g. nt!MiDeleteSubsectionPages
  culprit_process NVARCHAR(255) NULL,       -- e.g. msedgewebview2.exe
  culprit_module  NVARCHAR(255) NULL,       -- first non-nt/hal module in the stack, if any
  analyze_text    NVARCHAR(MAX) NULL,       -- full cdb output (drives the report)
  analyze_error   NVARCHAR(512) NULL,
  dmp_blob        VARBINARY(MAX) NULL,      -- raw minidump bytes
  ingested_at     DATETIME2 NOT NULL CONSTRAINT DF_crash_dumps_ingested DEFAULT SYSUTCDATETIME(),
  analyzed_at     DATETIME2 NULL,
  CONSTRAINT UQ_crash_dumps_file UNIQUE (computer_id, source_filename)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_crash_dumps_status')
CREATE INDEX IX_crash_dumps_status ON crash_dumps (status, ingested_at);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_crash_dumps_occurred')
CREATE INDEX IX_crash_dumps_occurred ON crash_dumps (occurred_at DESC);

-- Defaults (off by default — operator opts in). cdb path = installed Debugging Tools.
MERGE settings AS t USING (VALUES
  ('crash.enabled', '0'),
  ('crash.interval_sec', '3600'),
  ('crash.analyzer_interval_sec', '300'),
  ('crash.cdb_path', 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe'),
  ('crash.symbol_path', 'srv*C:\symbols*https://msdl.microsoft.com/download/symbols'),
  ('crash.blob_retention_days', '180')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
