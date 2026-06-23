// Minimal, dependency-free Markdown → self-contained HTML renderer for the
// oponentura document. Handles the constructs the doc actually uses: ATX headings,
// pipe tables, ordered/unordered lists, blockquotes, --- rules, fenced code,
// **bold**, *italic*, `code`, and paragraphs. Good enough for a print-ready,
// offline-openable artifact (no CDN, no build step).
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('./oponentura.md', import.meta.url), 'utf8');
const lines = src.replace(/\r\n/g, '\n').split('\n');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  // order matters: escape first, then re-introduce markup
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

const out = [];
let i = 0;
let slug = 0;
const toc = [];
while (i < lines.length) {
  const line = lines[i];

  // fenced code
  if (/^```/.test(line)) {
    const buf = [];
    i++;
    while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
    i++;
    out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
    continue;
  }
  // heading
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) {
    const lvl = h[1].length;
    const id = 's' + (slug++);
    if (lvl <= 3) toc.push({ lvl, id, text: h[2].replace(/[*`]/g, '') });
    out.push(`<h${lvl} id="${id}">${inline(h[2])}</h${lvl}>`);
    i++;
    continue;
  }
  // hr
  if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
  // table (header row + separator)
  if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
    const cells = (r) => r.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim());
    const head = cells(line);
    i += 2;
    const rows = [];
    while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
    let t = '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (const r of rows) t += '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
    t += '</tbody></table>';
    out.push(t);
    continue;
  }
  // blockquote
  if (/^>\s?/.test(line)) {
    const buf = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
    out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    continue;
  }
  // unordered list
  if (/^\s*[-*]\s+/.test(line)) {
    const buf = [];
    while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i++; }
    out.push('<ul>' + buf.join('') + '</ul>');
    continue;
  }
  // ordered list
  if (/^\s*\d+\.\s+/.test(line)) {
    const buf = [];
    while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`); i++; }
    out.push('<ol>' + buf.join('') + '</ol>');
    continue;
  }
  // blank
  if (/^\s*$/.test(line)) { i++; continue; }
  // paragraph (gather until blank)
  const buf = [];
  while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|>\s?|\||```|---\s*$|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) {
    buf.push(lines[i]); i++;
  }
  if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
  else i++;
}

const tocHtml = '<nav class="toc"><h2>Obsah dokumentu</h2><ul>' +
  toc.filter((t) => t.lvl <= 2).map((t) => `<li class="l${t.lvl}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('') +
  '</ul></nav>';

const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ITDashboard — oponentura</title>
<style>
:root{--ink:#1a1a1a;--dim:#555;--line:#ddd;--accent:#0b5cad;--bg:#fff;--code:#f4f4f6}
*{box-sizing:border-box}
body{font-family:"Segoe UI",Calibri,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.55;max-width:900px;margin:0 auto;padding:32px 28px}
h1{font-size:1.9rem;border-bottom:3px solid var(--accent);padding-bottom:.3em;margin-top:1.8em;page-break-before:always}
h1:first-of-type{page-break-before:avoid}
h2{font-size:1.4rem;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:.2em;margin-top:1.6em}
h3{font-size:1.12rem;margin-top:1.3em}
h4{font-size:1rem;color:var(--dim)}
p{margin:.6em 0}
code{background:var(--code);padding:.1em .35em;border-radius:3px;font-family:Consolas,monospace;font-size:.9em}
pre{background:var(--code);padding:12px 14px;border-radius:6px;overflow-x:auto;border:1px solid var(--line)}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92em}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:#eef3f8}
blockquote{border-left:4px solid var(--accent);margin:1em 0;padding:.4em 1em;background:#f7f9fb;color:var(--dim)}
hr{border:none;border-top:1px solid var(--line);margin:1.5em 0}
a{color:var(--accent)}
.toc{background:#f7f9fb;border:1px solid var(--line);border-radius:8px;padding:14px 20px;margin:1.5em 0}
.toc ul{list-style:none;padding-left:0;columns:2;column-gap:32px}
.toc li.l1{font-weight:600;margin-top:.5em;break-inside:avoid}
.toc li.l2{padding-left:1em;font-size:.92em}
.toc a{text-decoration:none}
@media print{body{max-width:none;padding:0}a{color:inherit;text-decoration:none}}
</style></head><body>
${out[0] || ''}
${tocHtml}
${out.slice(1).join('\n')}
</body></html>`;

writeFileSync(new URL('./oponentura.html', import.meta.url), html, 'utf8');
console.log('oponentura.html written:', html.length, 'bytes,', toc.length, 'headings');
