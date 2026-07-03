#!/usr/bin/env node
'use strict';

// The agent-facing CLI. Each plan under review is an isolated SESSION, so
// multiple agents can drive their own reviews at once without clobbering each
// other. `start` mints a session and prints its id; every later command for
// that review must carry it via `--session <id>`:
//
//   planreview start plan.md            # -> {"id":"a1b2c3","url":"…/s/a1b2c3", …}
//   planreview wait --session a1b2c3    # block until the reviewer does something
//   ... {"type":"chat"}    -> planreview say "answer" --session a1b2c3 ; wait
//   ... {"type":"submit"}  -> rework plan.md ; planreview present plan.md --session a1b2c3 ; wait
//   ... {"type":"end"}     -> planreview stop --session a1b2c3
//
// One shared server (default port 4780) holds every session. Every command
// prints JSON to stdout so agents can parse results directly.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PLANREVIEW_PORT || 4780);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const { codeVersion } = require(path.join(__dirname, '..', 'server', 'version'));

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

async function serverHealth() {
  try {
    return await request('GET', '/health');
  } catch {
    return null;
  }
}

async function serverAlive() {
  return (await serverHealth()) !== null;
}

function openBrowser(url) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(opener, [url], () => {});
}

async function spawnServer(want) {
  spawn(process.execPath, [SERVER], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const h = await serverHealth();
    if (h && h.version === want) return true;
  }
  throw new Error(`server did not come up on ${BASE}`);
}

async function shutdownAndWait() {
  await request('POST', '/admin/shutdown').catch(() => {});
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!(await serverAlive())) return;
  }
}

// Ensure a server running CURRENT code is up. A server that started before a
// code edit is stale; replace it — but only when it has no active sessions, so
// a code change can never yank another agent's live review out from under it.
async function ensureServer() {
  const want = codeVersion();
  const health = await serverHealth();
  if (health) {
    if (health.version === want) return false; // up to date — reuse
    if (health.sessions > 0) {
      console.error(
        `planreview: server on ${BASE} runs older code and has ${health.sessions} active ` +
          `session(s); reusing it as-is. Stop those sessions (or run \`planreview restart --force\`) to load the new code.`
      );
      return false;
    }
    await shutdownAndWait(); // stale and empty — safe to replace
  }
  return spawnServer(want);
}

function resolveDoc(file) {
  if (!file) throw new Error('missing <file.md>');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
  return abs;
}

// Minimal flag parser: pulls --session/--timeout (value flags) and --no-open
// (boolean) out, leaving the rest as positionals.
function parseArgs(argv) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') opts.session = argv[++i];
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--no-open') opts.noOpen = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else positionals.push(a);
  }
  return { opts, positionals };
}

function requireSession(opts, cmd) {
  const id = opts.session || process.env.PLANREVIEW_SESSION;
  if (!id) throw new Error(`${cmd} requires --session <id> (printed by \`planreview start\`)`);
  return id;
}

function scoped(pathname, id) {
  const sep = pathname.includes('?') ? '&' : '?';
  return `${pathname}${sep}session=${encodeURIComponent(id)}`;
}

const commands = {
  // start = begin a NEW isolated session and present the plan in a fresh tab.
  async start(argv) {
    const { opts, positionals } = parseArgs(argv);
    const file = resolveDoc(positionals[0]);
    await ensureServer();
    const out = await request('POST', '/agent/start', { path: file });
    const url = BASE + out.url;
    if (!opts.noOpen) openBrowser(url);
    console.log(
      JSON.stringify({ ok: true, id: out.id, url, version: out.version, title: out.title })
    );
  },

  // present = next round in the SAME session (keeps chat history).
  async present(argv) {
    const { opts, positionals } = parseArgs(argv);
    const id = requireSession(opts, 'present');
    const file = resolveDoc(positionals[0]);
    const out = await request('POST', scoped('/agent/present', id), { path: file });
    console.log(JSON.stringify({ ok: true, id, ...out }));
  },

  // Blocks until the reviewer produces the next event for this session.
  // Long-poll connections that drop mid-wait (sleep, proxy, etc.) are retried;
  // a dead server or a vanished session is not.
  // --timeout <seconds> makes it return {"type":"timeout"} instead of blocking
  // forever, so agents with shell time limits can poll in a loop.
  async wait(argv) {
    const { opts } = parseArgs(argv);
    const id = requireSession(opts, 'wait');
    const seconds = opts.timeout;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0))
      throw new Error('usage: planreview wait --session <id> [--timeout <seconds>]');
    let pathname = scoped('/agent/wait', id);
    if (seconds > 0) pathname += `&timeout=${Math.round(seconds * 1000)}`;
    for (;;) {
      try {
        const event = await request('GET', pathname);
        console.log(JSON.stringify(event));
        return;
      } catch (err) {
        if (/no such session/i.test(err.message))
          throw new Error(`no such session: ${id} (it may have ended)`);
        if (err.code === 'ECONNREFUSED') throw new Error('server is not running');
        await sleep(500);
        if (!(await serverAlive())) throw new Error('server is not running');
      }
    }
  },

  async say(argv) {
    const { opts, positionals } = parseArgs(argv);
    const id = requireSession(opts, 'say');
    const text = positionals.join(' ').trim();
    if (!text) throw new Error('usage: planreview say <message> --session <id>');
    console.log(JSON.stringify(await request('POST', scoped('/agent/say', id), { text })));
  },

  async status(argv) {
    const { opts } = parseArgs(argv);
    const id = requireSession(opts, 'status');
    const s = await request('GET', scoped('/api/state', id));
    console.log(
      JSON.stringify({
        id,
        status: s.status,
        title: s.doc.title,
        version: s.doc.version,
        comments: s.review.comments.length,
        chat: s.chat.length,
        clients: s.clients,
      })
    );
  },

  // list every open session on the shared server (mirrors the / index page).
  async list() {
    if (!(await serverAlive())) return console.log(JSON.stringify([]));
    console.log(JSON.stringify(await request('GET', '/api/sessions')));
  },

  async open(argv) {
    const { opts } = parseArgs(argv);
    const id = requireSession(opts, 'open');
    const url = `${BASE}/s/${id}`;
    openBrowser(url);
    console.log(JSON.stringify({ ok: true, url }));
  },

  async stop(argv) {
    const { opts } = parseArgs(argv);
    const id = requireSession(opts, 'stop');
    console.log(JSON.stringify(await request('POST', scoped('/agent/stop', id))));
  },

  // Force the shared server to reload its code. Normally unnecessary — `start`
  // auto-restarts a stale, empty server — but useful after editing server code
  // while sessions are open. Refuses to drop live sessions without --force.
  async restart(argv) {
    const { opts } = parseArgs(argv);
    const health = await serverHealth();
    if (health && health.sessions > 0 && !opts.force)
      throw new Error(
        `refusing to restart: ${health.sessions} active session(s) would be dropped — re-run with --force`
      );
    if (health) await shutdownAndWait();
    await spawnServer(codeVersion());
    console.log(JSON.stringify({ ok: true, url: BASE }));
  },
};

function usage() {
  console.error(`usage: planreview <command>

  start <file.md> [--no-open]        create an isolated session, present the plan, open a tab;
                                     prints {"id":…} — pass that id to every later command
  present <file.md> --session <id>   (re)present a plan into an existing session
  wait --session <id> [--timeout s]  block until the next reviewer event, print it as JSON;
                                     with --timeout, print {"type":"timeout"} if nothing happens
  say <message> --session <id>       send a chat message to the reviewer
  status --session <id>              print session status
  list                               list all open sessions
  open --session <id>                (re)open a session's review tab in the browser
  stop --session <id>                end and drop the session
  restart [--force]                  reload the server's code (auto on start when the
                                     server is stale + idle; --force drops live sessions)

The shared server (default port 4780) exits on its own once no sessions remain.`);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = commands[cmd];
if (!run) usage();
run(rest).catch((err) => {
  console.error(`planreview ${cmd}: ${err.message}`);
  process.exit(2);
});
