-- VoIP is out of reach from the central server: the IP phones (Yealink, OUI
-- 24:9A:D8) register to T-Mobile's cloud PBX (BroadWorks, xspweb.t-mobile.cz) and
-- sit on a network the polled routers don't inventory — none appear in dhcp_leases,
-- so the 'voip' matrix row is always empty. Drop the VoIP check from the default
-- (printers only) — deferred ("maybe later"). The OUI-aware matrix code and
-- svcports.voip_ouis stay, so re-adding a 'Telefon …:port:voip' check once phones
-- become visible (their voice subnet added to mikrotik.scan_ranges AND reachable
-- from .213) is all that's needed. Only touch installs still on the 068 default.
UPDATE settings SET [value] = 'Tiskárna RAW 9100:9100:printer,Tiskárna LPR 515:515:printer,Tiskárna IPP 631:631:printer'
WHERE [key] = 'svcports.checks'
  AND [value] = 'Tiskárna RAW 9100:9100:printer,Tiskárna LPR 515:515:printer,Tiskárna IPP 631:631:printer,Telefon web 80:80:voip';
