import React from 'react';
import type { Summary, ComputerItem } from '../api.js';

export function SummaryCards({ summary, computers }: { summary: Summary | null; computers: ComputerItem[] }) {
  const enabledCount = computers.filter((c) => c.enabled).length;
  const total = computers.length;
  return (
    <div className="cards">
      <Card label="Critical (24h)" value={summary?.critical_24h ?? '—'} kind="critical" />
      <Card label="Error (24h)" value={summary?.error_24h ?? '—'} kind="error" />
      <Card label="Warning (24h)" value={summary?.warning_24h ?? '—'} kind="warning" />
      <Card label="Computers" value={`${enabledCount}/${total}`} kind="info" />
    </div>
  );
}

function Card({ label, value, kind }: { label: string; value: number | string; kind: 'critical' | 'error' | 'warning' | 'info' }) {
  return (
    <div className={`card ${kind}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
