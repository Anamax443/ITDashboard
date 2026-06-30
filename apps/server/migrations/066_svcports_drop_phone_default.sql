-- The default phone SIP check (065) probed the generic 'phone' category, which in
-- practice holds guest-WiFi mobiles (Androids/iPhones/tablets), NOT the wired VoIP
-- desk phones — so the SIP row was meaningless. Drop it from the default check set
-- (printers only) until IP phones are identified as their own category. Only touch
-- installs still on the original 065 default — don't clobber a customized list.
UPDATE settings SET [value] = 'Tiskárna RAW 9100:9100:printer,Tiskárna LPR 515:515:printer,Tiskárna IPP 631:631:printer'
WHERE [key] = 'svcports.checks'
  AND [value] = 'Tiskárna RAW 9100:9100:printer,Tiskárna LPR 515:515:printer,Tiskárna IPP 631:631:printer,Telefon SIP 5060:5060:phone';
