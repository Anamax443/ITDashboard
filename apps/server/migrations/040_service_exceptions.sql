-- Two per-PC service-monitoring levels with per-PC exception (ignore) lists,
-- mirroring the per-PC disk drive-scope:
--   * service_monitor + service_exceptions          → "Services" (broad): every
--     Auto service that is not Running, minus the per-PC ignore list, minus the
--     global whitelist, EXCLUDING names that are critical (those belong to the
--     critical level so they are never reported twice).
--   * service_email_monitor + critical_service_exceptions → "Critical services"
--     (the existing key-service alerting), now with a per-PC ignore list so e.g.
--     a demoted DC can suppress NTDS/Kdc without muting them fleet-wide.
-- Exceptions are comma/newline-separated service NAMES (case-insensitive,
-- * and ? wildcards), same syntax as the global critical_names / whitelist.

IF COL_LENGTH('computers', 'service_monitor') IS NULL
  ALTER TABLE computers ADD service_monitor BIT NOT NULL DEFAULT 0;

IF COL_LENGTH('computers', 'service_exceptions') IS NULL
  ALTER TABLE computers ADD service_exceptions NVARCHAR(MAX) NULL;

IF COL_LENGTH('computers', 'critical_service_exceptions') IS NULL
  ALTER TABLE computers ADD critical_service_exceptions NVARCHAR(MAX) NULL;
