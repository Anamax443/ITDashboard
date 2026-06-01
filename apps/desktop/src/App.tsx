import React, { useEffect, useState } from 'react';

interface Summary {
  critical_24h: number;
  error_24h: number;
  warning_24h: number;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://10.8.2.213:4000';

export function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/events/summary`)
      .then((r) => r.json())
      .then(setSummary)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div style={{ fontFamily: 'Segoe UI, sans-serif', padding: 24 }}>
      <h1>ITDashboard</h1>
      {error && <div style={{ color: 'crimson' }}>API error: {error}</div>}
      {summary && (
        <div style={{ display: 'flex', gap: 16 }}>
          <Card label="Critical (24h)" value={summary.critical_24h} color="#b91c1c" />
          <Card label="Error (24h)" value={summary.error_24h} color="#c2410c" />
          <Card label="Warning (24h)" value={summary.warning_24h} color="#a16207" />
        </div>
      )}
    </div>
  );
}

function Card({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ border: `2px solid ${color}`, borderRadius: 8, padding: 16, minWidth: 160 }}>
      <div style={{ fontSize: 12, color: '#444' }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
