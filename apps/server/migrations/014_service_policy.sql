-- Service policy — what each service pattern SHOULD be doing.
-- After every scan, collector marks each problem as compliant vs drift
-- based on the highest-priority matching policy row.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'service_policy')
CREATE TABLE service_policy (
  id                    INT IDENTITY(1,1) PRIMARY KEY,
  pattern               NVARCHAR(255) NOT NULL,         -- glob: GoogleUpdater*, regex with ^/$ also supported
  expected_start_mode   NVARCHAR(32) NULL,              -- 'Auto', 'Manual', 'Disabled', 'Trigger', or NULL = don't care
  expected_state        NVARCHAR(32) NULL,              -- 'Running', 'Stopped', or NULL = don't care
  priority              INT NOT NULL DEFAULT 100,       -- lower wins on overlap
  reason                NVARCHAR(MAX) NULL,
  created_at            DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Seed with known-noise defaults
MERGE service_policy AS t
USING (VALUES
  ('GoogleUpdater*',                       'Manual', NULL,    50, 'Google auto-updater — runs only on update check'),
  ('DropboxUpdater*',                      'Manual', NULL,    50, 'Dropbox auto-updater'),
  ('Intel(R) TPM*',                        'Manual', NULL,    50, 'Intel TPM provisioning — one-time init'),
  ('Intel(R) Platform License*',           'Manual', NULL,    50, 'Intel DRM, app-specific'),
  ('IntelAudioService',                    'Manual', NULL,    50, 'Intel Smart Sound driver helper'),
  ('IntelDisplayUMService',                'Manual', NULL,    50, 'Intel graphics helper'),
  ('WbfPolicyService*',                    'Manual', NULL,    50, 'Windows Biometric Framework policy — on-demand'),
  ('MFUninst*',                            'Manual', NULL,    50, 'MyFonts uninstall'),
  ('MFClient*',                            'Manual', NULL,    50, 'MyFonts client'),
  ('MFSetup*',                             'Manual', NULL,    50, 'MyFonts setup'),
  ('cortsmartserver',                      'Manual', NULL,    50, 'Cortado print server'),
  ('O2 Internet*',                         'Manual', NULL,    50, 'O2 mobile broadband connector'),
  ('scvpn',                                'Manual', NULL,    50, 'Sangfor VPN'),
  ('LPlatSvc',                             'Manual', NULL,    50, 'Lenovo Platform Service'),
  ('SynaHlp',                              'Manual', NULL,    50, 'Synaptics touchpad helper'),
  ('CxUIUSvc',                             'Manual', NULL,    50, 'Conexant audio UI'),
  ('tiledatamodelsvc',                     'Manual', NULL,    50, 'Deprecated Windows Tile Data Model'),
  ('AsusUpdateCheck',                      'Manual', NULL,    50, 'ASUS update checker'),
  ('XTU3SERVICE',                          'Manual', NULL,    50, 'Intel Extreme Tuning Utility'),
  ('GBTECService',                         'Manual', NULL,    50, 'Gigabyte tech service'),
  ('VemaAdminService',                     'Auto',   'Running', 80, 'VEMA application — should run if used'),
  ('HP LaserJet Service',                  'Auto',   'Running', 80, 'HP printer service — should run on print servers'),
  ('CCAgent',                              'Auto',   'Running', 90, 'SCCM Configuration Manager client — critical for managed PCs'),
  ('TrustedInstaller',                     'Manual', NULL,    90, 'Windows Modules Installer — Microsoft default is Manual, Auto+Stopped usually means stuck Windows Update'),
  ('ShellHWDetection',                     'Auto',   'Running', 80, 'Shell Hardware Detection — affects USB autoplay')
) AS s(pattern, expected_start_mode, expected_state, priority, reason)
ON t.pattern = s.pattern
WHEN NOT MATCHED THEN
  INSERT (pattern, expected_start_mode, expected_state, priority, reason)
  VALUES (s.pattern, s.expected_start_mode, s.expected_state, s.priority, s.reason);

-- Drift columns on service_problems
IF COL_LENGTH('service_problems', 'is_compliant') IS NULL
  ALTER TABLE service_problems ADD is_compliant BIT NULL;
IF COL_LENGTH('service_problems', 'policy_id') IS NULL
  ALTER TABLE service_problems ADD policy_id INT NULL;
