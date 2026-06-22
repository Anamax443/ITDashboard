import type { DeviceItem } from '../api.js';

// Self-contained "managerial" report for the Devices tab: pie charts (by category,
// by site, online/offline) + summary counts, rendered as a standalone HTML doc and
// opened in a print window (→ PDF). No chart library — inline SVG.

const PALETTE = ['#4a9eff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#1abc9c', '#e67e22', '#7d8590', '#ec4899', '#22d3ee', '#84cc16', '#fb923c'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Slice { label: string; value: number; color: string; }

function pieSvg(data: Slice[], size = 170): string {
  const slices = data.filter((d) => d.value > 0);
  const total = slices.reduce((s, d) => s + d.value, 0);
  const r = size / 2 - 2, cx = size / 2, cy = size / 2;
  if (total === 0) return `<svg width="${size}" height="${size}"></svg>`;
  if (slices.length === 1) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${slices[0]!.color}"/></svg>`;
  }
  let a = -Math.PI / 2;
  const paths = slices.map((d) => {
    const ang = (d.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(a), y1 = cy + r * Math.sin(a);
    a += ang;
    const x2 = cx + r * Math.cos(a), y2 = cy + r * Math.sin(a);
    const large = ang > Math.PI ? 1 : 0;
    return `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${d.color}" stroke="#fff" stroke-width="1"/>`;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}</svg>`;
}

function legend(data: Slice[], total: number): string {
  return '<table class="legend">' + data.filter((d) => d.value > 0)
    .map((d) => `<tr><td><span class="sw" style="background:${d.color}"></span>${esc(d.label)}</td><td class="num">${d.value}</td><td class="num dim">${total ? Math.round((d.value / total) * 100) : 0}%</td></tr>`)
    .join('') + '</table>';
}

function countBy(rows: DeviceItem[], keyOf: (d: DeviceItem) => string): Slice[] {
  const m = new Map<string, number>();
  for (const d of rows) { const k = keyOf(d); m.set(k, (m.get(k) ?? 0) + 1); }
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({ label, value, color: PALETTE[i % PALETTE.length]! }));
}

function chartBlock(title: string, slices: Slice[]): string {
  const total = slices.reduce((s, d) => s + d.value, 0);
  return `<div class="chart"><h3>${esc(title)}</h3><div class="chart-row">${pieSvg(slices)}${legend(slices, total)}</div></div>`;
}

export interface ReportTableColumn { label: string; get: (r: DeviceItem) => string | number | boolean | null | undefined; }

export interface DeviceReportOpts {
  rows: DeviceItem[];
  catLabel: (k: string) => string;
  reachOf: (d: DeviceItem) => boolean | null;
  filterSummary: string;
  uncategorizedLabel: string;
  now: string;
  tableColumns: ReportTableColumn[];
  listTitle: string;
}

export function buildDeviceReportHtml(opts: DeviceReportOpts): string {
  const { rows, catLabel, reachOf, filterSummary, uncategorizedLabel, now, tableColumns, listTitle } = opts;

  const byCategory = countBy(rows, (d) => d.category ? catLabel(d.category) : uncategorizedLabel);
  const bySite = countBy(rows, (d) => d.site || '—');
  // Online / offline / unknown with fixed colours.
  const on = rows.filter((d) => reachOf(d) === true).length;
  const off = rows.filter((d) => reachOf(d) === false).length;
  const unk = rows.length - on - off;
  const reach: Slice[] = [
    { label: 'Online', value: on, color: '#3fb950' },
    { label: 'Offline', value: off, color: '#f85149' },
    { label: '? neznámé', value: unk, color: '#7d8590' },
  ];

  const total = rows.length;
  const identified = rows.filter((d) => d.category).length;
  const inAd = rows.filter((d) => d.computer_id != null).length;
  const usbPrinters = rows.filter((d) => d.source === 'share').length;
  const netPrinters = rows.filter((d) => d.category === 'printer' && d.source !== 'share').length;
  const cards = [
    { k: 'Zařízení celkem', v: total },
    { k: 'Identifikováno', v: identified },
    { k: 'Neidentifikováno', v: total - identified },
    { k: 'Tiskárny síťové', v: netPrinters },
    { k: 'Tiskárny USB', v: usbPrinters },
    { k: 'Online', v: on },
    { k: 'Offline', v: off },
    { k: 'V AD', v: inAd },
    { k: 'Lokalit', v: bySite.length },
  ].map((c) => `<div class="card"><div class="cv">${c.v}</div><div class="ck">${esc(c.k)}</div></div>`).join('');

  const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>Report zařízení</title>
<style>
  body{font:13px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2937;margin:24px;}
  h1{font-size:20px;margin:0 0 4px;} .meta{color:#6b7280;font-size:11px;margin-bottom:14px;}
  .banner{background:#fff7ed;border:1px solid #fb923c;padding:8px 12px;border-radius:4px;margin-bottom:16px;font-size:12px;color:#7c2d12;}
  .cards{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:22px;}
  .card{border:1px solid #e5e7eb;border-radius:8px;padding:10px 16px;min-width:110px;}
  .cv{font-size:24px;font-weight:700;} .ck{font-size:11px;color:#6b7280;}
  .charts{display:flex;flex-wrap:wrap;gap:28px;}
  .chart h3{font-size:13px;margin:0 0 8px;} .chart-row{display:flex;align-items:flex-start;gap:14px;}
  table.legend{border-collapse:collapse;font-size:12px;} .legend td{padding:2px 6px;} .legend .num{text-align:right;} .legend .dim{color:#6b7280;}
  .sw{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:6px;vertical-align:-1px;}
  .list-h{font-size:15px;margin:26px 0 8px;}
  table.list{width:100%;border-collapse:collapse;font-size:11px;}
  table.list th{background:#f3f4f6;text-align:left;padding:5px 7px;border-bottom:2px solid #d1d5db;}
  table.list td{padding:4px 7px;border-bottom:1px solid #e5e7eb;word-break:break-word;}
  table.list tr:nth-child(even) td{background:#fafafa;}
  @page{size:A4;margin:10mm;}
  @media print{body{margin:0;} .banner{background:#fff;} .charts{gap:14px;} .chart{break-inside:avoid;} .card{break-inside:avoid;}}
</style></head><body>
<h1>📊 Report zařízení v síti</h1>
<div class="meta">ITDashboard — ${esc(now)} — ${total} zařízení</div>
${filterSummary ? `<div class="banner">⚠ <strong>Filtrováno:</strong> ${esc(filterSummary)}</div>` : ''}
<div class="cards">${cards}</div>
<div class="charts">
  ${chartBlock('Podle kategorie', byCategory)}
  ${chartBlock('Podle lokality', bySite)}
  ${chartBlock('Dostupnost', reach)}
</div>
<h2 class="list-h">${esc(listTitle)}</h2>
<table class="list">
<thead><tr><th>#</th>${tableColumns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td>${tableColumns.map((c) => { const v = c.get(r); return `<td>${esc(v == null ? '' : String(v))}</td>`; }).join('')}</tr>`).join('')}</tbody>
</table>
</body></html>`;

  return html;
}

export function openDeviceReport(opts: DeviceReportOpts): void {
  const w = window.open('', '_blank', 'width=1100,height=800');
  if (!w) return;
  w.document.open(); w.document.write(buildDeviceReportHtml(opts)); w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* manual print */ } }, 300);
}
