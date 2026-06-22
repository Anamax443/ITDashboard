-- Temporary per-PC snooze for the eventlog "problem PC" tile.
--
-- When the operator has reviewed and resolved a box's eventlog problems, they can
-- sign off ("vyřešeno") and snooze that PC for a chosen number of days. While the
-- snooze is active the PC is excluded from the "PC v problémech" risk count (so the
-- tile stops lighting up needlessly) and flagged "💤 uspáno" in the Events tab.
--
-- The snooze is ALWAYS temporary: snoozed_until is a hard expiry. After it passes
-- the PC returns to standard automatically — there is no timer, the pc-health query
-- simply treats `snoozed_until > now` as active. This keeps the warning system
-- honest: a sign-off mutes known-resolved noise for a bounded window, it does not
-- hide the box forever. The operator can also clear a snooze early.
--
-- One active snooze per PC (PK computer_id); re-snoozing overwrites (MERGE). The
-- signature (who/when/note) is the audit record; each snooze/clear is also written
-- to activity_log for the full history.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'eventlog_snooze')
CREATE TABLE eventlog_snooze (
  computer_id   INT NOT NULL PRIMARY KEY,
  snoozed_at    DATETIME2 NOT NULL,
  snoozed_until DATETIME2 NOT NULL,
  snoozed_by    NVARCHAR(128) NOT NULL,
  note          NVARCHAR(1000) NULL,
  CONSTRAINT FK_eventlog_snooze_computer FOREIGN KEY (computer_id)
    REFERENCES computers(id) ON DELETE CASCADE
);

-- Default snooze length offered in the UI (operator can override per snooze).
MERGE settings AS t
USING (VALUES ('faulty.snooze_default_days', '7')) AS s([key], [value])
  ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
