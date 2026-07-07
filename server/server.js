#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderDiff, renderVersionDiff } = require('./markdown');
const { quoteAnchors } = require('./anchor');
const { codeVersion } = require('./version');

const PORT = Number(process.env.PLANREVIEW_PORT || 4780);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Fingerprint of this process's code, captured at startup. The CLI compares it
// to the on-disk code to detect (and restart) a server running stale logic.
const VERSION = codeVersion();

// Exit once no sessions remain for this long, so the shared server doesn't
// linger forever after every agent is done (a fresh `start` respawns it).
const IDLE_SHUTDOWN_MS = Number(process.env.PLANREVIEW_IDLE_MS || 60_000);
// Reap a session that has no browser tab, no waiting agent, and no activity
// for this long — an abandoned start that was never stopped.
const ABANDON_MS = Number(process.env.PLANREVIEW_ABANDON_MS || 6 * 60 * 60 * 1000);
// How often the abandon sweep runs (configurable only so tests can exercise it
// quickly; the default is unchanged).
const SWEEP_MS = Number(process.env.PLANREVIEW_SWEEP_MS || 60_000);

// Persist each session's serializable state to disk so an open review survives a
// server restart — a crash, a reboot, or this project's own idle-shutdown /
// stale-code respawn. On by default; PLANREVIEW_PERSIST=0 disables all disk I/O.
// State lives in a per-session file under STATE_DIR (repo-local .sessions/ by
// default; override with PLANREVIEW_STATE_DIR).
const PERSIST = process.env.PLANREVIEW_PERSIST !== '0';
const STATE_DIR = process.env.PLANREVIEW_STATE_DIR || path.join(process.cwd(), '.sessions');
const PERSIST_DEBOUNCE_MS = Number(process.env.PLANREVIEW_PERSIST_MS || 250);

// How many prior document versions each session retains for the "show changes
// since v N" diff. A bounded ring: only the last N versions' markdown SOURCE is
// kept (re-rendered on demand — cheap), so memory stays capped no matter how
// many rework rounds a session runs. Older versions age out and can no longer
// be diffed against.
const VERSION_HISTORY = Number(process.env.PLANREVIEW_VERSION_HISTORY || 10);

// ---------- sessions ----------
//
// Every agent's plan lives in its own session, keyed by a short id. Nothing is
// shared between sessions: separate document, review, chat, SSE tabs, event
// queue, and waiters. So a second agent's `start` mints a new id and cannot
// touch — or even see — a first agent's plan or its browser tab.

const sessions = new Map(); // id -> session

// The shape of a session: serializable state plus live handles. restoreSessions
// rebuilds this exact shape from disk with fresh, empty sse/waiters — so the
// serialize/restore round-trip and createSession never drift apart.
function blankSession(id) {
  return {
    id,
    status: 'idle', // idle | reviewing | working (agent reworking) | ended
    doc: { path: null, title: '', html: '', version: 0, blocks: null, history: [] },
    // blocks: prev render, for the per-round highlight. history: a bounded ring
    // of { version, title, markdown } (last VERSION_HISTORY), for version diffs.
    review: { comments: [], choices: {} }, // in-progress review, survives refreshes
    submissions: [], // completed review bundles, oldest first
    chat: [], // {role: 'reviewer' | 'agent', text, ts}
    progress: [], // {text, ts} steps the agent reports while reworking
    sse: new Set(), // browser tabs watching this session (never persisted)
    queue: [], // agent events awaiting a wait
    waiters: [], // {res, timer} in-flight /agent/wait long-polls (never persisted)
    touched: Date.now(),
  };
}

function createSession() {
  let id;
  do {
    id = crypto.randomBytes(3).toString('hex');
  } while (sessions.has(id));
  const s = blankSession(id);
  sessions.set(id, s);
  cancelIdleShutdown();
  return s;
}

function touch(s) {
  s.touched = Date.now();
}

// Tear a session down: release its waiters, close its tabs, drop it. Called on
// `stop` and by the abandoned-session sweep.
function removeSession(s) {
  for (const w of s.waiters.splice(0)) {
    clearTimeout(w.timer);
    try {
      sendJson(w.res, 200, { type: 'end' });
    } catch {
      /* already closed */
    }
  }
  for (const c of s.sse) {
    try {
      c.end();
    } catch {
      /* already closed */
    }
  }
  s.sse.clear();
  sessions.delete(s.id);
  deletePersisted(s); // cancel any pending flush + delete the file (no resurrection)
  armIdleShutdownIfEmpty();
}

function sessionSummary(s) {
  return {
    id: s.id,
    title: s.doc.title || '(untitled)',
    status: s.status,
    version: s.doc.version,
    clients: s.sse.size,
    url: `/s/${s.id}`,
  };
}

// ---------- persistence ----------
//
// Write-through each session's serializable state to <STATE_DIR>/<id>.json,
// debounced per session and written atomically (temp file + rename), then
// restore it on startup with fresh, empty sse/waiters. On by default;
// PLANREVIEW_PERSIST=0 disables all disk I/O.

const persistTimers = new Map(); // id -> pending debounce timer; keys ⊆ sessions

function sessionFile(id) {
  return path.join(STATE_DIR, `${id}.json`);
}

// Exactly the serializable state — never the live handles (sse/waiters) or the
// res/timer objects inside them. An explicit allowlist, so a field added later
// can't silently leak a non-serializable value into the file.
function serialize(s) {
  return {
    id: s.id,
    status: s.status,
    doc: s.doc, // includes doc.blocks so the next present still diffs correctly
    review: s.review,
    submissions: s.submissions,
    chat: s.chat,
    progress: s.progress,
    queue: s.queue, // pending agent events must survive a restart (decision 3)
    touched: s.touched,
  };
}

// Atomic + defensive. Write a temp file in the same dir, then rename over the
// target (atomic on one filesystem — a reader never sees a torn file). This runs
// inside a debounce timer, OUTSIDE the request try/catch, so any disk error is
// swallowed and logged: a failed write must never crash the process and take
// every other session down with it.
function writeSession(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = sessionFile(s.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(serialize(s)));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`planreview: failed to persist session ${s.id}: ${err.message}`);
  }
}

// Schedule-once debounce: the first mutation arms a flush ~PERSIST_DEBOUNCE_MS
// out; further mutations inside that window don't re-arm; when it fires it
// serializes the CURRENT state (capturing every mutation up to fire time). This
// bounds staleness to the debounce window while coalescing chat/progress bursts,
// and still survives a hard kill -9 (modulo the last sub-debounce window).
function persist(s) {
  if (!PERSIST) return;
  if (persistTimers.has(s.id)) return; // a flush is already scheduled
  const timer = setTimeout(() => {
    persistTimers.delete(s.id);
    if (!sessions.has(s.id)) return; // removed before the flush — don't resurrect its file
    writeSession(s);
  }, PERSIST_DEBOUNCE_MS);
  persistTimers.set(s.id, timer);
}

// Cancel any pending flush (so it can't recreate the file after we unlink) and
// delete the file. Called from removeSession — the single teardown path shared
// by /agent/stop and the abandon sweep. Clearing the timer is safe even with
// persistence off; the unlink is skipped when off.
function deletePersisted(s) {
  const timer = persistTimers.get(s.id);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(s.id);
  }
  if (!PERSIST) return;
  try {
    fs.unlinkSync(sessionFile(s.id));
  } catch {
    /* nothing to delete */
  }
}

// Rebuild every persisted session BEFORE the server listens. Fresh, empty
// sse/waiters (live connections are never serialized — the browser's own SSE
// reconnect repopulates them); the persisted queue replays to the next
// /agent/wait. A corrupt / truncated / missing-id file is logged and skipped —
// never fatal to startup. Synchronous, so restored sessions exist before the
// first request and before armIdleShutdownIfEmpty evaluates sessions.size.
function restoreSessions() {
  if (!PERSIST) return;
  let names;
  try {
    names = fs.readdirSync(STATE_DIR);
  } catch {
    return; // no state dir yet — nothing to restore
  }
  for (const name of names) {
    const full = path.join(STATE_DIR, name);
    if (name.endsWith('.tmp')) {
      try {
        fs.unlinkSync(full); // orphaned partial write from a crashed flush — clean it up
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!data || typeof data.id !== 'string') throw new Error('missing session id');
      const s = blankSession(data.id);
      if (typeof data.status === 'string') s.status = data.status;
      // Object fields fall back to blankSession's defaults if a hand-edited file
      // has them as the wrong type — restore a usable session, never a booby-trap.
      // Merge (not replace) the doc so a partial file can't leave version/blocks/
      // html undefined (a later loadDoc's `version += 1` would go NaN).
      if (data.doc && typeof data.doc === 'object') s.doc = { ...s.doc, ...data.doc };
      if (!Array.isArray(s.doc.history)) s.doc.history = []; // handlers assume it exists
      if (data.review && typeof data.review === 'object') s.review = data.review;
      // A restored review must have the exact shapes the merge/render code assumes.
      if (!Array.isArray(s.review.comments)) s.review.comments = [];
      if (!s.review.choices || typeof s.review.choices !== 'object' || Array.isArray(s.review.choices))
        s.review.choices = {};
      // Migrate a pre-004 flat choice value ({choiceId: option|options[]}) to the
      // per-reviewer shape { reviewerId: option }, keeping the legacy answer under
      // 'anonymous' rather than dropping it on the first post-upgrade merge/render.
      for (const [cid, v] of Object.entries(s.review.choices)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) s.review.choices[cid] = { anonymous: v };
      }
      if (Array.isArray(data.submissions)) s.submissions = data.submissions;
      if (Array.isArray(data.chat)) s.chat = data.chat;
      if (Array.isArray(data.progress)) s.progress = data.progress;
      if (Array.isArray(data.queue)) s.queue = data.queue;
      if (typeof data.touched === 'number') s.touched = data.touched; // honor age so the sweep still reaps
      sessions.set(s.id, s);
    } catch (err) {
      console.error(`planreview: skipping unreadable session file ${name}: ${err.message}`);
    }
  }
}

// ---------- lifecycle timers ----------

let idleTimer = null;

function armIdleShutdownIfEmpty() {
  if (sessions.size > 0) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (sessions.size === 0) process.exit(0);
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

setInterval(() => {
  const cutoff = Date.now() - ABANDON_MS;
  for (const s of sessions.values()) {
    if (s.sse.size === 0 && s.waiters.length === 0 && s.touched < cutoff) removeSession(s);
  }
}, SWEEP_MS).unref();

// ---------- server-sent events ----------

function broadcast(s, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of s.sse) client.write(frame);
}

// ---------- agent event queue ----------
//
// Everything the reviewer does that the agent must react to becomes an event:
//   {type: 'chat', text}      — reviewer said something in the sidebar
//   {type: 'submit', ...}     — reviewer submitted their bundled review
//   {type: 'end'}             — reviewer ended the session
// The agent consumes events one at a time via the long-polling GET /agent/wait.

function enqueueAgentEvent(s, event) {
  const waiter = s.waiters.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    sendJson(waiter.res, 200, event);
  } else {
    s.queue.push(event);
  }
}

function titleFrom(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function loadDoc(s, docPath) {
  const markdown = fs.readFileSync(docPath, 'utf8');
  // Highlight what changed since the previous cycle (nothing on the first load).
  const { html, blocks } = renderDiff(markdown, s.doc.blocks);
  s.doc.path = docPath;
  s.doc.title = titleFrom(markdown) || path.basename(docPath);
  s.doc.html = html;
  s.doc.blocks = blocks;
  s.doc.version += 1;
  // Retain the markdown SOURCE for this version (re-rendered on demand for the
  // version diff), capped at the last VERSION_HISTORY — older versions age out.
  s.doc.history.push({ version: s.doc.version, title: s.doc.title, markdown });
  if (s.doc.history.length > VERSION_HISTORY) s.doc.history.shift();
  // Carry comments (and their reply threads) forward across rounds so a
  // conversation can outlive one cycle: a comment survives as long as its quote
  // still anchors in the reworked document; otherwise it's flagged `archived`
  // and shown collapsed by the client — never silently dropped. Answers are kept
  // for the same reason (the UI collapses answered questions with a "Change").
  // Archived comments accumulate unbounded across many rounds; that's an
  // accepted trade-off for a localhost single-user tool that idle-shuts-down —
  // capping the list could drop a thread the reviewer still cares about.
  const carried = (s.review.comments || []).map((c) => ({
    ...c,
    archived: !quoteAnchors(c.quote, html),
  }));
  s.review = { comments: carried, choices: s.review.choices || {} };
  s.progress = []; // the reworked doc is here — the previous round's steps are done
  s.status = 'reviewing';
  touch(s);
  persist(s); // covers /agent/start and /agent/present
}

// Normalize a review bundle from a browser POST (shared by submit + approve).
// Comments carry their full reply threads through verbatim, so the agent sees
// the whole conversation (the reviewer's follow-ups included).
function reviewBundle(s, body, posterId) {
  // CONSOLIDATE: the submitter's posted body is merged over the shared review (every
  // peer's already-synced comments + the full per-reviewer choice map) into a throwaway
  // snapshot — so nothing is lost — WITHOUT mutating s.review (the draft's carry-forward
  // behavior is unchanged). structuredClone de-aliases the snapshot from live session
  // objects (e.g. a later /agent/reply mutating a comment's replies must not rewrite a
  // historical submission).
  const comments = mergeComments(
    s.review.comments,
    Array.isArray(body.comments) ? body.comments : [],
    posterId
  );
  const choices = mergeChoices(
    s.review.choices,
    body.choices && typeof body.choices === 'object' ? body.choices : {},
    posterId
  );
  return {
    comments: structuredClone(comments),
    choices: structuredClone(choices),
    note: typeof body.note === 'string' ? body.note : '',
    docVersion: s.doc.version,
    submittedAt: new Date().toISOString(),
  };
}

// Union two reply lists, de-duplicating identical replies (same role+ts+text)
// and ordering by timestamp. This is what makes an agent reply appended
// server-side (POST /agent/reply) survive a browser sync that raced the SSE
// broadcast, and keeps a reply the browser already has from doubling. Array
// .sort is stable, so equal-ts replies keep insertion order (prev before new).
function mergeReplies(prev, incoming) {
  const seen = new Set();
  const out = [];
  for (const r of [...(prev || []), ...(incoming || [])]) {
    if (!r || typeof r.text !== 'string') continue;
    // Include the author so two reviewers whose replies collide on role|ts|text
    // (e.g. a millisecond race, or a fixed-ts test) aren't deduped down to one.
    // Agent replies have no author -> authorId returns 'anonymous' on both copies,
    // so the server-appended-vs-browser-synced agent-reply dedup still works.
    const key = `${r.role}|${r.ts}|${r.text}|${authorId(r)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

// A comment's (or a POST body's) author id, defaulting to a synthetic 'anonymous'
// so an old client / curl with no identity still round-trips without breaking.
function authorId(c) {
  return (c && c.author && typeof c.author.id === 'string' && c.author.id) || 'anonymous';
}

// The reviewer id a POST claims for itself (top-level, per the design). Determines
// which comments in the body this POST is authoritative over.
function posterIdOf(body) {
  return (body && typeof body.reviewerId === 'string' && body.reviewerId) || 'anonymous';
}

// The author object for a chat/reply from a POST body: {id, name?} when the body
// carries a reviewerId, else null (an un-identified message stays un-attributed and
// renders exactly as it did before this feature). NOTE: posterIdOf/authorId fold a
// missing id to the string 'anonymous' (a real merge key); authorOf returns null
// (omit the field) — the two differ deliberately by call site (merge vs. display).
function authorOf(body) {
  const id = body && typeof body.reviewerId === 'string' ? body.reviewerId.trim() : '';
  if (!id) return null;
  const name = body && typeof body.reviewerName === 'string' ? body.reviewerName.trim() : '';
  return name ? { id, name } : { id };
}

// Reconcile ONE browser comment against the server's copy: union replies, and keep
// the server-authoritative archived flag (the browser can clobber neither). This is
// the per-comment step lifted out of the old mergeComments so mergeComments can
// choose, per author, whether to apply it.
function reconcileComment(prev, incoming) {
  const replies = mergeReplies(prev && prev.replies, incoming.replies);
  const merged = { ...incoming };
  if (replies.length) merged.replies = replies;
  else delete merged.replies;
  delete merged.archived; // server-authoritative — never trust the browser's copy
  if (prev && prev.archived) merged.archived = true;
  return merged;
}

// Reconcile the browser's comment array with the server's. The browser owns the
// set of comments (create / edit / delete / order); the server owns each
// comment's `archived` flag (set at re-present) and any agent replies appended
// out-of-band. So take the incoming comments, but union each one's replies with
// the server's copy and re-apply the server's archived flag — the browser can't
// clobber either.
// Author-scoped union — the CORE multi-reviewer change. A POST is authoritative
// ONLY over its own author's comments (create / edit / delete): those in `incoming`
// whose author.id === posterId. Every OTHER author's comment is preserved from
// `prev` untouched, so reviewer B's sync can never drop or edit reviewer A's
// comments — even when B's browser holds A's comments (from live sync) and posts
// them back. Order follows `prev` (peers stay put; a peer's card never jumps when
// you edit yours), with the poster's brand-new comments appended.
function mergeComments(prev, incoming, posterId) {
  // Drop malformed entries up front (a null / non-object / id-less comment from a
  // buggy client or curl) so no downstream `.id` deref can throw — FM-7. Mirrors the
  // defensive filtering mergeReplies already does for reply objects.
  const ok = (c) => c && typeof c === 'object' && typeof c.id === 'string';
  const cleanIncoming = (incoming || []).filter(ok);
  const cleanPrev = (prev || []).filter(ok);
  const mine = new Map(cleanIncoming.filter((c) => authorId(c) === posterId).map((c) => [c.id, c]));
  const incomingById = new Map(cleanIncoming.map((c) => [c.id, c]));
  const prevById = new Map(cleanPrev.map((c) => [c.id, c]));
  const emitted = new Set();
  const out = [];
  for (const p of cleanPrev) {
    if (authorId(p) === posterId) {
      const inc = mine.get(p.id);
      if (!inc) continue; // the poster deleted their own comment
      out.push(reconcileComment(p, inc));
    } else {
      // A peer's comment: the poster can't edit or delete it (body stays authoritative),
      // but replies are open to everyone (issue 002 threads) — so union any replies the
      // poster added to this thread onto the server's copy; mergeReplies only ADDS, never
      // removes, so a peer can't clobber existing replies. Without this, a reply left on
      // another reviewer's comment would be silently dropped.
      const inc = incomingById.get(p.id);
      if (inc && Array.isArray(inc.replies) && inc.replies.length) {
        const replies = mergeReplies(p.replies, inc.replies);
        out.push(replies.length ? { ...p, replies } : p);
      } else {
        out.push(p);
      }
    }
    emitted.add(p.id);
  }
  for (const c of cleanIncoming) {
    if (authorId(c) !== posterId || emitted.has(c.id)) continue;
    out.push(reconcileComment(prevById.get(c.id), c)); // brand-new poster comment
    emitted.add(c.id);
  }
  return out;
}

// Per-reviewer choice map: { choiceId: { reviewerId: option } }. A POST carries the
// poster's OWN flat picks ({ choiceId: option }); we replace ONLY the poster's entries
// (a divergent pick by reviewer B never overwrites reviewer A's) and drop any of the
// poster's prior picks it no longer sends (a deselect). A prev entry that isn't a plain
// object — e.g. a pre-004 persisted `{choiceId: <string>}` — is dropped rather than
// mangled: a one-time loss only for a session already open across the upgrade.
function mergeChoices(prev, incoming, posterId) {
  const out = {};
  for (const [choiceId, byReviewer] of Object.entries(prev || {})) {
    if (!byReviewer || typeof byReviewer !== 'object' || Array.isArray(byReviewer)) continue;
    const kept = {};
    for (const [rid, opt] of Object.entries(byReviewer)) if (rid !== posterId) kept[rid] = opt;
    if (Object.keys(kept).length) out[choiceId] = kept;
  }
  for (const [choiceId, opt] of Object.entries(incoming || {})) {
    if (opt === undefined || opt === null || opt === '' || (Array.isArray(opt) && opt.length === 0)) continue;
    (out[choiceId] || (out[choiceId] = {}))[posterId] = opt;
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, name, type) {
  fs.readFile(path.join(PUBLIC_DIR, name), (err, data) => {
    if (err) return sendJson(res, 500, { error: `missing asset: ${name}` });
    // These files are edited live during development; never let the browser
    // serve a stale cached copy (a cached style.css hid the CSS overlay fix).
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// The index at / — a live list of every open plan, one per agent.
function indexHtml() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan Review — open sessions</title>
<link rel="stylesheet" href="/style.css">
<style>
  body { padding: 32px 24px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5em; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--ink-soft); margin: 0 0 24px; }
  .sess { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--line);
          border-radius: 10px; background: var(--surface); margin-bottom: 10px; text-decoration: none; color: var(--ink); }
  .sess:hover { border-color: var(--accent); }
  .sess .title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sess .meta { color: var(--ink-soft); font-size: 13px; white-space: nowrap; }
  .empty { color: var(--ink-soft); font-style: italic; }
</style></head><body><div class="wrap">
<h1>Plan Review</h1>
<p class="sub">Open review sessions — each is isolated, one per agent.</p>
<div id="list"></div>
</div>
<script>
function esc(t){return String(t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
async function render(){
  var items=[];
  try{ items=await (await fetch('/api/sessions')).json(); }catch(e){ return; }
  var list=document.getElementById('list');
  if(!items.length){ list.innerHTML='<p class="empty">No open sessions.</p>'; return; }
  list.innerHTML=items.map(function(s){
    return '<a class="sess" href="'+s.url+'">'
      +'<span class="pill" data-status="'+s.status+'">'+s.status+'</span>'
      +'<span class="title">'+esc(s.title)+'</span>'
      +'<span class="meta">v'+s.version+' &middot; '+s.clients+' tab'+(s.clients===1?'':'s')+'</span></a>';
  }).join('');
}
render(); setInterval(render, 2000);
</script></body></html>`;
}

// ---------- request routing ----------

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method;

  try {
    // ----- shared, session-less routes -----

    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, sessions: sessions.size, version: VERSION });
    }
    // Shut the whole server down (used by the CLI to restart a server running
    // stale code). Localhost-only, like everything else here.
    if (method === 'POST' && pathname === '/admin/shutdown') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (method === 'GET' && pathname === '/app.js') {
      return sendFile(res, 'app.js', 'text/javascript; charset=utf-8');
    }
    if (method === 'GET' && pathname === '/liveness.js') {
      return sendFile(res, 'liveness.js', 'text/javascript; charset=utf-8');
    }
    if (method === 'GET' && pathname === '/style.css') {
      return sendFile(res, 'style.css', 'text/css; charset=utf-8');
    }
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return sendHtml(res, indexHtml());
    }
    if (method === 'GET' && pathname === '/api/sessions') {
      return sendJson(res, 200, [...sessions.values()].map(sessionSummary));
    }
    // the review UI for one session; the client reads its id from the URL
    if (method === 'GET' && pathname.startsWith('/s/')) {
      return sendFile(res, 'index.html', 'text/html; charset=utf-8');
    }

    // ----- start = create a session and present into it (agent-driven) -----
    if (method === 'POST' && pathname === '/agent/start') {
      const body = await readBody(req);
      if (!body.path) return sendJson(res, 400, { error: 'missing "path"' });
      const s = createSession();
      loadDoc(s, path.resolve(body.path));
      return sendJson(res, 200, {
        ok: true,
        id: s.id,
        url: `/s/${s.id}`,
        version: s.doc.version,
        title: s.doc.title,
      });
    }

    // ----- everything else is scoped to one session -----
    const s = sessions.get(reqUrl.searchParams.get('session') || '');
    if (!s) return sendJson(res, 404, { error: 'no such session' });

    if (method === 'GET' && pathname === '/api/state') {
      touch(s);
      return sendJson(res, 200, {
        status: s.status,
        // versions: the retained version numbers (oldest→newest) the client can
        // diff between. Numbers only — the markdown source stays server-side.
        doc: {
          title: s.doc.title,
          html: s.doc.html,
          version: s.doc.version,
          versions: s.doc.history.map((h) => h.version),
        },
        review: s.review,
        chat: s.chat,
        progress: s.progress,
        clients: s.sse.size,
      });
    }

    // Annotated diff between two retained versions (add / remove / change), used
    // by the "show changes since v N" selector. ?from=&to= are version numbers;
    // both default sensibly (previous → current). Any version outside the
    // retention ring (aged out, unknown, or malformed) is a 400 that lists what
    // is still comparable — we never feed a missing version into the renderer.
    if (method === 'GET' && pathname === '/api/diff') {
      touch(s);
      const history = s.doc.history;
      const versions = history.map((h) => h.version);
      const current = s.doc.version;
      const parseVersion = (raw, fallback) => {
        if (raw === null || raw === '') return fallback;
        const n = Number(raw);
        return Number.isInteger(n) ? n : NaN;
      };
      const to = parseVersion(reqUrl.searchParams.get('to'), current);
      // Default `from` to the retained version immediately BEFORE `to` (per the
      // documented contract), not merely the second-newest overall — so an
      // explicit ?to=<older> still gets a sensible previous-version baseline.
      const toIdx = versions.indexOf(to);
      const defaultFrom = toIdx > 0 ? versions[toIdx - 1] : versions[0];
      const from = parseVersion(reqUrl.searchParams.get('from'), defaultFrom);
      const fromEntry = history.find((h) => h.version === from);
      const toEntry = history.find((h) => h.version === to);
      if (!fromEntry || !toEntry) {
        return sendJson(res, 400, {
          error: 'from and to must both be retained versions',
          versions,
          current,
        });
      }
      const { html } = renderVersionDiff(fromEntry.markdown, toEntry.markdown);
      return sendJson(res, 200, { from, to, html, versions, current });
    }

    if (method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      s.sse.add(res);
      touch(s);
      req.on('close', () => s.sse.delete(res));
      return;
    }

    if (method === 'POST' && pathname === '/api/chat') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'empty message' });
      const author = authorOf(body);
      const msg = { role: 'reviewer', text, ts: Date.now(), ...(author ? { author } : {}) };
      s.chat.push(msg);
      touch(s);
      broadcast(s, 'chat', msg);
      enqueueAgentEvent(s, { type: 'chat', text, ts: msg.ts, ...(author ? { author } : {}) });
      persist(s);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/end') {
      s.status = 'ended';
      touch(s);
      broadcast(s, 'status', { status: s.status });
      enqueueAgentEvent(s, { type: 'end' });
      persist(s);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/review-state') {
      const body = await readBody(req);
      const posterId = posterIdOf(body);
      // Author-scoped merge: preserves peers' comments (and agent replies + the
      // server's archived flag) against a browser sync that only owns its author's set.
      if (Array.isArray(body.comments))
        s.review.comments = mergeComments(s.review.comments, body.comments, posterId);
      // Per-reviewer choices: record only the poster's picks; peers' picks survive.
      if (body.choices && typeof body.choices === 'object')
        s.review.choices = mergeChoices(s.review.choices, body.choices, posterId);
      touch(s);
      // Live sync: fan the merged review out so other tabs render peers' comments and
      // choice picks. The poster ignores its own echo by author.id (see the client).
      broadcast(s, 'review', {
        comments: s.review.comments,
        choices: s.review.choices,
        author: { id: posterId },
      });
      persist(s);
      return sendJson(res, 200, { ok: true });
    }

    // Submit = another round: the agent reworks and re-presents (status
    // 'working' until it does). Approve = the reviewer is satisfied and done:
    // the same bundle, but the session goes straight to a terminal 'done'
    // state (no spinner, no dependency on the agent) and the agent is told to
    // apply any feedback and proceed WITHOUT re-presenting.
    if (method === 'POST' && (pathname === '/api/submit' || pathname === '/api/approve')) {
      const approve = pathname === '/api/approve';
      const verb = approve ? 'approve' : 'submit';
      const body = await readBody(req);
      // Guard AFTER the await, then mutate synchronously — closes the check-then-act
      // race where two reviewers submitting at once both pass a pre-await guard and
      // each enqueue a round (FM-3). reviewBundle below performs no I/O / await.
      if (s.status !== 'reviewing')
        return sendJson(res, 409, { error: `cannot ${verb} while ${s.status}` });
      const bundle = reviewBundle(s, body, posterIdOf(body));
      s.submissions.push(bundle);
      s.progress = []; // start the rework round with a clean progress log
      s.status = approve ? 'done' : 'working';
      touch(s);
      broadcast(s, 'status', { status: s.status });
      enqueueAgentEvent(s, { type: verb, ...bundle });
      persist(s);
      return sendJson(res, 200, { ok: true });
    }

    // ----- agent API (driven by bin/planreview.js) -----

    if (method === 'POST' && pathname === '/agent/present') {
      const body = await readBody(req);
      if (!body.path) return sendJson(res, 400, { error: 'missing "path"' });
      loadDoc(s, path.resolve(body.path));
      broadcast(s, 'doc', { version: s.doc.version });
      return sendJson(res, 200, { ok: true, version: s.doc.version, title: s.doc.title });
    }

    if (method === 'GET' && pathname === '/agent/wait') {
      touch(s);
      const event = s.queue.shift();
      if (event) return sendJson(res, 200, event);
      const waiter = { res, timer: null };
      // ?timeout=ms lets agents poll within their shell's time limit:
      // they get {type: 'timeout'} back and simply call wait again.
      const timeoutMs = Number(reqUrl.searchParams.get('timeout') || 0);
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = s.waiters.indexOf(waiter);
          if (idx !== -1) {
            s.waiters.splice(idx, 1);
            sendJson(res, 200, { type: 'timeout' });
          }
        }, timeoutMs);
      }
      s.waiters.push(waiter);
      req.on('close', () => {
        clearTimeout(waiter.timer);
        const idx = s.waiters.indexOf(waiter);
        if (idx !== -1) s.waiters.splice(idx, 1);
      });
      return;
    }

    if (method === 'POST' && pathname === '/agent/say') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'empty message' });
      const msg = { role: 'agent', text, ts: Date.now() };
      s.chat.push(msg);
      touch(s);
      broadcast(s, 'chat', msg);
      persist(s); // agent chat is persisted state too — mirror /api/chat so it survives a restart
      return sendJson(res, 200, { ok: true });
    }

    // Reply to a SPECIFIC inline comment (vs /agent/say, which is the global,
    // un-anchored chat). Appends to that comment's thread and broadcasts a
    // comment-reply so open tabs render it in place. Does NOT touch status or
    // enqueue an agent event — a reply is not a review round.
    if (method === 'POST' && pathname === '/agent/reply') {
      const body = await readBody(req);
      const commentId = typeof body.commentId === 'string' ? body.commentId : '';
      const text = String(body.text || '').trim();
      if (!commentId) return sendJson(res, 400, { error: 'missing "commentId"' });
      if (!text) return sendJson(res, 400, { error: 'empty message' });
      const comment = s.review.comments.find((c) => c.id === commentId);
      if (!comment) return sendJson(res, 404, { error: `no such comment: ${commentId}` });
      const reply = { role: 'agent', text, ts: Date.now() };
      (comment.replies || (comment.replies = [])).push(reply);
      touch(s);
      broadcast(s, 'comment-reply', { commentId, reply });
      return sendJson(res, 200, { ok: true, commentId, reply });
    }

    // A rework step, shown live in the "reworking" overlay so the reviewer sees
    // real progress instead of a bare spinner. Cleared when the new doc arrives.
    if (method === 'POST' && pathname === '/agent/progress') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'empty progress' });
      const msg = { text, ts: Date.now() };
      s.progress.push(msg);
      touch(s);
      broadcast(s, 'progress', msg);
      persist(s);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/agent/stop') {
      s.status = 'ended';
      broadcast(s, 'status', { status: s.status });
      sendJson(res, 200, { ok: true });
      // let the response and the SSE frame flush, then drop just this session
      setTimeout(() => removeSession(s), 200);
      return;
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: String((err && err.message) || err) });
  }
});

// /agent/wait long-polls can outlive Node's default 5-minute request timeout
server.requestTimeout = 0;
server.headersTimeout = 0;

restoreSessions(); // rebuild any persisted sessions before we accept requests

server.listen(PORT, HOST, () => {
  console.log(`plan-review-editor listening on http://${HOST}:${PORT}`);
  armIdleShutdownIfEmpty(); // exit if nobody ever connects (and nothing was restored)
});
