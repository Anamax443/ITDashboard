-- "Faulty PC / reinstall candidate" detection.
--
-- Ranks PCs by accumulated critical/error/warning eventlog volume over a window,
-- but with a "damped blend" score so a single chatty source can't flag an
-- otherwise-healthy box:
--   * each distinct signature (provider + event_id + level) contributes at most
--     `signature_cap` occurrences (a driver screaming 4000x counts as cap, not 4000),
--   * weighted by severity (critical >> error >> warning),
--   * plus a breadth bonus (how many DIFFERENT error/critical signatures) and a
--     persistence bonus (how many distinct DAYS had errors) — a systemically sick
--     box has many different problems across many days, not one loud one.
-- score = Σ min(cnt, cap)·weight(level)  +  signatures·weight_breadth
--                                         +  active_days·weight_persistence
-- A PC is a "watch" at >= threshold_watch and a reinstall "risk" at >= threshold_risk.
-- All knobs live here (settings) so the operator can tune without a redeploy.

MERGE settings AS t
USING (VALUES
  ('faulty.window_days', '14'),
  ('faulty.signature_cap', '20'),
  ('faulty.weight_critical', '10'),
  ('faulty.weight_error', '3'),
  ('faulty.weight_warning', '1'),
  ('faulty.weight_breadth', '5'),
  ('faulty.weight_persistence', '3'),
  ('faulty.threshold_watch', '60'),
  ('faulty.threshold_risk', '150')
) AS s([key], [value]) ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
