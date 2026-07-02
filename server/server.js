#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { render } = require('./markdown');

const PORT = Number(process.env.PLANREVIEW_PORT || 4780);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const state = {
  status: 'idle', // idle | reviewing | working (agent is reworking the plan)
  doc: { path: null, title: '', html: '', version: 0 },
  review: { comments: [], choices: {} }, // in-progress review, survives page refreshes
  submissions: [], // completed review bundles, oldest first
  chat: [], // {role: 'reviewer' | 'agent', text, ts}
};

// ---------- server-sent events ----------

const sseClients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(frame);
}

// ---------- agent event queue ----------
//
// Everything the reviewer does that the agent must react to becomes an event:
//   {type: 'chat', text}      — reviewer said something in the sidebar
//   {type: 'submit', ...}     — reviewer submitted their bundled review
// The agent consumes events one at a time via the long-polling GET /agent/wait.

const agentQueue = [];
const agentWaiters = [];

function enqueueAgentEvent(event) {
  const waiter = agentWaiters.shift();
  if (waiter) sendJson(waiter, 200, event);
  else agentQueue.push(event);
}

function titleFrom(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function loadDoc(docPath) {
  const markdown = fs.readFileSync(docPath, 'utf8');
  state.doc.path = docPath;
  state.doc.title = titleFrom(markdown) || path.basename(docPath);
  state.doc.html = render(markdown);
  state.doc.version += 1;
  state.review = { comments: [], choices: {} };
  state.status = 'reviewing';
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
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && STATIC[pathname]) {
      return sendFile(res, STATIC[pathname][0], STATIC[pathname][1]);
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, {
        status: state.status,
        doc: { title: state.doc.title, html: state.doc.html, version: state.doc.version },
        review: state.review,
        chat: state.chat,
      });
    }

    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'empty message' });
      const msg = { role: 'reviewer', text, ts: Date.now() };
      state.chat.push(msg);
      broadcast('chat', msg);
      enqueueAgentEvent({ type: 'chat', text, ts: msg.ts });
      return sendJson(res, 200, { ok: true });
    }

    // ----- agent API (driven by bin/planreview.js) -----

    if (req.method === 'POST' && pathname === '/agent/present') {
      const body = await readBody(req);
      if (!body.path) return sendJson(res, 400, { error: 'missing "path"' });
      loadDoc(path.resolve(body.path));
      broadcast('doc', { version: state.doc.version });
      return sendJson(res, 200, {
        ok: true,
        version: state.doc.version,
        title: state.doc.title,
      });
    }

    if (req.method === 'GET' && pathname === '/agent/wait') {
      const event = agentQueue.shift();
      if (event) return sendJson(res, 200, event);
      agentWaiters.push(res);
      req.on('close', () => {
        const idx = agentWaiters.indexOf(res);
        if (idx !== -1) agentWaiters.splice(idx, 1);
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/agent/say') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'empty message' });
      const msg = { role: 'agent', text, ts: Date.now() };
      state.chat.push(msg);
      broadcast('chat', msg);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/review-state') {
      const body = await readBody(req);
      if (Array.isArray(body.comments)) state.review.comments = body.comments;
      if (body.choices && typeof body.choices === 'object') state.review.choices = body.choices;
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/submit') {
      if (state.status !== 'reviewing')
        return sendJson(res, 409, { error: `cannot submit while ${state.status}` });
      const body = await readBody(req);
      state.submissions.push({
        comments: Array.isArray(body.comments) ? body.comments : [],
        choices: body.choices && typeof body.choices === 'object' ? body.choices : {},
        note: typeof body.note === 'string' ? body.note : '',
        docVersion: state.doc.version,
        submittedAt: new Date().toISOString(),
      });
      state.status = 'working';
      broadcast('status', { status: state.status });
      enqueueAgentEvent({ type: 'submit', ...state.submissions[state.submissions.length - 1] });
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: String((err && err.message) || err) });
  }
});

const docArg = process.argv[2];
if (docArg) loadDoc(path.resolve(docArg));

// /agent/wait long-polls can outlive Node's default 5-minute request timeout
server.requestTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`plan-review-editor listening on http://${HOST}:${PORT}`);
});
