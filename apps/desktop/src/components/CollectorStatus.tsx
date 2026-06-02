import React, { useEffect, useRef, useState } from 'react';
import type { CollectorStatus as CS, ActivityLogEntry } from '../api.js';
import { api, timeAgo } from '../api.js';

const POLL_IDLE_MS = 15_000;
const POLL_RUNNING_MS = 2_000;

export function CollectorStatus() {
  const [status, setStatus] = useState<CS | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggeringAll, setTriggeringAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLog, setLastLog] = useState<ActivityLogEntry | null>(null);
  const [lastAllSummary, setLastAllSummary] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logSeqRef = useRef<number>(0);

  const fetchStatus = async () => {
    try {
      const s = await api.collectorStatus();
      setStatus(s);
      // Also pull last log line
      try {
        const log = await api.activityLog(5, logSeqRef.current);
        if (log.entries.length > 0) {
          setLastLog(log.entries[log.entries.length - 1] ?? null);
        }
        logSeqRef.current = log.seq;
      } catch { /* ignore */ }
      return s;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const s = await fetchStatus();
      const inFlight = s?.inFlight ?? false;
      const next = inFlight ? POLL_RUNNING_MS : POLL_IDLE_MS;
      timerRef.current = setTimeout(tick, next);
    };
    tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const trigger = async () => {
    setTriggering(true);
    setError(null);
    setLastAllSummary(null);
    try {
      await api.collectorRun();
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setTriggering(false);
    }
  };

  const triggerAll = async () => {
    setTriggeringAll(true);
    setError(null);
    setLastAllSummary(null);
    try {
      const result = await api.collectorRunAll();
      const parts = [
        result.eventlog ? `events +${result.eventlog.eventsAdded}` : 'events skipped',
        result.disk ? `disks ${result.disk.drives} drives` : 'disks skipped',
        result.services ? `services ${result.services.problems} problems` : 'services skipped',
      ];
      setLastAllSummary(`${parts.join(' · ')} · ${(result.durationMs / 1000).toFixed(1)}s`);
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setTriggeringAll(false);
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await api.collectorStop();
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    }
  };

  const inFlight = status?.inFlight || triggering || triggeringAll;
  const progress = status?.progress;
  const last = status?.lastRun;

  return (
    <div style={{ background: 'var(--surface)', borderRadius: 8, padding: 8, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Collector:</span>

        {inFlight && progress ? (
          <ProgressDisplay progress={progress} />
        ) : inFlight ? (
          <span style={{ color: 'var(--accent)' }}>● Starting…</span>
        ) : last ? (
          <IdleDisplay last={last} />
        ) : (
          <span style={{ color: 'var(--text-dim)' }}>never ran</span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {inFlight && (
            <button
              className="refresh-btn"
              onClick={stop}
              style={{ borderColor: 'var(--critical)', color: 'var(--critical)' }}
            >
              ⏹ Stop
            </button>
          )}
          <button className="refresh-btn" onClick={trigger} disabled={inFlight}>
            {inFlight ? 'Running…' : '▶ Run now'}
          </button>
          <button className="refresh-btn" onClick={triggerAll} disabled={inFlight} title="Run eventlog collector, disk scan, and services scan sequentially">
            {triggeringAll ? 'Running all…' : '▶ Run all checks'}
          </button>
        </div>
        {error && <span style={{ color: 'var(--critical)' }}>⚠ {error}</span>}
      </div>

      {lastAllSummary && !inFlight && (
        <div style={{ marginTop: 4, fontSize: 10, fontFamily: 'Consolas, monospace', color: 'var(--ok)' }}>
          [checks] {lastAllSummary}
        </div>
      )}

      {inFlight && progress && progress.recentFailures.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>
          Recent failures:{' '}
          {progress.recentFailures.map((f) => (
            <span key={f.name} title={f.error} style={{ marginRight: 8 }}>
              <span style={{ color: 'var(--critical)' }}>{f.name}</span>
            </span>
          ))}
        </div>
      )}

      {lastLog && (
        <div style={{ marginTop: 4, fontSize: 10, fontFamily: 'Consolas, monospace', color: 'var(--text-dim)' }}>
          <span style={{ color: 'var(--accent)' }}>[{lastLog.source}]</span> {lastLog.message}
        </div>
      )}
    </div>
  );
}

function ProgressDisplay({ progress }: { progress: NonNullable<CS['progress']> }) {
  const pct = progress.totalPcs > 0 ? (progress.processedPcs / progress.totalPcs) * 100 : 0;
  const elapsed = Math.floor((Date.now() - new Date(progress.startedAt).getTime()) / 1000);
  return (
    <>
      <span style={{ color: 'var(--accent)' }}>● Running</span>
      <div style={{ flex: '0 0 200px', height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s' }} />
      </div>
      <span>{progress.processedPcs}/{progress.totalPcs} PCs</span>
      <span>·</span>
      <span style={{ color: 'var(--ok)' }}>✓ {progress.succeededPcs}</span>
      <span style={{ color: 'var(--text-dim)' }}>/</span>
      <span style={{ color: 'var(--critical)' }}>✗ {progress.failedPcs}</span>
      <span>·</span>
      <span>+{progress.eventsAddedSoFar} events</span>
      <span>·</span>
      <span style={{ color: 'var(--text-dim)' }}>{elapsed}s</span>
      {progress.currentlyProcessing.length > 0 && (
        <>
          <span style={{ color: 'var(--text-dim)' }}>·</span>
          <span style={{ color: 'var(--text-dim)' }} title={progress.currentlyProcessing.join(', ')}>
            now: {progress.currentlyProcessing.slice(0, 2).join(', ')}{progress.currentlyProcessing.length > 2 ? ` +${progress.currentlyProcessing.length - 2}` : ''}
          </span>
        </>
      )}
    </>
  );
}

function IdleDisplay({ last }: { last: NonNullable<CS['lastRun']> }) {
  return (
    <>
      <span>Last: {timeAgo(last.finished_at ?? last.started_at)} ({last.trigger_source})</span>
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
  );
}
