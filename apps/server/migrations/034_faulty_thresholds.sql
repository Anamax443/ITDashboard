-- Recalibrate the faulty-PC thresholds from the seeded first guess (60 / 150).
-- Live data showed active Windows 11 boxes carry a high event baseline
-- (routine warnings + the breadth bonus), so 60/150 flagged ~42% of the fleet
-- as "risk" — useless as a shortlist. Tuned against the real score distribution:
-- watch=400 keeps the watch+risk list to the worst ~35, risk=600 keeps the
-- actionable "reinstall now" tile to the worst ~10. Still fully tunable in
-- Settings. Guarded to the original seed values so any operator tuning that
-- already happened is never clobbered.
UPDATE settings SET [value] = '400' WHERE [key] = 'faulty.threshold_watch' AND [value] = '60';
UPDATE settings SET [value] = '600' WHERE [key] = 'faulty.threshold_risk'  AND [value] = '150';
