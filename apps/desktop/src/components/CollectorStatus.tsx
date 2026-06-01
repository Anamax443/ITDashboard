import React, { useEffect, useState } from 'react';
import type { CollectorStatus as CS } from '../api.js';
import { api, timeAgo } from '../api.js';

export function CollectorStatus() {
  const [status, setStatus] = useState<CS | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const s = await api.collectorStatus();
      setStatus(s);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    fetchStatus();
    const t = setInterval(fetchStatus, 15_000);
    return () => clearInterval(t);
  }, []);

  const trigger = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.collectorRun();
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const last = status?.lastRun;
  const inFlight = status?.inFlight || running;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: 'var(--surface)', borderRadius: 8, fontSize: 12 }}>
      <span style={{ color: 'var(--text-dim)' }}>Collector:</span>
      {inFlight && <span style={{ color: 'var(--accent)' }}>● Running…</span>}
      {!inFlight && last && (
        <>
          <span>
            Last: {timeAgo(last.finished_at ?? last.started_at)} ({last.trigger_source})
          </span>
          <span>·</span>
          <span style={{ color: 'var(--ok)' }}>{last.pcs_succeeded ?? 0} OK</span>
          {(last.pcs_failed ?? 0) > 0 && (
            <>
              <span style={{ color: 'var(--text-dim)' }}>/</span>
              <span style={{ color: 'var(--critical)' }}>{last.pcs_failed} fail</span>
            </>
          )}
          <span>·</span>
          <span>+{last.events_added ?? 0} events</span>
        </>
      )}
      {!inFlight && !last && <span style={{ color: 'var(--text-dim)' }}>never ran</span>}
      <button className="refresh-btn" onClick={trigger} disabled={inFlight} style={{ marginLeft: 'auto' }}>
        {inFlight ? '…' : 'Run now'}
      </button>
      {error && <span style={{ color: 'var(--critical)' }}>⚠ {error}</span>}
    </div>
  );
}
