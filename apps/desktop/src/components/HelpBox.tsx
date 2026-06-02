import React, { useState } from 'react';

export function HelpBox({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 8, padding: open ? 12 : '6px 10px',
      marginBottom: 8, fontSize: 12, borderLeft: '3px solid var(--accent)',
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'transparent', color: 'var(--accent)', border: 'none',
          cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
        }}
      >
        {open ? '▼' : '▶'} ℹ {title}
      </button>
      {open && (
        <div style={{ marginTop: 8, color: 'var(--text)', lineHeight: 1.5 }}>
          {children}
        </div>
      )}
    </div>
  );
}
