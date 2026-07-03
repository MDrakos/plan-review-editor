'use strict';

// ---------- session ----------
//
// This tab is bound to exactly one session, identified in its URL as /s/<id>.
// Every request carries that id so the server routes it to the right session —
// which is what keeps concurrent agents' plans from cross-contaminating.

const SESSION = decodeURIComponent((location.pathname.match(/\/s\/([^/]+)/) || [])[1] || '');

function api(pathname) {
  const sep = pathname.includes('?') ? '&' : '?';
  return `${pathname}${sep}session=${encodeURIComponent(SESSION)}`;
}

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
const chatListEl = document.getElementById('chat-list');
const chatFormEl = document.getElementById('chat-form');
const chatInputEl = document.getElementById('chat-input');

// ---------- state ----------

const state = {
  status: 'idle',
  version: 0,
  comments: [], // {id, quote, text, ts}
  choices: {}, // choiceId -> value (string) or values (string[]) when multi
};

let pendingRange = null;
let pendingQuote = '';
let editingId = null; // id of the comment currently open for inline editing

// ---------- status & document ----------

const STATUS_LABEL = {
  idle: 'waiting for a plan',
  reviewing: 'reviewing',
  working: 'agent is reworking the plan',
  done: 'review approved',
  ended: 'session ended',
};

function setStatus(status) {
  state.status = status;
  statusPill.dataset.status = status;
  statusPill.textContent = STATUS_LABEL[status] || status;
  document.getElementById('working-overlay').hidden = status !== 'working';
  document.getElementById('done-overlay').hidden = status !== 'done';
  document.getElementById('ended-overlay').hidden = status !== 'ended';
  // 'done' and 'ended' are both terminal — the review is over either way
  const terminal = status === 'done' || status === 'ended';
  document.getElementById('end-btn').disabled = terminal;
  chatInputEl.disabled = terminal;
  if (terminal) hideTyping();
  updateSubmitButton();
}

document.getElementById('end-btn').addEventListener('click', async () => {
  if (!confirm('End the review session and hand control back to the terminal?')) return;
  await fetch(api('/api/end'), { method: 'POST' }).catch(() => {});
  setStatus('ended');
});

function renderDoc(doc) {
  docTitleEl.textContent = doc.title || '';
  document.title = doc.title ? `${doc.title} — Plan Review` : 'Plan Review';
  docEl.innerHTML =
    doc.html || '<p class="empty">Waiting for the agent to present a plan…</p>';
  state.version = doc.version;
}

async function fetchState() {
  let s;
  try {
    const res = await fetch(api('/api/state'));
    if (!res.ok) {
      // the session no longer exists (server restarted, or it was stopped)
      setStatus('ended');
      return;
    }
    s = await res.json();
  } catch {
    return; // server unreachable — the event stream's reconnect will retry us
  }
  renderDoc(s.doc);
  setStatus(s.status);
  state.comments = (s.review && s.review.comments) || [];
  state.choices = (s.review && s.review.choices) || {};
  for (const c of state.comments) anchorByQuote(c.quote, c.id);
  renderComments();
  bindChoices();
  hideTyping();
  chatListEl.innerHTML = '';
  for (const msg of s.chat || []) appendChatMessage(msg);
}

// ---------- chat ----------

function appendChatMessage(msg) {
  const el = document.createElement('div');
  el.className = `chat-msg ${msg.role}`;
  el.textContent = msg.text;
  chatListEl.appendChild(el);
  chatListEl.scrollTop = chatListEl.scrollHeight;
}

// A "…" bubble shown from the moment the reviewer sends a message until the
// agent's reply arrives, so it's clear a response is on the way. Purely visual
// and local to this tab; cleared by the agent's chat over SSE (or, as a safety
// net if no agent is listening, after a couple of minutes).
let typingEl = null;
let typingTimer = null;

function showTyping() {
  hideTyping();
  typingEl = document.createElement('div');
  typingEl.className = 'chat-msg agent typing';
  typingEl.setAttribute('aria-label', 'Agent is replying');
  typingEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  chatListEl.appendChild(typingEl);
  chatListEl.scrollTop = chatListEl.scrollHeight;
  typingTimer = setTimeout(hideTyping, 120000);
}

function hideTyping() {
  clearTimeout(typingTimer);
  typingTimer = null;
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

chatFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatInputEl.value = '';
  appendChatMessage({ role: 'reviewer', text });
  showTyping();
  await fetch(api('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
});

// ---------- live events ----------

function connectEvents() {
  const es = new EventSource(api('/events'));
  // Resync on every (re)connect. A tab that missed broadcasts while the
  // server restarted — e.g. one still showing a previous session's "ended"
  // overlay — heals itself the moment it reattaches to the new session.
  es.onopen = () => fetchState();
  es.addEventListener('chat', (e) => {
    const msg = JSON.parse(e.data);
    // our own messages are appended optimistically on send
    if (msg.role !== 'reviewer') {
      hideTyping(); // the reply is here
      appendChatMessage(msg);
    }
  });
  // a reworked document arrived: reload it in place and start a fresh review
  es.addEventListener('doc', () => {
    dismissComposer();
    fabEl.hidden = true;
    fetchState();
  });
  es.addEventListener('status', (e) => setStatus(JSON.parse(e.data).status));
}

// ---------- choice blocks ----------

function bindChoices() {
  for (const block of docEl.querySelectorAll('.choice-block')) {
    const id = block.dataset.choiceId;
    const multi = block.dataset.multi === 'true';
    const boxes = [...block.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    const otherBox = block.querySelector('input[data-other="true"]');
    const otherText = block.querySelector('.choice-other-text');
    const presets = new Set(boxes.filter((i) => !i.dataset.other).map((i) => i.value));

    // the value an option contributes: for "Other", whatever was typed
    const valueOf = (i) =>
      i.dataset.other ? (otherText ? otherText.value.trim() : '') : i.value;

    const sync = () => {
      const vals = boxes.filter((i) => i.checked).map(valueOf).filter((v) => v !== '');
      state.choices[id] = multi ? vals : vals[0];
      syncReview();
    };

    // restore a saved answer — a value that matches no preset is an "Other" answer
    const saved = state.choices[id];
    for (const box of boxes) {
      if (saved !== undefined) {
        if (box.dataset.other) {
          const custom = (multi ? saved : [saved]).filter((v) => v && !presets.has(v))[0];
          if (custom) {
            box.checked = true;
            if (otherText) otherText.value = custom;
          }
        } else {
          box.checked = multi ? saved.includes(box.value) : saved === box.value;
        }
      }
      box.addEventListener('change', sync);
    }

    if (otherText) {
      // typing implies choosing "Other" (and, for single-select, deselects the rest)
      otherText.addEventListener('input', () => {
        if (otherBox && !otherBox.checked) otherBox.checked = true;
        sync();
      });
    }
  }
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
  if (state.status !== 'reviewing') return;
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
  updateSubmitButton();
  commentListEl.innerHTML = '';
  if (!state.comments.length) {
    commentListEl.innerHTML =
      '<p class="hint">Select text in the document to leave a comment.</p>';
    return;
  }
  for (const c of state.comments) {
    commentListEl.appendChild(c.id === editingId ? editCard(c) : viewCard(c));
  }
}

function iconBtn(glyph, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = title;
  b.textContent = glyph;
  b.addEventListener('click', onClick);
  return b;
}

function viewCard(c) {
  const card = document.createElement('div');
  card.className = 'comment-card';
  card.dataset.cid = c.id;

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.append(
    iconBtn('✎', 'Edit comment', (e) => {
      e.stopPropagation();
      beginEdit(c.id);
    }),
    iconBtn('✕', 'Delete comment', (e) => {
      e.stopPropagation();
      deleteComment(c.id);
    })
  );

  const quote = document.createElement('blockquote');
  quote.textContent = truncate(c.quote, 120);
  const body = document.createElement('p');
  body.textContent = c.text;

  card.append(actions, quote, body);
  card.addEventListener('click', () => flashHighlight(c.id));
  return card;
}

function editCard(c) {
  const card = document.createElement('div');
  card.className = 'comment-card editing';
  card.dataset.cid = c.id;
  // clicks inside the editor must not scroll/flash the document highlight
  card.addEventListener('click', (e) => e.stopPropagation());

  const quote = document.createElement('blockquote');
  quote.textContent = truncate(c.quote, 120);

  const ta = document.createElement('textarea');
  ta.className = 'comment-edit';
  ta.rows = 3;
  ta.value = c.text;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelEdit();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitEdit(c.id, ta.value);
  });

  const actions = document.createElement('div');
  actions.className = 'composer-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', cancelEdit);
  const save = document.createElement('button');
  save.className = 'btn primary';
  save.textContent = 'Save';
  save.addEventListener('click', () => commitEdit(c.id, ta.value));
  actions.append(cancel, save);

  card.append(quote, ta, actions);
  // focus once the card is in the DOM, caret at the end
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 0);
  return card;
}

function beginEdit(id) {
  editingId = id;
  renderComments();
}

function cancelEdit() {
  editingId = null;
  renderComments();
}

function commitEdit(id, value) {
  const text = value.trim();
  const c = state.comments.find((c) => c.id === id);
  if (c && text) {
    c.text = text;
    syncReview();
  }
  editingId = null;
  renderComments();
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
  await fetch(api('/api/review-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: state.comments, choices: state.choices }),
  }).catch(() => {});
}

// ---------- submit / approve (split button) ----------
//
// The primary button submits a review round (agent reworks and re-presents);
// the dropdown switches it to "Approve & finish", which sends the same bundle
// but ends the review — the UI goes straight to a terminal state instead of
// spinning, so it never waits on the agent.

const submitMenuToggle = document.getElementById('submit-menu-toggle');
const submitMenu = document.getElementById('submit-menu');
let submitMode = 'submit'; // 'submit' | 'approve'

function updateSubmitButton() {
  if (submitMode === 'approve') {
    submitBtn.textContent = 'Approve & finish';
    submitBtn.classList.add('approve');
  } else {
    submitBtn.textContent = state.comments.length
      ? `Submit review (${state.comments.length})`
      : 'Submit review';
    submitBtn.classList.remove('approve');
  }
  const locked = state.status !== 'reviewing';
  submitBtn.disabled = locked;
  submitMenuToggle.disabled = locked;
}

function closeSubmitMenu() {
  submitMenu.hidden = true;
  submitMenuToggle.setAttribute('aria-expanded', 'false');
}

submitMenuToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = submitMenu.hidden;
  submitMenu.hidden = !open;
  submitMenuToggle.setAttribute('aria-expanded', String(open));
});

for (const item of submitMenu.querySelectorAll('.split-item')) {
  item.addEventListener('click', () => {
    submitMode = item.dataset.mode;
    closeSubmitMenu();
    updateSubmitButton();
  });
}

document.addEventListener('click', (e) => {
  if (!submitMenu.hidden && !submitMenu.contains(e.target) && e.target !== submitMenuToggle)
    closeSubmitMenu();
});

submitBtn.addEventListener('click', () => (submitMode === 'approve' ? approveReview() : submitReview()));

function reviewBundle() {
  return {
    comments: state.comments,
    choices: state.choices,
    note: overallNoteEl.value.trim(),
    docVersion: state.version,
  };
}

// Surface a failed POST instead of silently swallowing it (a stale/old server,
// for instance, 404s a request and the click would otherwise look like a no-op).
function flashSubmitError() {
  submitBtn.disabled = false;
  submitBtn.textContent = "Couldn't reach the agent — try again";
  setTimeout(updateSubmitButton, 2500);
}

async function submitReview() {
  if (state.status !== 'reviewing') return;
  submitBtn.disabled = true;
  const res = await fetch(api('/api/submit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reviewBundle()),
  }).catch(() => null);
  if (!res || !res.ok) return flashSubmitError();
  overallNoteEl.value = '';
  setStatus('working');
}

async function approveReview() {
  if (state.status !== 'reviewing') return;
  submitBtn.disabled = true;
  const res = await fetch(api('/api/approve'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reviewBundle()),
  }).catch(() => null);
  if (!res || !res.ok) return flashSubmitError();
  overallNoteEl.value = '';
  setStatus('done');
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
connectEvents();
