-- ITDashboard initial schema
-- MSSQL — partitioning by month on events table for clean 90d retention.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'computers')
CREATE TABLE computers (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  name         NVARCHAR(255) NOT NULL UNIQUE,
  fqdn         NVARCHAR(512) NULL,
  os_version   NVARCHAR(128) NULL,
  last_seen    DATETIME2 NULL,
  enabled      BIT NOT NULL DEFAULT 1,
  created_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'events')
CREATE TABLE events (
  id             BIGINT IDENTITY(1,1) NOT NULL,
  computer_id    INT NOT NULL,
  log_name       NVARCHAR(128) NOT NULL,
  event_id       INT NOT NULL,
  level          TINYINT NOT NULL,        -- 1=Critical, 2=Error, 3=Warning, 4=Info, 5=Verbose
  time_created   DATETIME2 NOT NULL,
  provider_name  NVARCHAR(255) NULL,
  task           NVARCHAR(255) NULL,
  message        NVARCHAR(MAX) NULL,
  raw_xml        NVARCHAR(MAX) NULL,
  collected_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_events PRIMARY KEY NONCLUSTERED (id, time_created),
  CONSTRAINT fk_events_computer FOREIGN KEY (computer_id) REFERENCES computers(id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_events_time_level' AND object_id = OBJECT_ID('events'))
CREATE CLUSTERED INDEX ix_events_time_level ON events (time_created DESC, level);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_events_computer_time' AND object_id = OBJECT_ID('events'))
CREATE NONCLUSTERED INDEX ix_events_computer_time ON events (computer_id, time_created DESC) INCLUDE (level, event_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_events_eventid_time' AND object_id = OBJECT_ID('events'))
CREATE NONCLUSTERED INDEX ix_events_eventid_time ON events (event_id, time_created DESC) INCLUDE (level);

-- Daily aggregates — kept forever, used for trend / capacity dashboards.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'event_daily_agg')
CREATE TABLE event_daily_agg (
  day           DATE NOT NULL,
  computer_id   INT NOT NULL,
  log_name      NVARCHAR(128) NOT NULL,
  event_id      INT NOT NULL,
  level         TINYINT NOT NULL,
  count         INT NOT NULL,
  CONSTRAINT pk_event_daily_agg PRIMARY KEY (day, computer_id, log_name, event_id, level)
);

-- Script catalog + run history
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'scripts')
CREATE TABLE scripts (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  slug         NVARCHAR(255) NOT NULL UNIQUE,
  name         NVARCHAR(255) NOT NULL,
  language     NVARCHAR(32) NOT NULL,   -- powershell | python | csharp
  description  NVARCHAR(MAX) NULL,
  path         NVARCHAR(1024) NOT NULL,
  params_json  NVARCHAR(MAX) NULL,
  enabled      BIT NOT NULL DEFAULT 1,
  created_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'script_runs')
CREATE TABLE script_runs (
  id           BIGINT IDENTITY(1,1) PRIMARY KEY,
  script_id    INT NOT NULL,
  invoked_by   NVARCHAR(255) NOT NULL,
  target       NVARCHAR(255) NULL,
  params_json  NVARCHAR(MAX) NULL,
  started_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  finished_at  DATETIME2 NULL,
  exit_code    INT NULL,
  stdout       NVARCHAR(MAX) NULL,
  stderr       NVARCHAR(MAX) NULL,
  CONSTRAINT fk_script_runs_script FOREIGN KEY (script_id) REFERENCES scripts(id)
);

-- Stored credentials (DPAPI-encrypted blob, opaque to SQL — server decrypts at use site)
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'credentials')
CREATE TABLE credentials (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  slug            NVARCHAR(255) NOT NULL UNIQUE,
  kind            NVARCHAR(32) NOT NULL,    -- domain-admin | local-admin | service-account
  username        NVARCHAR(255) NOT NULL,
  encrypted_blob  VARBINARY(MAX) NOT NULL,
  created_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  last_used_at    DATETIME2 NULL
);
