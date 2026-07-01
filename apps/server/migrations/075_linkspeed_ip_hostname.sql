-- Store BOTH the resolved IP and hostname of each measured PC, so the output always
-- shows both — e.g. a hostname target also gets its current IP (tells wifi vs cable).
IF COL_LENGTH('link_speed_results', 'ip_address') IS NULL
  ALTER TABLE link_speed_results ADD ip_address NVARCHAR(45) NULL;
IF COL_LENGTH('link_speed_results', 'host_name') IS NULL
  ALTER TABLE link_speed_results ADD host_name NVARCHAR(255) NULL;
