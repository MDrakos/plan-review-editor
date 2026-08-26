'use strict';

// Zero-dependency markdown renderer tuned for agent plan documents.
// Supports headings, paragraphs, hr, blockquotes, nested lists (with task
// checkboxes), fenced code, tables, and inline code/bold/italic/links.
// Deliberately not full CommonMark — plans don't need it.

const { escapeHtml } = require('./escapehtml');
const { renderFlow } = require('./flow');

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
  if (lang === 'flow') return renderFlow(body);
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
// Parse ONE ```choice fence body into its spec. Shared by renderChoice (which then
// builds HTML) and parseChoiceSpecs (which the server uses to validate a resolve
// against the block's declared options), so the two never disagree about a block.
// `other` (default true) appends a free-text "Other" answer, like the CLI's
// AskUserQuestion; set `other: false` to force a choice from the listed options.
function parseChoiceSpec(body) {
  const spec = { id: '', prompt: '', multi: false, other: true, options: [] };
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
      else if (kv[1] === 'other') spec.other = kv[2].trim() !== 'false';
      else if (kv[1] === 'id' || kv[1] === 'prompt') spec[kv[1]] = kv[2].trim();
    }
  }
  return spec;
}

// Scan a markdown document for every well-formed ```choice fence and return
// { choiceId: { options, multi, other } }. Malformed blocks (no id / no options,
// exactly the ones renderChoice falls back to code on) are skipped. Fence detection
// mirrors renderBlocks so the two never disagree about what counts as a fence.
function parseChoiceSpecs(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^```(\S*)\s*$/);
    if (!fence) {
      i++;
      continue;
    }
    const body = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
    i++; // closing fence
    if (fence[1] !== 'choice') continue;
    const spec = parseChoiceSpec(body.join('\n'));
    // Skip a reserved id like "__proto__": `out[spec.id] = …` would set the map's
    // prototype instead of a real entry, silently corrupting choiceSpecs.
    if (spec.id && spec.id !== '__proto__' && spec.options.length)
      out[spec.id] = { options: spec.options, multi: spec.multi, other: spec.other };
  }
  return out;
}

function renderChoice(body) {
  const spec = parseChoiceSpec(body);
  if (!spec.id || !spec.options.length) {
    // malformed block: fall back to showing it as code
    return `<pre><code class="language-choice">${escapeHtml(body)}</code></pre>`;
  }
  const type = spec.multi ? 'checkbox' : 'radio';
  const name = `choice-${escapeHtml(spec.id)}`;
  const options = spec.options
    .map(
      (o) =>
        `<label class="choice-option"><input type="${type}" name="${name}" value="${escapeHtml(o)}"> <span>${inline(o)}</span></label>`
    )
    .join('\n');
  // The "Other" answer contributes whatever the reviewer types (see bindChoices).
  const other = spec.other
    ? `\n<div class="choice-option choice-other"><label><input type="${type}" name="${name}" value="" data-other="true"> <span>Other</span></label><textarea class="choice-other-text" rows="1" placeholder="Type your own answer…"></textarea></div>`
    : '';
  return `<div class="choice-block" data-choice-id="${escapeHtml(spec.id)}" data-multi="${spec.multi}">
<p class="choice-prompt">${inline(spec.prompt || 'Choose:')}</p>
${options}${other}
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
    let html = '';
    let openTag = null; // the currently open <ul>/<ol>, or null between runs
    let idx = 0;
    while (idx < slice.length) {
      const it = slice[idx];
      let j = idx + 1;
      while (j < slice.length && slice[j].indent > base) j++;
      const children = slice.slice(idx + 1, j);
      // A change of marker type (bullet <-> number) starts a new list, per
      // CommonMark. Close the open run and open the other kind so an ordered
      // item among bullets keeps its number instead of collapsing to a disc.
      const tag = it.ordered ? 'ol' : 'ul';
      if (tag !== openTag) {
        if (openTag) html += `</${openTag}>`;
        html += `<${tag}>`;
        openTag = tag;
      }
      const task = it.text.match(/^\[( |x)\]\s+(.*)$/i);
      // Wrap the task text in a single <span>: the <li> is a flex row
      // ([checkbox][text]), and without the span each text run and inline
      // <code> becomes its own flex item and gets crushed into a narrow
      // word-stacked column.
      const body = task
        ? `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> <span>${inline(task[2])}</span>`
        : inline(it.text);
      html += `<li>${body}${children.length ? build(children) : ''}</li>`;
      idx = j;
    }
    return html + (openTag ? `</${openTag}>` : '');
  }
  return build(items);
}

function render(markdown) {
  return renderBlocks(markdown).join('\n');
}

// Render to an array of top-level block HTML strings (one per paragraph,
// heading, list, table, etc.). Diffing works at this granularity.
function renderBlocks(markdown) {
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
      out.push(`<div class="table-wrap"><table>${thead}<tbody>${tbody}</tbody></table></div>`);
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

  return out;
}

// Wrap blocks in `newBlocks` that aren't present (unchanged) in `prevBlocks`
// in a <div data-changed> highlight container. A multiset match handles
// duplicate blocks; a modified block's text differs from the old one, so it
// counts as changed. Added and changed blocks get wrapped; removed ones simply
// vanish. Wrapping (vs. tagging the block itself) lets the highlight own its
// border/padding without disturbing the inner block's own styling.
function markChanges(prevBlocks, newBlocks) {
  const counts = new Map();
  for (const b of prevBlocks) counts.set(b, (counts.get(b) || 0) + 1);
  return newBlocks
    .map((b) => {
      const c = counts.get(b) || 0;
      if (c > 0) {
        counts.set(b, c - 1);
        return b; // unchanged since last cycle
      }
      return `<div data-changed>${b}</div>`; // new or modified
    })
    .join('\n');
}

// Render `markdown`, highlighting what changed since `prevBlocks` (the block
// array from the previous cycle). Returns { html, blocks }; pass the returned
// `blocks` as `prevBlocks` next time. With no prevBlocks, nothing is marked.
function renderDiff(markdown, prevBlocks) {
  const blocks = renderBlocks(markdown);
  const html = prevBlocks ? markChanges(prevBlocks, blocks) : blocks.join('\n');
  return { html, blocks };
}

// ---------- version diff (add / remove / change) ----------
//
// `markChanges` above is the per-round highlight: it marks added/changed blocks
// only, using order-insensitive multiset matching, and never reports removals.
// The version diff below is the removal-aware counterpart used by "show changes
// since v N". It stays block-level (same granularity — no line/word diff) but
// aligns the two block arrays with an LCS so removed blocks can be slotted back
// in at the position they were dropped. `markChanges` is deliberately left
// untouched so the existing dismissible per-round highlight keeps working
// exactly as before.

// The block's opening tag, including its attributes (e.g. `<p>`,
// `<div class="table-wrap">`, `<div class="choice-block" data-choice-id="x" …>`).
// Used as a "same kind of block" signature: a modified paragraph keeps `<p>`, a
// re-edited choice block keeps the same opening (its id is in the attributes),
// but a table (`<div class="table-wrap">`) and a choice (`<div class="choice-block"…>`)
// differ — so cross-kind blocks are never mistaken for an edit of one another.
function blockKind(block) {
  const s = String(block);
  const gt = s.indexOf('>');
  return gt === -1 ? s : s.slice(0, gt + 1);
}

// A lone `remove` immediately followed by a lone `add` of the same kind is a
// modified block, not an unrelated delete + insert — collapse the pair into a
// single `change` op carrying both the old and new block. Kept deliberately
// conservative: it only fires for an *isolated* remove→add pair (not one buried
// in a run of removes or adds), so churn like "delete A, delete B, add C" stays
// as clean removes + an add rather than a misleading B→C "change". Purely
// presentational — both blocks are still shown either way.
function coalesceChanges(ops) {
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const cur = ops[k];
    const nxt = ops[k + 1];
    const isolated =
      (k === 0 || ops[k - 1].type !== 'remove') &&
      (k + 2 >= ops.length || ops[k + 2].type !== 'add');
    if (
      cur.type === 'remove' &&
      nxt &&
      nxt.type === 'add' &&
      isolated &&
      blockKind(cur.block) === blockKind(nxt.block)
    ) {
      out.push({ type: 'change', block: nxt.block, old: cur.block });
      k++; // consume the paired add
    } else {
      out.push(cur);
    }
  }
  return out;
}

// Align two arrays of rendered block strings with a longest-common-subsequence
// walk (blocks compared by exact string equality) and emit an ordered op list:
// `keep` (unchanged), `add` (only in `to`), `remove` (only in `from`), and,
// after coalescing, `change` (a same-kind block modified in place). Removed
// blocks land at the position they occupied, i.e. between surviving blocks.
function diffBlocks(fromBlocks, toBlocks) {
  const n = fromBlocks.length;
  const m = toBlocks.length;
  // lcs[i][j] = LCS length of fromBlocks[i:] and toBlocks[j:]
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        fromBlocks[i] === toBlocks[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (fromBlocks[i] === toBlocks[j]) {
      ops.push({ type: 'keep', block: toBlocks[j] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'remove', block: fromBlocks[i] });
      i++;
    } else {
      ops.push({ type: 'add', block: toBlocks[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'remove', block: fromBlocks[i++] });
  while (j < m) ops.push({ type: 'add', block: toBlocks[j++] });
  return coalesceChanges(ops);
}

// Render `toMarkdown` annotated against `fromMarkdown`: added/changed blocks and
// (unlike the per-round highlight) removed blocks are all marked. Returns
// { html }. Emits `data-diff="add|remove|change"` wrappers; a change wraps the
// old (removed) block and the new (added) block together.
function renderVersionDiff(fromMarkdown, toMarkdown) {
  const fromBlocks = renderBlocks(fromMarkdown);
  const toBlocks = renderBlocks(toMarkdown);
  const html = diffBlocks(fromBlocks, toBlocks)
    .map((op) => {
      if (op.type === 'add') return `<div data-diff="add">${op.block}</div>`;
      if (op.type === 'remove') return `<div data-diff="remove">${op.block}</div>`;
      if (op.type === 'change')
        return `<div data-diff="change"><div class="diff-removed">${op.old}</div><div class="diff-added">${op.block}</div></div>`;
      return op.block; // keep
    })
    .join('\n');
  return { html };
}

module.exports = { render, renderDiff, renderVersionDiff, escapeHtml, parseChoiceSpecs };
