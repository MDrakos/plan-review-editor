'use strict';

// The code-review UI: a git diff you can read inline or side-by-side, comment on
// line by line, and hand back to the agent — the same review loop the plan side
// runs (server/server.js), pointed at the repo instead of a document.
//
// The server ships the diff as DATA (files → hunks → lines, both sides' numbers,
// annotated with what moved since the previous round) and this file draws it. No
// syntax highlighting: changed lines get a word-level highlight instead, which
// carries more review signal than coloured keywords.

const SESSION = decodeURIComponent((location.pathname.match(/\/r\/([^/]+)/) || [])[1] || '');

function api(pathname) {
  const sep = pathname.includes('?') ? '&' : '?';
  return `${pathname}${sep}session=${encodeURIComponent(SESSION)}`;
}

async function post(pathname, body) {
  const res = await fetch(api(pathname), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, reviewerId: reviewer.id, reviewerName: reviewer.name }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------- reviewer identity ----------
//
// Per-browser and ephemeral, sharing localStorage with the plan UI so the same
// person is the same author in both. The name is seeded by the agent (from
// --reviewer-name / $PLANREVIEW_REVIEWER_NAME / `git config user.name`), so
// unlike the plan UI this one never prompts: a saved name wins, the seed is the
// fallback, and an unnamed reviewer is simply "reviewer".
const ID_KEY = 'pr.reviewerId';
const NAME_KEY = 'pr.reviewerName';

function readStore(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return ''; // private window / blocked storage — identity is just per-tab then
  }
}
function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}

const reviewer = (() => {
  let id = readStore(ID_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    writeStore(ID_KEY, id);
  }
  let seeded = '';
  try {
    seeded = String((window && window.__planreviewDefaultName) || '').trim();
  } catch {
    seeded = '';
  }
  const name = readStore(NAME_KEY) || seeded || 'reviewer';
  return { id, name };
})();

// ---------- local state ----------

const state = {
  status: 'idle',
  version: 0,
  diff: null,
  comments: [],
  chat: [],
  progress: [],
  workingSince: null,
  lastAgentActivity: null,
};

// Per-file UI state, remembered per session so a refresh mid-review doesn't undo
// the reviewer's navigation: the layout choice and which files are marked viewed.
const VIEW_KEY = `pr.codeview.${SESSION}.layout`;
const VIEWED_KEY = `pr.codeview.${SESSION}.viewed`;
let layout = readStore(VIEW_KEY) === 'split' ? 'split' : 'inline';
const viewed = new Set(JSON.parse(readStore(VIEWED_KEY) || '[]'));
// Which file cards are folded shut right now. Seeded from `viewed` (marking a
// file viewed folds it), then toggled by hand — one set, no precedence puzzle.
const folded = new Set(viewed);
// lazydev: a very large diff folds everything past the first 20 files so the
// first paint stays fast; the reviewer unfolds what they want. Raise or drop
// this if a real review ever needs 100 files open at once.
const EAGER_FILES = 20;
let seededFolds = false;
const lineText = new Map(); // `${file}|${side}|${line}` -> text, for quoting

const el = (id) => document.getElementById(id);

// ---------- boot ----------

async function boot() {
  el('identity').textContent = reviewer.name;
  wireChrome();
  trackFilesBarHeight();
  await refresh();
  connect();
}

// The sticky file header parks under the files bar, and that bar's height moves
// with the window (its jump chips wrap). Publish the measurement as a custom
// property so review.css can position against it instead of a magic number.
function trackFilesBarHeight() {
  const bar = el('files-bar');
  if (!bar || !window.ResizeObserver) return;
  const publish = () =>
    document.documentElement.style.setProperty('--files-bar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  new ResizeObserver(publish).observe(bar);
  publish();
}

async function refresh() {
  const res = await fetch(api('/api/state'));
  if (!res.ok) return;
  const s = await res.json();
  state.status = s.status;
  state.diff = s.diff || null;
  state.version = (s.doc && s.doc.version) || 0;
  state.comments = (s.review && s.review.comments) || [];
  state.chat = s.chat || [];
  state.progress = s.progress || [];
  state.workingSince = s.workingSince;
  state.lastAgentActivity = s.lastAgentActivity;
  el('doc-title').textContent = (s.doc && s.doc.title) || '';
  el('session-meta').textContent = state.diff ? state.diff.label : '';
  renderAll();
  renderChat();
  renderStatus();
}

function connect() {
  const url = `${api('/events')}&rid=${encodeURIComponent(reviewer.id)}&rname=${encodeURIComponent(reviewer.name)}`;
  const es = new EventSource(url);
  es.addEventListener('open', () => (el('chat-state').textContent = 'connected'));
  es.addEventListener('error', () => (el('chat-state').textContent = 'reconnecting…'));
  // A new round: the agent re-read the repo, so the whole diff is replaced.
  es.addEventListener('doc', () => refresh());
  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    state.status = d.status;
    state.workingSince = d.workingSince;
    state.lastAgentActivity = d.lastAgentActivity;
    renderStatus();
  });
  es.addEventListener('review', (e) => {
    const d = JSON.parse(e.data);
    if (d.author && d.author.id === reviewer.id) return; // our own echo
    state.comments = d.comments || [];
    renderThreads();
    renderCommentList();
  });
  es.addEventListener('chat', (e) => {
    state.chat.push(JSON.parse(e.data));
    renderChat();
  });
  es.addEventListener('progress', (e) => {
    state.progress.push(JSON.parse(e.data));
    state.lastAgentActivity = Date.now();
    renderProgress();
  });
  es.addEventListener('comment-reply', (e) => {
    const { commentId, reply } = JSON.parse(e.data);
    const c = state.comments.find((x) => x.id === commentId);
    if (!c) return;
    (c.replies || (c.replies = [])).push(reply);
    renderThreads();
    renderCommentList();
  });
}

// ---------- chrome ----------

let submitMode = 'submit';

function wireChrome() {
  for (const btn of document.querySelectorAll('.view-btn')) {
    btn.addEventListener('click', () => {
      layout = btn.dataset.view;
      writeStore(VIEW_KEY, layout);
      renderAll();
    });
  }
  el('end-btn').addEventListener('click', async () => {
    await saveReview();
    await post('/api/end');
  });
  el('interrupt-btn').addEventListener('click', () => post('/api/interrupt'));

  el('submit-menu-toggle').addEventListener('click', () => {
    const menu = el('submit-menu');
    menu.hidden = !menu.hidden;
    el('submit-menu-toggle').setAttribute('aria-expanded', String(!menu.hidden));
  });
  for (const item of document.querySelectorAll('.split-item')) {
    item.addEventListener('click', () => {
      submitMode = item.dataset.mode;
      el('submit-menu').hidden = true;
      el('submit-btn').textContent = submitMode === 'approve' ? 'Approve' : 'Request changes';
      el('submit-mode-label').textContent =
        submitMode === 'approve' ? 'apply my notes, then push' : 'fix these, then show me again';
    });
  }
  el('submit-btn').addEventListener('click', submitReview);

  // The chat box is a textarea so it can grow with a long message (see
  // #chat-form textarea in style.css). That costs it Enter-to-send, so put it
  // back: Enter sends, shift+Enter starts a new line.
  el('chat-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    el('chat-form').requestSubmit();
  });

  el('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = el('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await post('/api/chat', { text });
  });
}

function renderStatus() {
  const pill = el('status-pill');
  pill.textContent = state.status;
  pill.dataset.status = state.status;
  el('working-overlay').hidden = state.status !== 'working';
  el('done-overlay').hidden = state.status !== 'done';
  el('ended-overlay').hidden = state.status !== 'ended';
  if (state.status === 'working') renderProgress();
}

let elapsedTimer = null;
function renderProgress() {
  const list = el('progress-list');
  list.replaceChildren(
    ...state.progress.map((p) => {
      const li = document.createElement('li');
      li.className = 'progress-item done';
      const mark = document.createElement('span');
      mark.className = 'progress-mark';
      mark.textContent = '✓';
      const text = document.createElement('span');
      text.textContent = p.text;
      li.append(mark, text);
      return li;
    })
  );
  const last = state.progress[state.progress.length - 1];
  el('working-step').textContent = last ? last.text : 'working…';
  clearInterval(elapsedTimer);
  if (state.status !== 'working') return;
  const tick = () => {
    const since = state.workingSince || Date.now();
    el('working-elapsed').textContent = window.Liveness.formatElapsed(Date.now() - since);
    const hint = window.Liveness.stalenessHint(Date.now() - (state.lastAgentActivity || since));
    const stale = el('working-stale');
    stale.hidden = !hint;
    stale.textContent = hint || '';
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
}

// ---------- the diff ----------

function renderAll() {
  for (const btn of document.querySelectorAll('.view-btn'))
    btn.setAttribute('aria-pressed', String(btn.dataset.view === layout));
  lineText.clear();
  const host = el('files');
  if (!state.diff) {
    host.replaceChildren();
    return;
  }
  if (!seededFolds) {
    seededFolds = true;
    state.diff.files.slice(EAGER_FILES).forEach((f) => folded.add(f.path));
  }
  renderFilesBar();
  const draft = composerDraft; // replaceChildren below destroys the composer's DOM
  host.replaceChildren(...state.diff.files.map(renderFile));
  renderThreads();
  renderCommentList();
  // Put a half-written comment back. Any re-render replaces the whole files DOM,
  // and the composer lives ONLY in that DOM — so without this, every re-read of
  // the diff silently ate whatever the reviewer was typing. Both callers hit it:
  // the agent's `present` (SSE `doc`) and the reviewer's own "Re-read diff".
  // lazydev: if the line the draft hung on is gone from the new diff, openComposer
  // can't re-anchor it and there is no UI for it — the draft stays in memory, so a
  // later round that brings the line back restores it. Give it a home of its own
  // (a detached "orphaned draft" panel) only if that turns out to happen in practice.
  if (draft) openComposer(draft.file, draft.side, draft.from, draft.to, draft);
}

function renderFilesBar() {
  const d = state.diff;
  const bar = el('files-bar');
  const summary = document.createElement('div');
  summary.className = 'files-summary';
  summary.textContent = `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed`;
  const counts = document.createElement('span');
  counts.className = 'files-counts';
  counts.append(plusMinus(d.additions, d.deletions));
  summary.append(counts);

  summary.append(refreshButton());

  const jump = document.createElement('div');
  jump.className = 'files-jump';
  for (const f of d.files) {
    const a = document.createElement('a');
    a.href = `#f-${cssId(f.path)}`;
    a.className = 'file-chip';
    if (f.round) a.dataset.round = f.round;
    a.textContent = shortPath(f.path);
    if (f.round) {
      const dot = document.createElement('span');
      dot.className = 'round-dot';
      dot.title = f.round === 'new' ? 'new this round' : 'changed this round';
      a.append(dot);
    }
    jump.append(a);
  }
  bar.replaceChildren(summary, jump);
}

// Pull in work the agent committed AFTER the round it belonged to (issue 015).
// The agent's `present` is gated to a working round, so without this the diff on
// screen can lag the repo until the next round. Draft comments are saved first —
// the re-read replaces state.comments from the server, so an unsaved draft would
// otherwise be lost.
function refreshButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn files-refresh';
  btn.textContent = 'Re-read diff';
  btn.title = 'Re-read the repo — picks up anything committed since this round';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await saveReview();
      const res = await post('/api/refresh');
      if (!res.ok) {
        btn.textContent = (res.data && res.data.error) || 'could not re-read';
        return;
      }
      await refresh(); // repaints the bar, so this button (and its label) is replaced
    } catch {
      btn.textContent = 'could not re-read';
    } finally {
      btn.disabled = false; // never leave the control wedged on a dropped request
    }
  });
  return btn;
}

function plusMinus(add, del) {
  const wrap = document.createElement('span');
  const a = document.createElement('span');
  a.className = 'count-add';
  a.textContent = `+${add}`;
  const d = document.createElement('span');
  d.className = 'count-del';
  d.textContent = `−${del}`;
  wrap.append(a, d);
  return wrap;
}

const cssId = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const shortPath = (p) => (p.length > 44 ? `…${p.slice(-43)}` : p);

function renderFile(file) {
  const card = document.createElement('section');
  card.className = 'file-card';
  card.id = `f-${cssId(file.path)}`;
  card.dataset.file = file.path;
  const isCollapsed = folded.has(file.path);

  const head = document.createElement('header');
  head.className = 'file-head';
  const fold = document.createElement('button');
  fold.className = 'btn fold';
  fold.textContent = isCollapsed ? '▸' : '▾';
  fold.title = isCollapsed ? 'Expand file' : 'Collapse file';
  fold.addEventListener('click', () => {
    if (isCollapsed) folded.delete(file.path);
    else folded.add(file.path);
    renderAll();
  });

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path;

  const tags = document.createElement('span');
  tags.className = 'file-tags';
  if (file.status !== 'modified') {
    const t = document.createElement('span');
    t.className = 'tag';
    t.dataset.status = file.status;
    t.textContent = file.status;
    tags.append(t);
  }
  if (file.untracked) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.dataset.status = 'untracked';
    t.textContent = 'untracked';
    tags.append(t);
  }
  if (file.round) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.dataset.round = file.round;
    t.textContent = file.round === 'new' ? 'new this round' : `changed this round`;
    tags.append(t);
  }

  const counts = document.createElement('span');
  counts.className = 'file-counts';
  counts.append(plusMinus(file.additions, file.deletions));

  const viewedLabel = document.createElement('label');
  viewedLabel.className = 'viewed';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = viewed.has(file.path);
  box.addEventListener('change', () => {
    if (box.checked) {
      viewed.add(file.path);
      folded.add(file.path);
    } else {
      viewed.delete(file.path);
      folded.delete(file.path);
    }
    writeStore(VIEWED_KEY, JSON.stringify([...viewed]));
    renderAll();
  });
  viewedLabel.append(box, document.createTextNode('Viewed'));

  head.append(fold, name, tags, counts, viewedLabel);
  card.append(head);
  if (isCollapsed) return card;

  if (file.binary) {
    const note = document.createElement('p');
    note.className = 'file-note';
    note.textContent = 'Binary file — not shown.';
    card.append(note);
    return card;
  }
  if (!file.hunks.length) {
    const note = document.createElement('p');
    note.className = 'file-note';
    note.textContent = 'No textual changes (mode or metadata only).';
    card.append(note);
    return card;
  }

  const table = document.createElement('table');
  table.className = `diff ${layout}`;
  // Explicit column widths. With table-layout:fixed the browser takes widths
  // from the first row, and the first row is a hunk header (one cell spanning
  // everything) — which would split the table into equal columns and leave two
  // enormous empty gutters. A colgroup states the widths outright instead.
  const cols = document.createElement('colgroup');
  const widths = layout === 'split' ? ['52px', 'calc(50% - 52px)', '52px', 'auto'] : ['52px', '52px', 'auto'];
  for (const w of widths) {
    const col = document.createElement('col');
    col.style.width = w;
    cols.append(col);
  }
  table.append(cols);
  const body = document.createElement('tbody');
  file.hunks.forEach((hunk, i) => {
    const gap = gapBefore(file, i);
    if (gap) body.append(gapRow(file, i, gap));
    for (const row of hunkRows(file, hunk)) body.append(row);
  });
  const tailGap = gapAfter(file);
  if (tailGap) body.append(gapRow(file, file.hunks.length, tailGap));
  table.append(body);
  card.append(table);
  return card;
}

// ---------- context expansion ----------
//
// The unified diff shows three lines of context. Everything else in the file is
// still on disk, so a gap between hunks (or before the first / after the last)
// can be opened up 20 lines at a time from /api/expand.

const EXPAND_STEP = 20;

function gapBefore(file, index) {
  const hunk = file.hunks[index];
  const prev = index > 0 ? file.hunks[index - 1] : null;
  const prevEnd = prev ? prev.newStart + Math.max(prev.newCount, 0) - 1 : 0;
  const from = prevEnd + 1;
  const to = hunk.newStart - 1;
  if (to < from) return null;
  return { from, to, delta: hunk.oldStart - hunk.newStart };
}

function gapAfter(file) {
  const last = file.hunks[file.hunks.length - 1];
  if (!last || file.newTotal == null) return null;
  const from = last.newStart + Math.max(last.newCount, 0);
  if (from > file.newTotal) return null;
  return { from, to: file.newTotal, delta: last.oldStart - last.newStart };
}

function gapRow(file, index, gap) {
  const tr = document.createElement('tr');
  tr.className = 'gap-row';
  const td = document.createElement('td');
  td.colSpan = layout === 'split' ? 4 : 3;
  const btn = document.createElement('button');
  btn.className = 'btn expand';
  const size = gap.to - gap.from + 1;
  btn.textContent = size > EXPAND_STEP ? `⬆ expand ${EXPAND_STEP} of ${size} lines` : `⬆ expand ${size} lines`;
  btn.addEventListener('click', async () => {
    // Expand from the bottom of the gap upward: the lines nearest the hunk are
    // the ones the reviewer wants first.
    const from = Math.max(gap.from, gap.to - EXPAND_STEP + 1);
    const res = await fetch(api(`/api/expand?file=${encodeURIComponent(file.path)}&from=${from}&to=${gap.to}`));
    if (!res.ok) {
      btn.textContent = 'could not expand';
      return;
    }
    const { lines } = await res.json();
    // Build the row in the CURRENT layout's shape — a 3-cell inline row dropped
    // into a 4-column side-by-side table lands in the wrong columns.
    const rows = lines.map((l) => {
      const ctx = { type: 'ctx', oldNo: l.newNo + gap.delta, newNo: l.newNo, text: l.text };
      return layout === 'split' ? pairRow(file, ctx, ctx, null) : lineRow(file, ctx, null);
    });
    for (const row of rows) tr.parentNode.insertBefore(row, tr);
    if (from > gap.from) {
      gap.to = from - 1; // more left above — keep the control, retarget it
      const left = gap.to - gap.from + 1;
      btn.textContent = left > EXPAND_STEP ? `⬆ expand ${EXPAND_STEP} of ${left} lines` : `⬆ expand ${left} lines`;
    } else {
      tr.remove();
    }
    renderThreads();
  });
  td.append(btn);
  tr.append(td);
  return tr;
}

// ---------- rows ----------

// Pair each removal with the addition that replaced it (run against run, in
// order) so a changed line can be word-highlighted in BOTH layouts. Returns a
// Map from a line object to its counterpart on the other side.
function counterparts(lines) {
  const map = new Map();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === 'ctx') {
      i += 1;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      map.set(dels[k], adds[k]);
      map.set(adds[k], dels[k]);
    }
  }
  return map;
}

function hunkRows(file, hunk) {
  const head = document.createElement('tr');
  head.className = 'hunk-head';
  const td = document.createElement('td');
  td.colSpan = layout === 'split' ? 4 : 3;
  td.textContent = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${
    hunk.heading ? ` ${hunk.heading}` : ''
  }`;
  head.append(td);
  const rows = [head];
  const pairs = counterparts(hunk.lines);
  if (layout === 'split') rows.push(...splitRows(file, hunk, pairs));
  else for (const l of hunk.lines) rows.push(lineRow(file, l, pairs));
  return rows;
}

// Side-by-side pairs a run of removals with the run of additions that follows
// it: row k shows del[k] against add[k], and the shorter side is padded. That is
// what makes a one-line edit read as one row with both versions on it.
function splitRows(file, hunk, pairs) {
  const rows = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'ctx') {
      rows.push(pairRow(file, l, l, pairs));
      i += 1;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push(pairRow(file, dels[k] || null, adds[k] || null, pairs));
  }
  return rows;
}

function pairRow(file, left, right, pairs) {
  const tr = document.createElement('tr');
  tr.className = 'line-row';
  const mate = (l) => (pairs && pairs.get(l) ? pairs.get(l).text : null);
  tr.append(gutter(file, 'old', left), codeCell(file, left, 'old', left && mate(left)));
  tr.append(gutter(file, 'new', right), codeCell(file, right, 'new', right && mate(right)));
  return tr;
}

function lineRow(file, line, pairs) {
  const tr = document.createElement('tr');
  tr.className = 'line-row';
  const mate = pairs && pairs.get(line) ? pairs.get(line).text : null;
  tr.append(gutter(file, 'old', line.type === 'add' ? null : line));
  tr.append(gutter(file, 'new', line.type === 'del' ? null : line));
  tr.append(codeCell(file, line, line.type === 'del' ? 'old' : 'new', mate));
  return tr;
}

function gutter(file, side, line) {
  const td = document.createElement('td');
  td.className = `ln ${side}`;
  if (!line) return td;
  const no = side === 'old' ? line.oldNo : line.newNo;
  if (no == null) return td;
  td.textContent = String(no);
  td.dataset.file = file.path;
  td.dataset.side = side;
  td.dataset.line = String(no);
  td.classList.add('anchor');
  lineText.set(`${file.path}|${side}|${no}`, line.text);
  return td;
}

function codeCell(file, line, side, counterpart) {
  const td = document.createElement('td');
  td.className = 'code';
  if (!line) {
    td.classList.add('empty');
    return td;
  }
  td.classList.add(line.type);
  if (line.fresh) td.classList.add('fresh');
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  td.append(mark, ...intraLine(line.text, counterpart, line.type, langFor(file.path)));
  return td;
}

// ---------- syntax + word-level highlighting ----------
//
// Two layers on one line. highlight.js (vendored in public/vendor, loaded by
// review.html) tokenises the text; the word-level del/add highlight is then
// painted on top of those tokens with a Range, so a line can be both coloured
// and marked as changed.
//
// lazydev: each line is tokenised on its own, so a line in the middle of a
// multi-line construct (a /* */ block, a docstring, a template literal) loses
// its context and renders plain. It degrades to "plain", never to "wrong". If
// that starts to grate, tokenise each hunk side as one string and split the
// resulting DOM on newlines.

const langCache = new Map();

// highlight.js registers the usual file extensions as aliases (pl, rs, py, ts,
// yml, md, …), so the extension is the language id — no map to maintain here.
function langFor(path) {
  if (langCache.has(path)) return langCache.get(path);
  const ext = ((path || '').match(/\.([A-Za-z0-9]+)$/) || [])[1];
  const key = ext ? ext.toLowerCase() : null;
  const lang = key && window.hljs && hljs.getLanguage(key) ? key : null;
  langCache.set(path, lang);
  return lang;
}

// The run that actually differs between a paired del/add, as [start, end) char
// offsets: trim the common prefix and suffix.
// lazydev: prefix/suffix trimming, not a token LCS — it nails the common case (a
// changed argument, a flipped operator) and degrades to "the whole line differs"
// on a rewrite, which is honest.
function diffRange(text, counterpart, type) {
  if (!counterpart || type === 'ctx') return null;
  const a = counterpart;
  const b = text;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  const end = b.length - s;
  if (end <= p || (p === 0 && end === b.length)) return null;
  return [p, end];
}

function intraLine(text, counterpart, type, lang) {
  const range = diffRange(text, counterpart, type);
  const root = highlightLine(text, lang);
  if (!root) {
    // No highlighter for this file: the original flat prefix / mark / suffix.
    if (!range) return [document.createTextNode(text)];
    const span = document.createElement('span');
    span.className = 'wd';
    span.textContent = text.slice(range[0], range[1]);
    return [
      document.createTextNode(text.slice(0, range[0])),
      span,
      document.createTextNode(text.slice(range[1])),
    ];
  }
  if (range) markRange(root, range[0], range[1]);
  return [root];
}

// hljs.highlight escapes the source, so its output is safe to set as HTML. The
// `hljs` class deliberately stays off this span: the vendored theme's base rules
// (its own background and padding) would fight the diff row tint.
function highlightLine(text, lang) {
  if (!lang) return null;
  try {
    const span = document.createElement('span');
    span.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    return span;
  } catch {
    return null;
  }
}

// Wrap [start, end) of root's text in span.wd. extractContents splits any token
// span the range only partly covers, so the syntax colours survive underneath.
function markRange(root, start, end) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let opened = false;
  let node;
  while ((node = walk.nextNode())) {
    const len = node.nodeValue.length;
    if (!opened && start <= pos + len) {
      range.setStart(node, start - pos);
      opened = true;
    }
    if (opened && end <= pos + len) {
      range.setEnd(node, end - pos);
      const span = document.createElement('span');
      span.className = 'wd';
      span.append(range.extractContents());
      range.insertNode(span);
      return;
    }
    pos += len;
  }
}

// ---------- selecting lines ----------
//
// Click a line number to comment on it; drag down the gutter to cover a range.
// Both sides are commentable: a note on a removed line is a note about what was
// taken out.

let drag = null;

document.addEventListener('mousedown', (e) => {
  const td = e.target.closest && e.target.closest('td.ln.anchor');
  if (!td) return;
  e.preventDefault();
  drag = { file: td.dataset.file, side: td.dataset.side, from: Number(td.dataset.line), to: Number(td.dataset.line) };
  paintDrag();
});

document.addEventListener('mouseover', (e) => {
  if (!drag) return;
  const td = e.target.closest && e.target.closest('td.ln.anchor');
  if (!td || td.dataset.file !== drag.file || td.dataset.side !== drag.side) return;
  drag.to = Number(td.dataset.line);
  paintDrag();
});

document.addEventListener('mouseup', () => {
  if (!drag) return;
  const { file, side } = drag;
  const from = Math.min(drag.from, drag.to);
  const to = Math.max(drag.from, drag.to);
  clearDrag();
  drag = null;
  openComposer(file, side, from, to);
});

function paintDrag() {
  clearDrag();
  const lo = Math.min(drag.from, drag.to);
  const hi = Math.max(drag.from, drag.to);
  for (const td of document.querySelectorAll('td.ln.anchor')) {
    if (td.dataset.file !== drag.file || td.dataset.side !== drag.side) continue;
    const n = Number(td.dataset.line);
    if (n >= lo && n <= hi) td.closest('tr').classList.add('selecting');
  }
}

function clearDrag() {
  for (const tr of document.querySelectorAll('tr.selecting')) tr.classList.remove('selecting');
}

function quoteFor(file, side, from, to) {
  const out = [];
  for (let n = from; n <= to; n++) {
    const t = lineText.get(`${file}|${side}|${n}`);
    if (t !== undefined) out.push(t);
  }
  return out.join('\n');
}

// The row a comment (or the composer) hangs under: the last line of its range.
function anchorRow(file, side, line) {
  const td = document.querySelector(
    `td.ln.anchor[data-file="${cssEscape(file)}"][data-side="${side}"][data-line="${line}"]`
  );
  return td ? td.closest('tr') : null;
}

function cssEscape(v) {
  return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"');
}

// ---------- composer ----------

// The composer's text lives in the DOM and nowhere else, so a re-render loses it.
// `composerDraft` is the memory copy that survives one — kept in step with the
// textareas on every keystroke, and handed back in as `restore` by renderAll.
let composerDraft = null;

function openComposer(file, side, from, to, restore) {
  closeComposer(); // clears composerDraft, so set it below, not above
  const row = anchorRow(file, side, to);
  if (!row) return;
  const quote = quoteFor(file, side, from, to);
  composerDraft = restore || { file, side, from, to, mode: 'comment', text: '', suggestion: quote };
  const tr = document.createElement('tr');
  tr.className = 'composer-row';
  const td = document.createElement('td');
  td.colSpan = layout === 'split' ? 4 : 3;

  const head = document.createElement('div');
  head.className = 'composer-head';
  head.textContent = `${file}:${from === to ? from : `${from}-${to}`}${side === 'old' ? ' (removed)' : ''}`;

  const tabs = document.createElement('div');
  tabs.className = 'composer-tabs';
  const commentTab = document.createElement('button');
  commentTab.className = 'btn tab active';
  commentTab.textContent = 'Comment';
  const suggestTab = document.createElement('button');
  suggestTab.className = 'btn tab';
  suggestTab.textContent = 'Suggest';
  tabs.append(commentTab, suggestTab);
  head.append(tabs);

  const text = document.createElement('textarea');
  text.rows = 3;
  text.placeholder = 'Leave a comment…';

  const suggestion = document.createElement('textarea');
  suggestion.className = 'suggestion-input';
  suggestion.rows = Math.min(10, to - from + 1);
  suggestion.value = quote;
  suggestion.hidden = true;

  let mode = 'comment';
  const setMode = (m) => {
    mode = m;
    if (composerDraft) composerDraft.mode = m;
    commentTab.classList.toggle('active', m === 'comment');
    suggestTab.classList.toggle('active', m === 'suggest');
    suggestion.hidden = m !== 'suggest';
    text.placeholder = m === 'suggest' ? 'Why this change… (optional)' : 'Leave a comment…';
  };
  commentTab.addEventListener('click', () => setMode('comment'));
  suggestTab.addEventListener('click', () => setMode('suggest'));
  text.addEventListener('input', () => composerDraft && (composerDraft.text = text.value));
  suggestion.addEventListener('input', () => composerDraft && (composerDraft.suggestion = suggestion.value));

  const actions = document.createElement('div');
  actions.className = 'composer-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeComposer);
  const save = document.createElement('button');
  save.className = 'btn primary';
  save.textContent = 'Add comment';
  save.addEventListener('click', async () => {
    const body = text.value.trim();
    const sug = mode === 'suggest' ? suggestion.value : '';
    if (!body && !sug) return;
    state.comments.push({
      id: `c${Math.random().toString(16).slice(2, 8)}`,
      file,
      side,
      line: from,
      ...(to !== from ? { endLine: to } : {}),
      quote,
      text: body,
      ...(mode === 'suggest' ? { suggestion: sug } : {}),
      ts: Date.now(),
      author: { id: reviewer.id, name: reviewer.name },
    });
    closeComposer();
    renderThreads();
    renderCommentList();
    await saveReview();
  });
  actions.append(cancel, save);

  td.append(head, text, suggestion, actions);
  tr.append(td);
  row.parentNode.insertBefore(tr, row.nextSibling);
  if (restore) {
    text.value = restore.text;
    suggestion.value = restore.suggestion;
    setMode(restore.mode);
  }
  text.focus();
}

function closeComposer() {
  composerDraft = null; // cancel/save both discard the draft on purpose
  for (const tr of document.querySelectorAll('tr.composer-row')) tr.remove();
}

// ---------- threads, inline and in the sidebar ----------

function renderThreads() {
  for (const tr of document.querySelectorAll('tr.thread-row')) tr.remove();
  const byAnchor = new Map();
  for (const c of state.comments) {
    if (c.archived) continue;
    const key = `${c.file}|${c.side}|${c.endLine || c.line}`;
    if (!byAnchor.has(key)) byAnchor.set(key, []);
    byAnchor.get(key).push(c);
  }
  for (const [key, comments] of byAnchor) {
    const [file, side, line] = key.split('|');
    const row = anchorRow(file, side, Number(line));
    if (!row) continue; // the line isn't on screen (collapsed file, or unexpanded)
    const tr = document.createElement('tr');
    tr.className = 'thread-row';
    const td = document.createElement('td');
    td.colSpan = layout === 'split' ? 4 : 3;
    for (const c of comments) td.append(commentCard(c, { inline: true }));
    tr.append(td);
    row.parentNode.insertBefore(tr, row.nextSibling);
  }
}

function commentCard(c, { inline } = {}) {
  const card = document.createElement('div');
  card.className = 'comment-card';
  if (c.archived) card.classList.add('archived');

  const head = document.createElement('div');
  head.className = 'card-head';
  const who = document.createElement('strong');
  who.textContent = (c.author && c.author.name) || 'reviewer';
  const where = document.createElement('span');
  where.className = 'card-time';
  where.textContent = `${shortPath(c.file)}:${c.endLine ? `${c.line}-${c.endLine}` : c.line}`;
  head.append(who, where);
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if ((c.author || {}).id === reviewer.id) {
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Delete';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.comments = state.comments.filter((x) => x.id !== c.id);
      renderThreads();
      renderCommentList();
      await saveReview();
    });
    actions.append(del);
  }
  head.append(actions);

  const body = document.createElement('div');
  body.className = 'card-body';
  if (!inline) {
    const quote = document.createElement('blockquote');
    quote.textContent = c.quote;
    body.append(quote);
  }
  if (c.text) {
    const p = document.createElement('p');
    p.textContent = c.text;
    body.append(p);
  }
  if (c.suggestion !== undefined) {
    const label = document.createElement('div');
    label.className = 'suggestion-label';
    label.textContent = 'Suggested change';
    const pre = document.createElement('pre');
    pre.className = 'suggestion';
    pre.textContent = c.suggestion;
    body.append(label, pre);
  }

  const thread = document.createElement('div');
  thread.className = 'comment-thread';
  for (const r of c.replies || []) {
    const reply = document.createElement('div');
    reply.className = `reply ${r.role}`;
    const author = document.createElement('span');
    author.className = 'reply-author';
    author.textContent = r.role === 'agent' ? 'agent' : (r.author && r.author.name) || 'reviewer';
    const p = document.createElement('p');
    p.textContent = r.text;
    reply.append(author, p);
    thread.append(reply);
  }

  const form = document.createElement('form');
  form.className = 'reply-form';
  const input = document.createElement('input');
  input.placeholder = 'Reply…';
  const send = document.createElement('button');
  send.className = 'btn';
  send.textContent = 'Reply';
  form.append(input, send);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    (c.replies || (c.replies = [])).push({
      role: 'reviewer',
      text,
      ts: Date.now(),
      author: { id: reviewer.id, name: reviewer.name },
    });
    renderThreads();
    renderCommentList();
    await saveReview();
  });

  card.append(head, body, thread, form);
  if (inline) card.addEventListener('click', (e) => e.stopPropagation());
  return card;
}

function renderCommentList() {
  const live = state.comments.filter((c) => !c.archived);
  const archived = state.comments.filter((c) => c.archived);
  el('comment-count').textContent = String(live.length);
  el('archived-note').textContent = archived.length ? `${archived.length} unanchored` : '';
  const list = el('comment-list');
  const cards = [];
  for (const c of live) {
    const card = commentCard(c, { inline: false });
    card.addEventListener('click', () => {
      // A comment on a file the reviewer folded away (or marked viewed) still
      // has to be reachable from the sidebar — so unfold it, then jump.
      if (folded.has(c.file)) {
        folded.delete(c.file);
        renderAll();
      }
      const row = anchorRow(c.file, c.side, c.endLine || c.line);
      if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    cards.push(card);
  }
  if (archived.length) {
    const head = document.createElement('div');
    head.className = 'panel-head-aside archived-head';
    head.textContent = 'No longer in the diff';
    cards.push(head, ...archived.map((c) => commentCard(c, { inline: false })));
  }
  list.replaceChildren(...cards);
  const suggestions = live.filter((c) => c.suggestion !== undefined).length;
  el('submit-tally').textContent =
    `${live.length} comment${live.length === 1 ? '' : 's'}` +
    (suggestions ? `, ${suggestions} suggestion${suggestions === 1 ? '' : 's'}` : '');
}

function renderChat() {
  const list = el('chat-list');
  list.replaceChildren(
    ...state.chat.map((m) => {
      const div = document.createElement('div');
      div.className = `chat-msg ${m.role}`;
      const author = document.createElement('span');
      author.className = 'chat-author';
      author.textContent = m.role === 'agent' ? 'agent' : (m.author && m.author.name) || 'you';
      const p = document.createElement('p');
      p.textContent = m.text;
      div.append(author, p);
      return div;
    })
  );
  list.scrollTop = list.scrollHeight;
}

// ---------- handing it back ----------

// The in-progress review is synced to the server so it survives a refresh (and
// so peers see it), exactly as the plan UI does.
async function saveReview() {
  await post('/api/review-state', { comments: state.comments });
}

async function submitReview() {
  const note = el('overall-note').value.trim();
  const path = submitMode === 'approve' ? '/api/approve' : '/api/submit';
  const res = await post(path, { comments: state.comments, note });
  if (!res.ok) {
    el('submit-tally').textContent = (res.data && res.data.error) || 'could not submit';
    return;
  }
  el('overall-note').value = '';
}

boot();
