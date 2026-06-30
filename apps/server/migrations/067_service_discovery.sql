-- Service discovery (user-triggered broad port scan on a sample of devices per
-- category) + VoIP OUI list so wired IP desk phones (Yealink etc.) are recognised
-- as 'voip' rather than lumped with guest-WiFi mobiles in the generic 'phone'
-- category. OUIs are the first 6 hex of the MAC (no separators).
MERGE settings AS t USING (VALUES
  ('svcdisc.sample', '8'),
  ('svcdisc.full_sample', '3'),
  ('svcdisc.timeout_ms', '800'),
  ('svcdisc.categories', 'printer,voip,phone,network,iot'),
  ('svcports.voip_ouis', '805ec0,249ad8,001565')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
