-- Store how many cycles a link-speed measurement used (shown in the table).
IF COL_LENGTH('link_speed_results', 'cycles') IS NULL
  ALTER TABLE link_speed_results ADD cycles INT NULL;
