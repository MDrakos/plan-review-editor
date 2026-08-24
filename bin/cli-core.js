'use strict';

// The half of the agent-facing CLI that has nothing to do with WHAT is under
// review: talking to the shared server, keeping its code fresh, long-polling for
// the reviewer's next event, chat, replies, progress, teardown.
//
// Two front ends sit on top of it — `planreview` (a markdown plan) and
// `codereview` (a git diff) — and they differ only in `start`, `present`,
// `status`, `open`, and their usage text. Everything else is literally the same
// command, so it lives here once.
//
// Both front ends drive ONE server (default port 4780) and share its
// PLANREVIEW_* environment variables; sessions are isolated by id.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');

// Which front end is running, for error text and usage. Derived from the entry
// script so neither front end has to declare it.
const TOOL = path.basename(process.argv[1] || 'planreview', '.js');

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
          if (res.statusCode >= 400) {
            const e = new Error(parsed.error || `HTTP ${res.statusCode}`);
            e.statusCode = res.statusCode; // lets present/progress tell a 409 (interrupted) from a fatal error
            reject(e);
          } else resolve(parsed);
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

// FM-2: present/progress are gated to an active working round — a reviewer
// interrupt discards the stale rework and makes them 409. That's a documented
// recovery, not a fatal error: print it and let the caller exit 0 (so a
// `present && wait` chain proceeds into the next `wait`). Returns true if it
// handled a 409; false means the error is fatal and the caller must rethrow.
function handledInterrupt409(err) {
  if (err.statusCode !== 409) return false;
  console.log(JSON.stringify({ interrupted: true, message: 'round interrupted; wait again' }));
  return true;
}

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
        `${TOOL}: server on ${BASE} runs older code and has ${health.sessions} active ` +
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
    else if (a === '--warn-after') opts.warnAfter = Number(argv[++i]);
    else if (a === '--reviewer-name') opts.reviewerName = argv[++i];
    // code-review flags: what slice of the repo is under review (see bin/codereview.js)
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--range') opts.range = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--context') opts.context = Number(argv[++i]);
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--no-pull') opts.noPull = true;
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

// The reviewer name to seed into the browser so it stops prompting on a fresh tab.
// Priority: an explicit --reviewer-name flag, then $PLANREVIEW_REVIEWER_NAME, then the
// repo/user's `git config user.name` — so it just works with zero configuration. Empty
// string if none resolve (the browser then prompts on first load, exactly as before).
function resolveReviewerName(opts) {
  const explicit = (opts.reviewerName || process.env.PLANREVIEW_REVIEWER_NAME || '').trim();
  if (explicit) return explicit;
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return ''; // no git, or user.name unset — leave it to the browser
  }
}


// ---------- commands shared by both front ends ----------
//
// Identical for a plan and a diff: the event loop, chat, threaded replies,
// progress, listing, teardown, and the server's own code freshness. A front end
// spreads these into its command table and adds its own start/present/status/open.

function sharedCommands({ sessionPath }) {
  return {
    // Blocks until the reviewer produces the next real event for this session.
    // The reviewer has NO time limit — a long doc (or a long diff) can take as
    // long as it takes. Internally this polls the server in short windows and
    // loops straight past its "nothing yet" replies, so from the caller's side it
    // just blocks. Dropped connections are retried; a dead server or a vanished
    // session is not.
    //
    // --timeout <seconds>  return {"type":"timeout"} after this long instead of
    //                      blocking, so an agent whose shell caps command time
    //                      can return cleanly and re-run `wait` in a loop.
    // --warn-after <sec>   print a one-line "still waiting" note to stderr once
    //                      the wait passes this (default 300s / 5m).
    async wait(argv) {
      const { opts } = parseArgs(argv);
      const id = requireSession(opts, 'wait');
      const hardCap = opts.timeout;
      if (hardCap !== undefined && (!Number.isFinite(hardCap) || hardCap <= 0))
        throw new Error(`usage: ${TOOL} wait --session <id> [--timeout <seconds>]`);
      const warnAfter = opts.warnAfter !== undefined ? opts.warnAfter : 300;
      const windowMs = Number(process.env.PLANREVIEW_POLL_MS) || 50000;
      const start = Date.now();
      let warned = false;
      for (;;) {
        const elapsed = Date.now() - start;
        let poll = windowMs;
        if (hardCap !== undefined) {
          const remaining = hardCap * 1000 - elapsed;
          if (remaining <= 0) return console.log(JSON.stringify({ type: 'timeout' }));
          poll = Math.min(windowMs, remaining);
        }
        let event;
        try {
          event = await request('GET', `${scoped('/agent/wait', id)}&timeout=${Math.round(poll)}`);
        } catch (err) {
          if (/no such session/i.test(err.message))
            throw new Error(`no such session: ${id} (it may have ended)`);
          if (err.code === 'ECONNREFUSED') throw new Error('server is not running');
          await sleep(500);
          if (!(await serverAlive())) throw new Error('server is not running');
          continue;
        }
        if (event.type === 'timeout') {
          if (!warned && warnAfter > 0 && Date.now() - start >= warnAfter * 1000) {
            warned = true;
            const mins = Math.round((Date.now() - start) / 60000);
            process.stderr.write(
              `${TOOL}: still waiting for the reviewer (~${mins}m) — no time limit; expected for long reviews.\n`
            );
          }
          continue;
        }
        console.log(JSON.stringify(event));
        return;
      }
    },

    async say(argv) {
      const { opts, positionals } = parseArgs(argv);
      const id = requireSession(opts, 'say');
      const text = positionals.join(' ').trim();
      if (!text) throw new Error(`usage: ${TOOL} say <message> --session <id>`);
      console.log(JSON.stringify(await request('POST', scoped('/agent/say', id), { text })));
    },

    // Reply to a SPECIFIC inline comment (threaded under it), vs `say` which
    // posts to the global chat. The comment id comes from the submit bundle.
    async reply(argv) {
      const { opts, positionals } = parseArgs(argv);
      const id = requireSession(opts, 'reply');
      const commentId = positionals[0];
      const text = positionals.slice(1).join(' ').trim();
      if (!commentId || !text)
        throw new Error(`usage: ${TOOL} reply <commentId> <message> --session <id>`);
      console.log(JSON.stringify(await request('POST', scoped('/agent/reply', id), { commentId, text })));
    },

    // Report a rework step; shown live in the reviewer's "reworking" overlay.
    async progress(argv) {
      const { opts, positionals } = parseArgs(argv);
      const id = requireSession(opts, 'progress');
      const text = positionals.join(' ').trim();
      if (!text) throw new Error(`usage: ${TOOL} progress <message> --session <id>`);
      let out;
      try {
        out = await request('POST', scoped('/agent/progress', id), { text });
      } catch (err) {
        if (handledInterrupt409(err)) return;
        throw err;
      }
      console.log(JSON.stringify(out));
    },

    // list every open session on the shared server (mirrors the / index page).
    async list() {
      if (!(await serverAlive())) return console.log(JSON.stringify([]));
      console.log(JSON.stringify(await request('GET', '/api/sessions')));
    },

    async open(argv) {
      const { opts } = parseArgs(argv);
      const id = requireSession(opts, 'open');
      const url = `${BASE}${sessionPath}${id}`;
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

    // Bring the checkout the CLI runs from up to the latest main, then make a
    // running server reflect it. Both front ends run out of this one repo, so
    // "the current version" is whatever is checked out here. A server that is
    // idle on older code is restarted onto the new code; one with live sessions
    // is left running (restarting would drop those reviews) and picks the change
    // up on its next idle restart. --no-pull skips the git step.
    async update(argv) {
      const { opts } = parseArgs(argv);
      const repo = path.join(__dirname, '..');
      let pulled = 'skipped (--no-pull)';
      if (!opts.noPull) {
        try {
          execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
          pulled = execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], {
            cwd: repo,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
        } catch (e) {
          const detail = (e.stderr && e.stderr.toString().trim()) || e.message;
          throw new Error(`git update failed (resolve it by hand in ${repo}): ${detail}`);
        }
      }
      const want = codeVersion();
      const health = await serverHealth();
      let server;
      if (!health) {
        server = `not running; next \`${TOOL} start\` launches the current code`;
      } else if (health.version === want) {
        server = 'already running the current code';
      } else if (health.sessions > 0) {
        server =
          `running older code with ${health.sessions} active session(s); left as-is — ` +
          `run \`${TOOL} restart --force\` to load the new code now (drops those sessions)`;
      } else {
        await shutdownAndWait();
        await spawnServer(want);
        server = 'restarted onto the current code (was idle on older code)';
      }
      console.log(JSON.stringify({ ok: true, pulled, version: want, server }));
    },
  };
}

// Dispatch: look the subcommand up, run it, and turn a thrown error into the
// one-line stderr + exit 2 both front ends already used.
function run(commands, usage) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = commands[cmd];
  if (!fn) usage();
  fn(rest).catch((err) => {
    console.error(`${TOOL} ${cmd}: ${err.message}`);
    process.exit(2);
  });
}

module.exports = {
  TOOL,
  PORT,
  BASE,
  request,
  sleep,
  handledInterrupt409,
  serverHealth,
  serverAlive,
  openBrowser,
  spawnServer,
  shutdownAndWait,
  ensureServer,
  resolveDoc,
  parseArgs,
  requireSession,
  scoped,
  resolveReviewerName,
  sharedCommands,
  run,
};
