#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { render } = require('./markdown');

const PORT = Number(process.env.PLANREVIEW_PORT || 4780);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Exit once no sessions remain for this long, so the shared server doesn't
// linger forever after every agent is done (a fresh `start` respawns it).
const IDLE_SHUTDOWN_MS = Number(process.env.PLANREVIEW_IDLE_MS || 60_000);
// Reap a session that has no browser tab, no waiting agent, and no activity
// for this long — an abandoned start that was never stopped.
const ABANDON_MS = Number(process.env.PLANREVIEW_ABANDON_MS || 6 * 60 * 60 * 1000);

// ---------- sessions ----------
//
// Every agent's plan lives in its own session, keyed by a short id. Nothing is
// shared between sessions: separate document, review, chat, SSE tabs, event
// queue, and waiters. So a second agent's `start` mints a new id and cannot
// touch — or even see — a first agent's plan or its browser tab.

const sessions = new Map(); // id -> session

function createSession() {
  let id;
  do {
    id = crypto.randomBytes(3).toString('hex');
  } while (sessions.has(id));
  const s = {
    id,
    status: 'idle', // idle | reviewing | working (agent reworking) | ended
    doc: { path: null, title: '', html: '', version: 0 },
    review: { comments: [], choices: {} }, // in-progress review, survives refreshes
    submissions: [], // completed review bundles, oldest first
    chat: [], // {role: 'reviewer' | 'agent', text, ts}
    sse: new Set(), // browser tabs watching this session
    queue: [], // agent events awaiting a wait
    waiters: [], // {res, timer} in-flight /agent/wait long-polls
    touched: Date.now(),
  };
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
}, 60_000).unref();

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
  s.doc.path = docPath;
  s.doc.title = titleFrom(markdown) || path.basename(docPath);
  s.doc.html = render(markdown);
  s.doc.version += 1;
  s.review = { comments: [], choices: {} };
  s.status = 'reviewing';
  touch(s);
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
      return sendJson(res, 200, { ok: true, sessions: sessions.size });
    }
    if (method === 'GET' && pathname === '/app.js') {
      return sendFile(res, 'app.js', 'text/javascript; charset=utf-8');
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
        doc: { title: s.doc.title, html: s.doc.html, version: s.doc.version },
        review: s.review,
        chat: s.chat,
        clients: s.sse.size,
      });
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
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/end') {
      s.status = 'ended';
      touch(s);
      broadcast(s, 'status', { status: s.status });
      enqueueAgentEvent(s, { type: 'end' });
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/review-state') {
      const body = await readBody(req);
      if (Array.isArray(body.comments)) s.review.comments = body.comments;
      if (body.choices && typeof body.choices === 'object') s.review.choices = body.choices;
      touch(s);
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
      s.status = approve ? 'done' : 'working';
      touch(s);
      broadcast(s, 'status', { status: s.status });
      enqueueAgentEvent(s, { type: verb, ...bundle });
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

server.listen(PORT, HOST, () => {
  console.log(`plan-review-editor listening on http://${HOST}:${PORT}`);
  armIdleShutdownIfEmpty(); // exit if nobody ever connects
});
