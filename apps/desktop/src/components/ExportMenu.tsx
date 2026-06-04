import React, { useState, useEffect, useRef } from 'react';

export interface ExportColumn<T> {
  key: string;
  label: string;
  get: (row: T) => string | number | boolean | null | undefined;
}

export interface ExportMenuProps<T> {
  rows: T[];
  columns: ExportColumn<T>[];
  title: string;
  filterSummary: string;
  filenameBase: string;
}

function escapeCsvCell(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCSV<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const header = columns.map((c) => escapeCsvCell(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => escapeCsvCell(c.get(r))).join(','));
  // Excel-friendly BOM so diacritics open correctly
  return '﻿' + [header, ...lines].join('\r\n');
}

function toTSV<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const header = columns.map((c) => c.label).join('\t');
  const lines = rows.map((r) =>
    columns.map((c) => {
      const v = c.get(r);
      return v == null ? '' : String(v).replace(/[\t\r\n]+/g, ' ');
    }).join('\t'),
  );
  return [header, ...lines].join('\r\n');
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toHTML<T>(rows: T[], columns: ExportColumn<T>[], title: string, filterSummary: string): string {
  const now = new Date().toLocaleString();
  const cells = rows
    .map(
      (r) =>
        '<tr>' +
        columns
          .map((c) => {
            const v = c.get(r);
            return '<td>' + htmlEscape(v == null ? '' : String(v)) + '</td>';
          })
          .join('') +
        '</tr>',
    )
    .join('\n');
  return `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>
  body { font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 6px 0; }
  .meta { color: #6b7280; font-size: 11px; margin-bottom: 16px; }
  .banner { background: #fff7ed; border: 1px solid #fb923c; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; font-size: 12px; color: #7c2d12; }
  .banner strong { color: #9a3412; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #f3f4f6; text-align: left; padding: 6px 8px; border-bottom: 2px solid #d1d5db; font-weight: 600; }
  td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; word-break: break-word; }
  tr:nth-child(even) td { background: #fafafa; }
  @media print {
    body { margin: 12mm; }
    .banner { background: #fff; }
    thead { display: table-header-group; }
  }
</style>
</head>
<body>
<h1>${htmlEscape(title)}</h1>
<div class="meta">ITDashboard export — ${htmlEscape(now)} — ${rows.length} řádků</div>
${filterSummary ? `<div class="banner">⚠ <strong>Filtrováno:</strong> ${htmlEscape(filterSummary)}</div>` : '<div class="meta">Bez aktivního filtru (úplný snapshot zobrazené tabulky).</div>'}
<table>
<thead><tr>${columns.map((c) => '<th>' + htmlEscape(c.label) + '</th>').join('')}</tr></thead>
<tbody>
${cells}
</tbody>
</table>
</body></html>`;
}

function downloadBlob(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPDF<T>(rows: T[], columns: ExportColumn<T>[], title: string, filterSummary: string): void {
  const html = toHTML(rows, columns, title, filterSummary);
  const w = window.open('', '_blank', 'width=1024,height=720');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Allow rendering before triggering print
  setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {
      /* user can print manually */
    }
  }, 250);
}

export function ExportMenu<T>({ rows, columns, title, filterSummary, filenameBase }: ExportMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const exportAs = (format: 'csv' | 'tsv' | 'html' | 'pdf') => {
    setOpen(false);
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
    const base = `itdashboard-${filenameBase}-${ts}${filterSummary ? '-filtered' : ''}`;
    if (format === 'csv') return downloadBlob(`${base}.csv`, toCSV(rows, columns), 'text/csv;charset=utf-8');
    if (format === 'tsv') return downloadBlob(`${base}.txt`, toTSV(rows, columns), 'text/plain;charset=utf-8');
    if (format === 'html') return downloadBlob(`${base}.html`, toHTML(rows, columns, title, filterSummary), 'text/html;charset=utf-8');
    if (format === 'pdf') return exportPDF(rows, columns, title, filterSummary);
  };

  const itemStyle: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '6px 10px', fontSize: 12, background: 'transparent',
    color: 'var(--text)', border: 'none', cursor: 'pointer',
    fontFamily: 'inherit',
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="refresh-btn"
        onClick={() => setOpen((o) => !o)}
        style={{ padding: '4px 10px', fontSize: 11 }}
        title="Export aktuálně zobrazené tabulky (respektuje filtry)"
      >
        📤 Export ({rows.length})
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4,
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: 4,
            zIndex: 100, minWidth: 170,
            boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
          }}
        >
          <button style={itemStyle} onClick={() => exportAs('pdf')}>🖨 PDF / Tisk</button>
          <button style={itemStyle} onClick={() => exportAs('html')}>🌐 HTML</button>
          <button style={itemStyle} onClick={() => exportAs('csv')}>📊 CSV (Excel)</button>
          <button style={itemStyle} onClick={() => exportAs('tsv')}>📝 TXT (Tab)</button>
        </div>
      )}
    </div>
  );
}
