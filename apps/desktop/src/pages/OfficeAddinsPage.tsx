import React, { useEffect, useState } from 'react';
import type { OfficeAddinRow, OfficeAddinsResult } from '../api.js';
import { api, timeAgo } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { ExportMenu, type ExportColumn } from '../components/ExportMenu.js';
import { useSort, SortHeader, useSortedItems } from '../lib/useSort.jsx';
import { useI18n } from '../i18n.js';

// Zakázané doplňky Office napříč flotilou.
//
// Office si po pádu doplněk sám vypne a nikam to nenahlásí — uživateli pak tiše
// nefunguje Teams v Outlooku nebo M-Files ve Wordu a nikdo o tom neví, dokud si
// nestěžuje. Tahle stránka je ten seznam, který dřív neexistoval.
//
// Doplněk vs. dokument: DisabledItems drží obojí (Office si zapisuje i soubor, na
// kterém spadl). Dokument není provozní problém, jen historie jednoho pádu, takže
// se defaultně nezobrazuje a nikde se nepočítá — ale jde si ho zobrazit.

const isAddin = (r: OfficeAddinRow) => r.item_kind !== 'document';

// Ikona podle aplikace — v seznamu je potřeba na první pohled poznat, jestli je
// rozbitý Outlook nebo Word; "Office" samo o sobě operátorovi nestačí.
const APP_ICON: Record<string, string> = {
  Excel: '🟩', Word: '🟦', Outlook: '🟧', PowerPoint: '🟥',
};

export function OfficeAddinsPage({ onJumpToComputer }: { onJumpToComputer?: (name: string) => void } = {}) {
  const { t } = useI18n();
  const [data, setData] = useState<OfficeAddinsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [appFilter, setAppFilter] = useState<string>('');
  const [showDocs, setShowDocs] = useState(false);
  const [scanning, setScanning] = useState(false);
  const { sort, toggle } = useSort<OfficeAddinRow>({ col: 'computer_name', dir: 'asc' });

  const refresh = () => { api.officeAddins().then(setData).catch((e) => setError(String(e))); };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  const runScan = async () => {
    setScanning(true);
    try { await api.officeAddinsScan(); } catch (e) { setError(String(e)); }
    // Sweep běží minuty na pozadí; tlačítko se jen odemkne, data si vezme interval.
    setTimeout(() => setScanning(false), 3000);
  };

  const all = data?.items ?? [];
  const addins = all.filter(isAddin);
  const docs = all.filter((r) => !isAddin(r));
  const shown = showDocs ? all : addins;

  const filtered = shown.filter((r) => {
    if (appFilter && r.office_app !== appFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (r.addin_name ?? '').toLowerCase().includes(q)
        || (r.addin_path ?? '').toLowerCase().includes(q)
        || r.computer_name.toLowerCase().includes(q)
        || (r.user_account ?? '').toLowerCase().includes(q)
        || r.office_app.toLowerCase().includes(q);
    }
    return true;
  });
  // NAV nahoru (známý dopad), pak podle aktivního řazení.
  const base = useSortedItems(filtered, sort);
  const sorted = [...base].sort((a, b) => Number(b.is_nav) - Number(a.is_nav));

  const byApp = (app: string) => addins.filter((r) => r.office_app === app).length;
  const pcs = new Set(addins.map((r) => r.computer_id)).size;
  const sum = data?.summary;

  const exportColumns: ExportColumn<OfficeAddinRow>[] = [
    { key: 'computer_name', label: 'Computer', get: (r) => r.computer_name },
    { key: 'user_account', label: 'User', get: (r) => r.user_account ?? r.user_sid },
    { key: 'office_app', label: 'Application', get: (r) => r.office_app },
    { key: 'office_version', label: 'Office version', get: (r) => r.office_version },
    { key: 'item_kind', label: 'Kind', get: (r) => r.item_kind ?? '' },
    { key: 'addin_name', label: 'Add-in', get: (r) => r.addin_name ?? '' },
    { key: 'addin_path', label: 'Path', get: (r) => r.addin_path ?? '' },
    { key: 'is_nav', label: 'NAV', get: (r) => (r.is_nav ? 'yes' : 'no') },
    { key: 'scanned_at', label: 'Scanned', get: (r) => r.scanned_at ?? '' },
  ];

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
      <div style={{ padding: 12 }}>
        <HelpBox title={t('help.tabTitle')}>
          <p>{t('officeaddins.help')}</p>
        </HelpBox>
      </div>
      <div className="panel-header">
        <h2>
          🧩 {t('officeaddins.title')}{' '}
          <span style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 400 }}>
            (<span style={{ color: addins.length > 0 ? 'var(--warning)' : 'var(--ok)', fontWeight: 700 }}>{addins.length} {t('officeaddins.addins')}</span>
            {' · '}{pcs} {t('officeaddins.pcs')}
            {sum ? <> · {sum.scannedPcs} {t('officeaddins.scanned')}</> : null}
            {sum && sum.noUserPcs > 0 ? <> · <span style={{ color: 'var(--text-dim)' }} title={t('officeaddins.noUsersTip')}>{sum.noUserPcs} {t('officeaddins.noUsers')}</span></> : null}
            {sum && sum.errorPcs > 0 ? <> · <span style={{ color: 'var(--critical)' }} title={t('officeaddins.errorTip')}>{sum.errorPcs} {t('officeaddins.errors')}</span></> : null})
          </span>
        </h2>
        <div className="panel-actions filters">
          <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
          <select value={appFilter} onChange={(e) => setAppFilter(e.target.value)} title={t('officeaddins.appFilterTip')}>
            <option value="">{t('officeaddins.allApps')}</option>
            {['Outlook', 'Word', 'Excel', 'PowerPoint'].map((a) => (
              <option key={a} value={a}>{APP_ICON[a]} {a} ({byApp(a)})</option>
            ))}
          </select>
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }} title={t('officeaddins.showDocsTip')}>
            <input type="checkbox" checked={showDocs} onChange={(e) => setShowDocs(e.target.checked)} />
            {t('officeaddins.showDocs')} ({docs.length})
          </label>
          <ExportMenu rows={sorted} columns={exportColumns} title="ITDashboard — Zakázané doplňky Office" filterSummary={[search ? `search="${search}"` : '', appFilter ? `app=${appFilter}` : '', showDocs ? 'incl-documents' : 'addins-only'].filter(Boolean).join(' AND ')} filenameBase="office-addins" />
          <button className="refresh-btn" onClick={runScan} disabled={scanning} title={t('officeaddins.scanTip')}>
            {scanning ? '…' : `⟳ ${t('officeaddins.scan')}`}
          </button>
          <button className="refresh-btn" onClick={refresh} title={t('officeaddins.reloadTip')}>↻</button>
        </div>
      </div>
      <div className="panel-body">
        {error && <div style={{ color: 'var(--critical)', padding: 8 }}>⚠ {error}</div>}
        {data && !data.enabled && (
          <div style={{ color: 'var(--warning)', fontSize: 11, padding: '6px 8px' }} title={t('officeaddins.disabledTip')}>
            ⚠ {t('officeaddins.disabledBanner')}
          </div>
        )}
        {sorted.length === 0 ? (
          <div className="empty">{all.length === 0 ? t('officeaddins.empty') : t('officeaddins.noMatch')}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <SortHeader<OfficeAddinRow> col="office_app" label={t('officeaddins.col.app')} sort={sort} toggle={toggle} width={120} />
                <SortHeader<OfficeAddinRow> col="addin_name" label={t('officeaddins.col.addin')} sort={sort} toggle={toggle} />
                <SortHeader<OfficeAddinRow> col="computer_name" label={t('officeaddins.col.pc')} sort={sort} toggle={toggle} width={160} />
                <SortHeader<OfficeAddinRow> col="user_account" label={t('officeaddins.col.user')} sort={sort} toggle={toggle} width={180} />
                <th title={t('officeaddins.col.pathTip')}>{t('officeaddins.col.path')}</th>
                <SortHeader<OfficeAddinRow> col="scanned_at" label={t('officeaddins.col.scanned')} sort={sort} toggle={toggle} width={100} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} style={{ opacity: isAddin(r) ? 1 : 0.55 }}>
                  <td style={{ fontSize: 11 }}>
                    <span style={{ fontWeight: 600 }}>{APP_ICON[r.office_app] ?? '·'} {r.office_app}</span>
                    <span style={{ color: 'var(--text-dim)', marginLeft: 5 }}>{r.office_version}</span>
                  </td>
                  <td style={{ fontSize: 11, fontWeight: 600 }}>
                    {r.is_nav && <span style={{ color: 'var(--critical)', marginRight: 5 }} title={t('officeaddins.navTip')}>⚠ NAV</span>}
                    {!isAddin(r) && <span style={{ color: 'var(--text-dim)', marginRight: 5 }} title={t('officeaddins.docTip')}>📄 {t('officeaddins.doc')}</span>}
                    {r.addin_name || '—'}
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    {onJumpToComputer ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); onJumpToComputer(r.computer_name); }} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{r.computer_name}</a>
                    ) : r.computer_name}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }} title={r.user_sid}>{r.user_account ?? r.user_sid}</td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 10, fontFamily: 'Consolas, monospace', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.addin_path ?? ''}>
                    {r.addin_path ?? '—'}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.scanned_at ? timeAgo(r.scanned_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
