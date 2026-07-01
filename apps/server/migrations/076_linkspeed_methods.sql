-- Extra measurement methods per result: negotiated NIC link speed (via DCOM CIM) and
-- robocopy /MT throughput. Each method is independently toggleable in Settings.
IF COL_LENGTH('link_speed_results', 'nic_mbps') IS NULL
  ALTER TABLE link_speed_results ADD nic_mbps INT NULL;
IF COL_LENGTH('link_speed_results', 'nic_name') IS NULL
  ALTER TABLE link_speed_results ADD nic_name NVARCHAR(255) NULL;
IF COL_LENGTH('link_speed_results', 'robo_up_mbps') IS NULL
  ALTER TABLE link_speed_results ADD robo_up_mbps FLOAT NULL;
IF COL_LENGTH('link_speed_results', 'robo_down_mbps') IS NULL
  ALTER TABLE link_speed_results ADD robo_down_mbps FLOAT NULL;
