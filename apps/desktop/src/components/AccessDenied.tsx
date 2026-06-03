import React from 'react';

export function AccessDenied({ ip }: { ip: string }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg, #1e1e1e)',
      color: 'var(--text, #ddd)',
      fontFamily: 'Segoe UI, Arial, sans-serif',
      padding: 32,
    }}>
      <div style={{ maxWidth: 560, textAlign: 'left' }}>
        <div style={{ fontSize: 13, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
          ITDashboard
        </div>
        <h1 style={{ color: '#f48771', fontSize: 28, margin: '0 0 16px 0' }}>
          Access not configured
        </h1>
        <p style={{ lineHeight: 1.6, color: '#bbb' }}>
          Your IP <code style={{ background: '#2d2d2d', padding: '2px 8px', borderRadius: 3 }}>{ip}</code> is
          not on the dashboard access list.
        </p>
        <p style={{ lineHeight: 1.6, color: '#bbb' }}>
          The ITDashboard UI is restricted to a small set of IT operator workstations
          to prevent incidental access by other domain users. The underlying JSON API
          remains reachable for service integrations.
        </p>
        <p style={{ lineHeight: 1.6, color: '#888', fontSize: 13 }}>
          Ask the dashboard operator to add your IP via Settings → Dashboard UI access.
        </p>
      </div>
    </div>
  );
}
