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

// ---------- reviewer identity ----------
//
// Ephemeral and per-browser. reviewerId persists in localStorage so a refresh keeps
// the same identity (and thus authorship of this tab's comments); reviewerName is an
// optional, editable display label. No accounts, no server roster — identity rides
// along on every mutating request as a top-level reviewerId/reviewerName and, on
// comments/replies, an author:{id,name}. Absent identity, the server treats the
// poster as 'anonymous' and everything behaves as it did before this feature.

const REVIEWER_ID_KEY = 'pr.reviewerId';
const REVIEWER_NAME_KEY = 'pr.reviewerName';

function loadReviewerId() {
  let id = '';
  try {
    id = localStorage.getItem(REVIEWER_ID_KEY) || '';
  } catch {
    /* storage blocked (private mode) — fall through to a fresh per-load id */
  }
  if (!id) {
    id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      localStorage.setItem(REVIEWER_ID_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

const reviewer = {
  id: loadReviewerId(),
  get name() {
    try {
      return localStorage.getItem(REVIEWER_NAME_KEY) || '';
    } catch {
      return '';
    }
  },
  set name(v) {
    try {
      localStorage.setItem(REVIEWER_NAME_KEY, v || '');
    } catch {
      /* ignore */
    }
  },
};

// The author stamp for a comment/reply this tab creates.
function author() {
  return reviewer.name ? { id: reviewer.id, name: reviewer.name } : { id: reviewer.id };
}

// This tab's OWN flat picks pulled out of the nested per-reviewer choice map — the
// shape the server expects a POST to carry (it re-nests them under reviewer.id).
function myChoices() {
  const out = {};
  for (const [id, byReviewer] of Object.entries(state.choices || {})) {
    if (byReviewer && typeof byReviewer === 'object' && byReviewer[reviewer.id] !== undefined)
      out[id] = byReviewer[reviewer.id];
  }
  return out;
}

// This tab's own current pick for one choice block (undefined if it hasn't chosen).
function myPick(id) {
  const byReviewer = state.choices[id];
  return byReviewer && typeof byReviewer === 'object' ? byReviewer[reviewer.id] : undefined;
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
const progressListEl = document.getElementById('progress-list');
const workingElapsedEl = document.getElementById('working-elapsed');
const workingStaleEl = document.getElementById('working-stale');
const changesBar = document.getElementById('changes-bar');
const changesLabel = document.getElementById('changes-label');
const changesDismiss = document.getElementById('changes-dismiss');
const diffBar = document.getElementById('diff-bar');
const diffFromEl = document.getElementById('diff-from');
const diffToEl = document.getElementById('diff-to');
const diffShowBtn = document.getElementById('diff-show');
const diffCloseBtn = document.getElementById('diff-close');
const diffLegend = document.getElementById('diff-legend');
const diffErrorEl = document.getElementById('diff-error');

// ---------- state ----------

const state = {
  status: 'idle',
  version: 0,
  versions: [], // retained version numbers available to diff between
  diffing: false, // true while the doc pane shows a version diff (read-only)
  comments: [], // {id, quote, text, ts, replies?: [{role:'agent'|'reviewer', text, ts}], archived?}
  choices: {}, // choiceId -> { reviewerId -> value(string) | values(string[]) when multi }
  progress: [], // {text, ts} rework steps, shown in the working overlay
  presence: [], // [{id, name, connectedAt, count}] reviewers viewing now (live, never persisted)
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
  const wasWorking = state.status === 'working';
  state.status = status;
  statusPill.dataset.status = status;
  statusPill.textContent = STATUS_LABEL[status] || status;
  document.getElementById('working-overlay').hidden = status !== 'working';
  document.getElementById('done-overlay').hidden = status !== 'done';
  document.getElementById('ended-overlay').hidden = status !== 'ended';
  // Liveness cue: run the elapsed timer only while working. Start it on the
  // transition into 'working' (not on every setStatus, so re-broadcasts don't
  // reset it); stop and clear it the moment we leave — which is also how the
  // hint clears when the reworked document loads (present → 'reviewing').
  if (status === 'working') {
    if (!wasWorking) startWorkingTimer();
  } else if (wasWorking) {
    stopWorkingTimer();
  }
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
  // Rendering the live document means we are NOT in the diff view — reset it, so
  // a reworked doc arriving mid-diff (or any state resync) lands cleanly on the
  // current version rather than leaving a half-open diff.
  resetDiffView();
  docTitleEl.textContent = doc.title || '';
  document.title = doc.title ? `${doc.title} — Plan Review` : 'Plan Review';
  docEl.innerHTML =
    doc.html || '<p class="empty">Waiting for the agent to present a plan…</p>';
  state.version = doc.version;
  state.versions = doc.versions || [];
  updateChangesBar();
  populateVersionSelects();
}

// Blocks changed since the last cycle carry a data-changed attribute (added by
// the server). Show a dismissible bar when there are any; a freshly rendered
// doc always starts with its highlights visible.
function updateChangesBar() {
  docEl.classList.remove('changes-dismissed');
  const n = docEl.querySelectorAll('[data-changed]').length;
  changesBar.hidden = n === 0;
  if (n > 0)
    changesLabel.textContent = `${n} change${n === 1 ? '' : 's'} since your last review — highlighted below.`;
}

changesDismiss.addEventListener('click', () => {
  docEl.classList.add('changes-dismissed');
  changesBar.hidden = true;
});

// ---------- version diff ("show changes since v N") ----------
//
// The reviewer can compare any two RETAINED versions (see the server's version
// ring). Picking a from/to pair and hitting "Show changes" fetches an annotated
// diff — add / remove / change markers, including removals — and swaps it into
// the doc pane read-only; "Back to current" restores the live document. This is
// separate from the dismissible per-round highlight above, which is untouched.

function resetDiffView() {
  state.diffing = false;
  diffLegend.hidden = true;
  diffErrorEl.hidden = true;
  diffShowBtn.hidden = false;
  diffCloseBtn.hidden = true;
}

function populateVersionSelects() {
  const versions = state.versions || [];
  // need at least two retained versions to have something to compare
  if (versions.length < 2) {
    diffBar.hidden = true;
    return;
  }
  const keepFrom = diffFromEl.value;
  const keepTo = diffToEl.value;
  const asStr = versions.map(String);
  const opts = versions.map((v) => `<option value="${v}">${v}</option>`).join('');
  diffFromEl.innerHTML = opts;
  diffToEl.innerHTML = opts;
  // keep the reviewer's pick if still valid; else default previous → current
  diffFromEl.value = asStr.includes(keepFrom) ? keepFrom : asStr[asStr.length - 2];
  diffToEl.value = asStr.includes(keepTo) ? keepTo : asStr[asStr.length - 1];
  if (!state.diffing) diffBar.hidden = false;
  updateDiffShowState();
}

function updateDiffShowState() {
  diffShowBtn.disabled = diffFromEl.value === diffToEl.value;
}

async function showDiff() {
  const from = diffFromEl.value;
  const to = diffToEl.value;
  if (from === to) return;
  diffErrorEl.hidden = true;
  let data;
  try {
    const res = await fetch(
      api(`/api/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    );
    data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || 'diff unavailable');
  } catch (err) {
    // Surface the error in the diff bar (textContent, never innerHTML) and leave
    // the live document intact — never strand the reviewer on an error string
    // with no way back.
    diffErrorEl.textContent = `Couldn't load that diff: ${err.message}`;
    diffErrorEl.hidden = false;
    return;
  }
  // entering a read-only diff: drop any in-progress comment affordances
  dismissComposer();
  fabEl.hidden = true;
  changesBar.hidden = true; // the per-round highlight doesn't apply to a diff
  state.diffing = true;
  docEl.innerHTML = /data-diff/.test(data.html || '')
    ? data.html
    : '<p class="empty">No changes between these versions.</p>';
  diffLegend.hidden = false;
  diffShowBtn.hidden = true;
  diffCloseBtn.hidden = false;
}

// Restore the live document. fetchState re-renders the current doc (via
// renderDoc → resetDiffView) and re-anchors comment highlights.
function exitDiff() {
  fetchState();
}

diffShowBtn.addEventListener('click', showDiff);
diffCloseBtn.addEventListener('click', exitDiff);
diffFromEl.addEventListener('change', updateDiffShowState);
diffToEl.addEventListener('change', updateDiffShowState);

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
  // Only active comments anchor into the document; archived ones (their quote is
  // gone from the reworked plan) have nothing to highlight and live collapsed.
  for (const c of state.comments) if (!c.archived) anchorByQuote(c.quote, c.id);
  renderComments();
  bindChoices();
  hideTyping();
  chatListEl.innerHTML = '';
  for (const msg of s.chat || []) appendChatMessage(msg);
  state.progress = s.progress || [];
  renderProgress();
  state.presence = Array.isArray(s.presence) ? s.presence : [];
  renderPresence();
}

// ---------- chat ----------

function appendChatMessage(msg) {
  const el = document.createElement('div');
  el.className = `chat-msg ${msg.role}`;
  if (msg.role !== 'agent' && msg.author) {
    const who = document.createElement('span');
    who.className = 'chat-author';
    who.textContent = authorLabel(msg.author);
    if (msg.author.id) who.style.setProperty('--author-color', authorColor(msg.author.id));
    el.appendChild(who);
  }
  const body = document.createElement('span');
  body.className = 'chat-text';
  body.textContent = msg.text;
  el.appendChild(body);
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

// ---------- rework progress ----------
//
// While the agent reworks (status 'working'), it can report steps that show
// up as a live checklist in the overlay: earlier steps are ✓ done, the latest
// is the one in progress. Cleared when the reworked document arrives.

function renderProgress() {
  const items = state.progress || [];
  progressListEl.innerHTML = '';
  if (!items.length) {
    // The list lives inside the working overlay, so this is only ever seen
    // during a rework — a placeholder until the agent reports its first step.
    const li = document.createElement('li');
    li.className = 'progress-item placeholder';
    li.textContent = 'Progress will show up here as the agent works…';
    progressListEl.appendChild(li);
    return;
  }
  items.forEach((p, i) => {
    const current = i === items.length - 1;
    const li = document.createElement('li');
    li.className = `progress-item ${current ? 'current' : 'done'}`;
    const mark = document.createElement('span');
    mark.className = 'progress-mark';
    if (!current) mark.textContent = '✓';
    const txt = document.createElement('span');
    txt.className = 'progress-text';
    txt.textContent = p.text;
    li.append(mark, txt);
    progressListEl.appendChild(li);
  });
  progressListEl.scrollTop = progressListEl.scrollHeight;
}

// ---------- working-overlay liveness ----------
//
// While the agent reworks, the spinner alone can't tell "still thinking" from
// "silently died." So the overlay shows a live elapsed timer, and if no sign of
// life arrives for a while it adds a muted, advisory "may be stuck" line. Purely
// a client-side cue driven off SSE events — it never touches session status.
//
// Signs of life we can observe client-side: entering 'working', and each
// /agent/progress event. Absence of progress is a soft staleness proxy (a
// healthy agent can rework silently), so the hint stays deliberately low-key.

// The staleness threshold lives in window.Liveness (single source of truth);
// stalenessHint() defaults to it, so this file never redeclares the constant —
// two classic <script>s share one global scope, and a duplicate top-level
// `const` would throw "already declared" and take the whole page down.
let workingTimer = null; // interval ticking the elapsed/staleness display
let workingStartTs = 0; // when this rework spell began (client clock)
let lastSignalTs = 0; // last sign of life: entering 'working' or a progress event

function startWorkingTimer() {
  workingStartTs = Date.now();
  lastSignalTs = workingStartTs;
  tickWorking(); // paint 0:00 immediately rather than leaving a blank first second
  clearInterval(workingTimer);
  workingTimer = setInterval(tickWorking, 1000);
}

function stopWorkingTimer() {
  clearInterval(workingTimer);
  workingTimer = null;
  workingElapsedEl.textContent = '';
  workingStaleEl.hidden = true;
  workingStaleEl.textContent = '';
}

// A progress event means the agent is alive: reset the staleness clock and drop
// any advisory that was showing.
function noteAgentSignal() {
  lastSignalTs = Date.now();
  updateStaleHint();
}

function tickWorking() {
  workingElapsedEl.textContent = window.Liveness.formatElapsed(Date.now() - workingStartTs);
  updateStaleHint();
}

function updateStaleHint() {
  const hint = window.Liveness.stalenessHint(Date.now() - lastSignalTs);
  workingStaleEl.textContent = hint || '';
  workingStaleEl.hidden = !hint;
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
    body: JSON.stringify({ text, reviewerId: reviewer.id, reviewerName: reviewer.name }),
  }).catch(() => {});
});

// ---------- live events ----------

// The SSE URL carries this tab's identity so the server can add it to the session's
// presence roster (issue 007). rid is always present (loadReviewerId always mints one);
// rname is optional. An identity-less connection (not possible from this client, but
// e.g. curl) stays anonymous and registers no presence.
function eventsUrl() {
  let qs = `rid=${encodeURIComponent(reviewer.id)}`;
  if (reviewer.name) qs += `&rname=${encodeURIComponent(reviewer.name)}`;
  return api(`/events?${qs}`); // let api() append &session=… last, matching the /api/diff call
}

function connectEvents() {
  const es = new EventSource(eventsUrl());
  // Resync on every (re)connect. A tab that missed broadcasts while the
  // server restarted — e.g. one still showing a previous session's "ended"
  // overlay — heals itself the moment it reattaches to the new session.
  es.onopen = () => fetchState();
  // the live roster of who is viewing changed (someone joined or left): re-render the
  // strip. The payload is the full roster, so replace wholesale; guard the shape so a
  // malformed frame can't throw and kill the stream.
  es.addEventListener('presence', (e) => {
    const roster = JSON.parse(e.data);
    state.presence = Array.isArray(roster) ? roster : [];
    renderPresence();
  });
  es.addEventListener('chat', (e) => {
    const msg = JSON.parse(e.data);
    // our own messages are appended optimistically on send
    if (msg.role !== 'reviewer') {
      hideTyping(); // the reply is here
      appendChatMessage(msg);
    }
  });
  // the agent replied to a specific comment: thread it under that comment
  es.addEventListener('comment-reply', (e) => {
    const { commentId, reply } = JSON.parse(e.data);
    const c = state.comments.find((x) => x.id === commentId);
    if (!c) return; // not in this tab's set yet — a later fetchState will hydrate it
    (c.replies || (c.replies = [])).push(reply);
    renderComments();
  });
  // another reviewer changed the shared review (a comment or a choice pick): re-sync
  // from the server so their comment/pick renders live. Ignore our own echo — we are
  // the source of truth for our in-flight edits and must not clobber the composer.
  es.addEventListener('review', (e) => {
    const d = JSON.parse(e.data);
    if (d.author && d.author.id === reviewer.id) return; // our own change — already local
    fetchState();
  });
  // a reworked document arrived: reload it in place and start a fresh review
  es.addEventListener('doc', () => {
    dismissComposer();
    fabEl.hidden = true;
    fetchState();
  });
  es.addEventListener('progress', (e) => {
    state.progress.push(JSON.parse(e.data));
    renderProgress();
    noteAgentSignal(); // a progress event = the agent is alive; reset staleness
  });
  es.addEventListener('status', (e) => {
    const status = JSON.parse(e.data).status;
    if (status === 'working') {
      state.progress = []; // a fresh rework round — clear last round's steps
      renderProgress();
    }
    setStatus(status);
  });
}

// ---------- choice blocks ----------

const answerText = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
const hasAnswer = (v) => (Array.isArray(v) ? v.length > 0 : !!v);

function bindChoices() {
  for (const block of docEl.querySelectorAll('.choice-block')) {
    const id = block.dataset.choiceId;
    const multi = block.dataset.multi === 'true';
    const boxes = [...block.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    const otherBox = block.querySelector('input[data-other="true"]');
    const otherText = block.querySelector('.choice-other-text');
    const presets = new Set(boxes.filter((i) => !i.dataset.other).map((i) => i.value));

    // A question answered in an earlier cycle collapses to a one-line summary
    // with a Change button, so it isn't re-asked. Built here, shown via the
    // `answered` class (which also hides the option rows — see CSS).
    const summary = document.createElement('div');
    summary.className = 'choice-summary';
    const summaryVal = document.createElement('span');
    summaryVal.className = 'choice-summary-value';
    const changeBtn = document.createElement('button');
    changeBtn.type = 'button';
    changeBtn.className = 'btn choice-change';
    changeBtn.textContent = 'Change';
    changeBtn.addEventListener('click', () => block.classList.remove('answered'));
    summary.append(summaryVal, changeBtn);
    block.appendChild(summary);
    const refreshSummary = () => {
      summaryVal.textContent = answerText(myPick(id));
    };

    // Who picked what across ALL reviewers (not just this tab): a badge per option
    // with the reviewers who chose it, plus a muted hint when picks diverge. No lock.
    const picksEl = document.createElement('div');
    picksEl.className = 'choice-picks';
    block.appendChild(picksEl);
    const renderPicks = () => {
      const byReviewer = state.choices[id];
      // Guard the shape (DSM-13): a pre-004 restored session can still hold a legacy
      // scalar/array here until its first post-restore sync; Object.entries on a string
      // would yield per-character garbage badges. Only a plain nested object renders.
      const entries =
        byReviewer && typeof byReviewer === 'object' && !Array.isArray(byReviewer)
          ? Object.entries(byReviewer) // [reviewerId, option]
          : [];
      picksEl.innerHTML = '';
      if (!entries.length) {
        picksEl.hidden = true;
        return;
      }
      picksEl.hidden = false;
      // count per option label, skipping empty/non-string labels (FM-10)
      const counts = new Map();
      for (const [rid, opt] of entries) {
        for (const label of Array.isArray(opt) ? opt : [opt]) {
          if (typeof label !== 'string' || label === '') continue;
          if (!counts.has(label)) counts.set(label, []);
          counts.get(label).push(rid);
        }
      }
      for (const [label, rids] of counts) {
        const tag = document.createElement('span');
        tag.className = 'choice-pick';
        tag.textContent = `${rids.length} · ${label}`;
        tag.title = rids.map((r) => (r === reviewer.id ? 'you' : r.slice(0, 8))).join(', ');
        picksEl.appendChild(tag);
      }
      if (counts.size > 1) {
        const hint = document.createElement('span');
        hint.className = 'choice-disagree';
        hint.textContent = 'reviewers disagree';
        picksEl.appendChild(hint);
      }
    };

    // the value an option contributes: for "Other", whatever was typed
    const valueOf = (i) =>
      i.dataset.other ? (otherText ? otherText.value.trim() : '') : i.value;

    const sync = () => {
      const vals = boxes.filter((i) => i.checked).map(valueOf).filter((v) => v !== '');
      const pick = multi ? vals : vals[0];
      // Write only THIS reviewer's entry into the per-reviewer map; a deselect (no
      // pick) removes our entry so the server drops it too (peers' picks untouched).
      const byReviewer = state.choices[id] || (state.choices[id] = {});
      if (pick === undefined || (Array.isArray(pick) && pick.length === 0)) delete byReviewer[reviewer.id];
      else byReviewer[reviewer.id] = pick;
      refreshSummary();
      renderPicks();
      syncReview();
    };

    // restore a saved answer — a value that matches no preset is an "Other" answer
    const saved = myPick(id);
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

    refreshSummary();
    renderPicks();
    if (hasAnswer(myPick(id))) block.classList.add('answered'); // collapse if already answered
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
  if (state.diffing) return; // the diff view is read-only — no commenting on it
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
  state.comments.push({ id, quote: pendingQuote, text, ts: Date.now(), author: author() });
  window.getSelection().removeAllRanges();
  dismissComposer();
  renderComments();
  syncReview();
}

// ---------- comment panel ----------

// A stable, legible color per reviewer id — a hashed hue so the same reviewer gets
// the same badge color across cards without any server-assigned palette.
function authorColor(id) {
  let h = 0;
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

// The display label for an author stamp: their name, else a short id, else 'anonymous'.
function authorLabel(a) {
  if (!a) return 'anonymous';
  if (a.name) return a.name;
  return a.id ? a.id.slice(0, 8) : 'anonymous';
}

// A monogram for a presence avatar: initials from the name (first + last word, or the
// first two letters of a lone name), else the head of the id. Code-point aware so an
// emoji/astral first letter isn't split into a broken surrogate. Coerces a non-string
// name to '' so a malformed roster frame can never throw here (FM-12).
function initials(name, id) {
  const n = (typeof name === 'string' ? name : '').trim();
  if (n) {
    const words = n.split(/\s+/);
    const cp = (w) => [...w][0] || '';
    const mono = words.length > 1 ? cp(words[0]) + cp(words[words.length - 1]) : [...words[0]].slice(0, 2).join('');
    return mono.toUpperCase();
  }
  return [...(typeof id === 'string' ? id : '?')].slice(0, 2).join('').toUpperCase() || '?';
}

// The live "who is viewing now" strip in the top bar: one color-coded avatar per present
// reviewer (you included), colored by reviewerId to match 004's attribution. Names are
// untrusted, so they only ever reach textContent / the title attribute — never innerHTML.
function renderPresence() {
  const el = document.getElementById('presence');
  if (!el) return;
  el.innerHTML = '';
  for (const p of state.presence || []) {
    const av = document.createElement('span');
    av.className = 'presence-avatar';
    if (p && p.id === reviewer.id) av.classList.add('you');
    av.textContent = initials(p && p.name, p && p.id);
    if (p && p.id) av.style.setProperty('--author-color', authorColor(p.id));
    const tabs = p && p.count > 1 ? ` · ${p.count} tabs` : '';
    av.title = `${authorLabel(p)}${p && p.id === reviewer.id ? ' (you)' : ''}${tabs}`;
    el.appendChild(av);
  }
}

// Whether this tab may edit/delete a comment: only its own (the server enforces the
// same rule, so offering edit/delete on a peer's comment would just optimistically
// apply then silently revert on the next sync). An authorless comment (anonymous /
// pre-004) is treated as own, matching single-reviewer behavior.
function ownComment(c) {
  return !c.author || c.author.id === reviewer.id;
}

// A small colored badge naming an author (used on comment cards, replies, chat).
function authorBadge(a) {
  const badge = document.createElement('span');
  badge.className = 'author-badge';
  badge.textContent = authorLabel(a);
  if (a && a.id) badge.style.setProperty('--author-color', authorColor(a.id));
  return badge;
}

function renderComments() {
  const active = state.comments.filter((c) => !c.archived);
  const archived = state.comments.filter((c) => c.archived);
  commentCountEl.textContent = String(active.length);
  updateSubmitButton();
  commentListEl.innerHTML = '';
  if (!state.comments.length) {
    commentListEl.innerHTML =
      '<p class="hint">Select text in the document to leave a comment.</p>';
    return;
  }
  for (const c of active) {
    commentListEl.appendChild(c.id === editingId ? editCard(c) : viewCard(c));
  }
  // A comment whose quote no longer appears in the reworked plan can't anchor.
  // Rather than drop it (and its thread), keep it in a collapsed, distinct
  // section so the conversation is never silently lost.
  if (archived.length) commentListEl.appendChild(archivedSection(archived));
}

function archivedSection(archived) {
  const details = document.createElement('details');
  details.className = 'archived-comments';
  const summary = document.createElement('summary');
  const n = archived.length;
  summary.textContent = `${n} unanchored comment${n === 1 ? '' : 's'} — text no longer in the plan`;
  details.appendChild(summary);
  for (const c of archived) details.appendChild(viewCard(c));
  return details;
}

// The reply thread under a comment: each reply as a small bubble, plus (for an
// active comment while reviewing) a box for the reviewer to follow up. Reply
// text is untrusted (agent- or reviewer-authored) so it is set via textContent,
// never innerHTML.
function renderThread(c) {
  const thread = document.createElement('div');
  thread.className = 'comment-thread';
  for (const r of c.replies || []) {
    const reply = document.createElement('div');
    reply.className = `reply ${r.role === 'agent' ? 'agent' : 'reviewer'}`;
    if (r.role !== 'agent' && r.author) reply.appendChild(authorBadge(r.author));
    const body = document.createElement('span');
    body.className = 'reply-text';
    body.textContent = r.text;
    reply.appendChild(body);
    thread.appendChild(reply);
  }
  if (!c.archived && state.status === 'reviewing') thread.appendChild(replyForm(c));
  return thread;
}

function replyForm(c) {
  const form = document.createElement('form');
  form.className = 'reply-form';
  // a click inside the thread must not scroll/flash the document highlight
  form.addEventListener('click', (e) => e.stopPropagation());
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Reply…';
  input.autocomplete = 'off';
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'btn';
  btn.textContent = 'Reply';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    (c.replies || (c.replies = [])).push({ role: 'reviewer', text, ts: Date.now(), author: author() });
    renderComments(); // the follow-up rides along in the next submit bundle
    syncReview();
  });
  form.append(input, btn);
  return form;
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
  card.className = c.archived ? 'comment-card archived' : 'comment-card';
  card.dataset.cid = c.id;

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  // Attribute the card to its author (color-coded) so reviewers can tell who said what.
  if (c.author) actions.appendChild(authorBadge(c.author));
  // Edit/Delete are offered only for this reviewer's OWN comments — the server rejects
  // edits/deletes to a peer's comment, so showing the controls would just invite a
  // no-op. A peer's comment is read-only here (but its reply thread stays open to all).
  const own = ownComment(c);
  // An archived comment's text is gone from the plan, so there's nothing to edit
  // in place — only offer to dismiss it.
  if (!c.archived && own) {
    actions.append(
      iconBtn('✎', 'Edit comment', (e) => {
        e.stopPropagation();
        beginEdit(c.id);
      })
    );
  }
  if (own) {
    actions.append(
      iconBtn('✕', c.archived ? 'Dismiss comment' : 'Delete comment', (e) => {
        e.stopPropagation();
        deleteComment(c.id);
      })
    );
  }

  const quote = document.createElement('blockquote');
  quote.textContent = truncate(c.quote, 120);
  const body = document.createElement('p');
  body.textContent = c.text;

  card.append(actions, quote, body, renderThread(c));
  card.addEventListener('click', () => {
    if (!c.archived) flashHighlight(c.id);
  });
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
    body: JSON.stringify({
      reviewerId: reviewer.id,
      reviewerName: reviewer.name,
      comments: state.comments,
      choices: myChoices(),
    }),
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
  const n = state.comments.filter((c) => !c.archived).length;
  if (submitMode === 'approve') {
    submitBtn.textContent = 'Approve & finish';
    submitBtn.classList.add('approve');
  } else {
    submitBtn.textContent = n ? `Submit review (${n})` : 'Submit review';
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
    reviewerId: reviewer.id,
    reviewerName: reviewer.name,
    comments: state.comments,
    choices: myChoices(),
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
  state.progress = [];
  renderProgress();
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

// ---------- identity affordance ----------
// A small "you are <name> (edit)" chip. Editing the name updates localStorage and
// re-syncs so peers see the new label on this tab's future mutations.
function renderIdentity() {
  const el = document.getElementById('identity');
  if (!el) return;
  el.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'identity-name';
  label.textContent = `you are ${authorLabel({ id: reviewer.id, name: reviewer.name })}`;
  label.style.setProperty('--author-color', authorColor(reviewer.id));
  const edit = document.createElement('button');
  edit.className = 'btn identity-edit';
  edit.textContent = 'edit';
  edit.addEventListener('click', () => {
    const next = prompt('Your reviewer name (shown to others on this plan):', reviewer.name);
    if (next === null) return;
    reviewer.name = next.trim();
    renderIdentity();
    syncReview(); // re-stamp future work; existing comments keep their prior author
  });
  el.append(label, edit);
}

// ---------- boot ----------

renderIdentity();
renderPresence();
fetchState();
connectEvents();
