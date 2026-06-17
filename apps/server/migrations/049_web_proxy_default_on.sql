-- Device web proxy (cert-bypass for printer EWS) defaults to ON, so the printer
-- card click + the Devices IP link route through the server (which ignores the
-- printer's self-signed cert) instead of hitting NET::ERR_CERT_AUTHORITY_INVALID.
-- WHEN NOT MATCHED only, so an explicit operator choice (incl. turning it OFF
-- later) is preserved — the seed just sets the default for a deployment that has
-- never touched the setting.
MERGE settings AS t
USING (VALUES ('devices.web_proxy', '1')) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
