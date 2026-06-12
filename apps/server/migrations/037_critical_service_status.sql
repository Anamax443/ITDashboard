-- Real state of the configured critical services (alerts.services.critical_names)
-- on every monitored PC, in ANY state — not just when stopped. The services
-- collector only stores Auto + non-Running "problems" in service_problems, so a
-- critical service that is Running was invisible; the operator needs to confirm
-- that ALL critical services (NTDS, DNS, Kdc, Veeam, …) are actually up.
--
-- Only services that EXIST on a given machine are stored, so a workstation
-- without NTDS simply has no NTDS row (servers vs PCs sorts itself out). Offline
-- machines aren't rescanned, so their last-known rows persist with an older
-- collected_at — the UI flags that staleness.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'critical_service_status')
  CREATE TABLE critical_service_status (
    computer_id   INT NOT NULL,
    service_name  NVARCHAR(255) NOT NULL,
    display_name  NVARCHAR(255) NULL,
    state         NVARCHAR(32) NOT NULL,   -- Running / Stopped / Paused / ...
    start_mode    NVARCHAR(32) NULL,       -- Auto / Manual / Disabled
    collected_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_critical_service_status PRIMARY KEY (computer_id, service_name)
  );
