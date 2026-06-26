import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.js';

// "Routers" page — the round-trip "router → FTP files → DB → page" surfaced
// read-only, one card per configured router, scaling to however many are set up.
// Shows the FTP file-source freshness (last file time, minutes since the data last
// advanced, parsed lease/ARP counts, last error) plus a device count by source.

type Row = Awaited<ReturnType<typeof api.routersStatus>>[number];

function fmtAgoMin(mins: number | null): string {
  if (mins == null) return '—';
  if (mins < 1) return 'teď';
  if (mins < 60) return `před ${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `před ${h} h` : `před ${Math.floor(h / 24)} dny`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function Badge({ text, color, bg }: { text: string; color: string; bg: string }) {
  return <span style={{ fontSize: 11, fontWeight: 700, color, background: bg, borderRadius: 999, padding: '2px 9px' }}>{text}</span>;
}

function RouterCard({ r }: { r: Row }) {
  const { t } = useI18n();
  // State colour: error/stale = red, fresh FTP = green, REST-only = neutral.
  const bad = r.stale === true || !!r.lastError;
  const good = r.ftp && r.stale === false;
  const accent = bad ? 'var(--critical)' : good ? 'var(--ok)' : 'var(--text-dim)';
  return (
    <div style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderLeft: `4px solid ${accent}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 17, fontWeight: 700 }}>{r.site}</span>
        <span style={{ color: 'var(--text-dim)', fontFamily: 'Consolas, monospace', fontSize: 13 }}>{r.ip}</span>
        <span style={{ flex: 1 }} />
        {r.ftp
          ? <Badge text="FTP" color="#fff" bg="var(--ok)" />
          : <Badge text={t('net.restOnly')} color="var(--text-dim)" bg="var(--surface-hover)" />}
        {r.muted && <Badge text={t('net.muted')} color="#92400e" bg="#fef3c7" />}
        {bad
          ? <Badge text={t('net.stale')} color="#fff" bg="var(--critical)" />
          : r.ftp && <Badge text={t('net.fresh')} color="#fff" bg="var(--ok)" />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('net.lastData')}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: accent }}>{fmtAgoMin(r.minsSinceChange)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{fmtTime(r.leaseFileTime)}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('net.parsed')}</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{r.ftp ? `${r.leaseCount ?? '—'} / ${r.arpCount ?? '—'}` : '—'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('net.leasesArp')}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('net.devices')}</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{r.devices}</div>
          {r.bySource && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>dhcp {r.bySource.dhcp} · arp {r.bySource.arp} · scan {r.bySource.scan}{r.bySource.unifi ? ` · unifi ${r.bySource.unifi}` : ''}</div>}
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('net.fetched')}</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{fmtTime(r.fetchedAt)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{r.ftp ? t('net.viaFtp') : t('net.viaRest')}</div>
        </div>
      </div>

      {r.lastError && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--critical)', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 10px' }}>
          ⚠ {r.lastError}
        </div>
      )}
    </div>
  );
}

export function NetworkPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.routersStatus()
      .then((r) => { setRows(r); setErr(null); })
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <div style={{ padding: 20, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>{t('net.title')}</h2>
        <button className="refresh-btn" onClick={load} disabled={loading}>{loading ? '…' : `🔄 ${t('net.refresh')}`}</button>
      </div>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '0 0 16px' }}>{t('net.subtitle')}</p>

      {err && <div style={{ color: 'var(--critical)', marginBottom: 12 }}>⚠ {err}</div>}
      {!loading && rows.length === 0 && !err && <div style={{ color: 'var(--text-dim)' }}>{t('net.none')}</div>}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {rows.map((r) => <RouterCard key={r.site} r={r} />)}
      </div>
    </div>
  );
}
