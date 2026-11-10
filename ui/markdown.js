// Small, safe Markdown rendering. Everything is HTML-escaped first, so text
// from Gemini can never inject markup or script into the app.

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PH = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_ \-]{0,60}?)\s*\}\}/g;

function inline(src) {
  return src.split(/(`[^`\n]+`)/g).map((part) => {
    if (/^`[^`\n]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
    let t = esc(part);
    t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w_])/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="#" class="ext" data-href="$2">$1</a>');
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, '$1<a href="#" class="ext" data-href="$2">$2</a>');
    t = t.replace(PH, '<span class="ph">{{$1}}</span>');
    return t;
  }).join('');
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function parseList(lines, start) {
  const base = lines[start].match(/^\s*/)[0].length;
  const ordered = /^\s*\d+[.)]/.test(lines[start]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      const next = lines[i + 1];
      const nm = next && next.match(LIST_RE);
      if (nm && nm[1].length >= base) { i++; continue; }
      break;
    }
    const ind = line.match(/^\s*/)[0].length;
    const m = line.match(LIST_RE);
    if (m && ind <= base + 1 && ind >= base - 1) {
      if (/^\d/.test(m[2]) !== ordered) break; // "-" list followed by "1." list: a new list

      items.push({ text: m[3], kids: [] });
      i++;
      continue;
    }
    if (ind > base + 1 && items.length) {
      if (m) {
        const sub = parseList(lines, i);
        items[items.length - 1].kids.push(sub.html);
        i = sub.next;
      } else {
        items[items.length - 1].text += '\n' + line.trim();
        i++;
      }
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const first = ordered ? parseInt(lines[start].trim(), 10) : 1;
  const startAttr = ordered && first > 1 ? ` start="${first}"` : '';
  const body = items.map((it) => {
    let txt = it.text;
    let box = '';
    const cb = txt.match(/^\[([ xX])\]\s+/);
    if (cb) { box = cb[1] === ' ' ? '<span class="cb">☐</span> ' : '<span class="cb on">☑</span> '; txt = txt.slice(cb[0].length); }
    return `<li>${box}${txt.split('\n').map(inline).join('<br>')}${it.kids.join('')}</li>`;
  }).join('');
  return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: i };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let para = [];
  const flush = () => {
    if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (m) {
      flush();
      const fence = m[1];
      const lang = m[2];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) { buf.push(lines[i]); i++; }
      i++;
      html += `<div class="codeblock"><div class="code-head"><span>${esc(lang || 'code')}</span><button type="button" class="code-copy">Copy</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) { flush(); const lvl = m[1].length; html += `<h${lvl}>${inline(m[2])}</h${lvl}>`; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html += '<hr>'; i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      html += '<div class="table-wrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>';
      continue;
    }
    if (LIST_RE.test(line)) { flush(); const res = parseList(lines, i); html += res.html; i = res.next; continue; }
    para.push(line);
    i++;
  }
  flush();
  return html;
}

// ------------------------------------------------- prompt "source" highlight

function hlInline(s, fills) {
  let t = esc(s);
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<span class="hp-mark">**</span><b>$1</b><span class="hp-mark">**</span>');
  t = t.replace(/&lt;(\/?)([A-Za-z_][\w-]*)&gt;/g, '<span class="hp-tag">&lt;$1$2&gt;</span>');
  t = t.replace(/`([^`\n]+)`/g, '<span class="hp-code">`$1`</span>');
  // Blanks last, so a filled-in value is shown exactly as typed.
  t = t.replace(PH, (all, name) => {
    const key = name.trim();
    const v = fills && fills[key] && fills[key].trim();
    return v
      ? `<span class="ph filled" title="{{${esc(key)}}}">${esc(v)}</span>`
      : `<span class="ph">{{${key}}}</span>`;
  });
  return t;
}

/** The prompt shown exactly as it will be copied, with light highlighting. */
export function highlightPrompt(text, fills) {
  let inFence = false;
  return String(text || '').split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return `<span class="hp-fence">${esc(line)}</span>`; }
    if (inFence) return `<span class="hp-codeline">${esc(line)}</span>`;
    let m = line.match(/^(#{1,6}\s+)(.*)$/);
    if (m) return `<span class="hp-h"><span class="hp-mark">${esc(m[1])}</span>${hlInline(m[2], fills)}</span>`;
    m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
    if (m) return `${m[1]}<span class="hp-li">${esc(m[2])}</span>${m[3]}${hlInline(m[4], fills)}`;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return `<span class="hp-mark">${esc(line)}</span>`;
    m = line.match(/^(\s*(?:Prompt|Negative prompt|Settings|Aspect ratio|Shot \d+[^:]*)\s*:)(.*)$/i);
    if (m) return `<span class="hp-label">${esc(m[1])}</span>${hlInline(m[2], fills)}`;
    return hlInline(line, fills);
  }).join('\n');
}
