-- Sprint 1.7: capture Win32_Service ExitCode + ServiceSpecificExitCode
-- alongside the existing State / StartMode / trigger / delayed signals.
--
-- Without ExitCode the dashboard cannot distinguish a trigger-start service
-- that finished gracefully (ExitCode = 0) from one that crashed (ExitCode
-- != 0). Per oponentura 2026-06-04 (Services tab alert-fatigue review)
-- commitment 1, the collector now persists both codes and the UI surfaces
-- them as a column + filter chip.
--
-- exit_code: standard Win32 exit code reported by SCM when the service
--   transitioned to Stopped. 0 = clean exit. Non-zero = SCM-level failure.
-- service_specific_exit_code: present when exit_code = 1066 (Win32 error
--   ERROR_SERVICE_SPECIFIC_ERROR). Some services use this to encode their
--   own internal failure reason.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'exit_code' AND Object_ID = OBJECT_ID('service_problems')
)
BEGIN
  ALTER TABLE service_problems ADD exit_code INT NULL;
END

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'service_specific_exit_code' AND Object_ID = OBJECT_ID('service_problems')
)
BEGIN
  ALTER TABLE service_problems ADD service_specific_exit_code INT NULL;
END
