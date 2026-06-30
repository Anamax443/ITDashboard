-- Per-branch service-port consistency matrix. For each "Label:port:category" check
-- the app server probes that TCP port on every categorized device of that category
-- at each site (from mikrotik.routers), so the operator can see whether a service
-- (printers, IP phones, …) is reachable the same way on every branch. Curated ports
-- only — never a full scan. No table: the matrix is an in-memory snapshot.
MERGE settings AS t USING (VALUES
  ('svcports.enabled', '1'),
  ('svcports.interval_sec', '900'),
  ('svcports.timeout_ms', '1500'),
  ('svcports.max_per_cell', '60'),
  ('svcports.checks', 'Tiskárna RAW 9100:9100:printer,Tiskárna LPR 515:515:printer,Tiskárna IPP 631:631:printer,Telefon SIP 5060:5060:phone')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
