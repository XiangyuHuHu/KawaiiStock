function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { meta: {}, body: text };
  const block = text.slice(4, end).replace(/\r/g, '');
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}

function inline(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

export function renderMarkdown(raw) {
  const lines = String(raw ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i]);
        i += 1;
      }
      const parsed = rows
        .filter((row, idx) => idx !== 1)
        .map((row) => row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
      const head = parsed[0] ?? [];
      const body = parsed.slice(1);
      out.push('<div class="md-table-wrap"><table>');
      out.push('<thead><tr>' + head.map((cell) => `<th>${inline(cell)}</th>`).join('') + '</tr></thead>');
      out.push('<tbody>');
      for (const row of body) {
        out.push('<tr>' + row.map((cell) => `<td>${inline(cell)}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table></div>');
      continue;
    }
    if (line.startsWith('> ')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        buf.push(lines[i].slice(2));
        i += 1;
      }
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^[-*] /.test(line)) {
      const buf = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^[-*] /, ''))}</li>`);
        i += 1;
      }
      out.push(`<ul>${buf.join('')}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const buf = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\d+\. /, ''))}</li>`);
        i += 1;
      }
      out.push(`<ol>${buf.join('')}</ol>`);
      continue;
    }
    if (line.startsWith('### ')) {
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
      i += 1;
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
      i += 1;
      continue;
    }
    if (line.startsWith('# ')) {
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
      i += 1;
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }
  return out.join('\n');
}

export function extractSection(body, heading) {
  const text = String(body ?? '').replace(/\r/g, '');
  const pattern = new RegExp(`^## ${heading}\\s*$`, 'm');
  const match = pattern.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}
