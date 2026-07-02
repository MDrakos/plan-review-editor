'use strict';

// Zero-dependency markdown renderer tuned for agent plan documents.
// Supports headings, paragraphs, hr, blockquotes, nested lists (with task
// checkboxes), fenced code, tables, and inline code/bold/italic/links.
// Deliberately not full CommonMark — plans don't need it.

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  return out;
}

function renderFence(lang, body) {
  if (lang === 'choice') return renderChoice(body);
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<pre><code${cls}>${escapeHtml(body)}</code></pre>`;
}

// A ```choice fence embeds a decision in the document:
//
//   ```choice
//   id: storage
//   prompt: Where should limiter state live?
//   multi: false
//   options:
//     - Redis
//     - In-process
//   ```
function renderChoice(body) {
  const spec = { id: '', prompt: '', multi: false, options: [] };
  let inOptions = false;
  for (const raw of body.split('\n')) {
    const opt = raw.match(/^\s*-\s+(.*)$/);
    if (inOptions && opt) {
      spec.options.push(opt[1].trim());
      continue;
    }
    const kv = raw.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      inOptions = kv[1] === 'options';
      if (kv[1] === 'multi') spec.multi = kv[2].trim() === 'true';
      else if (kv[1] === 'id' || kv[1] === 'prompt') spec[kv[1]] = kv[2].trim();
    }
  }
  if (!spec.id || !spec.options.length) {
    // malformed block: fall back to showing it as code
    return `<pre><code class="language-choice">${escapeHtml(body)}</code></pre>`;
  }
  const type = spec.multi ? 'checkbox' : 'radio';
  const options = spec.options
    .map(
      (o) =>
        `<label class="choice-option"><input type="${type}" name="choice-${escapeHtml(spec.id)}" value="${escapeHtml(o)}"> <span>${inline(o)}</span></label>`
    )
    .join('\n');
  return `<div class="choice-block" data-choice-id="${escapeHtml(spec.id)}" data-multi="${spec.multi}">
<p class="choice-prompt">${inline(spec.prompt || 'Choose:')}</p>
${options}
</div>`;
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function startsBlock(line) {
  return (
    /^#{1,6}\s/.test(line) ||
    /^```/.test(line) ||
    /^\s*([-*+]|\d+\.)\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  );
}

function renderList(items) {
  function build(slice) {
    const base = slice[0].indent;
    const tag = slice[0].ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;
    let idx = 0;
    while (idx < slice.length) {
      const it = slice[idx];
      let j = idx + 1;
      while (j < slice.length && slice[j].indent > base) j++;
      const children = slice.slice(idx + 1, j);
      const task = it.text.match(/^\[( |x)\]\s+(.*)$/i);
      const body = task
        ? `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> ${inline(task[2])}`
        : inline(it.text);
      html += `<li>${body}${children.length ? build(children) : ''}</li>`;
      idx = j;
    }
    return html + `</${tag}>`;
  }
  return build(items);
}

function render(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(renderFence(fence[1], body.join('\n')));
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${render(body.join('\n'))}</blockquote>`);
      continue;
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])
    ) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '')
        rows.push(splitRow(lines[i++]));
      const thead = `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table>${thead}<tbody>${tbody}</tbody></table>`);
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        i++;
      }
      out.push(renderList(items));
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i]))
      para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

module.exports = { render, escapeHtml };
