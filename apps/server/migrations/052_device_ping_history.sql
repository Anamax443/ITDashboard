-- Long-term packet-loss / latency for the Devices tab (the "ms / %" column).
--
-- The previous metric stored only the LAST 4-ping burst, overwriting it every
-- cycle. So a momentary blip — a PC re-joining the network, one dropped echo —
-- showed as 25–75% loss and falsely flagged the device "problémové (ztráta)".
-- The operator wants the LONG-TERM loss rate, not a snapshot.
--
-- We now keep a rolling history of per-cycle ping samples (sent / recv / latency)
-- and compute the displayed loss as a TRUE windowed ratio: dropped / sent over the
-- last N hours (default 24). A single bad cycle then carries only 1/N weight and
-- dissolves on its own; latency is the windowed average RTT. The aggregate is
-- written back into dhcp_leases.packet_loss / latency_ms each cycle, so the
-- GET /devices read is unchanged.
--
-- Only ONLINE cycles are sampled: a powered-off box must not accrue "100% loss"
-- (that is just "offline", shown by the Stav column, not link degradation). When a
-- device is offline the loss/latency are cleared to NULL. Samples older than the
-- window are pruned each collect run, so the table stays bounded.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'device_ping_samples')
CREATE TABLE device_ping_samples (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  mac_address NVARCHAR(32) NOT NULL,
  sample_at   DATETIME2 NOT NULL CONSTRAINT DF_device_ping_samples_at DEFAULT SYSUTCDATETIME(),
  sent        INT NOT NULL,
  recv        INT NOT NULL,
  latency_ms  INT NULL
);

-- Keyed/aggregated by MAC (a physical NIC is unique to one device, and a synthetic
-- "IP-<ip>" id is unique per IP), so the history survives a site-label change.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_device_ping_samples_mac_time')
CREATE INDEX IX_device_ping_samples_mac_time
  ON device_ping_samples (mac_address, sample_at);

-- Rolling window length (hours) for the long-term loss/latency calc. Tunable.
MERGE settings AS t
USING (VALUES ('devices.loss_window_hours', '24')) AS s([key], [value])
  ON t.[key] = s.[key]
WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);
