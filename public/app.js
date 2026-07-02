'use strict';

// ---------- elements ----------

const docEl = document.getElementById('doc');
const docTitleEl = document.getElementById('doc-title');
const statusPill = document.getElementById('status-pill');
const fabEl = document.getElementById('comment-fab');
const composerEl = document.getElementById('composer');
const composerQuoteEl = document.getElementById('composer-quote');
const composerTextEl = document.getElementById('composer-text');
const commentListEl = document.getElementById('comment-list');
const commentCountEl = document.getElementById('comment-count');
const overallNoteEl = document.getElementById('overall-note');
const submitBtn = document.getElementById('submit-btn');

// ---------- state ----------

const state = {
  status: 'idle',
  version: 0,
  comments: [], // {id, quote, text, ts}
};

let pendingRange = null;
let pendingQuote = '';

// ---------- status & document ----------

const STATUS_LABEL = {
  idle: 'waiting for a plan',
  reviewing: 'reviewing',
  submitted: 'review submitted',
};

function setStatus(status) {
  state.status = status;
  statusPill.dataset.status = status;
  statusPill.textContent = STATUS_LABEL[status] || status;
  submitBtn.disabled = status !== 'reviewing';
}

function renderDoc(doc) {
  docTitleEl.textContent = doc.title || '';
  document.title = doc.title ? `${doc.title} — Plan Review` : 'Plan Review';
  docEl.innerHTML =
    doc.html || '<p class="empty">Waiting for the agent to present a plan…</p>';
  state.version = doc.version;
}

async function fetchState() {
  const res = await fetch('/api/state');
  const s = await res.json();
  renderDoc(s.doc);
  setStatus(s.status);
  state.comments = (s.review && s.review.comments) || [];
  for (const c of state.comments) anchorByQuote(c.quote, c.id);
  renderComments();
}

// ---------- selection → comment ----------

function selectionInDoc() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!docEl.contains(range.commonAncestorContainer)) return null;
  if (!sel.toString().trim()) return null;
  return range;
}

document.addEventListener('mouseup', (e) => {
  if (composerEl.contains(e.target) || fabEl.contains(e.target)) return;
  // let the selection settle before reading it
  setTimeout(() => {
    const range = selectionInDoc();
    if (!range) {
      fabEl.hidden = true;
      return;
    }
    pendingRange = range.cloneRange();
    pendingQuote = window.getSelection().toString();
    const rect = range.getBoundingClientRect();
    fabEl.style.left = `${Math.min(rect.right + 8, window.innerWidth - 130)}px`;
    fabEl.style.top = `${Math.max(rect.top - 4, 8)}px`;
    fabEl.hidden = false;
  }, 0);
});

document.querySelector('.doc-pane').addEventListener('scroll', () => {
  fabEl.hidden = true;
});

document.getElementById('fab-btn').addEventListener('click', () => {
  if (!pendingRange) return;
  fabEl.hidden = true;
  const rect = pendingRange.getBoundingClientRect();
  composerQuoteEl.textContent = truncate(pendingQuote, 160);
  composerTextEl.value = '';
  composerEl.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - 380))}px`;
  composerEl.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 220)}px`;
  composerEl.hidden = false;
  composerTextEl.focus();
});

function dismissComposer() {
  composerEl.hidden = true;
  pendingRange = null;
  pendingQuote = '';
}

document.getElementById('composer-cancel').addEventListener('click', dismissComposer);

document.getElementById('composer-save').addEventListener('click', saveComment);

composerTextEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') dismissComposer();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
});

function saveComment() {
  const text = composerTextEl.value.trim();
  if (!text || !pendingRange) return;
  const id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  highlightRange(pendingRange, id);
  state.comments.push({ id, quote: pendingQuote, text, ts: Date.now() });
  window.getSelection().removeAllRanges();
  dismissComposer();
  renderComments();
  syncReview();
}

// ---------- comment panel ----------

function renderComments() {
  commentCountEl.textContent = String(state.comments.length);
  submitBtn.textContent = state.comments.length
    ? `Submit review (${state.comments.length})`
    : 'Submit review';
  commentListEl.innerHTML = '';
  if (!state.comments.length) {
    commentListEl.innerHTML =
      '<p class="hint">Select text in the document to leave a comment.</p>';
    return;
  }
  for (const c of state.comments) {
    const card = document.createElement('div');
    card.className = 'comment-card';
    card.dataset.cid = c.id;

    const quote = document.createElement('blockquote');
    quote.textContent = truncate(c.quote, 120);
    const body = document.createElement('p');
    body.textContent = c.text;
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = 'Delete comment';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteComment(c.id);
    });

    card.append(del, quote, body);
    card.addEventListener('click', () => flashHighlight(c.id));
    commentListEl.appendChild(card);
  }
}

function deleteComment(id) {
  const idx = state.comments.findIndex((c) => c.id === id);
  if (idx === -1) return;
  state.comments.splice(idx, 1);
  removeHighlight(id);
  renderComments();
  syncReview();
}

function flashHighlight(id) {
  const mark = docEl.querySelector(`mark[data-cid="${id}"]`);
  if (!mark) return;
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const m of docEl.querySelectorAll(`mark[data-cid="${id}"]`)) {
    m.classList.add('active');
    setTimeout(() => m.classList.remove('active'), 1200);
  }
}

async function syncReview() {
  await fetch('/api/review-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: state.comments }),
  }).catch(() => {});
}

// ---------- submit ----------

submitBtn.addEventListener('click', submitReview);

async function submitReview() {
  if (state.status !== 'reviewing') return;
  const bundle = {
    comments: state.comments,
    note: overallNoteEl.value.trim(),
    docVersion: state.version,
  };
  submitBtn.disabled = true;
  const res = await fetch('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle),
  }).catch(() => null);
  if (!res || !res.ok) {
    submitBtn.disabled = false;
    return;
  }
  overallNoteEl.value = '';
  setStatus('submitted');
}

// ---------- highlights ----------

// Wrap every text-node segment inside `range` in <mark data-cid>.
function highlightRange(range, cid) {
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!range.intersectsNode(n)) continue;
    if (!/\S/.test(n.nodeValue) && n !== range.startContainer && n !== range.endContainer)
      continue;
    nodes.push(n);
  }
  for (const n of nodes) {
    let start = 0;
    let end = n.nodeValue.length;
    if (n === range.startContainer) start = range.startOffset;
    if (n === range.endContainer) end = Math.min(end, range.endOffset);
    if (start >= end) continue;
    const target = n.splitText(start);
    target.splitText(end - start);
    const mark = document.createElement('mark');
    mark.className = 'hl';
    mark.dataset.cid = cid;
    target.parentNode.replaceChild(mark, target);
    mark.appendChild(target);
  }
}

function removeHighlight(cid) {
  for (const mark of docEl.querySelectorAll(`mark[data-cid="${cid}"]`)) {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

// Best-effort re-anchoring after a page refresh: find the quote's text in the
// document and rebuild a range for it. Quotes that span block boundaries may
// not re-anchor (selection text ≠ textContent there); the comment itself is
// unaffected.
function anchorByQuote(quote, cid) {
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
  let text = '';
  const map = [];
  while (walker.nextNode()) {
    map.push({ node: walker.currentNode, start: text.length });
    text += walker.currentNode.nodeValue;
  }
  const idx = text.indexOf(quote);
  if (idx === -1) return false;
  const from = posToPoint(map, idx, false);
  const to = posToPoint(map, idx + quote.length, true);
  if (!from || !to) return false;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  highlightRange(range, cid);
  return true;
}

function posToPoint(map, pos, isEnd) {
  for (const m of map) {
    const end = m.start + m.node.nodeValue.length;
    if (pos >= m.start && (isEnd ? pos <= end : pos < end))
      return { node: m.node, offset: pos - m.start };
  }
  return null;
}

// ---------- utils ----------

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------- boot ----------

fetchState();
