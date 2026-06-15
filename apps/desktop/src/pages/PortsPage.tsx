import React, { useEffect, useState } from 'react';
import type { PortStatusComputer, PortStatusEntry } from '../api.js';
import { api, timeAgo } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { useI18n } from '../i18n.js';

// Latest per-port availability grid. Rows = monitored PCs, columns = the
// configured port checks (Name:Port). Data comes from the standalone
// port-status probe; "Probe now" refreshes the whole fleet, the per-row "Ping"
// does a live ICMP ping + TCP probe of one PC.

function pcHasClosedPort(pc: PortStatusComputer): boolean {
  return pc.reachable !== false && pc.ports.some((p) => !p.is_open);
}

function lastChecked(pc: PortStatusComputer): string | null {
  let max: string | null = null;
  for (const p of pc.ports) {
    if (max == null || p.checked_at > max) max = p.checked_at;
  }
  return max;
}

export function PortsPage({ onJumpToComputer }: { onJumpToComputer?: (name: string) => void } = {}) {
  const { t } = useI18n();
  const [items, setItems] = useState<PortStatusComputer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [probing, setProbing] = useState(false);
  const [rowBusy, setRowBusy] = useState<Record<number, boolean>>({});
  const [consoleOut, setConsoleOut] = useState<{ name: string; text: string | null; error?: boolean } | null>(null);

  const refresh = () => { api.portStatus().then((r) => setItems(r.items)).catch((e) => setError(String(e))); };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  const probeAll = async () => {
    if (probing) return;
    setProbing(true);
    try {
      await api.portStatusRun();
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  };

  const pingOne = async (pc: PortStatusComputer) => {
    if (rowBusy[pc.id]) return;
    setRowBusy((m) => ({ ...m, [pc.id]: true }));
    // Open the console modal immediately with a "running" placeholder so the
    // operator sees that something is happening (the probe takes a few seconds).
    setConsoleOut({ name: pc.name, text: null });
    try {
      const r = await api.probeComputer(pc.id);
      setConsoleOut({ name: pc.name, text: r.console });
      refresh();
    } catch (e) {
      setConsoleOut({ name: pc.name, text: String(e), error: true });
    } finally {
      setRowBusy((m) => ({ ...m, [pc.id]: false }));
    }
  };

  // Column set = union of configured port checks across PCs, ordered by port.
  const colMap = new Map<string, number>();
  for (const pc of items) for (const p of pc.ports) if (!colMap.has(p.check_name)) colMap.set(p.check_name, p.port);
  const cols = Array.from(colMap.entries()).sort((a, b) => a[1] - b[1]);

  const machines = items.length;
  const offline = items.filter((pc) => pc.reachable === false).length;
  const withIssues = items.filter(pcHasClosedPort).length;

  const filtered = items.filter((pc) => {
    if (onlyIssues && !pcHasClosedPort(pc)) return false;
    if (search) {
      const q = search.toLowerCase();
      return pc.name.toLowerCase().includes(q) || (pc.ip_address ?? '').toLowerCase().includes(q);
    }
    return true;
  });
  // Issues first, then offline, then name.
  const sorted = [...filtered].sort((a, b) => {
    const ai = pcHasClosedPort(a) ? 0 : a.reachable === false ? 2 : 1;
    const bi = pcHasClosedPort(b) ? 0 : b.reachable === false ? 2 : 1;
    return ai - bi || a.name.localeCompare(b.name);
  });

  const cell = (pc: PortStatusComputer, name: string) => {
    if (pc.reachable === false) return <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>—</span>;
    const e: PortStatusEntry | undefined = pc.ports.find((p) => p.check_name === name);
    if (!e) return <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>—</span>;
    return (
      <span
        style={{ color: e.is_open ? 'var(--ok)' : 'var(--critical)', fontSize: 11, fontWeight: 700 }}
        title={`${name}:${e.port} · ${e.is_open ? t('ports.open') : t('ports.closed')}${e.latency_ms != null ? ` · ${e.latency_ms} ms` : ''} · ${timeAgo(e.checked_at)}`}
      >
        {e.is_open ? '●' : '○'}{e.is_open && e.latency_ms != null ? <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}> {e.latency_ms}ms</span> : ''}
      </span>
    );
  };

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('ports.help')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>
          🔌 {t('ports.title')}{' '}
          <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
            ({machines} {t('ports.machines')} · <span style={{ color: withIssues > 0 ? 'var(--critical)' : 'var(--ok)', fontWeight: 700 }}>{withIssues} {t('ports.withIssues')}</span>{offline > 0 ? <> · <span style={{ color: 'var(--warning)' }}>{offline} {t('ports.offline')}</span></> : ''})
          </span>
        </h2>
        <div className="panel-actions filters">
          <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
            {t('ports.onlyIssues')}
          </label>
          <button className="refresh-btn" onClick={probeAll} disabled={probing} style={{ fontWeight: 600 }}>
            {probing ? t('ports.probing') : `⚡ ${t('ports.probeNow')}`}
          </button>
          <button className="refresh-btn" onClick={refresh}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {sorted.length === 0 ? (
          <div className="empty">{items.length === 0 ? t('ports.empty') : t('ports.noMatch')}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 170 }}>{t('ports.computer')}</th>
                <th style={{ width: 120 }}>IP</th>
                {cols.map(([name, port]) => (
                  <th key={name} style={{ textAlign: 'center', width: 70 }} title={`${name}:${port}`}>{name}<br /><span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 10 }}>{port}</span></th>
                ))}
                <th style={{ width: 110 }}>{t('ports.lastCheck')}</th>
                <th style={{ width: 140 }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((pc) => {
                const lc = lastChecked(pc);
                return (
                  <tr key={pc.id} style={pc.reachable === false ? { opacity: 0.55 } : undefined}>
                    <td style={{ fontWeight: 600 }}>
                      {onJumpToComputer ? (
                        <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(pc.name); }} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{pc.name}</a>
                      ) : pc.name}
                      {pc.reachable === false && <span style={{ color: 'var(--warning)', fontSize: 10, marginLeft: 6 }}>{t('ports.offline')}</span>}
                    </td>
                    <td style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'Consolas, monospace' }}>{pc.ip_address ?? '—'}</td>
                    {cols.map(([name]) => (
                      <td key={name} style={{ textAlign: 'center' }}>{cell(pc, name)}</td>
                    ))}
                    <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{lc ? timeAgo(lc) : '—'}</td>
                    <td style={{ fontSize: 11 }}>
                      <button className="refresh-btn" onClick={() => pingOne(pc)} disabled={rowBusy[pc.id]} style={{ padding: '2px 8px', fontSize: 11 }}>
                        {rowBusy[pc.id] ? t('ports.pinging') : `📡 ${t('ports.ping')}`}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {consoleOut && (
        <div
          onClick={() => setConsoleOut(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#0c0c0c', border: '1px solid #333', borderRadius: 6, width: 760, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #333', background: '#1a1a1a' }}>
              <span style={{ color: '#ccc', fontFamily: 'Consolas, monospace', fontSize: 12 }}>📡 ping — {consoleOut.name}</span>
              <button onClick={() => setConsoleOut(null)} style={{ background: 'transparent', border: 'none', color: '#ccc', fontSize: 16, cursor: 'pointer' }}>×</button>
            </div>
            <pre style={{ margin: 0, padding: 14, overflow: 'auto', color: consoleOut.error ? '#ff6b6b' : '#d4d4d4', fontFamily: 'Consolas, monospace', fontSize: 12, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {consoleOut.text ?? `${t('ports.pinging')} ${consoleOut.name} ▌`}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
