-- Store DistinguishedName from AD + parsed human-readable OU path
IF COL_LENGTH('computers', 'distinguished_name') IS NULL
  ALTER TABLE computers ADD distinguished_name NVARCHAR(1024) NULL;

IF COL_LENGTH('computers', 'ou_path') IS NULL
  ALTER TABLE computers ADD ou_path NVARCHAR(1024) NULL;
