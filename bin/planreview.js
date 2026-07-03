#!/usr/bin/env node
'use strict';

// The agent-facing CLI. A terminal agent drives a review session like this:
//
//   planreview start plan.md        # boot server, open browser, present plan
//   planreview wait                 # block until the reviewer does something
//   ... {"type":"chat"}    -> planreview say "answer" ; planreview wait
//   ... {"type":"submit"}  -> rework plan.md ; planreview present plan.md ; wait
//   ... {"type":"end"}     -> planreview stop
//
// Every command prints JSON to stdout so agents can parse results directly.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PLANREVIEW_PORT || 4780);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server', 'server.js');

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${BASE}${pathname}`,
      {
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = { raw: data };
          }
          if (res.statusCode >= 400)
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          else resolve(parsed);
        });
      }
    );
    req.setTimeout(0);
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverAlive() {
  try {
    await request('GET', '/api/state');
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(opener, [url], () => {});
}

async function ensureServer() {
  if (await serverAlive()) return false;
  spawn(process.execPath, [SERVER], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await serverAlive()) return true;
  }
  throw new Error(`server did not come up on ${BASE}`);
}

function resolveDoc(file) {
  if (!file) throw new Error('usage: planreview present <file.md>');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
  return abs;
}

const commands = {
  // start = begin a NEW session. If a server survived an abandoned session,
  // reset it so stale events (especially a queued "end") cannot leak in.
  // present = next round in the SAME session, keeping chat history.
  async start(args) {
    const file = args.find((a) => !a.startsWith('--'));
    await ensureServer();
    await request('POST', '/agent/reset');
    let presented = null;
    if (file) presented = await request('POST', '/agent/present', { path: resolveDoc(file) });
    if (!args.includes('--no-open')) {
      // Tabs from a previous session reconnect within ~1s and reload in
      // place. Give them that window and only open a new tab if none did —
      // otherwise every session leaves another stale tab behind.
      await sleep(1500);
      const s = await request('GET', '/api/state');
      if (!s.clients) openBrowser(BASE);
    }
    console.log(JSON.stringify({ ok: true, url: BASE, ...(presented || {}) }));
  },

  async present(args) {
    const out = await request('POST', '/agent/present', { path: resolveDoc(args[0]) });
    console.log(JSON.stringify(out));
  },

  // Blocks until the reviewer produces the next event. Long-poll connections
  // that drop mid-wait (sleep, proxy, etc.) are retried; a dead server is not.
  // --timeout <seconds> makes it return {"type":"timeout"} instead of blocking
  // forever, so agents with shell time limits can poll in a loop.
  async wait(args) {
    const tIdx = args.indexOf('--timeout');
    const seconds = tIdx !== -1 ? Number(args[tIdx + 1]) : 0;
    if (tIdx !== -1 && (!Number.isFinite(seconds) || seconds <= 0))
      throw new Error('usage: planreview wait [--timeout <seconds>]');
    const qs = seconds > 0 ? `?timeout=${Math.round(seconds * 1000)}` : '';
    for (;;) {
      try {
        const event = await request('GET', `/agent/wait${qs}`);
        console.log(JSON.stringify(event));
        return;
      } catch (err) {
        if (err.code === 'ECONNREFUSED') throw new Error('server is not running');
        await sleep(500);
        if (!(await serverAlive())) throw new Error('server is not running');
      }
    }
  },

  async say(args) {
    const text = args.join(' ').trim();
    if (!text) throw new Error('usage: planreview say <message>');
    console.log(JSON.stringify(await request('POST', '/agent/say', { text })));
  },

  async status() {
    const s = await request('GET', '/api/state');
    console.log(
      JSON.stringify({
        status: s.status,
        title: s.doc.title,
        version: s.doc.version,
        comments: s.review.comments.length,
        chat: s.chat.length,
      })
    );
  },

  async open() {
    openBrowser(BASE);
    console.log(JSON.stringify({ ok: true, url: BASE }));
  },

  async stop() {
    console.log(JSON.stringify(await request('POST', '/agent/stop')));
  },
};

function usage() {
  console.error(`usage: planreview <command>

  start [file.md] [--no-open]   boot the server, open the browser, present a plan
  present <file.md>             (re)present a plan document to the reviewer
  wait [--timeout <sec>]        block until the next reviewer event, print it as JSON;
                                with --timeout, print {"type":"timeout"} if nothing happens
  say <message>                 send a chat message to the reviewer
  status                        print session status
  open                          reopen the review UI in the browser
  stop                          shut the server down (after the reviewer ends the session)`);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = commands[cmd];
if (!run) usage();
run(rest).catch((err) => {
  console.error(`planreview ${cmd}: ${err.message}`);
  process.exit(2);
});
