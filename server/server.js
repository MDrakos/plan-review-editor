#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderDiff, renderVersionDiff } = require('./markdown');
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
  deleteSession(s); // cancel any pending flush + delete the file (no resurrection)
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
function deleteSession(s) {
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
      if (data.doc) s.doc = data.doc;
      if (data.review) s.review = data.review;
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
  // Fresh comments each round, but keep prior answers — the reviewer shouldn't
  // have to re-answer a question they already decided (the UI shows those
  // collapsed with a "Change" option).
  s.review = { comments: [], choices: s.review.choices || {} };
  s.progress = []; // the reworked doc is here — the previous round's steps are done
  s.status = 'reviewing';
  touch(s);
  persist(s); // covers /agent/start and /agent/present
}

// Normalize a review bundle from a browser POST (shared by submit + approve).
function reviewBundle(s, body) {
  return {
    comments: Array.isArray(body.comments) ? body.comments : [],
    choices: body.choices && typeof body.choices === 'object' ? body.choices : {},
    note: typeof body.note === 'string' ? body.note : '',
    docVersion: s.doc.version,
    submittedAt: new Date().toISOString(),
  };
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
      const msg = { role: 'reviewer', text, ts: Date.now() };
      s.chat.push(msg);
      touch(s);
      broadcast(s, 'chat', msg);
      enqueueAgentEvent(s, { type: 'chat', text, ts: msg.ts });
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
      if (Array.isArray(body.comments)) s.review.comments = body.comments;
      if (body.choices && typeof body.choices === 'object') s.review.choices = body.choices;
      touch(s);
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
      if (s.status !== 'reviewing')
        return sendJson(res, 409, { error: `cannot ${verb} while ${s.status}` });
      const bundle = reviewBundle(s, await readBody(req));
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
      return sendJson(res, 200, { ok: true });
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
