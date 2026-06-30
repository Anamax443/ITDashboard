-- Add a VoIP liveness check (Yealink phones' web UI on TCP 80) to the default
-- matrix. The matrix now promotes VoIP-OUI devices to category 'voip' (Yealink),
-- so this targets the wired IP phones — not the guest-WiFi mobiles in 'phone'.
-- The real phone signal here is online/offline (a dead phone), since SIP to the
-- T-Mobile cloud PBX can't be measured from the central server. Only touch installs
-- still on the 066 printers-only default.
UPDATE settings SET [value] = 'Tiskárna RAW 9100:9100:printer,Tiskárna LPR 515:515:printer,Tiskárna IPP 631:631:printer,Telefon web 80:80:voip'
WHERE [key] = 'svcports.checks'
  AND [value] = 'Tiskárna RAW 9100:9100:printer,Tiskárna LPR 515:515:printer,Tiskárna IPP 631:631:printer';
