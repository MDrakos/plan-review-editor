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
const REVIEWER_NAME_ASKED_KEY = 'pr.reviewerNameAsked';

// The agent can seed a default reviewer name when it starts the session — the CLI
// resolves it from --reviewer-name, $PLANREVIEW_REVIEWER_NAME, or `git config user.name`,
// and the server injects it into this page as window.__planreviewDefaultName. It's a
// FALLBACK only: a name this browser saved earlier (localStorage) always wins, so a
// reviewer who renamed themselves keeps that name. When present it spares a fresh browser
// the first-load prompt entirely (reviewer.name is non-empty, so maybePromptForName() is a
// no-op); empty/whitespace is treated as absent and the prompt still fires.
function serverDefaultName() {
  try {
    return String((window && window.__planreviewDefaultName) || '').trim();
  } catch {
    return '';
  }
}

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
      return localStorage.getItem(REVIEWER_NAME_KEY) || serverDefaultName();
    } catch {
      return serverDefaultName();
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

// A first-time reviewer has no name yet, so the header used to fall back to a slice
// of their id hash. Ask once, on the reviewer's first visit, so the header reads like
// a name instead. Dismissing (Cancel, or a blank/whitespace answer) doesn't re-prompt
// on the next load — it's remembered via a separate "asked" flag so a reviewer who'd
// rather stay nameless isn't nagged every time — and renderIdentity() falls back to a
// neutral placeholder rather than the raw hash (see identityLabel() below).
function maybePromptForName() {
  if (reviewer.name) return;
  let asked = false;
  try {
    asked = localStorage.getItem(REVIEWER_NAME_ASKED_KEY) === '1';
  } catch {
    /* storage blocked — treat as not-yet-asked; we'll just ask again next load too */
  }
  if (asked) return;
  const answer = prompt('Your name (shown to other reviewers on this plan):', '');
  try {
    localStorage.setItem(REVIEWER_NAME_ASKED_KEY, '1');
  } catch {
    /* ignore */
  }
  if (answer && answer.trim()) reviewer.name = answer.trim();
}

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
const sessionMetaEl = document.getElementById('session-meta');
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
const progressFillEl = document.getElementById('progress-fill');
const workingStepEl = document.getElementById('working-step');
const workingElapsedEl = document.getElementById('working-elapsed');
const workingStaleEl = document.getElementById('working-stale');
const archivedNoteEl = document.getElementById('archived-note');
const submitTallyEl = document.getElementById('submit-tally');
const submitModeLabelEl = document.getElementById('submit-mode-label');
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
  presentedAt: null, // when the agent presented this version (server clock)
  diffing: false, // true while the doc pane shows a version diff (read-only)
  comments: [], // {id, quote, text, ts, replies?: [{role:'agent'|'reviewer', text, ts}], archived?}
  choices: {}, // choiceId -> { reviewerId -> value(string) | values(string[]) when multi }
  resolutions: {}, // 008: choiceId -> { option, by, byName, at, reason } — shared decision on a divergent choice
  progress: [], // {text, ts} rework steps, shown in the working overlay
  presence: [], // [{id, name, connectedAt, count}] reviewers viewing now (live, never persisted)
};

let pendingRange = null;
let pendingQuote = '';
// Set instead of pendingRange when the composer was opened from a flow diagram:
// a non-empty list of node/edge anchor ids the comment will be attached to.
let pendingAnchors = null;
let editingId = null; // id of the comment currently open for inline editing

// ---------- status & document ----------

// Short, chip-sized labels — the topbar chip is a state marker, not a sentence.
const STATUS_LABEL = {
  idle: 'waiting',
  reviewing: 'reviewing',
  working: 'reworking',
  done: 'approved',
  ended: 'ended',
};

function setStatus(status, activity) {
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
    if (!wasWorking) startWorkingTimer(activity);
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

// issue 012: abort an in-progress rework and go back to editing on the same
// document. FM-6: disable the button for the duration of the request so a
// double-click can't fire it twice; a 409 just means the agent already
// presented (or another tab/interrupt beat us to it) — a benign no-op, since
// the incoming 'status'/'doc' event settles the UI either way. Any other
// failure is surfaced the same way submit/approve surface theirs.
const interruptBtn = document.getElementById('interrupt-btn');
function flashInterruptError() {
  const original = interruptBtn.textContent;
  interruptBtn.textContent = "Couldn't reach the agent — try again";
  setTimeout(() => {
    interruptBtn.textContent = original;
  }, 2500);
}
interruptBtn.addEventListener('click', async () => {
  if (!confirm('Interrupt the rework and go back to editing? The agent will discard this round.')) return;
  interruptBtn.disabled = true;
  const res = await fetch(api('/api/interrupt'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewerId: reviewer.id }),
  }).catch(() => null);
  interruptBtn.disabled = false;
  if (!res || (!res.ok && res.status !== 409)) flashInterruptError();
  // success (200) or a benign 409: the broadcast 'status' event clears the
  // overlay (and resyncs the panel) — nothing else to do here.
});

// Fenced code blocks arrive from server/markdown.js already carrying
// `class="language-<lang>"`; highlight.js (vendored in public/vendor) reads that
// and colours them in place. Languages it doesn't know — `choice`, which is our
// own fence type, above all — are left exactly as they were.
function highlightDoc() {
  if (!window.hljs) return;
  for (const code of docEl.querySelectorAll('pre > code[class*="language-"]')) {
    const lang = (code.className.match(/language-([\w-]+)/) || [])[1];
    if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
  }
}

function renderDoc(doc) {
  // Rendering the live document means we are NOT in the diff view — reset it, so
  // a reworked doc arriving mid-diff (or any state resync) lands cleanly on the
  // current version rather than leaving a half-open diff.
  resetDiffView();
  docTitleEl.textContent = doc.title || '';
  document.title = doc.title ? `${doc.title} — Plan Review` : 'Plan Review';
  docEl.innerHTML =
    doc.html || '<p class="empty">Waiting for the agent to present a plan…</p>';
  highlightDoc();
  bindFlows();
  state.version = doc.version;
  state.versions = doc.versions || [];
  state.presentedAt = doc.presentedAt || null;
  sessionMetaEl.textContent = doc.version ? `v${doc.version} · session ${SESSION}` : `session ${SESSION}`;
  renderDocMeta();
  updateChangesBar();
  populateVersionSelects();
}

// The meta line under the document h1: which version this is, when the agent
// presented it, and what the reviewer has open on it. Re-rendered whenever the
// comment/decision counts move, so it never goes stale mid-review.
function renderDocMeta() {
  if (!docEl.firstElementChild || state.diffing) return;
  let meta = docEl.querySelector(':scope > .doc-meta');
  const h1 = docEl.querySelector('h1');
  if (!h1) {
    if (meta) meta.remove();
    return;
  }
  if (!meta) {
    meta = document.createElement('div');
    meta.className = 'doc-meta';
    // The h1 may sit inside a [data-changed] wrapper — hang the meta line off
    // that wrapper's top-level slot so it never lands inside the change fill.
    let anchor = h1;
    while (anchor.parentElement && anchor.parentElement !== docEl) anchor = anchor.parentElement;
    anchor.after(meta);
  }
  const comments = state.comments.filter((c) => !c.archived).length;
  const open = openDecisionCount();
  const parts = [`v${state.version}`];
  if (state.presentedAt) parts.push(`presented ${formatPresented(state.presentedAt)}`);
  parts.push(`${comments} comment${comments === 1 ? '' : 's'}`);
  parts.push(`${open} decision${open === 1 ? '' : 's'} open`);
  meta.textContent = parts.join(' · ');
}

// UTC, minute precision — a stamp two reviewers in different zones can compare.
function formatPresented(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// A decision is "open" while this reviewer hasn't picked and it carries no shared
// resolution — the same rule the choice block's head chip uses.
function openDecisionCount() {
  let n = 0;
  for (const block of docEl.querySelectorAll('.choice-block')) {
    const id = block.dataset.choiceId;
    if (!state.resolutions[id] && !hasAnswer(myPick(id))) n++;
  }
  return n;
}

// Blocks changed since the last cycle carry a data-changed attribute (added by
// the server). Show a dismissible bar when there are any; a freshly rendered
// doc always starts with its highlights visible.
function updateChangesBar() {
  docEl.classList.remove('changes-dismissed');
  const n = docEl.querySelectorAll('[data-changed]').length;
  changesBar.hidden = n === 0;
  // ★ is the brand motif for "new in this version" — used here and nowhere else.
  if (n > 0)
    changesLabel.textContent = `★ v${state.version} · ${n} block${n === 1 ? '' : 's'} changed since your last review`;
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
  highlightDoc();
  bindFlows();
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
  setStatus(s.status, { workingSince: s.workingSince, lastAgentActivity: s.lastAgentActivity });
  state.comments = (s.review && s.review.comments) || [];
  state.choices = (s.review && s.review.choices) || {};
  state.resolutions = (s.review && s.review.resolutions) || {};
  // Only active comments anchor into the document; archived ones (their quote is
  // gone from the reworked plan) have nothing to highlight and live collapsed.
  for (const c of state.comments)
    if (!c.archived) {
      if (c.anchors) markFlowAnchors(c.anchors, c.id);
      else anchorByQuote(c.quote, c.id);
    }
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

// A flat bordered row, not a bubble: every message is left-aligned and carries
// its author as a label plus a left rule in that author's colour, so attribution
// never depends on which side of the panel a message landed on.
function appendChatMessage(msg) {
  const el = document.createElement('div');
  el.className = `chat-msg ${msg.role}`;
  const who = document.createElement('span');
  who.className = 'chat-author';
  if (msg.role === 'agent') {
    who.textContent = 'Agent';
  } else {
    who.textContent = authorLabel(msg.author || { id: reviewer.id, name: reviewer.name });
    const id = (msg.author && msg.author.id) || reviewer.id;
    el.style.setProperty('--author-color', authorColor(id));
  }
  el.appendChild(who);
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
  // A square in the agent's colour and a line of text — no bouncing dots.
  typingEl.innerHTML = '<span class="dot"></span>agent is typing…';
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

// The agent reports steps as it goes and never announces a total up front, so
// "step N of total" is derived: every step seen so far, plus the one running.
// A determinate bar beats a spinner here — the protocol can already resolve how
// far along the round is, so asserting indeterminacy would throw that away.
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
    workingStepEl.textContent = '';
    progressFillEl.style.width = '0%';
    return;
  }
  items.forEach((p, i) => {
    const current = i === items.length - 1;
    const li = document.createElement('li');
    li.className = `progress-item ${current ? 'current' : 'done'}`;
    const mark = document.createElement('span');
    mark.className = 'progress-mark';
    mark.textContent = current ? '›' : '✓';
    const txt = document.createElement('span');
    txt.className = 'progress-text';
    txt.textContent = p.text;
    li.append(mark, txt);
    progressListEl.appendChild(li);
  });
  const n = items.length;
  workingStepEl.textContent = `step ${n}`;
  // No total is announced, so the bar is fed n/(n+1): it advances on every step
  // and never claims 100% while the agent is still working. Honest about being
  // open-ended without falling back to a spinner.
  progressFillEl.style.width = `${Math.round((n / (n + 1)) * 100)}%`;
  progressListEl.scrollTop = progressListEl.scrollHeight;
}

// ---------- working-overlay liveness ----------
//
// While the agent reworks, the spinner alone can't tell "still thinking" from
// "silently died." So the overlay shows a live elapsed timer, and if no sign of
// life arrives for a while it adds a muted, advisory "still working" line. Purely
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

// `activity`, when present, carries the server's view of this round's real
// start/last-signal times ({ workingSince, lastAgentActivity }) — a refreshed
// (or freshly reconnected) tab passes this through so its clock reflects the
// round already in progress instead of restarting at 0:00. Number.isFinite
// (not ??/||) guards against a malformed/legacy payload's non-numeric field
// propagating into Math.max and producing NaN, which would render "No updates
// for NaN s" forever. Math.max(last, since) also means a stale leftover
// lastAgentActivity from a PRIOR round can never make a brand-new round look
// instantly stale — the round's own start time is always the floor.
function startWorkingTimer(activity) {
  const since = activity && Number.isFinite(activity.workingSince) ? activity.workingSince : Date.now();
  const last = activity && Number.isFinite(activity.lastAgentActivity) ? activity.lastAgentActivity : since;
  workingStartTs = since;
  lastSignalTs = Math.max(last, since);
  tickWorking(); // paint the real elapsed time immediately rather than leaving a blank first second
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

// The chat box is a textarea so it can grow with a long message (see
// #chat-form textarea in style.css). That costs it Enter-to-send, so put it
// back: Enter sends, shift+Enter starts a new line.
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  chatFormEl.requestSubmit();
});

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
    const d = JSON.parse(e.data);
    if (d.status === 'working') {
      state.progress = []; // a fresh rework round — clear last round's steps
      renderProgress();
    }
    const wasWorking = state.status === 'working'; // capture BEFORE setStatus mutates it
    setStatus(d.status, d);
    // issue 012: an interrupt lands as a 'status' event alone (the doc never
    // changed, so no 'doc' event follows) — resync the panel once (peer edits,
    // agent replies) on the working -> reviewing transition. Guarded on the
    // PRIOR status so a present's own resync (via its 'doc' event) is never
    // duplicated here.
    if (d.status === 'reviewing' && wasWorking) fetchState();
  });
}

// ---------- choice blocks ----------

const answerText = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
const hasAnswer = (v) => (Array.isArray(v) ? v.length > 0 : !!v);

// grows a textarea to fit its content, collapsing back down when text is removed.
// scrollHeight excludes border, but box-sizing:border-box height includes it —
// add back offsetHeight - clientHeight (the border width) or the bottom line clips.
const autoGrow = (el) => {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
};

function bindChoices() {
  for (const block of docEl.querySelectorAll('.choice-block')) {
    const id = block.dataset.choiceId;
    const multi = block.dataset.multi === 'true';
    const boxes = [...block.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    const otherBox = block.querySelector('input[data-other="true"]');
    const otherText = block.querySelector('.choice-other-text');
    const presets = new Set(boxes.filter((i) => !i.dataset.other).map((i) => i.value));

    // Re-shape the server's flat markup into the decision block: a plum header
    // bar naming the decision and its state, then a body holding the prompt and
    // one bordered option group. Layout only — no option or value is touched.
    const optionRows = [...block.querySelectorAll('.choice-option')];
    const prompt = block.querySelector('.choice-prompt');
    const group = document.createElement('div');
    group.className = 'choice-options';
    for (const row of optionRows) {
      boldLeadIn(row.querySelector('span'));
      group.appendChild(row);
    }
    const body = document.createElement('div');
    body.className = 'choice-body';
    if (prompt) body.appendChild(prompt);
    body.appendChild(group);

    const head = document.createElement('div');
    head.className = 'choice-head';
    const headLabel = document.createElement('span');
    headLabel.className = 'choice-head-label';
    headLabel.textContent = 'Decision';
    const headId = document.createElement('span');
    headId.className = 'choice-head-id';
    headId.textContent = id;
    const stateChip = document.createElement('span');
    stateChip.className = 'choice-state';
    head.append(headLabel, headId, stateChip);
    block.replaceChildren(head, body);

    // Who picked what, shown as initial badges on the option row itself — one
    // holder per row, keyed by the value that row contributes.
    const rowPicks = new Map();
    for (const row of optionRows) {
      const input = row.querySelector('input');
      const holder = document.createElement('span');
      holder.className = 'choice-row-picks';
      row.appendChild(holder);
      if (input) rowPicks.set(input.dataset.other ? ' other' : input.value, holder);
    }

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
    body.appendChild(summary);
    const refreshSummary = () => {
      summaryVal.textContent = answerText(myPick(id));
    };

    // Count who picked each option label across ALL reviewers → Map<label, reviewerId[]>,
    // skipping empty/non-string labels (FM-10). Shared by renderPicks (badges + the
    // "reviewers disagree" hint) and the 008 resolve control (divergence = >1 label), so
    // the divergence rule lives in ONE place. Guards the shape (DSM-13): a pre-004
    // restored session can hold a legacy scalar/array here until its first post-restore
    // sync; Object.entries on a string would yield per-character garbage. Only a plain
    // nested object counts. Also tracks the flat set of distinct reviewers who've picked
    // ANYTHING here (across all labels), so renderPicks can tell "just me" from "others
    // too" without re-deriving reviewer identity from the label buckets a second time.
    const pickCounts = () => {
      const byReviewer = state.choices[id];
      const entries =
        byReviewer && typeof byReviewer === 'object' && !Array.isArray(byReviewer)
          ? Object.entries(byReviewer) // [reviewerId, option]
          : [];
      const counts = new Map();
      const reviewers = new Set();
      for (const [rid, opt] of entries) {
        for (const label of Array.isArray(opt) ? opt : [opt]) {
          if (typeof label !== 'string' || label === '') continue;
          if (!counts.has(label)) counts.set(label, []);
          counts.get(label).push(rid);
          reviewers.add(rid);
        }
      }
      return { counts, reviewers };
    };

    // The state of the decision, in the header bar. Divergence is named here
    // rather than as a separate hint under the options.
    const renderState = () => {
      const resolution = state.resolutions[id];
      const divergent = pickCounts().counts.size > 1;
      if (resolution) {
        stateChip.className = 'choice-state answered';
        stateChip.textContent = 'Resolved';
      } else if (divergent) {
        stateChip.className = 'choice-state open';
        stateChip.textContent = 'Reviewers disagree';
      } else if (hasAnswer(myPick(id))) {
        stateChip.className = 'choice-state answered';
        stateChip.textContent = 'Answered';
      } else {
        stateChip.className = 'choice-state open';
        stateChip.textContent = 'Open';
      }
      renderDocMeta(); // the meta line counts open decisions
    };

    // Per-row initial badges replace the old tally line below the block, so a
    // lone reviewer never reads their own answer echoed back (issue 011 §3) —
    // badges only appear once some OTHER reviewer has weighed in.
    const renderPicks = () => {
      const { counts, reviewers } = pickCounts();
      for (const holder of rowPicks.values()) holder.innerHTML = '';
      const onlyMe = reviewers.size === 0 || (reviewers.size === 1 && reviewers.has(reviewer.id));
      if (!onlyMe) {
        for (const [label, rids] of counts) {
          const holder = rowPicks.get(presets.has(label) ? label : ' other');
          if (!holder) continue;
          for (const rid of rids) holder.appendChild(pickBadge(rid));
        }
      }
      for (const row of optionRows) {
        const input = row.querySelector('input');
        row.classList.toggle('picked', !!(input && input.checked));
      }
      renderState();
    };

    // 008: on a DIVERGENT choice, offer a "Resolve to:" control so reviewers can
    // converge on one attributed, optionally-reasoned shared decision. It appears only
    // on divergence (or once a resolution exists) — a single reviewer / all-agree block
    // never shows it, so those stay byte-for-byte 004. Any reviewer can set/change/clear;
    // updates sync to peers over 004's review SSE (fetchState rebuilds this block).
    const resolveEl = document.createElement('div');
    resolveEl.className = 'choice-resolve';
    body.appendChild(resolveEl);
    let resolveEditing = false; // true while the picker is open on an already-resolved block

    // Optimistically apply the intent locally, then POST it. intent: {option, reason?}
    // to set/change, or null to clear. syncReview carries only this choice's intent.
    const postResolution = (intent) => {
      if (intent === null) delete state.resolutions[id];
      else state.resolutions[id] = { option: intent.option, reason: intent.reason || '', by: reviewer.id, byName: reviewer.name || '' };
      resolveEditing = false;
      renderResolution();
      renderState(); // the head chip and the submit caption both count resolutions
      updateSubmitButton();
      syncReview({ [id]: intent });
    };

    function renderResolution() {
      resolveEl.innerHTML = '';
      const resolution = state.resolutions[id];
      const divergent = pickCounts().counts.size > 1;
      // No-friction guard: show nothing unless the block is divergent or already resolved.
      if (!resolution && !divergent) {
        resolveEl.hidden = true;
        return;
      }
      resolveEl.hidden = false;

      // Resolved banner (unless we're editing it): "Resolved to <option> — by <name>",
      // name colored by reviewerId (004 attribution), reason below, + Change / Clear.
      if (resolution && !resolveEditing) {
        const line = document.createElement('div');
        line.className = 'choice-resolved';
        const lead = document.createElement('span');
        lead.textContent = 'Resolved to ';
        const opt = document.createElement('strong');
        opt.textContent = resolution.option;
        const by = document.createElement('span');
        by.className = 'choice-resolved-by';
        by.textContent = ` — by ${authorLabel({ id: resolution.by, name: resolution.byName })}`;
        // Color by reviewerId via --author-color, the same custom-property convention
        // chat/comment/presence attribution uses (the .choice-resolved-by CSS reads it).
        if (resolution.by) by.style.setProperty('--author-color', authorColor(resolution.by));
        line.append(lead, opt, by);
        resolveEl.appendChild(line);
        if (resolution.reason) {
          const reasonEl = document.createElement('div');
          reasonEl.className = 'choice-resolved-reason';
          reasonEl.textContent = resolution.reason; // untrusted — textContent only
          resolveEl.appendChild(reasonEl);
        }
        const controls = document.createElement('div');
        controls.className = 'choice-resolve-controls';
        const changeBtn = document.createElement('button');
        changeBtn.type = 'button';
        changeBtn.className = 'btn choice-resolve-change';
        changeBtn.textContent = 'Change';
        changeBtn.addEventListener('click', () => {
          resolveEditing = true;
          renderResolution();
        });
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'btn choice-resolve-clear';
        clearBtn.textContent = 'Clear';
        clearBtn.addEventListener('click', () => postResolution(null));
        controls.append(changeBtn, clearBtn);
        resolveEl.appendChild(controls);
        // Resolving picks one answer to act on; it does not throw the others
        // away. Say so, in the reviewers' own numbers.
        const raw = [...pickCounts().counts].map(([label, rids]) => `${label} ×${rids.length}`);
        if (raw.length) {
          const rawEl = document.createElement('div');
          rawEl.className = 'choice-raw-picks';
          rawEl.textContent = `raw picks still travel to the agent: ${raw.join(', ')}`;
          resolveEl.appendChild(rawEl);
        }
        return;
      }

      // Picker: "Resolve to:" + one button per PRESET option + an optional reason input.
      const label = document.createElement('span');
      label.className = 'choice-resolve-label';
      label.textContent = 'Resolve to:';
      resolveEl.appendChild(label);
      const reasonInput = document.createElement('input');
      reasonInput.type = 'text';
      reasonInput.className = 'choice-resolve-reason';
      reasonInput.placeholder = 'Why this option? (optional)';
      if (resolution && resolution.reason) reasonInput.value = resolution.reason;
      for (const optVal of presets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn choice-resolve-option';
        b.textContent = optVal;
        if (resolution && resolution.option === optVal) b.classList.add('current');
        b.addEventListener('click', () => postResolution({ option: optVal, reason: reasonInput.value.trim() }));
        resolveEl.appendChild(b);
      }
      resolveEl.appendChild(reasonInput);
      if (resolution) {
        // editing an existing resolution — let the reviewer back out to the banner
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn choice-resolve-cancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => {
          resolveEditing = false;
          renderResolution();
        });
        resolveEl.appendChild(cancel);
      }
    }

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
      renderResolution(); // a pick change can open/close divergence → show/hide the control
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
            if (otherText) {
              otherText.value = custom;
              autoGrow(otherText);
            }
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
        autoGrow(otherText);
        sync();
      });
    }

    refreshSummary();
    renderPicks();
    renderResolution();
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
  if (e.target.closest && e.target.closest('.flow-block')) return; // panning, not selecting
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

// Open the composer next to `rect`, quoting `quote`. Shared by the selection fab
// and by a click on a diagram node or edge.
function openComposerAt(rect, quote) {
  fabEl.hidden = true;
  composerQuoteEl.textContent = truncate(quote, 160);
  composerTextEl.value = '';
  composerEl.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - 380))}px`;
  composerEl.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 220)}px`;
  composerEl.hidden = false;
  composerTextEl.focus();
}

document.getElementById('fab-btn').addEventListener('click', () => {
  if (!pendingRange) return;
  openComposerAt(pendingRange.getBoundingClientRect(), pendingQuote);
});

function dismissComposer() {
  composerEl.hidden = true;
  pendingRange = null;
  pendingAnchors = null;
  pendingQuote = '';
  clearFlowSelection();
}

document.getElementById('composer-cancel').addEventListener('click', dismissComposer);

document.getElementById('composer-save').addEventListener('click', saveComment);

composerTextEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') dismissComposer();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
});

function saveComment() {
  const text = composerTextEl.value.trim();
  if (!text || (!pendingRange && !pendingAnchors)) return;
  const id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const comment = { id, quote: pendingQuote, text, ts: Date.now(), author: author() };
  if (pendingAnchors) {
    comment.anchors = pendingAnchors;
    markFlowAnchors(pendingAnchors, id);
  } else {
    highlightRange(pendingRange, id);
  }
  state.comments.push(comment);
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
  const roster = state.presence || [];
  for (const p of roster) {
    const av = document.createElement('span');
    av.className = 'presence-avatar';
    if (p && p.id === reviewer.id) av.classList.add('you');
    av.textContent = initials(p && p.name, p && p.id);
    if (p && p.id) av.style.setProperty('--author-color', authorColor(p.id));
    const tabs = p && p.count > 1 ? ` ×${p.count}` : '';
    av.title = `${authorLabel(p)}${p && p.id === reviewer.id ? ' (you)' : ''}${tabs}`;
    el.appendChild(av);
  }
  if (roster.length) {
    const count = document.createElement('span');
    count.className = 'presence-count';
    count.textContent = `${roster.length} viewing`;
    el.appendChild(count);
  }
}

// Whether this tab may edit/delete a comment: only its own (the server enforces the
// same rule, so offering edit/delete on a peer's comment would just optimistically
// apply then silently revert on the next sync). An authorless comment (anonymous /
// pre-004) is treated as own, matching single-reviewer behavior.
function ownComment(c) {
  return !c.author || c.author.id === reviewer.id;
}

// A reviewer's display name, looked up wherever this tab has seen one: the live
// presence roster first, then any comment they authored. Empty when unknown —
// initials() falls back to the id head.
function reviewerName(rid) {
  if (rid === reviewer.id) return reviewer.name;
  const present = (state.presence || []).find((p) => p && p.id === rid);
  if (present && present.name) return present.name;
  const authored = state.comments.find((c) => c.author && c.author.id === rid && c.author.name);
  return authored ? authored.author.name : '';
}

// An initials badge marking one reviewer's pick on an option row.
function pickBadge(rid) {
  const b = document.createElement('span');
  b.className = 'pick-badge';
  b.textContent = initials(reviewerName(rid), rid);
  b.style.setProperty('--author-color', authorColor(rid));
  b.title = rid === reviewer.id ? 'you' : authorLabel({ id: rid, name: reviewerName(rid) });
  return b;
}

// Bold an option's lead-in — the part before the em dash the author wrote — so a
// row reads "**1 hour** — friendlier for slow inboxes". Only applied when the
// label is a single text node, so authored inline markup is never re-parsed.
function boldLeadIn(span) {
  if (!span || span.childNodes.length !== 1 || span.firstChild.nodeType !== Node.TEXT_NODE) return;
  const idx = span.textContent.indexOf(' — ');
  if (idx <= 0) return;
  const strong = document.createElement('strong');
  strong.textContent = span.textContent.slice(0, idx);
  const rest = document.createTextNode(span.textContent.slice(idx));
  span.replaceChildren(strong, rest);
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
  archivedNoteEl.textContent = archived.length ? `${archived.length} archived` : '';
  updateSubmitButton();
  renderDocMeta();
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
  // Only offer bulk-clear when the reviewer actually owns an archived comment
  // (a session full of a peer's archived comments, multi-reviewer, shows none)
  // AND the session is actively reviewing (mirrors replyForm's status gate,
  // line 800) — a rework in flight could re-anchor one of these comments
  // server-side before its `archived: false` update reaches this tab; clearing
  // mid-flight on stale data would drop that comment for good (FMEA finding).
  if (archived.some(ownComment) && state.status === 'reviewing') {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn clear-archived';
    clearBtn.textContent = 'Clear all';
    clearBtn.title = 'Dismiss all of your archived comments';
    clearBtn.addEventListener('click', clearArchived);
    details.appendChild(clearBtn);
  }
  for (const c of archived) details.appendChild(viewCard(c));
  return details;
}

// Dismiss every archived comment this reviewer owns, in one action — never a
// peer's (mirrors the existing edit/delete ownership rule in viewCard()). Reuses
// the same author-scoped sync path as an individual dismiss (deleteComment):
// filter locally, then let syncReview()/mergeComments do the rest, so a peer's
// stale tab can never resurrect what this reviewer just cleared.
//
// The status re-check below (not just the render-time gate in archivedSection())
// is load-bearing: setStatus() never re-renders the sidebar, so a "Clear all"
// button rendered while reviewing stays in the DOM and bound through a status
// flip to 'working' — a stale click must still be refused here, on data that
// may have re-anchored server-side since the last render (pre-PR logic finding).
function clearArchived() {
  if (state.status !== 'reviewing') return;
  const keep = state.comments.filter((c) => !(c.archived && ownComment(c)));
  if (keep.length === state.comments.length) return;
  state.comments = keep;
  renderComments();
  syncReview();
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
    // A labelled entry, not a bubble: the author reads off the label above the
    // text, so an agent and a reviewer reply share one column and one rule.
    const who = document.createElement('span');
    who.className = 'reply-author';
    if (r.role === 'agent') {
      who.textContent = 'Agent';
    } else {
      who.textContent = authorLabel(r.author);
      if (r.author && r.author.id) who.style.setProperty('--author-color', authorColor(r.author.id));
    }
    const body = document.createElement('span');
    body.className = 'reply-text';
    body.textContent = r.text;
    reply.append(who, body);
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

// A text button — the words carry the action, so no icon set is needed.
function textBtn(label, title, onClick, destructive) {
  const b = document.createElement('button');
  b.className = destructive ? 'icon-btn destructive' : 'icon-btn';
  b.title = title;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// HH:MM, local — enough to order a day's comments without spending a whole row.
function shortTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Three stacked rows — header / body / thread. Nothing is absolutely positioned
// and nothing overlaps, so a wide author name can never run over the comment
// text however long either gets (issue 011 §2).
function viewCard(c) {
  const card = document.createElement('div');
  card.className = c.archived ? 'comment-card archived' : 'comment-card';
  card.dataset.cid = c.id;

  // row 1: who, when, and what you can do about it
  const head = document.createElement('div');
  head.className = 'card-head';
  if (c.author) head.appendChild(authorBadge(c.author));
  if (c.ts) {
    const time = document.createElement('span');
    time.className = 'card-time';
    time.textContent = shortTime(c.ts);
    head.appendChild(time);
  }
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  // Edit/Delete are offered only for this reviewer's OWN comments — the server rejects
  // edits/deletes to a peer's comment, so showing the controls would just invite a
  // no-op. A peer's comment is read-only here (but its reply thread stays open to all).
  const own = ownComment(c);
  // An archived comment's text is gone from the plan, so there's nothing to edit
  // in place — only offer to dismiss it.
  if (!c.archived && own) {
    actions.append(
      textBtn('Edit', 'Edit comment', (e) => {
        e.stopPropagation();
        beginEdit(c.id);
      })
    );
  }
  if (own) {
    actions.append(
      textBtn(
        c.archived ? 'Dismiss' : 'Delete',
        c.archived ? 'Dismiss comment' : 'Delete comment',
        (e) => {
          e.stopPropagation();
          deleteComment(c.id);
        },
        true
      )
    );
  }
  head.appendChild(actions);

  // row 2: the quoted anchor, then the comment itself
  const body = document.createElement('div');
  body.className = 'card-body';
  const quote = document.createElement('blockquote');
  quote.textContent = truncate(c.quote, 120);
  const text = document.createElement('p');
  text.textContent = c.text;
  body.append(quote, text);

  card.append(head, body, renderThread(c));
  card.addEventListener('click', () => {
    if (!c.archived) focusComment(c.id);
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

// Draw attention by scrolling the anchor into view and outlining the matching
// card — never by recolouring the mark. The highlight colour is semantic
// ("there is a comment here"), so flashing it would say something untrue.
function focusComment(id) {
  const target =
    docEl.querySelector(`mark[data-cid="${id}"]`) || docEl.querySelector(`[data-cids~="${id}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const card of commentListEl.querySelectorAll('.comment-card.focused'))
    card.classList.remove('focused');
  const card = commentListEl.querySelector(`.comment-card[data-cid="${id}"]`);
  if (card) {
    card.classList.add('focused');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// The reverse trip: clicking a highlight in the document focuses its card.
docEl.addEventListener('click', (e) => {
  const mark = e.target.closest && e.target.closest('mark.hl');
  if (mark && mark.dataset.cid) focusComment(mark.dataset.cid);
});

// Sync this tab's review to the server. `resolutions` (008) is an optional per-choice
// resolve/clear intent ({ choiceId: {option, reason?} | null }) carried only when the
// reviewer sets/changes/clears a resolution — ordinary comment/pick syncs omit it, so
// the shared resolutions slot is only ever touched by a deliberate action.
async function syncReview(resolutions) {
  const body = {
    reviewerId: reviewer.id,
    reviewerName: reviewer.name,
    comments: state.comments,
    choices: myChoices(),
  };
  if (resolutions) body.resolutions = resolutions;
  await fetch(api('/api/review-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    submitModeLabelEl.textContent = 'apply my feedback, then proceed';
  } else {
    submitBtn.textContent = 'Submit review';
    submitBtn.classList.remove('approve');
    submitModeLabelEl.textContent = 'rework and show me again';
  }
  // The count moved off the button label into the caption row, next to the
  // decision tally — the button says what it does, the caption says what rides
  // along with it.
  const resolved = Object.keys(state.resolutions || {}).length;
  const parts = [`${n} comment${n === 1 ? '' : 's'}`];
  if (resolved) parts.push(`${resolved} decision${resolved === 1 ? '' : 's'} resolved`);
  submitTallyEl.textContent = parts.join(' · ');
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
  for (const g of docEl.querySelectorAll(`[data-cids~="${cid}"]`)) {
    const rest = g.dataset.cids.split(' ').filter((x) => x && x !== cid);
    if (rest.length) g.dataset.cids = rest.join(' ');
    else {
      delete g.dataset.cids;
      g.classList.remove('commented');
    }
  }
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

// This tab's own label for the "you are" chip: the reviewer's name, else a neutral
// placeholder — never the raw id hash. Unlike authorLabel() (used for OTHER
// reviewers' attribution in comments/badges/tooltips, where the hash is kept as a
// disambiguating fallback), there's only ever one "you" in this slot, so there's no
// collision to disambiguate.
function identityLabel() {
  return reviewer.name || 'Reviewer';
}

function renderIdentity() {
  const el = document.getElementById('identity');
  if (!el) return;
  el.innerHTML = '';
  const lead = document.createElement('span');
  lead.textContent = 'You are';
  const label = document.createElement('span');
  label.className = 'identity-name';
  label.textContent = identityLabel();
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
  el.append(lead, label, edit);
}

// ---------- flow diagrams (```flow) ----------
//
// A diagram is a viewport, not a picture: everything drawable sits in one
// <g class="flow-pan"> and the whole pan/zoom interaction is a single transform
// on it. Clicking a box or an arrow opens the same composer a text selection
// does; the comment carries `anchors` (node/edge ids) instead of anchoring on
// its quote, and the server carries it forward on those ids.

const flowClamp = (v, a, b) => Math.max(a, Math.min(b, v));

function flowEl(id) {
  return docEl.querySelector(`[data-anchor-id="${CSS.escape(id)}"]`);
}

// Mark every still-present member of `anchors` as carrying comment `cid`. Ids
// that no longer exist are simply skipped — the comment itself is unaffected,
// exactly as a quote that no longer anchors is.
function markFlowAnchors(anchors, cid) {
  for (const id of anchors) {
    const el = flowEl(id);
    if (!el) continue;
    el.classList.add('commented');
    const cids = (el.dataset.cids || '').split(' ').filter(Boolean);
    if (!cids.includes(cid)) cids.push(cid);
    el.dataset.cids = cids.join(' ');
  }
}

function clearFlowSelection() {
  for (const el of docEl.querySelectorAll('.flow-node.selected, .flow-edge.selected'))
    el.classList.remove('selected');
}

// The composer's quote for a group: the members' visible labels, abbreviated
// past three so a twelve-box selection doesn't fill the card.
function flowLabel(ids) {
  const names = ids.map((id) => (flowEl(id) || {}).dataset?.label).filter(Boolean);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function flowCommentable() {
  return state.status === 'reviewing' && !state.diffing;
}

function openFlowComposer(els) {
  if (!els.length) return;
  const ids = els.map((el) => el.dataset.anchorId);
  // Already commented, and only one thing picked: take the reviewer to that
  // thread rather than starting a second one, as clicking a highlight does.
  if (els.length === 1 && els[0].dataset.cids) {
    focusComment(els[0].dataset.cids.split(' ')[0]);
    return;
  }
  if (!flowCommentable()) return;
  pendingRange = null;
  pendingAnchors = ids;
  pendingQuote = flowLabel(ids);
  openComposerAt(els[0].getBoundingClientRect(), pendingQuote);
}

// Wire pan / zoom / box-select onto every diagram in the freshly rendered
// document. View state is per-diagram, in memory, and deliberately resets on
// re-present: a pan carried across a rework round leaves the reviewer looking at
// empty space where a deleted box used to be.
function bindFlows() {
  for (const block of docEl.querySelectorAll('.flow-block')) {
    if (block.dataset.flowBound) continue;
    block.dataset.flowBound = '1';
    const svg = block.querySelector('.flow-svg');
    const pan = block.querySelector('.flow-pan');
    if (!svg || !pan) continue;

    let scale = 1;
    let tx = 0;
    let ty = 0;
    const apply = () => pan.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
    // Screen to user space via the element's own CTM. A width ratio silently
    // mis-maps once the SVG is wider than its viewBox and letterboxes, and the
    // diagram then drifts under the pointer as it zooms.
    const toUser = (cx, cy) => {
      const m = svg.getScreenCTM();
      if (!m) return { x: 0, y: 0 };
      const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    };
    const pxToUser = () => {
      const m = svg.getScreenCTM();
      return m && m.a ? 1 / m.a : 1;
    };
    // Zoom about a point: that point must land where it already is, so the
    // translate absorbs the scale change instead of the diagram drifting.
    const zoomTo = (next, px, py) => {
      next = flowClamp(next, 0.4, 5);
      tx = px - (px - tx) * (next / scale);
      ty = py - (py - ty) * (next / scale);
      scale = next;
      apply();
    };
    const centre = () => {
      const r = svg.getBoundingClientRect();
      return toUser(r.left + r.width / 2, r.top + r.height / 2);
    };
    const reset = () => {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    };

    // A plain wheel must still scroll the page — only the zoom gesture is taken.
    // A trackpad pinch arrives as a ctrlKey wheel, so pinch works for free.
    svg.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const p = toUser(e.clientX, e.clientY);
        zoomTo(scale * Math.exp(-e.deltaY / 300), p.x, p.y);
      },
      { passive: false }
    );

    const marquee = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    marquee.setAttribute('class', 'flow-marquee');
    let drag = null;
    let marq = null;
    let moved = false;
    let selectMode = false;

    const drawMarquee = (cx, cy) => {
      const a = toUser(marq.x, marq.y);
      const b = toUser(cx, cy);
      marquee.setAttribute('x', Math.min(a.x, b.x));
      marquee.setAttribute('y', Math.min(a.y, b.y));
      marquee.setAttribute('width', Math.abs(b.x - a.x));
      marquee.setAttribute('height', Math.abs(b.y - a.y));
      if (!marquee.parentNode) svg.appendChild(marquee);
    };
    // An item is in the box when its bounding-box CENTRE is, for nodes and edges
    // alike. Plain overlap over-selects wildly: a long bowed edge has a bounding
    // box spanning most of the diagram.
    const hits = (cx, cy) => {
      const l = Math.min(marq.x, cx);
      const r = Math.max(marq.x, cx);
      const t = Math.min(marq.y, cy);
      const b = Math.max(marq.y, cy);
      const out = [];
      for (const el of svg.querySelectorAll('[data-anchor-id]')) {
        const k = el.getBoundingClientRect();
        const mx = k.left + k.width / 2;
        const my = k.top + k.height / 2;
        if (mx >= l && mx <= r && my >= t && my <= b) out.push(el);
      }
      return out;
    };

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      moved = false;
      if (e.shiftKey || selectMode) {
        e.preventDefault();
        marq = { x: e.clientX, y: e.clientY };
        clearFlowSelection();
        drawMarquee(e.clientX, e.clientY);
        svg.setPointerCapture(e.pointerId);
        return;
      }
      // Deliberately NO setPointerCapture here. While capture is held the browser
      // retargets the following `click` to the capturing <svg>, so
      // closest('[data-anchor-id]') finds nothing and clicking a box silently
      // stops opening the composer. Capture is taken below, once it is a real drag.
      drag = { x: e.clientX, y: e.clientY, tx, ty };
    });

    svg.addEventListener('pointermove', (e) => {
      if (marq) {
        drawMarquee(e.clientX, e.clientY);
        moved = true;
        clearFlowSelection();
        for (const el of hits(e.clientX, e.clientY)) el.classList.add('selected');
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        svg.classList.add('panning');
        try {
          svg.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer may already be gone */
        }
      }
      const k = pxToUser();
      tx = drag.tx + dx * k;
      ty = drag.ty + dy * k;
      apply();
    });

    const finish = (e) => {
      if (marq) {
        let sel = hits(e.clientX, e.clientY);
        // A shift-click with no drag: fall back to whatever is under the pointer.
        if (!sel.length) {
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const g = under && under.closest && under.closest('[data-anchor-id]');
          if (g) sel = [g];
        }
        marquee.remove();
        marq = null;
        moved = true; // swallow the click this release is about to produce
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        clearFlowSelection();
        for (const el of sel) el.classList.add('selected');
        openFlowComposer(sel);
        return;
      }
      if (!drag) return;
      drag = null;
      svg.classList.remove('panning');
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', finish);

    // A pan or a box-select that ends over an item must not also click that item.
    svg.addEventListener(
      'click',
      (e) => {
        if (!moved) return;
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      },
      true
    );
    svg.addEventListener('dblclick', (e) => {
      e.preventDefault();
      reset();
    });

    block.querySelector('.flow-tools').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.mode === 'select') {
        selectMode = !selectMode;
        b.setAttribute('aria-pressed', String(selectMode));
        svg.classList.toggle('selecting', selectMode);
        if (!selectMode) clearFlowSelection();
        return;
      }
      const c = centre();
      if (b.dataset.zoom === 'in') zoomTo(scale * 1.25, c.x, c.y);
      else if (b.dataset.zoom === 'out') zoomTo(scale / 1.25, c.x, c.y);
      else reset();
    });

    block.addEventListener('keydown', (e) => {
      if (e.target.closest('.flow-tools')) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        const c = centre();
        zoomTo(scale * 1.25, c.x, c.y);
      } else if (e.key === '-') {
        e.preventDefault();
        const c = centre();
        zoomTo(scale / 1.25, c.x, c.y);
      } else if (e.key === '0') {
        e.preventDefault();
        reset();
      }
    });
  }
}

// Click and Enter are delegated to the document, so they survive every
// re-render; the per-diagram state above is what needs re-binding.
docEl.addEventListener('click', (e) => {
  if (e.target.closest('.flow-tools')) return;
  const g = e.target.closest('[data-anchor-id]');
  if (g) openFlowComposer([g]);
});

docEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const g = e.target.closest && e.target.closest('[data-anchor-id]');
  if (!g) return;
  e.preventDefault();
  openFlowComposer([g]);
});

// ---------- boot ----------

maybePromptForName();
renderIdentity();
renderPresence();
fetchState();
connectEvents();
