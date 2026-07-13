#!/usr/bin/env node
'use strict';

// End-to-end test of the multi-session server, driven the way agents drive it
// (through the CLI) with the browser side simulated over HTTP.
//
// The headline guarantee: two agents can each have a plan open at once, keyed
// by distinct session ids, and neither can touch — or even see — the other's
// session. The rest covers a full review cycle, the "session id required"
// guard, the sessions index, and the idle self-shutdown.
//
// Run: node test/e2e.js   (binds an OS-assigned free port + a short idle window
// so it never clashes with a real session — or a sibling test run — and cleans
// itself up fast). Set PLANREVIEW_TEST_PORT to pin a specific port instead.

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const net = require('net');

// Port selection is resolved once at the start of main(): PLANREVIEW_TEST_PORT
// still wins (so an operator can pin a port), otherwise the OS hands us a free
// one (see freePort). PORT/BASE/env are therefore `let`s bound before any server
// work runs, not module-load constants.
let PORT;
let BASE;
let env;
const CLI = path.join(__dirname, '..', 'bin', 'planreview.js');
const { render, renderDiff, renderVersionDiff, parseChoiceSpecs } = require(path.join(__dirname, '..', 'server', 'markdown'));
const liveness = require(path.join(__dirname, '..', 'public', 'liveness'));
const { quoteAnchors } = require(path.join(__dirname, '..', 'server', 'anchor'));

// Ask the OS for a free TCP port: bind port 0, read the actual port back off the
// listening socket, then release it. Every worktree that runs this suite gets
// its own port, so concurrent `npm test` runs never share a server — a shared
// fixed port used to let one run restart the other's server and drop its
// sessions, surfacing as a false "no such session". Returns a Promise<number>.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// PLANREVIEW_TEST_PORT pins a port; otherwise fall back to an OS-assigned one.
const resolvePort = async () => Number(process.env.PLANREVIEW_TEST_PORT) || (await freePort());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { env }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim() ? JSON.parse(stdout.trim()) : {});
    });
  });
}

// like cli() but never rejects — for asserting on failures/exit codes
function cliRaw(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// A tiny HTTP client bound to one base URL: a JSON request (the browser side),
// a raw-text fetch, and a health probe. The module-level helpers below target
// the CLI-managed server; the persistence phase builds its own against a second
// port — so the same three shapes serve both without duplication.
function makeClient(base) {
  return {
    // simulate the review UI in the browser
    async json(pathname, body) {
      const res = await fetch(base + pathname, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON (e.g. HTML page) */
      }
      return { status: res.status, ok: res.ok, data };
    },
    async text(pathname) {
      const res = await fetch(base + pathname);
      return { status: res.status, ok: res.ok, body: await res.text() };
    },
    async alive() {
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    },
  };
}

// Bound in main() once BASE is known (see the port-selection note above).
let browser;
let text;
let serverAlive;

// simulate a review tab's SSE connection to one session
async function openEventStream(id) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/events?session=${id}`, { signal: controller.signal });
  const reader = res.body.getReader();
  (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* aborted */
    }
  })();
  return { close: () => controller.abort() };
}

// like openEventStream, but parses SSE frames into {event, data} so a test can
// assert what the server broadcast (used for the comment-reply path). Optional
// rid/rname carry the reviewer identity on the /events query so the connection
// registers presence (issue 007) — omit them for an anonymous, presence-inert tab.
// presenceFrames() returns each 'presence' frame's parsed roster, newest last.
async function captureEvents(id, rid, rname) {
  let url = `${BASE}/events?session=${id}`;
  if (rid !== undefined) url += `&rid=${encodeURIComponent(rid)}`;
  if (rname !== undefined) url += `&rname=${encodeURIComponent(rname)}`;
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = {};
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = line.slice(6);
          }
          if (ev.event) events.push(ev);
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    events,
    presenceFrames: () => events.filter((e) => e.event === 'presence').map((e) => JSON.parse(e.data)),
    close: () => controller.abort(),
  };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.error(` FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// Shared VM-shim builder for the liveness DOM harness: builds the hand-rolled,
// zero-dep DOM/EventSource/fetch/timer shim (a `vm.createContext` global object
// shaped like the handful of browser globals app.js/liveness.js touch), and
// returns a `load(file)` helper that `vm.runInContext`s a real public/*.js file
// into it. Both driveLivenessWiring (one long sequential story, its own local
// `now`/`fetchCalls` mutated directly by the story) and bootLivenessHarness
// (one-shot per-scenario boots, a boxed clock advanced after boot) call this —
// `getNow` and `onFetch` are hooks so each caller's own clock/counter variables
// keep working exactly as before, since neither caller's driving code may change.
// promptQueue lets a caller script canned answers for successive window.prompt()
// calls (issue 011 #1: the first-load name prompt, then a later 'edit' click reusing
// the same global) — shift() one per call, () => null once exhausted (matches the
// old fixed stub so callers that never pass it see unchanged behavior). storage lets
// a caller share one localStorage-backed Map across two separate boots, to simulate
// a page reload that must see what the first boot persisted.
function buildLivenessVm({ fakeState, getNow, onFetch, promptQueue, storage }) {
  let timers = [];
  let tid = 1;
  const pump = () => { for (const t of [...timers]) t.fn(); }; // one tick of every live interval

  const makeEl = () => {
    const listeners = {};
    return {
      textContent: '', innerHTML: '', hidden: false, disabled: false, value: '',
      className: '', dataset: {}, style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, contains: () => false },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener() {}, appendChild() {}, removeChild() {},
      append() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
      scrollIntoView() {}, focus() {}, setSelectionRange() {},
      querySelector: () => makeEl(), querySelectorAll: () => [], contains: () => false,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), cloneRange() { return this; },
      // test-only: replay a captured listener (e.g. click the 'edit' button built by renderIdentity()).
      dispatch(type) { for (const fn of listeners[type] || []) fn(); },
    };
  };
  const els = {};
  const getEl = (id) => (els[id] || (els[id] = makeEl()));

  let es = null;
  let fetchCalls = 0; // count GET /api/state re-syncs (fetchState); always tracked, cheap either way
  let promptCalls = 0;
  const queue = promptQueue || [];
  const fire = (type, data) => es && es._h[type] && es._h[type]({ data: JSON.stringify(data) });

  const ctx = vm.createContext({
    window: {},
    document: {
      getElementById: getEl, querySelector: () => makeEl(), querySelectorAll: () => [], addEventListener() {},
      createElement: () => makeEl(), createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({}) }),
      createTreeWalker: () => ({ nextNode: () => null, currentNode: null }), title: '',
    },
    location: { pathname: '/s/abc' },
    EventSource: function (url) { es = { _url: url, onopen: null, _h: {}, addEventListener(t, fn) { this._h[t] = fn; } }; return es; },
    fetch: () => { fetchCalls++; if (onFetch) onFetch(); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fakeState) }); },
    setInterval: (fn) => { const id = tid++; timers.push({ id, fn }); return id; },
    clearInterval: (id) => { const idx = timers.findIndex((t) => t.id === id); if (idx !== -1) timers.splice(idx, 1); },
    setTimeout: () => 0, clearTimeout: () => {},
    Date: { now: getNow }, NodeFilter: { SHOW_TEXT: 4 }, confirm: () => true,
    prompt: () => { promptCalls++; return queue.length ? queue.shift() : null; },
    // Browser globals the reviewer-identity module (app.js) legitimately uses.
    crypto: { randomUUID: () => `shim-uuid-${tid++}` },
    localStorage: (() => {
      const m = storage || new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
    })(),
    JSON, Math, Number, String, Array, Object, Boolean, console, Promise, encodeURIComponent, decodeURIComponent,
  });

  const load = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), ctx, { filename: file });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

  return {
    ctx, getEl, fire, pump, timers, load, flush,
    get fetchCalls() { return fetchCalls; },
    get promptCalls() { return promptCalls; },
    get es() { return es; },
  };
}

// Exercise the working-overlay liveness WIRING the way a browser would: load the
// real public/liveness.js + public/app.js as two classic scripts into one shared
// scope (a hand-rolled, zero-dep DOM shim with a controllable clock), then drive
// the SSE lifecycle and assert what the reviewer sees. This is the only layer
// that catches (a) two <script>s colliding on a top-level `const`, which takes
// the whole page down, and (b) timer start/stop/reset bugs that structural regex
// checks can't see. No DOM library — just the handful of globals app.js touches.
async function driveLivenessWiring() {
  let now = 1_000_000; // fake clock (ms); app.js reads Date.now()
  let fetchCalls = 0; // count GET /api/state re-syncs (fetchState) so we can assert echo suppression
  const fakeState = { doc: { title: 'T', html: '<p>x</p>', version: 1 }, status: 'reviewing', review: { comments: [], choices: {} }, chat: [], progress: [], presence: [] };
  const vmHandle = buildLivenessVm({
    fakeState,
    getNow: () => now,
    onFetch: () => fetchCalls++,
  });
  const { ctx, getEl, fire, pump, timers, load, flush } = vmHandle;

  load('liveness.js');
  let loadErr = null;
  try {
    load('app.js'); // two classic scripts, one scope: a colliding top-level `const` throws here
  } catch (e) {
    loadErr = e;
  }
  // A redeclaration SyntaxError means the page is dead in the browser. Runtime
  // ReferenceErrors (document/location under our shim) are fine — instantiation
  // succeeded, which is all this assertion is about.
  const collided = loadErr && /already been declared/.test(loadErr.message);
  check('liveness.js + app.js load together with no top-level identifier collision', !collided, loadErr && loadErr.message);
  if (collided) return; // nothing more to drive — the page wouldn't have loaded

  await flush(); // boot fetchState() settles → status 'reviewing'
  const overlay = getEl('working-overlay'), elapsed = getEl('working-elapsed'), stale = getEl('working-stale');

  check('liveness: idle/reviewing shows no timer and a hidden overlay', overlay.hidden === true && timers.length === 0);

  fire('status', { status: 'working' });
  check('liveness: entering working shows the overlay and paints 0:00 at once', overlay.hidden === false && elapsed.textContent === '0:00', elapsed.textContent);
  check('liveness: exactly one timer runs while working', timers.length === 1, String(timers.length));

  fire('status', { status: 'working' }); // a re-broadcast must not start a second timer
  check('liveness: a re-broadcast working event does not duplicate the timer', timers.length === 1, String(timers.length));

  now += 5000; pump();
  check('liveness: elapsed ticks up (0:05) and stays fresh below threshold', elapsed.textContent === '0:05' && stale.hidden === true, elapsed.textContent);

  now += 40000; pump(); // 45s since the last sign of life
  check(
    'liveness: past the threshold a muted advisory appears with the count',
    elapsed.textContent === '0:45' && stale.hidden === false && stale.textContent === 'No updates for 45 s — the agent may be stuck.',
    JSON.stringify({ e: elapsed.textContent, h: stale.hidden, t: stale.textContent })
  );

  fire('progress', { text: 'Rewriting section', ts: 0 }); // a sign of life clears the advisory, timer keeps running
  check('liveness: a progress event clears the advisory and keeps the timer', stale.hidden === true && stale.textContent === '' && timers.length === 1, JSON.stringify({ h: stale.hidden, n: timers.length }));

  now += 3000; pump();
  check('liveness: elapsed keeps climbing (0:48) but stays fresh after progress', elapsed.textContent === '0:48' && stale.hidden === true, elapsed.textContent);

  now += 41000; pump();
  check('liveness: silence past the threshold again re-shows the advisory', stale.hidden === false, JSON.stringify(stale.textContent));
  fakeState.status = 'reviewing';
  fire('doc', {}); // reworked doc arrives → present → reviewing
  await flush();
  check(
    'liveness: the reworked document loading stops the timer and clears the cue',
    timers.length === 0 && elapsed.textContent === '' && stale.hidden === true && stale.textContent === '',
    JSON.stringify({ n: timers.length, e: elapsed.textContent, h: stale.hidden })
  );

  fakeState.status = 'working';
  fire('status', { status: 'working' });
  check('liveness: a fresh rework round restarts the timer at 0:00', timers.length === 1 && elapsed.textContent === '0:00');
  fire('status', { status: 'ended' }); // terminal state must look exactly as before: no timer, no cue
  check('liveness: a terminal state stops the timer and clears the cue', timers.length === 0 && elapsed.textContent === '' && stale.hidden === true);

  // review-delta echo suppression (functional, not just regex): a PEER's delta must
  // trigger a re-sync (fetchState → GET /api/state); this tab's OWN echo must not (or a
  // flipped ===/!== would spin every tab in a self-refetch loop / never show peers).
  const myId = vm.runInContext('reviewer.id', ctx);
  const beforePeer = fetchCalls;
  fire('review', { author: { id: 'some-peer-id' } });
  await flush();
  check('review: a peer delta triggers a re-sync (fetchState)', fetchCalls > beforePeer, `Δ=${fetchCalls - beforePeer}`);
  const beforeOwn = fetchCalls;
  fire('review', { author: { id: myId } });
  await flush();
  check('review: this tab ignores its own echo (no re-sync)', fetchCalls === beforeOwn, `Δ=${fetchCalls - beforeOwn}`);

  // presence (issue 007): the SSE connection must carry this tab's reviewer id so the
  // server can roster it — assert the URL the real connectEvents() built (not just that
  // an unused helper exists in source).
  check(
    'presence: connectEvents opens the SSE carrying the reviewer id (rid=<our id>)',
    !!vmHandle.es && typeof vmHandle.es._url === 'string' && vmHandle.es._url.includes('rid=' + encodeURIComponent(myId)),
    vmHandle.es && vmHandle.es._url
  );

  // Firing a roster must render without throwing, must tolerate malformed / non-array /
  // non-string-name payloads (FM-12), and — the security-relevant one — an untrusted name
  // must reach the DOM only via textContent/title, NEVER innerHTML (TM-3). The shim's
  // appendChild is a no-op, so inspecting the container proves nothing; spy on
  // createElement to capture the avatars actually built and inspect THEM.
  const createdEls = [];
  const realCreate = ctx.document.createElement;
  ctx.document.createElement = (tag) => { const el = realCreate(tag); createdEls.push(el); return el; };
  const XSS = '<img src=x onerror=alert(1)>';
  let presenceThrew = null;
  try {
    fire('presence', [{ id: 'peer1', name: 'Peer One', connectedAt: 1, count: 1 }, { id: myId, name: 'Me', connectedAt: 1, count: 2 }]);
    fire('presence', [{ id: 'evil', name: XSS, connectedAt: 1, count: 1 }]);
    fire('presence', [{ id: 'num', name: 42, connectedAt: 1, count: 1 }]); // non-string name
    fire('presence', [{}]);
    fire('presence', [{ id: 'x' }]);
    fire('presence', null);
  } catch (e) {
    presenceThrew = e;
  }
  ctx.document.createElement = realCreate;
  check(
    'presence: rendering a roster (HTML/non-string name, malformed, non-array) never throws (FM-12)',
    !presenceThrew,
    presenceThrew && presenceThrew.message
  );
  const innerHtmlHasPayload = createdEls.some((el) => typeof el.innerHTML === 'string' && el.innerHTML.includes('<img'));
  const nameRenderedViaTitle = createdEls.some((el) => (el.title || '').includes(XSS));
  check(
    'presence: an untrusted name reaches title/textContent but NEVER innerHTML (TM-3)',
    nameRenderedViaTitle && !innerHtmlHasPayload,
    JSON.stringify({ nameRenderedViaTitle, innerHtmlHasPayload })
  );

  // ---------- archived-comment management (issue 010) ----------
  // Drive clearArchived() against the real, loaded app.js state (not just a
  // source regex) so the "own comments only" scoping and the "active comments
  // untouched" invariant are actually exercised, not merely asserted to exist.
  // The liveness checks above leave state.status as 'ended' — clearArchived()
  // now refuses to act outside 'reviewing' (see its own guard), so every
  // fixture in this section needs an explicit reset first.
  // r3 carries an EXPLICIT author matching this tab's reviewer id — the shape
  // every real comment gets (app.js stamps `author: author()` on creation) —
  // so this exercises ownComment()'s `c.author.id === reviewer.id` branch, not
  // just its `!c.author` legacy fallback (which r1/r2 alone would only cover).
  vm.runInContext(
    `state.status = 'reviewing';
    state.comments = [
      { id: 'a1', quote: 'q1', text: 'active', archived: false },
      { id: 'r1', quote: 'q2', text: 'mine, archived', archived: true },
      { id: 'r2', quote: 'q3', text: 'mine too, archived', archived: true },
      { id: 'r3', quote: 'q5', text: 'mine, explicit author', archived: true, author: { id: '${myId}' } },
      { id: 'p1', quote: 'q4', text: "peer's archived", archived: true, author: { id: 'peer-1' } },
    ];`,
    ctx
  );
  const beforeClear = fetchCalls;
  vm.runInContext('clearArchived()', ctx);
  const afterClear = vm.runInContext('state.comments', ctx);
  check(
    "clearArchived: removes only the reviewer's own archived comments (a peer's survives)",
    afterClear.length === 2 &&
      afterClear.some((c) => c.id === 'a1') &&
      afterClear.some((c) => c.id === 'p1') &&
      !afterClear.some((c) => c.id === 'r1' || c.id === 'r2' || c.id === 'r3'),
    JSON.stringify(afterClear.map((c) => c.id))
  );
  check(
    'clearArchived: the surviving active comment is untouched (still archived: false)',
    afterClear.find((c) => c.id === 'a1').archived === false
  );
  check(
    'clearArchived: a real clear syncs the trimmed list to the server (fetch fired)',
    fetchCalls > beforeClear,
    `Δ=${fetchCalls - beforeClear}`
  );

  vm.runInContext(`state.comments = [{ id: 'a1', quote: 'q1', text: 'active', archived: false }];`, ctx);
  const beforeNoop = vm.runInContext('state.comments', ctx);
  const beforeNoopFetch = fetchCalls;
  vm.runInContext('clearArchived()', ctx);
  const afterNoop = vm.runInContext('state.comments', ctx);
  check(
    'clearArchived: a no-op (nothing archived-and-own) leaves state.comments untouched',
    afterNoop === beforeNoop,
    'expected the same array reference when there is nothing to clear'
  );
  check(
    'clearArchived: a no-op does not sync (no fetch fired)',
    fetchCalls === beforeNoopFetch,
    `Δ=${fetchCalls - beforeNoopFetch}`
  );

  // Peer-only-archived (multi-reviewer): the reviewer owns no archived comment at
  // all, only a peer's — clearArchived() must leave everything alone, matching
  // the "Clear all" button's own render gate (archived.some(ownComment)).
  vm.runInContext(
    `state.comments = [
      { id: 'a1', quote: 'q1', text: 'active', archived: false },
      { id: 'p1', quote: 'q4', text: "peer's archived", archived: true, author: { id: 'peer-1' } },
    ];`,
    ctx
  );
  const beforePeerOnly = vm.runInContext('state.comments', ctx);
  const beforePeerOnlyFetch = fetchCalls;
  vm.runInContext('clearArchived()', ctx);
  const afterPeerOnly = vm.runInContext('state.comments', ctx);
  check(
    "clearArchived: a peer-only-archived session (reviewer owns none) is untouched, no sync fired",
    afterPeerOnly === beforePeerOnly && fetchCalls === beforePeerOnlyFetch,
    `sameRef=${afterPeerOnly === beforePeerOnly} Δfetch=${fetchCalls - beforePeerOnlyFetch}`
  );

  // Race (pre-PR logic review finding): the "Clear all" button, once rendered
  // while reviewing, stays in the DOM and bound through a status flip to
  // 'working' — setStatus() (app.js:144) never re-renders the sidebar, neither
  // does submitReview() or the 'status' SSE handler. A stale click could land
  // after the flip. clearArchived() must refuse to act once status is no
  // longer 'reviewing', regardless of what a stale button click carries.
  vm.runInContext(
    `state.comments = [
      { id: 'a1', quote: 'q1', text: 'active', archived: false },
      { id: 'r1', quote: 'q2', text: 'mine, archived', archived: true },
    ];
    state.status = 'working';`,
    ctx
  );
  const beforeWorking = vm.runInContext('state.comments', ctx);
  const beforeWorkingFetch = fetchCalls;
  vm.runInContext('clearArchived()', ctx);
  const afterWorking = vm.runInContext('state.comments', ctx);
  check(
    'clearArchived: refuses to act while status is not "reviewing" (closes the stale-button race)',
    afterWorking === beforeWorking && fetchCalls === beforeWorkingFetch,
    `sameRef=${afterWorking === beforeWorking} Δfetch=${fetchCalls - beforeWorkingFetch}`
  );
  vm.runInContext(`state.status = 'reviewing';`, ctx); // restore in case ctx is inspected further
}

// ---------- liveness refresh accuracy (issue 009 T3) ----------
//
// driveLivenessWiring above proves a LIVE tab's timer/staleness lifecycle is
// correct. These scenarios prove a REFRESHED tab is correct too: app.js must
// seed workingStartTs/lastSignalTs from the server-reported workingSince /
// lastAgentActivity (carried on GET /api/state and on the `status` SSE event)
// rather than always restarting the clock at Date.now(). Each scenario gets
// its own fresh VM context/session — unlike driveLivenessWiring's one long
// story — since each needs a different boot payload and must not disturb the
// existing scenario's assertions.
//
// Factored out of driveLivenessWiring's inline setup so each scenario below
// can boot its own isolated shim with its own fake clock and fake state.
function bootLivenessHarness(fakeState, initialNow) {
  const clock = { now: initialNow }; // mutable box so Date.now() can be advanced after boot
  const { pump, fire, flush, getEl, timers, load } = buildLivenessVm({ fakeState, getNow: () => clock.now });
  load('liveness.js');
  load('app.js');

  return { clock, pump, fire, flush, getEl, timerCount: () => timers.length };
}

// Shared boot boilerplate for driveLivenessRefreshAccuracy's scenarios: merge
// each scenario's distinctive fields (workingSince/lastAgentActivity/status/etc.)
// over a default idle-doc fakeState, boot the harness, flush the initial
// fetchState(), and hand back the two elements every scenario asserts against.
async function runLivenessScenario(overrides, initialNow) {
  const fakeState = {
    doc: { title: 'T', html: '<p>x</p>', version: 1 },
    status: 'working',
    review: { comments: [], choices: {} },
    chat: [],
    progress: [],
    ...overrides,
  };
  const h = bootLivenessHarness(fakeState, initialNow);
  await h.flush(); // boot fetchState() settles
  return { h, elapsed: h.getEl('working-elapsed'), stale: h.getEl('working-stale') };
}

async function driveLivenessRefreshAccuracy() {
  // Scenario 1: a refresh mid-round shows the REAL elapsed time, not 0:00.
  {
    const workingSince = 1_000_000;
    const lastAgentActivity = workingSince + 5000;
    const now = workingSince + 12000; // boot 12s into a round already underway
    const { h, elapsed } = await runLivenessScenario({ workingSince, lastAgentActivity }, now);
    const overlay = h.getEl('working-overlay');
    check(
      'liveness refresh: overlay is visible on a mid-round boot',
      overlay.hidden === false,
      String(overlay.hidden)
    );
    check(
      'liveness refresh: mid-round boot paints the REAL elapsed time (0:12), not 0:00',
      elapsed.textContent === '0:12' && elapsed.textContent !== '0:00',
      elapsed.textContent
    );

    // Extend scenario 1 to prove lastSignalTs is really Math.max(lastAgentActivity,
    // workingSince) rather than workingSince alone. lastAgentActivity (1_005_000) is
    // 5s AFTER workingSince (1_000_000), so the two candidate staleness deadlines
    // land 5s apart: since-alone would cross the 40s threshold at now=1_040_000;
    // the correct max-based lastSignalTs (1_005_000) crosses it 5s later, at
    // now=1_045_000. Landing the clock in between (1_042_000) is hidden under the
    // correct implementation but would already show under a since-alone regression
    // that silently dropped the Math.max computation — the exact gap this closes.
    const stale = h.getEl('working-stale');
    h.clock.now = workingSince + 42000; // 1_042_000: past since-based deadline, before last-based deadline
    h.pump();
    check(
      'liveness refresh: Math.max(last, since) — hint stays hidden between the since-only and last-based deadlines',
      stale.hidden === true,
      JSON.stringify({ hidden: stale.hidden, text: stale.textContent })
    );
    h.clock.now = workingSince + 46000; // 1_046_000: past the correct (last-based) deadline too
    h.pump();
    check(
      'liveness refresh: Math.max(last, since) — hint finally appears once the last-based deadline passes',
      stale.hidden === false,
      JSON.stringify({ hidden: stale.hidden, text: stale.textContent })
    );
  }

  // Scenario 2 (FM-4): a malformed activity payload never produces "NaN s".
  {
    const now = 2_000_000;
    const { h, elapsed, stale } = await runLivenessScenario(
      { workingSince: 'not-a-number', lastAgentActivity: 'also-not-a-number' },
      now
    );
    check(
      'liveness refresh FM-4: garbage workingSince/lastAgentActivity falls back to Date.now() (0:00)',
      elapsed.textContent === '0:00',
      elapsed.textContent
    );
    check(
      'liveness refresh FM-4: the staleness hint never renders "NaN" and stays hidden',
      stale.hidden === true && !/NaN/.test(stale.textContent),
      JSON.stringify({ hidden: stale.hidden, text: stale.textContent })
    );
    h.pump(); // one more tick for good measure — still must never go NaN
    check(
      'liveness refresh FM-4: still no "NaN" after a tick',
      !/NaN/.test(elapsed.textContent) && !/NaN/.test(stale.textContent),
      JSON.stringify({ e: elapsed.textContent, s: stale.textContent })
    );
  }

  // Scenario 3 (FM-9): a future workingSince (clock skew) clamps to 0:00, no crash.
  {
    const now = 3_000_000;
    const workingSince = now + 5000; // ahead of "now" — simulated clock skew
    const { elapsed, stale } = await runLivenessScenario({ workingSince, lastAgentActivity: workingSince }, now);
    check(
      'liveness refresh FM-9: a future workingSince clamps the first tick to 0:00 (no negative/garbage)',
      elapsed.textContent === '0:00',
      elapsed.textContent
    );
    check(
      'liveness refresh FM-9: the staleness hint stays hidden under clock skew',
      stale.hidden === true,
      JSON.stringify({ hidden: stale.hidden, text: stale.textContent })
    );
  }

  // Scenario 4 (FM-2/FM-11): a stray workingSince on a terminal status is inert —
  // e.g. /agent/stop firing mid-round, which the server now allows. The 'ended'
  // branch of setStatus never reads `activity`, so this must produce the exact
  // same clean teardown as a bare {status:'ended'} event.
  {
    const now = 4_000_000;
    const { h } = await runLivenessScenario({ status: 'reviewing', workingSince: null, lastAgentActivity: null }, now); // boots into 'reviewing', no timer yet
    const workingSince = now - 3000; // a real round already 3s underway
    h.fire('status', { status: 'working', workingSince, lastAgentActivity: workingSince });
    check(
      'liveness refresh FM-2/FM-11 setup: a real round is running before the stray-stop event',
      h.timerCount() === 1,
      String(h.timerCount())
    );
    // /agent/stop mid-round: the server now allows this and still carries the
    // (now-stale) workingSince/lastAgentActivity fields on the terminal event.
    h.fire('status', { status: 'ended', workingSince, lastAgentActivity: workingSince });
    const elapsed = h.getEl('working-elapsed');
    const stale = h.getEl('working-stale');
    check(
      'liveness refresh FM-2/FM-11: a stray workingSince on a terminal status is inert — clean teardown',
      h.timerCount() === 0 && elapsed.textContent === '' && stale.hidden === true,
      JSON.stringify({ timers: h.timerCount(), elapsed: elapsed.textContent, staleHidden: stale.hidden })
    );
  }

  // Scenario 5 (FM-4 mixed payload): the failure mode Number.isFinite actually
  // guards against is a MIXED payload — one field a real timestamp, the other
  // garbage — not both-garbage (scenario 2 above; both-garbage happens to land on
  // NaN either way, since formatElapsed/stalenessHint already clamp NaN, so it
  // passes identically with or without the guard and proves nothing on its own).
  // With a naive `??`/`||` fallback, Math.max(garbageString, validNumber) still
  // coerces to NaN (Math.max always Numbers both args), which would permanently
  // poison lastSignalTs for the rest of the round: Date.now() - NaN is always NaN,
  // and stalenessHint's `!(NaN >= threshold)` is true, so it returns null forever
  // — the staleness advisory would be silently, permanently disabled. The correct
  // Number.isFinite guard instead falls the garbage field back to `since`, keeping
  // lastSignalTs a real number so staleness detection keeps working.
  {
    const now = 5_000_000;
    const workingSince = now - 5000; // a real round already 5s underway
    const { h, elapsed, stale } = await runLivenessScenario(
      { workingSince, lastAgentActivity: 'garbage' }, // the other field is garbage — the mixed case
      now
    );
    check(
      'liveness refresh FM-4 mixed: a valid workingSince paints the real elapsed time (0:05), proving it was not discarded',
      elapsed.textContent === '0:05',
      elapsed.textContent
    );
    h.clock.now = workingSince + 40000; // now - workingSince === 40000: past the staleness threshold
    h.pump();
    check(
      'liveness refresh FM-4 mixed: garbage lastAgentActivity does not poison Math.max into NaN — the staleness hint still fires',
      stale.hidden === false && !/NaN/.test(stale.textContent),
      JSON.stringify({ hidden: stale.hidden, text: stale.textContent })
    );
  }

  // Scenario 6 (FX-7): a LEFTOVER lastAgentActivity from a PREVIOUS round can be
  // numerically SMALLER (older) than the new round's workingSince — this is the
  // exact scenario that motivates Math.max(last, since) instead of using `last`
  // alone. Same discrimination technique as scenario 1: land the clock between
  // the WRONG (last-alone) deadline and the CORRECT (max-based) one, and prove
  // the stale, older lastAgentActivity does not make the hint fire early.
  {
    const STALE = liveness.STALE_THRESHOLD_MS;
    const workingSince = 6_000_000;
    const lastAgentActivity = workingSince - 5000; // stale, from a prior round — OLDER than workingSince
    const now = workingSince + 10000; // boot 10s into the new round
    const { h, elapsed, stale } = await runLivenessScenario({ workingSince, lastAgentActivity }, now);
    check(
      'liveness refresh FX-7: mid-round boot paints the real elapsed time (0:10) despite a stale, older lastAgentActivity',
      elapsed.textContent === '0:10',
      elapsed.textContent
    );

    // Wrong (last-alone) deadline: lastAgentActivity + STALE = (workingSince - 5000) + STALE.
    // Correct (max-based) deadline: workingSince + STALE — 5s later, since workingSince
    // is the larger (more recent) of the two candidates and Math.max must pick it.
    h.clock.now = workingSince - 5000 + STALE + 2000; // past the WRONG deadline, still before the correct one
    h.pump();
    check(
      'liveness refresh FX-7: Math.max(last, since) — the stale, older lastAgentActivity does not win; hint stays hidden past the wrong last-alone deadline',
      stale.hidden === true,
      JSON.stringify({ hidden: stale.hidden, text: stale.textContent })
    );

    h.clock.now = workingSince + STALE + 2000; // past the CORRECT (max-based) deadline
    h.pump();
    check(
      'liveness refresh FX-7: Math.max(last, since) — past the correct max-based deadline, the hint finally appears',
      stale.hidden === false,
      JSON.stringify({ hidden: stale.hidden, text: stale.textContent })
    );
  }
}

// ---------- reviewer identity: first-load name prompt (issue 011 #1) ----------
//
// Before this feature a first-time reviewer's header read "you are 2cf83d89" — the
// head of their crypto.randomUUID() id — since authorLabel() falls back to a hash
// slice when a reviewer has no name. Drive the real app.js boot in the same DOM shim
// driveLivenessWiring uses (minus liveness.js, which this feature doesn't touch) to
// prove the header never shows that raw hash, without touching authorLabel() itself —
// which other reviewers' attribution (comments, badges, presence tooltips) still relies
// on for its existing hash-fallback disambiguation.
function idleFakeState() {
  return { doc: { title: 'T', html: '<p>x</p>', version: 1 }, status: 'reviewing', review: { comments: [], choices: {} }, chat: [], progress: [], presence: [] };
}

// Boots app.js (no liveness.js — this feature never touches window.Liveness) with a
// createElement spy already installed, so callers can read back the label/edit
// elements renderIdentity() builds during boot. Returns the vm handle plus `created`,
// the ordered list of elements createElement() has produced so far.
function bootIdentityHarness({ promptQueue, storage, serverDefaultName } = {}) {
  const vmHandle = buildLivenessVm({ fakeState: idleFakeState(), getNow: () => 1, promptQueue, storage });
  // The server injects the agent-seeded default name as a window global on the page
  // (see server.js sendSessionPage); set it here before app.js boots so scenarios can
  // exercise the "adopt the default instead of prompting" path.
  if (serverDefaultName !== undefined) vmHandle.ctx.window.__planreviewDefaultName = serverDefaultName;
  const created = [];
  const realCreate = vmHandle.ctx.document.createElement;
  vmHandle.ctx.document.createElement = (tag) => { const el = realCreate(tag); created.push(el); return el; };
  vmHandle.load('app.js');
  // Attach `created` on the SAME object rather than spreading vmHandle into a new one —
  // a spread would snapshot its getter properties (fetchCalls/promptCalls) into static
  // values at this instant, breaking live tracking of calls made later in the test.
  vmHandle.created = created;
  return vmHandle;
}

// Elements are looked up by className rather than by position in `created` — position
// would break if renderIdentity() ever creates/reorders an extra element, even though
// behavior hadn't changed. Most-recent-first, since a re-render (e.g. after 'edit')
// appends a fresh label/button rather than replacing the old ones in `created`.
function findLastByClass(created, className) {
  for (let i = created.length - 1; i >= 0; i--) {
    if (created[i].className === className) return created[i];
  }
  return undefined;
}
const identityLabelEl = (h) => findLastByClass(h.created, 'identity-name');
const identityEditBtn = (h) => findLastByClass(h.created, 'btn identity-edit');

async function driveReviewerIdentityPrompt() {
  // Scenario 1: a brand-new reviewer (no stored name) is prompted once on boot; a
  // real answer is stored and reflected immediately in the header — and the existing
  // 'edit' flow (unchanged) still works afterwards, reusing the same window.prompt()
  // (queued as a second scripted answer, consumed on the later click).
  {
    const h = bootIdentityHarness({ promptQueue: ['Ada', 'Ada2'] });
    await h.flush();

    check('identity FM-1: a first-time reviewer is prompted for a name exactly once on boot', h.promptCalls === 1, String(h.promptCalls));
    check(
      'identity FM-1: a real answer to the first-load prompt renders in the header, not the raw id hash',
      identityLabelEl(h).textContent === 'you are Ada',
      identityLabelEl(h).textContent
    );
    check('identity FM-1: the answered name is persisted for future loads/attribution', vm.runInContext('reviewer.name', h.ctx) === 'Ada');

    const fetchBefore = h.fetchCalls;
    identityEditBtn(h).dispatch('click');
    await h.flush();

    check(
      "identity FM-1: the existing 'edit' flow still updates the header after the first-load prompt",
      identityLabelEl(h).textContent === 'you are Ada2',
      identityLabelEl(h).textContent
    );
    check('identity FM-1: editing the name still re-syncs (syncReview fires)', h.fetchCalls > fetchBefore, `Δ=${h.fetchCalls - fetchBefore}`);
  }

  // Scenario 2 (FM-2): dismissing the first-load prompt (Cancel → null) must not hard-block
  // or fall back to the raw id hash — a neutral placeholder shows instead — and a simulated
  // reload (same localStorage) does not nag the reviewer with the prompt again.
  {
    const storage = new Map();
    const h1 = bootIdentityHarness({ promptQueue: [null], storage });
    await h1.flush();
    check('identity FM-2: dismissing (Cancel) the first-load prompt still only prompts once', h1.promptCalls === 1, String(h1.promptCalls));
    check(
      'identity FM-2: a dismissed prompt shows a neutral placeholder, never the raw id hash',
      identityLabelEl(h1).textContent === 'you are Reviewer',
      identityLabelEl(h1).textContent
    );

    const h2 = bootIdentityHarness({ promptQueue: [], storage });
    await h2.flush();
    check('identity FM-2: a later load with the same storage does not re-prompt after a dismissal', h2.promptCalls === 0, String(h2.promptCalls));
    check(
      'identity FM-2: the later load still shows the neutral placeholder (no name was ever stored)',
      identityLabelEl(h2).textContent === 'you are Reviewer',
      identityLabelEl(h2).textContent
    );
  }

  // Scenario 3 (FM-3): submitting a blank/whitespace-only answer is treated the same as a
  // dismissal — no name stored, no re-prompt on the next load.
  {
    const storage = new Map();
    const h1 = bootIdentityHarness({ promptQueue: ['   '], storage });
    await h1.flush();
    check('identity FM-3: a whitespace-only answer does not become the stored name', vm.runInContext('reviewer.name', h1.ctx) === '');
    check(
      'identity FM-3: a whitespace-only answer renders the neutral placeholder, not blank/hash',
      identityLabelEl(h1).textContent === 'you are Reviewer',
      identityLabelEl(h1).textContent
    );

    const h2 = bootIdentityHarness({ promptQueue: [], storage });
    await h2.flush();
    check('identity FM-3: a later load does not re-prompt after a blank answer', h2.promptCalls === 0, String(h2.promptCalls));
  }

  // Scenario 4 (FM-4): a reviewer who already has a name (pre-existing localStorage, e.g.
  // from before this feature shipped, or from a prior 'edit') is never prompted.
  {
    const storage = new Map([['pr.reviewerName', 'Bo']]);
    const h = bootIdentityHarness({ promptQueue: [], storage });
    await h.flush();
    check('identity FM-4: a reviewer with an existing name is not prompted on boot', h.promptCalls === 0, String(h.promptCalls));
    check(
      'identity FM-4: the existing name renders in the header unchanged',
      identityLabelEl(h).textContent === 'you are Bo',
      identityLabelEl(h).textContent
    );
  }

  // Scenario 5: attribution for OTHER reviewers must stay stable. An unnamed PEER's
  // presence tooltip still falls back to their id-hash slice via the untouched
  // authorLabel()/renderPresence() path — never identityLabel()'s "Reviewer" placeholder,
  // which is scoped to this tab's own "you are" chip only.
  {
    const h = bootIdentityHarness({ promptQueue: ['Ada'] });
    await h.flush();
    h.fire('presence', [{ id: '87654321-peer-uuid', connectedAt: 1, count: 1 }]); // no name
    await h.flush();
    const avatar = findLastByClass(h.created, 'presence-avatar');
    check(
      "identity: an unnamed PEER's presence tooltip still falls back to their id-hash slice (attribution elsewhere stays stable)",
      avatar.title === '87654321',
      avatar.title
    );
  }

  // Scenario 6: the existing 'edit' flow's Cancel path (unchanged) leaves the name and
  // header untouched and does not re-sync.
  {
    const h = bootIdentityHarness({ promptQueue: ['Ada', null] });
    await h.flush();
    const fetchBefore = h.fetchCalls;
    identityEditBtn(h).dispatch('click');
    await h.flush();
    check('identity: dismissing the edit prompt (Cancel) leaves the stored name unchanged', vm.runInContext('reviewer.name', h.ctx) === 'Ada');
    check('identity: dismissing the edit prompt does not re-sync (no fetch fired)', h.fetchCalls === fetchBefore, `Δ=${h.fetchCalls - fetchBefore}`);
    check(
      'identity: dismissing the edit prompt leaves the header text unchanged',
      identityLabelEl(h).textContent === 'you are Ada',
      identityLabelEl(h).textContent
    );
  }

  // Scenario 7 (server default): the agent seeds a default name (CLI resolves it from
  // --reviewer-name / $PLANREVIEW_REVIEWER_NAME / `git config user.name`, server injects
  // it into the page). A fresh browser (no stored name) adopts it silently — no prompt —
  // and it flows through to the header AND to author attribution.
  {
    const h = bootIdentityHarness({ promptQueue: ['SHOULD-NOT-BE-USED'], serverDefaultName: 'Grace Hopper' });
    await h.flush();
    check('identity FM-5: an agent-seeded default name means a fresh browser is never prompted', h.promptCalls === 0, String(h.promptCalls));
    check(
      'identity FM-5: the agent-seeded default renders in the header',
      identityLabelEl(h).textContent === 'you are Grace Hopper',
      identityLabelEl(h).textContent
    );
    check(
      'identity FM-5: the agent-seeded default flows through to author attribution',
      vm.runInContext('author().name', h.ctx) === 'Grace Hopper',
      String(vm.runInContext('author().name', h.ctx))
    );
  }

  // Scenario 8 (server default, precedence): a name this browser already saved wins over
  // the agent-seeded default — a reviewer who renamed themselves here keeps that name.
  {
    const storage = new Map([['pr.reviewerName', 'Bo']]);
    const h = bootIdentityHarness({ promptQueue: [], storage, serverDefaultName: 'Grace Hopper' });
    await h.flush();
    check('identity FM-5: a saved localStorage name still suppresses the prompt with a default present', h.promptCalls === 0, String(h.promptCalls));
    check(
      'identity FM-5: a saved localStorage name wins over the agent-seeded default',
      identityLabelEl(h).textContent === 'you are Bo',
      identityLabelEl(h).textContent
    );
  }

  // Scenario 9 (no/empty default): an empty default is treated as absent — a fresh browser
  // still gets the first-load prompt, exactly as before this feature.
  {
    const h = bootIdentityHarness({ promptQueue: ['Ada'], serverDefaultName: '  ' });
    await h.flush();
    check('identity FM-5: an empty/whitespace default does not suppress the first-load prompt', h.promptCalls === 1, String(h.promptCalls));
    check(
      'identity FM-5: with no usable default the prompt answer still renders',
      identityLabelEl(h).textContent === 'you are Ada',
      identityLabelEl(h).textContent
    );
  }
}

// ---------- persistence: sessions survive a server restart (issue 005) ----------
//
// Unlike the checks above (which drive the CLI-managed shared server on PORT),
// these need to control the server process directly — start it, kill -9, and
// restart it — with a temp PLANREVIEW_STATE_DIR. So this phase spawns
// `node server/server.js` itself on a separate port and talks HTTP directly.
async function persistenceChecks() {
  const SERVER = path.join(__dirname, '..', 'server', 'server.js');
  const PPORT = await freePort(); // own free port too — never clash with the main server or a sibling run
  const PBASE = `http://127.0.0.1:${PPORT}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-state-'));
  const doc = path.join(os.tmpdir(), 'planreview-persist-doc.md');
  const docV1 =
    '# Persisted Plan\n\nAlpha paragraph.\n\nBeta paragraph.\n\n' +
    '```choice\nid: pick\nprompt: Which?\noptions:\n  - One\n  - Two\n```\n';
  fs.writeFileSync(doc, docV1);

  const baseEnv = (extra) => ({
    ...process.env,
    PLANREVIEW_PORT: String(PPORT),
    PLANREVIEW_STATE_DIR: stateDir,
    PLANREVIEW_PERSIST_MS: '40', // short debounce so the flush lands fast in tests
    PLANREVIEW_IDLE_MS: '60000', // don't self-exit mid-test
    ...extra,
  });

  // Same three HTTP shapes as the module-level helpers, bound to this phase's port.
  const { json: p, text: pageText, alive: pAlive } = makeClient(PBASE);

  let child = null;
  function spawnP(extra) {
    child = spawn(process.execPath, [SERVER], {
      env: baseEnv(extra),
      stdio: ['ignore', 'ignore', 'inherit'], // surface server-side errors + skip logs
    });
  }
  async function waitHealth(up) {
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      if ((await pAlive()) === up) return true;
    }
    return false;
  }
  async function killP() {
    if (!child) return;
    child.kill('SIGKILL');
    await waitHealth(false);
    await sleep(150); // let the OS release the port before a respawn
    child = null;
  }
  const stop = (id) => p(`/agent/stop?session=${id}`, {}); // POST (body forces the method)
  const fileFor = (id) => path.join(stateDir, `${id}.json`);
  const readState = (id) => {
    try {
      return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
    } catch {
      return null;
    }
  };
  // poll the on-disk file until the debounced flush satisfies `pred`
  async function waitFile(id, pred) {
    for (let i = 0; i < 80; i++) {
      const st = readState(id);
      if (st && pred(st)) return st;
      await sleep(50);
    }
    return readState(id);
  }

  try {
    // ----- P1: kill -9 mid-review, restart -> everything restored -----
    console.log('persistence: a session survives kill -9 and is fully restored');
    spawnP();
    check('persistence server comes up', await waitHealth(true));
    const started = await p('/agent/start', { path: doc });
    const id = started.data.id;
    await p(`/api/review-state?session=${id}`, {
      comments: [{ id: 'c1', quote: 'Alpha paragraph.', text: 'keep this' }],
      choices: { pick: 'Two' },
    });
    await p(`/api/submit?session=${id}`, {
      comments: [{ id: 'c1', quote: 'Alpha paragraph.', text: 'keep this' }],
      choices: { pick: 'Two' },
      note: 'round one',
    });
    await p(`/api/chat?session=${id}`, { text: 'a question during review' });
    await p(`/agent/say?session=${id}`, { text: 'an agent reply' }); // agent chat must persist too
    await p(`/agent/progress?session=${id}`, { text: 'reworking step 1' });
    const before = await waitFile(
      id,
      (st) =>
        (st.submissions || []).length === 1 &&
        (st.progress || []).length === 1 &&
        (st.chat || []).length >= 2 &&
        st.status === 'working'
    );
    const EXPECTED_KEYS = [
      'chat',
      'defaultReviewerName',
      'doc',
      'id',
      'lastAgentActivity',
      'progress',
      'queue',
      'review',
      'status',
      'submissions',
      'touched',
      'workingSince',
    ];
    check(
      'persist: the on-disk file is exactly the serializable allowlist (no live handles)',
      before && JSON.stringify(Object.keys(before).sort()) === JSON.stringify(EXPECTED_KEYS),
      JSON.stringify(before && Object.keys(before).sort())
    );
    check(
      'persist: the on-disk file captures the full session state (incl. doc.blocks)',
      before &&
        before.submissions.length === 1 &&
        before.doc.version === 1 &&
        before.review.choices.pick.anonymous === 'Two' &&
        Array.isArray(before.doc.blocks),
      JSON.stringify(before && { v: before.doc && before.doc.version, sub: before.submissions.length })
    );

    // issue 007: presence is derived/live state. Open an SSE with an identity so the
    // roster is genuinely non-empty pre-restart, then prove (a) it shows in /api/state
    // while live, and (b) it never reaches the persisted file — the EXPECTED_KEYS check
    // above already forbids a `presence` key, this confirms a live roster doesn't sneak in.
    const presCtl = new AbortController();
    fetch(`${PBASE}/events?session=${id}&rid=ghost&rname=Ghost`, { signal: presCtl.signal }).catch(() => {});
    let livePres = [];
    for (let i = 0; i < 40; i++) {
      livePres = ((await p(`/api/state?session=${id}`)).data || {}).presence || [];
      if (livePres.some((r) => r.id === 'ghost')) break;
      await sleep(50);
    }
    check(
      'presence: a live SSE connection shows in /api/state before restart (issue 007)',
      livePres.some((r) => r.id === 'ghost' && r.count === 1),
      JSON.stringify(livePres)
    );
    // Force a debounced disk flush WHILE the roster is non-empty, so the "no presence key"
    // assertion proves a real mid-connection flush omits it — not just the earlier flush
    // that happened before anyone connected.
    await p(`/api/chat?session=${id}`, { text: 'flush with a reviewer present' });
    const flushed = await waitFile(id, (st) => (st.chat || []).some((c) => c.text === 'flush with a reviewer present'));
    check(
      'presence: a disk flush taken while a reviewer is present still omits presence (derived state, AC4)',
      flushed && !('presence' in flushed) && !('presenceTimer' in flushed),
      JSON.stringify(flushed && Object.keys(flushed))
    );
    presCtl.abort(); // drop the SSE before the kill so it can't linger

    await killP();
    spawnP();
    check('persist: server restarts after kill -9', await waitHealth(true));

    const restored = await p(`/api/state?session=${id}`);
    check(
      'presence: a restored session comes back with an empty roster until tabs reconnect (AC4)',
      Array.isArray(restored.data.presence) && restored.data.presence.length === 0,
      JSON.stringify(restored.data.presence)
    );
    check(
      'kill -9 restore: /api/state re-hydrates doc, review, choices, chat, progress, status',
      restored.status === 200 &&
        restored.data.status === 'working' &&
        restored.data.doc.title === 'Persisted Plan' &&
        restored.data.doc.version === 1 &&
        restored.data.review.comments.length === 1 &&
        restored.data.review.choices.pick.anonymous === 'Two' &&
        restored.data.chat.some((c) => c.role === 'reviewer' && c.text === 'a question during review') &&
        restored.data.chat.some((c) => c.role === 'agent' && c.text === 'an agent reply') &&
        restored.data.progress.length === 1,
      JSON.stringify(restored.data)
    );
    check(
      'kill -9 restore: the restored session has no live clients (empty sse/waiters)',
      restored.data.clients === 0,
      `clients=${restored.data.clients}`
    );
    check(
      'kill -9 restore: lastAgentActivity and workingSince round-trip exactly (set before the crash)',
      typeof before.lastAgentActivity === 'number' &&
        typeof before.workingSince === 'number' &&
        restored.data.lastAgentActivity === before.lastAgentActivity &&
        restored.data.workingSince === before.workingSince,
      JSON.stringify({
        before: { lastAgentActivity: before.lastAgentActivity, workingSince: before.workingSince },
        after: { lastAgentActivity: restored.data.lastAgentActivity, workingSince: restored.data.workingSince },
      })
    );
    const page = await pageText(`/s/${id}`);
    check('kill -9 restore: /s/<id> resolves after restart', page.ok);

    // submissions aren't in /api/state; prove they round-tripped by re-reading the file
    await p(`/agent/progress?session=${id}`, { text: 'reworking step 2' });
    const after = await waitFile(id, (st) => (st.progress || []).length === 2);
    check(
      'kill -9 restore: submissions survived the round-trip',
      after && after.submissions.length === 1 && after.submissions[0].note === 'round one',
      JSON.stringify(after && after.submissions)
    );

    // FM-6: doc.blocks survived, so the next present diffs against the real prior render
    fs.writeFileSync(doc, docV1.replace('Beta paragraph.', 'Beta paragraph EDITED.'));
    await p(`/agent/present?session=${id}`, { path: doc });
    const v2 = await p(`/api/state?session=${id}`);
    const marks = (v2.data.doc.html.match(/data-changed/g) || []).length;
    check(
      'kill -9 restore: doc.blocks survived so the next diff marks only the edited block',
      v2.data.doc.version === 2 && marks === 1 && /Beta paragraph EDITED/.test(v2.data.doc.html),
      `version=${v2.data.doc.version} marks=${marks}`
    );
    fs.writeFileSync(doc, docV1); // reset for later groups
    await stop(id);
    await sleep(300);

    // ----- P2: a queued-but-undelivered agent event survives the restart -----
    console.log('persistence: a queued agent event survives a restart');
    const q = await p('/agent/start', { path: doc });
    const qid = q.data.id;
    await p(`/api/chat?session=${qid}`, { text: 'queued while agent away' });
    const qfile = await waitFile(qid, (st) =>
      (st.queue || []).some((e) => e.type === 'chat' && e.text === 'queued while agent away')
    );
    check(
      'persist: the queued event is on disk before the crash',
      qfile && qfile.queue.length >= 1,
      JSON.stringify(qfile && qfile.queue)
    );
    await killP();
    spawnP();
    check('persist: server restarts (queued-event case)', await waitHealth(true));
    const waitRes = await p(`/agent/wait?session=${qid}&timeout=3000`);
    check(
      'queued event survives restart: the next /agent/wait delivers it',
      waitRes.data && waitRes.data.type === 'chat' && waitRes.data.text === 'queued while agent away',
      JSON.stringify(waitRes.data)
    );
    await stop(qid);
    await sleep(300);

    // ----- P3: stop deletes the file; a pending write never resurrects it -----
    console.log('persistence: stop deletes the file; a pending write never resurrects it');
    await killP();
    spawnP({ PLANREVIEW_PERSIST_MS: '400' }); // debounce longer than stop's 200ms teardown delay
    check('persist: server up (resurrection case)', await waitHealth(true));
    const d = await p('/agent/start', { path: doc });
    const did = d.data.id;
    check('stop test: a session file is created by persistence', !!(await waitFile(did, (st) => !!st)));
    // schedule a NEW persist, then stop before it can fire (removeSession @200ms < 400ms debounce)
    await p(`/api/review-state?session=${did}`, {
      comments: [{ id: 'x', quote: 'q', text: 't' }],
      choices: {},
    });
    await stop(did);
    await sleep(700); // past removeSession(200ms) AND the 400ms debounce that must be cancelled
    check(
      'stop deletes the file and the cancelled pending write does not resurrect it',
      !fs.existsSync(fileFor(did)),
      `exists=${fs.existsSync(fileFor(did))}`
    );

    // ----- P4: corrupt / empty / missing-id files are skipped, not fatal -----
    console.log('persistence: corrupt/empty/missing-id files are skipped, not fatal');
    await killP();
    spawnP();
    check('persist: server up (corrupt-file case)', await waitHealth(true));
    const good = await p('/agent/start', { path: doc });
    const gid = good.data.id;
    await waitFile(gid, (st) => !!st);
    await killP();
    fs.writeFileSync(path.join(stateDir, 'garbage.json'), '{ this is not json');
    fs.writeFileSync(path.join(stateDir, 'empty.json'), '');
    fs.writeFileSync(path.join(stateDir, 'noid.json'), JSON.stringify({ status: 'reviewing' }));
    fs.writeFileSync(path.join(stateDir, `${gid}.json.tmp`), 'partial-write-leftover'); // FM-14
    spawnP();
    check('corrupt files are not fatal: server still starts', await waitHealth(true));
    const goodState = await p(`/api/state?session=${gid}`);
    check(
      'the good session is restored despite sibling corrupt files',
      goodState.status === 200 && goodState.data.doc.title === 'Persisted Plan',
      JSON.stringify(goodState.status)
    );
    const listed = await p('/api/sessions');
    const ids4 = (listed.data || []).map((x) => x.id);
    check(
      'bad files were skipped, not loaded as sessions',
      ids4.length === 1 && ids4[0] === gid,
      JSON.stringify(ids4)
    );
    check(
      'a leftover .tmp is cleaned on restore (never loaded as a session)',
      !fs.existsSync(path.join(stateDir, `${gid}.json.tmp`)),
      'tmp still present'
    );
    await stop(gid);
    await sleep(300);

    // ----- P4b: FM-1 restore guard — a malformed/missing liveness field falls back to null -----
    console.log('persistence: a malformed lastAgentActivity type and a missing workingSince fall back to null (FM-1)');
    await killP();
    const stateDir4b = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-badtypes-'));
    const badId = 'badtypes1';
    fs.writeFileSync(
      path.join(stateDir4b, `${badId}.json`),
      JSON.stringify({
        id: badId,
        status: 'reviewing',
        doc: { path: null, title: 'BadTypes', html: '<p>Hi</p>', version: 1, blocks: ['<p>Hi</p>'], history: [] },
        review: { comments: [], choices: {} },
        submissions: [],
        chat: [],
        progress: [],
        queue: [],
        touched: Date.now(),
        lastAgentActivity: 'yesterday', // wrong type — must never pass through
        // workingSince intentionally omitted entirely
      })
    );
    spawnP({ PLANREVIEW_STATE_DIR: stateDir4b });
    check('persist: server up (bad-types case)', await waitHealth(true));
    const badState = await p(`/api/state?session=${badId}`);
    check(
      'FM-1: a wrong-typed lastAgentActivity and a missing workingSince both restore as null, not a crash',
      badState.status === 200 && badState.data.lastAgentActivity === null && badState.data.workingSince === null,
      JSON.stringify(badState.status === 200 ? { lastAgentActivity: badState.data.lastAgentActivity, workingSince: badState.data.workingSince } : badState.status)
    );
    await stop(badId);
    await sleep(300);
    fs.rmSync(stateDir4b, { recursive: true, force: true });

    // ----- P4b (mirror): the same guard applies to the OTHER field/direction -----
    console.log('persistence: a malformed workingSince type and a missing lastAgentActivity fall back to null (FM-1 mirror)');
    await killP();
    const stateDir4c = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-badtypes2-'));
    const badId2 = 'badtypes2';
    fs.writeFileSync(
      path.join(stateDir4c, `${badId2}.json`),
      JSON.stringify({
        id: badId2,
        status: 'working',
        doc: { path: null, title: 'BadTypes2', html: '<p>Hi</p>', version: 1, blocks: ['<p>Hi</p>'], history: [] },
        review: { comments: [], choices: {} },
        submissions: [],
        chat: [],
        progress: [],
        queue: [],
        touched: Date.now(),
        workingSince: 'yesterday', // wrong type — must never pass through
        // lastAgentActivity intentionally omitted entirely
      })
    );
    spawnP({ PLANREVIEW_STATE_DIR: stateDir4c });
    check('persist: server up (bad-types mirror case)', await waitHealth(true));
    const badState2 = await p(`/api/state?session=${badId2}`);
    check(
      'FM-1 mirror: a wrong-typed workingSince and a missing lastAgentActivity both restore as null, not a crash',
      badState2.status === 200 && badState2.data.workingSince === null && badState2.data.lastAgentActivity === null,
      JSON.stringify(badState2.status === 200 ? { workingSince: badState2.data.workingSince, lastAgentActivity: badState2.data.lastAgentActivity } : badState2.status)
    );
    await stop(badId2);
    await sleep(300);
    fs.rmSync(stateDir4c, { recursive: true, force: true });

    // ----- P5: PLANREVIEW_PERSIST=0 does no disk I/O -----
    console.log('persistence: PLANREVIEW_PERSIST=0 does no disk I/O');
    await killP();
    const stateDir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-nopersist-'));
    spawnP({ PLANREVIEW_PERSIST: '0', PLANREVIEW_STATE_DIR: stateDir0 });
    check('persist: server up (PERSIST=0 case)', await waitHealth(true));
    const z = await p('/agent/start', { path: doc });
    const zid = z.data.id;
    await p(`/api/chat?session=${zid}`, { text: 'no disk please' });
    await sleep(200); // longer than the debounce
    check(
      'PERSIST=0 writes nothing to STATE_DIR',
      fs.readdirSync(stateDir0).length === 0,
      JSON.stringify(fs.readdirSync(stateDir0))
    );
    const stopRes = await stop(zid);
    check(
      'PERSIST=0: stop still succeeds (delete is a safe no-op)',
      stopRes.data && stopRes.data.ok === true
    );
    await sleep(300);
    fs.rmSync(stateDir0, { recursive: true, force: true });

    // ----- FM-1: a failed write inside the debounced flush is logged, not fatal -----
    // The flush runs in a setTimeout, outside the request try/catch — an unhandled
    // throw there would take the whole process (every session) down.
    console.log('persistence: a failed disk write is swallowed, never crashes the process');
    await killP();
    const blocker = path.join(os.tmpdir(), `planreview-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'x'); // a regular file, so mkdir of a dir *under* it fails (ENOTDIR)
    spawnP({ PLANREVIEW_STATE_DIR: path.join(blocker, 'sub') });
    check('persist: server up (write-error case)', await waitHealth(true));
    const w = await p('/agent/start', { path: doc });
    check(
      'a mutation still returns 200 even when persistence cannot write',
      w.status === 200 && !!w.data.id
    );
    await sleep(300); // let the debounced flush fire and fail
    check('a failed disk write is swallowed — the server process survives', await waitHealth(true));
    await stop(w.data.id);
    await sleep(200);
    fs.rmSync(blocker, { force: true });

    // ----- FM-10: after a flush fires, a later mutation re-arms and persists again -----
    // Also covers /agent/say persistence. Deterministic: we wait for the FIRST flush to
    // land on disk (proving its debounce timer fired and was cleared) BEFORE the second
    // mutation, so the second write depends on the timer being re-armed — not on timing.
    console.log('persistence: a mutation after a flush re-arms the debounce (and /agent/say persists)');
    await killP();
    spawnP();
    check('persist: server up (reschedule case)', await waitHealth(true));
    const rs = await p('/agent/start', { path: doc });
    const rid = rs.data.id;
    await p(`/api/chat?session=${rid}`, { text: 'first' });
    await waitFile(rid, (st) => (st.chat || []).some((c) => c.text === 'first')); // 1st flush landed
    // second mutation is an agent /say — exercises both the re-arm AND the say persist site
    await p(`/agent/say?session=${rid}`, { text: 'second (agent)' });
    const two = await waitFile(rid, (st) => (st.chat || []).some((c) => c.text === 'second (agent)'));
    check(
      'a mutation after the flush is persisted (timer re-armed; /agent/say writes through)',
      two &&
        two.chat.some((c) => c.role === 'reviewer' && c.text === 'first') &&
        two.chat.some((c) => c.role === 'agent' && c.text === 'second (agent)'),
      JSON.stringify(two && two.chat.map((c) => `${c.role}:${c.text}`))
    );
    await stop(rid);
    await sleep(300);

    // ----- P6: restore completes before listen (a pre-seeded file resolves) -----
    console.log('persistence: an externally-written session file restores (restore-before-listen)');
    await killP();
    const stateDir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-preseed-'));
    const preId = 'abc123';
    fs.writeFileSync(
      path.join(stateDir6, `${preId}.json`),
      JSON.stringify({
        id: preId,
        status: 'reviewing',
        doc: { path: null, title: 'Preseeded', html: '<p>Hi</p>', version: 3, blocks: ['<p>Hi</p>'], history: [] },
        review: { comments: [], choices: {} },
        submissions: [],
        chat: [],
        progress: [],
        queue: [],
        touched: Date.now(),
      })
    );
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6 });
    check('persist: server up (pre-seed case)', await waitHealth(true));
    const first = await p(`/api/state?session=${preId}`);
    check(
      'a pre-seeded session file is restored and resolves (restore ran before listen)',
      first.status === 200 && first.data.doc.title === 'Preseeded' && first.data.doc.version === 3,
      JSON.stringify(first.status)
    );
    await stop(preId);
    await sleep(300);
    fs.rmSync(stateDir6, { recursive: true, force: true });

    // ----- P6b: a pre-004 legacy choice shape migrates on restore -----
    console.log('persistence: a pre-004 flat choice value migrates to the per-reviewer shape on restore');
    await killP();
    const stateDir6b = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-legacy-'));
    const legacyId = 'legacy1';
    fs.writeFileSync(
      path.join(stateDir6b, `${legacyId}.json`),
      JSON.stringify({
        id: legacyId,
        status: 'reviewing',
        doc: { path: null, title: 'Legacy', html: '<p>Hi</p>', version: 1, blocks: ['<p>Hi</p>'], history: [] },
        // OLD shape: choices is { choiceId: option } / { choiceId: options[] }, NOT nested.
        review: { comments: [], choices: { single: 'Two', multi: ['A', 'B'] } },
        submissions: [],
        chat: [],
        progress: [],
        queue: [],
        touched: Date.now(),
      })
    );
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6b });
    check('persist: server up (legacy-migration case)', await waitHealth(true));
    const migrated = await p(`/api/state?session=${legacyId}`);
    check(
      'a pre-004 flat choice value migrates to { reviewerId: option } under anonymous (answer preserved, not garbage)',
      migrated.status === 200 &&
        migrated.data.review.choices.single &&
        migrated.data.review.choices.single.anonymous === 'Two' &&
        Array.isArray(migrated.data.review.choices.multi.anonymous) &&
        migrated.data.review.choices.multi.anonymous.join(',') === 'A,B',
      JSON.stringify(migrated.data.review.choices)
    );
    await stop(legacyId);
    await sleep(300);
    fs.rmSync(stateDir6b, { recursive: true, force: true });

    // ----- P6b2: a pre-008 session (no resolutions key) restores as all-unresolved -----
    console.log('persistence: a pre-008 session (no resolutions) restores as all-unresolved (issue 008)');
    await killP();
    const stateDir6b2 = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-pre008-'));
    const pre008Id = 'pre008';
    fs.writeFileSync(
      path.join(stateDir6b2, `${pre008Id}.json`),
      JSON.stringify({
        id: pre008Id,
        status: 'reviewing',
        doc: { path: null, title: 'Pre008', html: '<p>x</p>', version: 1, blocks: ['<p>x</p>'], history: [] },
        // 004 shape: per-reviewer choices, but NO resolutions key and NO doc.choiceSpecs.
        review: { comments: [], choices: { pick: { A: 'A1', B: 'A2' } } },
        submissions: [],
        chat: [],
        progress: [],
        queue: [],
        touched: Date.now(),
      })
    );
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6b2 });
    check('persist: server up (pre-008 case)', await waitHealth(true));
    const pre008 = await p(`/api/state?session=${pre008Id}`);
    check(
      'a pre-008 file restores with review.resolutions === {} (unresolved), choices intact',
      pre008.status === 200 &&
        pre008.data.review.resolutions &&
        Object.keys(pre008.data.review.resolutions).length === 0 &&
        pre008.data.review.choices.pick.A === 'A1' &&
        pre008.data.review.choices.pick.B === 'A2',
      JSON.stringify(pre008.data.review)
    );
    await stop(pre008Id);
    await sleep(300);
    fs.rmSync(stateDir6b2, { recursive: true, force: true });

    // ----- P6b3: a resolution (with reason) round-trips a restart (issue 008) -----
    console.log('persistence: a choice resolution (with reason) round-trips a server restart (issue 008)');
    await killP();
    const stateDir6b3 = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-res008-'));
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6b3 });
    check('persist: server up (resolution round-trip case)', await waitHealth(true));
    const res008 = await p('/agent/start', { path: doc });
    const res008Id = res008.data.id;
    // Two reviewers diverge on `pick` (options One/Two); A resolves to Two with a reason.
    await p(`/api/review-state?session=${res008Id}`, { reviewerId: 'A', comments: [], choices: { pick: 'One' } });
    await p(`/api/review-state?session=${res008Id}`, { reviewerId: 'B', comments: [], choices: { pick: 'Two' } });
    await p(`/api/review-state?session=${res008Id}`, {
      reviewerId: 'A', reviewerName: 'Ada', comments: [],
      resolutions: { pick: { option: 'Two', reason: 'Two handles the edge case' } },
    });
    // wait for the debounced flush to write the resolution to disk, then kill & restart
    await waitFile(res008Id, (st) => st.review && st.review.resolutions && st.review.resolutions.pick);
    await killP();
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6b3 });
    check('persist: server restarts (resolution round-trip case)', await waitHealth(true));
    const restoredRes = await p(`/api/state?session=${res008Id}`);
    check(
      'a resolution + reason + attribution survives a restart',
      restoredRes.status === 200 &&
        restoredRes.data.review.resolutions.pick &&
        restoredRes.data.review.resolutions.pick.option === 'Two' &&
        restoredRes.data.review.resolutions.pick.by === 'A' &&
        restoredRes.data.review.resolutions.pick.byName === 'Ada' &&
        restoredRes.data.review.resolutions.pick.reason === 'Two handles the edge case',
      JSON.stringify(restoredRes.data.review.resolutions)
    );
    await stop(res008Id);
    await sleep(300);
    fs.rmSync(stateDir6b3, { recursive: true, force: true });

    // ----- P6b4: an agent-seeded reviewer name is injected into the page and survives a restart -----
    // The CLI resolves a default reviewer name (flag / env / `git config user.name`) and passes it
    // to /agent/start; the server injects it into /s/<id> as window.__planreviewDefaultName so the
    // browser adopts it without prompting. Prove (a) it's injected, (b) it's HTML-safe against a
    // "</script>" breakout, and (c) it round-trips a restart (persisted with the session).
    console.log('persistence: an agent-seeded reviewer name is injected into the page and survives a restart');
    await killP();
    const stateDir6b4 = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-rname-'));
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6b4 });
    check('persist: server up (reviewer-name injection case)', await waitHealth(true));
    const rname = await p('/agent/start', { path: doc, reviewerName: 'Grace Hopper' });
    const rnameId = rname.data.id;
    const page1 = await pageText(`/s/${rnameId}`);
    check(
      'reviewer name: /s/<id> injects the agent-seeded default as a window global',
      page1.ok && page1.body.includes('window.__planreviewDefaultName="Grace Hopper"'),
      page1.body.match(/__planreviewDefaultName[^<]*/)?.[0] || '(not found)'
    );
    // A session with no seeded name injects an empty string (never `undefined`/broken JS).
    const plain = await p('/agent/start', { path: doc });
    const plainPage = await pageText(`/s/${plain.data.id}`);
    check(
      'reviewer name: a session with no seeded name injects an empty string',
      plainPage.body.includes('window.__planreviewDefaultName=""'),
      plainPage.body.match(/__planreviewDefaultName[^<]*/)?.[0] || '(not found)'
    );
    // XSS guard: a name containing "</script>" must not break out of the inline <script>.
    const evil = await p('/agent/start', { path: doc, reviewerName: 'x</script><script>alert(1)' });
    const evilPage = await pageText(`/s/${evil.data.id}`);
    check(
      'reviewer name: a "</script>" in the name is neutralized, not emitted raw',
      !evilPage.body.includes('</script><script>alert(1)') && evilPage.body.includes('\\u003c/script'),
      '(checked for raw breakout)'
    );
    // Persist + restart: the seeded name is stored with the session and re-injected after a restart.
    await waitFile(rnameId, (st) => st.defaultReviewerName === 'Grace Hopper');
    await killP();
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6b4 });
    check('persist: server restarts (reviewer-name injection case)', await waitHealth(true));
    const page2 = await pageText(`/s/${rnameId}`);
    check(
      'reviewer name: the seeded default survives a restart and is re-injected',
      page2.ok && page2.body.includes('window.__planreviewDefaultName="Grace Hopper"'),
      page2.body.match(/__planreviewDefaultName[^<]*/)?.[0] || '(not found)'
    );
    await stop(rnameId);
    await stop(plain.data.id);
    await stop(evil.data.id);
    await sleep(300);
    fs.rmSync(stateDir6b4, { recursive: true, force: true });

    // ----- P6c: a submitted bundle is de-aliased from live session objects -----
    // mergeComments returns peer comments by reference; reviewBundle structuredClones the
    // result so a later /agent/reply (which mutates s.review.comments[i].replies in place)
    // can't reach back and rewrite an already-recorded submission. Prove the clone holds.
    console.log('persistence: a recorded submission is not mutated by a later /agent/reply (structuredClone guard)');
    await killP();
    const stateDir6c = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-alias-'));
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6c });
    check('persist: server up (de-alias case)', await waitHealth(true));
    const al = await p('/agent/start', { path: doc });
    const alId = al.data.id;
    // A owns comment k (lives in s.review.comments). B submits — so k is a PEER comment in
    // B's bundle, which mergeComments preserves BY REFERENCE; only reviewBundle's
    // structuredClone de-aliases it. Then /agent/reply mutates the live k in place. A
    // progress ping forces a persist flush (/agent/reply itself doesn't persist).
    await p(`/api/review-state?session=${alId}`, {
      reviewerId: 'A',
      comments: [{ id: 'k', quote: 'Alpha paragraph.', text: 'watch me', author: { id: 'A' } }],
      choices: {},
    });
    await p(`/api/submit?session=${alId}`, { reviewerId: 'B', comments: [], choices: {}, note: 'snapshot' });
    await p(`/agent/reply?session=${alId}`, { commentId: 'k', text: 'a late agent reply' });
    await p(`/agent/progress?session=${alId}`, { text: 'flush' }); // progress persists; reply alone does not
    // Read the file from THIS phase's state dir (the shared waitFile targets `stateDir`).
    let aliasFile = null;
    for (let i = 0; i < 80; i++) {
      try {
        aliasFile = JSON.parse(fs.readFileSync(path.join(stateDir6c, `${alId}.json`), 'utf8'));
      } catch {
        aliasFile = null;
      }
      const rep = aliasFile && (aliasFile.review.comments[0] || {}).replies;
      if (rep && rep.length === 1 && (aliasFile.submissions || []).length === 1) break;
      await sleep(50);
    }
    const submittedK = aliasFile.submissions[0].comments.find((c) => c.id === 'k');
    check(
      'a later /agent/reply mutates the live review but NOT the already-recorded submission',
      submittedK && !submittedK.replies && // the structuredClone snapshot never gained the reply
        aliasFile.review.comments[0].replies[0].text === 'a late agent reply', // the live copy did
      JSON.stringify({ submitted: submittedK, live: aliasFile.review.comments[0].replies })
    );
    await stop(alId);
    await sleep(300);
    fs.rmSync(stateDir6c, { recursive: true, force: true });

    // ----- P7: a restored-but-stale session is reaped by the sweep + file deleted -----
    console.log('persistence: a restored-but-stale session is reaped by the abandon sweep');
    await killP();
    const stateDir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-stale-'));
    const staleId = 'stale1';
    fs.writeFileSync(
      path.join(stateDir7, `${staleId}.json`),
      JSON.stringify({
        id: staleId,
        status: 'reviewing',
        doc: { path: null, title: 'Stale', html: '', version: 1, blocks: [] },
        review: { comments: [], choices: {} },
        submissions: [],
        chat: [],
        progress: [],
        queue: [],
        touched: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      })
    );
    spawnP({
      PLANREVIEW_STATE_DIR: stateDir7,
      PLANREVIEW_ABANDON_MS: '1000',
      PLANREVIEW_SWEEP_MS: '300',
    });
    check('persist: server up (stale-reap case)', await waitHealth(true));
    // Poll /api/sessions, NOT /api/state — /api/state calls touch(s), which would
    // keep resetting the session's age and prevent the abandon sweep from reaping it.
    let reaped = false;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const listed = await p('/api/sessions');
      if (!(listed.data || []).some((x) => x.id === staleId)) {
        reaped = true;
        break;
      }
    }
    check('a restored-but-stale session is reaped by the abandon sweep', reaped);
    check(
      "the reaped session's file is deleted",
      !fs.existsSync(path.join(stateDir7, `${staleId}.json`))
    );
    fs.rmSync(stateDir7, { recursive: true, force: true });
  } finally {
    await killP();
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.unlinkSync(doc);
    } catch {
      /* best effort */
    }
  }
}

async function main() {
  // Resolve this run's port and bind everything that hangs off it before any
  // server work starts.
  PORT = await resolvePort();
  BASE = `http://127.0.0.1:${PORT}`;
  env = {
    ...process.env,
    PLANREVIEW_PORT: String(PORT),
    PLANREVIEW_IDLE_MS: '1500',
    PLANREVIEW_POLL_MS: '400', // short internal poll window so tests can exercise the wait loop
    PLANREVIEW_PRESENCE_MS: '80', // short presence-broadcast debounce so join/leave frames land fast
    PLANREVIEW_MAX_PRESENCE: '4', // small roster cap so the map-growth guard is cheap to exercise
  };
  ({ json: browser, text, alive: serverAlive } = makeClient(BASE));

  const dir = os.tmpdir();
  const docA = path.join(dir, 'planreview-e2e-a.md');
  const docB = path.join(dir, 'planreview-e2e-b.md');
  fs.writeFileSync(
    docA,
    '# Plan A\n\nBody of plan A.\n\n```choice\nid: pick\nprompt: Which one?\noptions:\n  - A1\n  - A2\n```\n'
  );
  fs.writeFileSync(docB, '# Plan B\n\nBody of plan B — a totally separate document.\n');

  console.log('working-overlay liveness: elapsed formatting + staleness threshold (pure)');
  // FM-6: minutes:seconds with a zero-padded seconds field
  check(
    'formatElapsed renders m:ss with zero-padded seconds',
    liveness.formatElapsed(0) === '0:00' &&
      liveness.formatElapsed(5000) === '0:05' &&
      liveness.formatElapsed(48000) === '0:48' &&
      liveness.formatElapsed(65000) === '1:05' &&
      liveness.formatElapsed(600000) === '10:00',
    `${liveness.formatElapsed(65000)} / ${liveness.formatElapsed(5000)}`
  );
  // FM-5: a negative/skewed delta clamps to zero rather than showing "-1:59"/NaN
  check(
    'formatElapsed clamps a negative delta to 0:00',
    liveness.formatElapsed(-5000) === '0:00' && liveness.formatElapsed(NaN) === '0:00',
    `${liveness.formatElapsed(-5000)} / ${liveness.formatElapsed(NaN)}`
  );
  // FM-4: while fresh (below threshold) there is no hint at all
  check(
    'stalenessHint stays null below the threshold',
    liveness.stalenessHint(0, 40000) === null &&
      liveness.stalenessHint(39999, 40000) === null,
    JSON.stringify(liveness.stalenessHint(39999, 40000))
  );
  // FM-7: at/after the threshold a muted, non-alarming advisory appears with the count
  check(
    'stalenessHint fires at the threshold with an advisory message',
    liveness.stalenessHint(40000, 40000) === 'No updates for 40 s — the agent may be stuck.' &&
      liveness.stalenessHint(62000, 40000) === 'No updates for 62 s — the agent may be stuck.',
    JSON.stringify(liveness.stalenessHint(40000, 40000))
  );
  // the threshold has a sane default so callers can omit it
  check(
    'stalenessHint exposes a default threshold (~30-45s)',
    typeof liveness.STALE_THRESHOLD_MS === 'number' &&
      liveness.STALE_THRESHOLD_MS >= 30000 &&
      liveness.STALE_THRESHOLD_MS <= 45000 &&
      liveness.stalenessHint(liveness.STALE_THRESHOLD_MS) !== null &&
      liveness.stalenessHint(0) === null,
    `default=${liveness.STALE_THRESHOLD_MS}`
  );

  console.log('working-overlay liveness: overlay timer/hint lifecycle (real app.js in a DOM shim)');
  await driveLivenessWiring();

  console.log('working-overlay liveness: refresh-accurate elapsed timer + staleness hint (issue 009 T3)');
  await driveLivenessRefreshAccuracy();

  console.log('reviewer identity: first-load name prompt (issue 011 #1)');
  await driveReviewerIdentityPrompt();

  console.log('safeguard: a server running stale code is restarted on start');
  // occupy the port with a server that reports old code + no active sessions
  const STALE = `
    const http = require('http');
    http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health')
        return res.end(JSON.stringify({ ok: true, sessions: 0, version: 'stale-000000' }));
      if (req.url === '/admin/shutdown' && req.method === 'POST') {
        res.end('{"ok":true}');
        return setTimeout(() => process.exit(0), 50);
      }
      res.statusCode = 404; res.end('{"error":"not found"}');
    }).listen(${PORT}, '127.0.0.1');
  `;
  spawn(process.execPath, ['-e', STALE], { stdio: 'ignore', detached: true }).unref();
  await sleep(300);
  const staleBefore = await browser('/health');
  check(
    'a stale-code server is occupying the port',
    staleBefore.data && staleBefore.data.version === 'stale-000000',
    JSON.stringify(staleBefore.data)
  );
  const restarted = await cli('start', docA, '--no-open');
  check('start replaces the stale server and presents', restarted.ok === true && !!restarted.id);
  const fresh = await browser('/health');
  check(
    'the replacement runs current code',
    fresh.data.version && fresh.data.version !== 'stale-000000',
    JSON.stringify(fresh.data)
  );
  await cli('stop', '--session', restarted.id);

  console.log('choice blocks: free-text "Other" by default, opt out with other:false');
  const withOther = render('```choice\nid: q\nprompt: Pick\noptions:\n  - A\n  - B\n```\n');
  check(
    'a choice block renders a free-text Other input by default',
    /data-other="true"/.test(withOther) && /choice-other-text/.test(withOther)
  );
  check(
    'the Other field is a textarea (wraps + auto-grows) not a single-line input',
    /<textarea class="choice-other-text"[^>]*><\/textarea>/.test(withOther) &&
      !/<input[^>]*class="choice-other-text"/.test(withOther)
  );
  const noOther = render('```choice\nid: q\nprompt: Pick\nother: false\noptions:\n  - A\n  - B\n```\n');
  check(
    'other: false omits the free-text input',
    !/data-other/.test(noOther) && /choice-option/.test(noOther)
  );

  // issue 008: the server captures each choice block's declared options so a resolve
  // can be validated against them.
  const specs = parseChoiceSpecs(
    '# T\n\n```choice\nid: pick\nprompt: Which one?\noptions:\n  - A1\n  - A2\n```\n\n```choice\nid: multi\nmulti: true\noptions:\n  - X\n  - Y\n```\n'
  );
  check(
    'parseChoiceSpecs returns declared options per choice id',
    specs.pick && specs.pick.options.join(',') === 'A1,A2' && specs.pick.multi === false &&
      specs.multi && specs.multi.multi === true && specs.multi.options.join(',') === 'X,Y',
    JSON.stringify(specs)
  );
  check(
    'parseChoiceSpecs ignores a malformed choice (no id or no options)',
    Object.keys(parseChoiceSpecs('```choice\nprompt: no id\noptions:\n  - A\n```\n')).length === 0,
    JSON.stringify(parseChoiceSpecs('```choice\nprompt: no id\n```\n'))
  );

  console.log('doc changes: re-render highlights new/changed blocks; first render is clean');
  const firstRender = renderDiff('# T\n\nAlpha.\n\nBeta.\n', null);
  check(
    'first render marks nothing changed',
    !/data-changed/.test(firstRender.html) && firstRender.blocks.length >= 3
  );
  const reRender = renderDiff('# T\n\nAlpha.\n\nBeta changed.\n\nGamma.\n', firstRender.blocks);
  const marks = (reRender.html.match(/data-changed/g) || []).length;
  check(
    're-render wraps only the changed and added blocks',
    marks === 2 &&
      /<div data-changed><p>Beta changed\./.test(reRender.html) &&
      /<div data-changed><p>Gamma\./.test(reRender.html) &&
      !/data-changed><p>Alpha/.test(reRender.html),
    `marks=${marks}`
  );

  console.log('version diff: annotated add / remove / change markers (incl. removals)');
  // Beta removed, Gamma modified in place, New added — each isolated by survivors
  const vFrom = '# T\n\nIntro.\n\nBeta.\n\nMiddle.\n\nGamma.\n\nOutro.\n';
  const vTo = '# T\n\nIntro.\n\nMiddle.\n\nGamma edited.\n\nOutro.\n\nNew.\n';
  const vd = renderVersionDiff(vFrom, vTo).html;
  check(
    'a removed block is marked with a removal marker (the headline gap this closes)',
    /<div data-diff="remove"><p>Beta\.<\/p><\/div>/.test(vd),
    vd
  );
  check('an added block is marked added', /<div data-diff="add"><p>New\.<\/p><\/div>/.test(vd), vd);
  check(
    'a modified same-kind block is marked changed, wrapping old + new in the CSS-load-bearing shape',
    /<div data-diff="change"><div class="diff-removed"><p>Gamma\.<\/p><\/div><div class="diff-added"><p>Gamma edited\.<\/p><\/div><\/div>/.test(vd),
    vd
  );
  check(
    'unchanged blocks stay unmarked in the version diff',
    /<h1>T<\/h1>/.test(vd) && /<p>Intro\.<\/p>/.test(vd) && /<p>Middle\.<\/p>/.test(vd) && /<p>Outro\.<\/p>/.test(vd)
  );
  check('identical versions produce no diff markers', !/data-diff/.test(renderVersionDiff(vFrom, vFrom).html));
  check(
    'the version diff and the per-round highlight stay independent',
    !/data-changed/.test(vd) && !/data-diff/.test(reRender.html)
  );
  check('empty-to-empty and full-removal diffs never throw', renderVersionDiff('', '').html === '' &&
    /data-diff="remove"/.test(renderVersionDiff('# T\n\nGone.\n', '# T\n').html));
  // a table and a choice both render as <div…> blocks — they must NOT be mistaken
  // for an in-place edit of one another (would misreport a delete+insert as a change)
  const crossKind = renderVersionDiff(
    '# T\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    '# T\n\n```choice\nid: q\nprompt: Pick\noptions:\n  - A\n  - B\n```\n'
  ).html;
  check(
    'cross-kind div blocks diff as remove+add, not a false change',
    /data-diff="remove"/.test(crossKind) && /data-diff="add"/.test(crossKind) && !/data-diff="change"/.test(crossKind),
    crossKind
  );
  // a RUN of removes + an add must stay clean (no misleading B→C "change") — the
  // coalesce is deliberately limited to an isolated remove→add pair
  const runDiff = renderVersionDiff('# T\n\nAaa.\n\nBbb.\n\nCcc.\n', '# T\n\nDdd.\n').html;
  check(
    'a run of removes plus an add is not collapsed into a bogus change',
    (runDiff.match(/data-diff="remove"/g) || []).length === 3 &&
      /data-diff="add"><p>Ddd\./.test(runDiff) &&
      !/data-diff="change"/.test(runDiff),
    runDiff
  );

  console.log('anchor mirror: the server-side quote test matches what the browser would highlight');
  check('FX-1 a quote present in the rendered doc anchors', quoteAnchors('keep Redis', render('We will keep Redis.')) === true);
  check('FX-2 a quote absent from the doc does not anchor', quoteAnchors('gone text', render('We will keep Redis.')) === false);
  check('FX-3 an escaped ampersand round-trips', quoteAnchors('a & b', render('x a & b y')) === true);
  check('FX-3b a quote containing a double-quote anchors (&quot; decode)', quoteAnchors('"hi"', render('he said "hi" today')) === true);
  // source '&lt;tag&gt;' → html '&amp;lt;tag&amp;gt;' → browser DOM text '&lt;tag&gt;'. Decoding &amp; LAST
  // must reproduce that literal; decoding it first would over-decode to '<tag>' and diverge.
  check(
    'FM-5 decode order (& last) handles a double-escaped entity like the browser',
    quoteAnchors('&lt;tag&gt;', render('shows &lt;tag&gt; literally')) === true,
    render('shows &lt;tag&gt; literally')
  );
  check('FM-6 an empty quote never anchors', quoteAnchors('', render('anything at all')) === false);
  const prevForDiff = renderDiff('# T\n\nOld body here.\n', null).blocks;
  const changedHtml = renderDiff('# T\n\nWe will keep Redis.\n', prevForDiff).html;
  check(
    'FM-17 a quote inside a changed (data-changed) block still anchors',
    /data-changed/.test(changedHtml) && quoteAnchors('keep Redis', changedHtml) === true,
    changedHtml
  );

  console.log('isolation: two agents, two sessions, zero cross-contamination');
  const a = await cli('start', docA, '--no-open');
  const b = await cli('start', docB, '--no-open');
  check('start mints distinct session ids', a.id && b.id && a.id !== b.id, `${a.id} vs ${b.id}`);
  const stateA = await browser(`/api/state?session=${a.id}`);
  const stateB = await browser(`/api/state?session=${b.id}`);
  check(
    'each session serves its own document',
    stateA.data.doc.title === 'Plan A' && stateB.data.doc.title === 'Plan B',
    `A=${stateA.data.doc.title} B=${stateB.data.doc.title}`
  );

  // a review submitted to A must reach A's agent and never B's
  await browser(`/api/submit?session=${a.id}`, {
    comments: [{ id: 'c1', quote: 'Body of plan A.', text: 'for A only' }],
    choices: { pick: 'A2' },
    note: 'A note',
  });
  const evA = await cli('wait', '--session', a.id, '--timeout', '3');
  check('A\'s agent receives A\'s submit', evA.type === 'submit' && evA.note === 'A note');
  const evB = await cli('wait', '--session', b.id, '--timeout', '1');
  check('B\'s agent sees nothing (no leak from A)', evB.type === 'timeout', JSON.stringify(evB));

  // a chat in B must reach B's agent and never A's
  await browser(`/api/chat?session=${b.id}`, { text: 'B question' });
  const ev2B = await cli('wait', '--session', b.id, '--timeout', '3');
  check('B\'s agent receives B\'s chat', ev2B.type === 'chat' && ev2B.text === 'B question');
  const ev2A = await cli('wait', '--session', a.id, '--timeout', '1');
  check('A\'s agent sees nothing (no leak from B)', ev2A.type === 'timeout', JSON.stringify(ev2A));

  await cli('stop', '--session', a.id);
  await cli('stop', '--session', b.id);

  console.log('full cycle: chat -> submit -> rework -> end within one session');
  const s = await cli('start', docA, '--no-open');
  const id = s.id;

  const waitChat = cli('wait', '--session', id, '--timeout', '10');
  await sleep(300);
  await browser(`/api/chat?session=${id}`, { text: 'why A2?' });
  const chatEv = await waitChat;
  check('chat event delivered to wait', chatEv.type === 'chat' && chatEv.text === 'why A2?');
  await cli('say', 'Because of X.', '--session', id);

  const waitSubmit = cli('wait', '--session', id, '--timeout', '10');
  await sleep(300);
  await browser(`/api/submit?session=${id}`, {
    comments: [{ id: 'c1', quote: 'Body of plan A.', text: 'expand this' }],
    choices: { pick: 'a custom third option' }, // free-text "Other" answer
    note: 'almost there',
  });
  const subEv = await waitSubmit;
  check(
    'submit delivers comments, note, and a free-text Other choice value (picks-only, unresolved)',
    subEv.type === 'submit' &&
      subEv.comments.length === 1 &&
      subEv.choices.pick.picks.anonymous === 'a custom third option' && // 008: choices now nested under `picks`
      !('resolved' in subEv.choices.pick) &&
      subEv.note === 'almost there'
  );
  const stWorking = await cli('status', '--session', id);
  check('session paused while agent reworks', stWorking.status === 'working');

  fs.appendFileSync(docA, '\n## Revisions\n\nExpanded the body.\n');
  const before = (await cli('status', '--session', id)).version;
  const rep = await cli('present', docA, '--session', id);
  check('re-present bumps the doc version', rep.version === before + 1);
  const s2 = await browser(`/api/state?session=${id}`);
  check(
    'rework starts a fresh round: review cleared, chat kept',
    s2.data.status === 'reviewing' && s2.data.review.comments.length === 0 && s2.data.chat.length === 2
  );
  check('the re-presented doc highlights the blocks that changed', /data-changed/.test(s2.data.doc.html));

  const waitEnd = cli('wait', '--session', id, '--timeout', '10');
  await sleep(300);
  await browser(`/api/end?session=${id}`, {});
  const endEv = await waitEnd;
  check('end event delivered to wait', endEv.type === 'end');
  await cli('stop', '--session', id);
  await sleep(400); // stop drops the session ~200ms after responding
  const gone = await browser(`/api/state?session=${id}`);
  check('stop drops the session (state now 404s)', gone.status === 404, `status=${gone.status}`);

  console.log('approve & finish: terminal state, no spinner, no re-present');
  const ap = await cli('start', docA, '--no-open');
  await browser(`/api/approve?session=${ap.id}`, {
    comments: [{ id: 'c9', quote: 'Body of plan A.', text: 'tiny nit' }],
    choices: { pick: 'A1' },
    note: 'ship it',
  });
  const apState = await browser(`/api/state?session=${ap.id}`);
  check(
    'approve goes to terminal "done" (not "working")',
    apState.data.status === 'done',
    apState.data.status
  );
  check(
    'FM-5: approve never sets workingSince (only submit does)',
    apState.data.workingSince === null,
    JSON.stringify(apState.data.workingSince)
  );
  const apEv = await cli('wait', '--session', ap.id, '--timeout', '3');
  check(
    'agent gets an approve event carrying the final bundle',
    apEv.type === 'approve' && apEv.note === 'ship it' && apEv.comments.length === 1
  );
  const reApprove = await browser(`/api/approve?session=${ap.id}`, {});
  check('cannot approve again once done', reApprove.status === 409, `status=${reApprove.status}`);
  await cli('stop', '--session', ap.id);

  console.log('issue 008: submit bundle carries resolved (+reason) + raw picks; unresolved carries picks only');
  const b8 = await cli('start', docA, '--no-open');
  const b8id = b8.id;
  await browser(`/api/review-state?session=${b8id}`, { reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${b8id}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  await browser(`/api/review-state?session=${b8id}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' },
    resolutions: { pick: { option: 'A2', reason: 'perf' } },
  });
  const b8Wait = cli('wait', '--session', b8id, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${b8id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' }, note: 'go' });
  const b8Ev = await b8Wait;
  check(
    'a resolved choice emits { resolved: {option, by, reason}, picks: {reviewerId: option} }',
    b8Ev.type === 'submit' &&
      b8Ev.choices.pick.resolved && b8Ev.choices.pick.resolved.option === 'A2' &&
      b8Ev.choices.pick.resolved.by === 'A' && b8Ev.choices.pick.resolved.reason === 'perf' &&
      b8Ev.choices.pick.picks.A === 'A1' && b8Ev.choices.pick.picks.B === 'A2',
    JSON.stringify(b8Ev.choices)
  );
  await cli('stop', '--session', b8id);

  console.log('issue 008: an unresolved choice emits picks only (no resolved key)');
  const u8 = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${u8.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  const u8Wait = cli('wait', '--session', u8.id, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${u8.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' }, note: 'x' });
  const u8Ev = await u8Wait;
  check(
    'an unresolved choice emits { picks } with no resolved key',
    u8Ev.choices.pick && u8Ev.choices.pick.picks.A === 'A1' && !('resolved' in u8Ev.choices.pick),
    JSON.stringify(u8Ev.choices)
  );
  await cli('stop', '--session', u8.id);

  console.log('rework progress: steps accumulate while working, clear on present');
  const pr = await cli('start', docA, '--no-open');
  await browser(`/api/submit?session=${pr.id}`, { comments: [], choices: {}, note: '' });
  await cli('progress', 'Applying comments', '--session', pr.id);
  await cli('progress', 'Rewriting the storage section', '--session', pr.id);
  const during = await browser(`/api/state?session=${pr.id}`);
  check(
    'progress steps accumulate during rework',
    during.data.status === 'working' &&
      during.data.progress.length === 2 &&
      during.data.progress[0].text === 'Applying comments' &&
      during.data.progress[1].text === 'Rewriting the storage section',
    JSON.stringify(during.data.progress)
  );
  fs.appendFileSync(docA, '\n(reworked)\n');
  await cli('present', docA, '--session', pr.id);
  const afterPresent = await browser(`/api/state?session=${pr.id}`);
  check(
    'present clears progress and returns to reviewing',
    afterPresent.data.status === 'reviewing' && afterPresent.data.progress.length === 0,
    JSON.stringify({ status: afterPresent.data.status, progress: afterPresent.data.progress })
  );
  await cli('stop', '--session', pr.id);

  console.log('liveness tracking: server-side lastAgentActivity/workingSince (issue 009)');
  const lt = await cli('start', docA, '--no-open');
  const ltState0 = await browser(`/api/state?session=${lt.id}`);
  check(
    // start's own loadDoc call already bumps lastAgentActivity (it's shared with
    // /agent/present, and the initial present is itself agent activity); workingSince
    // stays null until the first submit.
    'a fresh session starts with lastAgentActivity set by the initial present, workingSince still null',
    typeof ltState0.data.lastAgentActivity === 'number' &&
      Math.abs(Date.now() - ltState0.data.lastAgentActivity) < 5000 &&
      ltState0.data.workingSince === null,
    JSON.stringify({ lastAgentActivity: ltState0.data.lastAgentActivity, workingSince: ltState0.data.workingSince })
  );

  await cli('progress', 'doing something', '--session', lt.id);
  const ltAfterProgress = await browser(`/api/state?session=${lt.id}`);
  check(
    '/agent/progress bumps lastAgentActivity to ~now',
    typeof ltAfterProgress.data.lastAgentActivity === 'number' &&
      Math.abs(Date.now() - ltAfterProgress.data.lastAgentActivity) < 5000,
    JSON.stringify(ltAfterProgress.data.lastAgentActivity)
  );

  const beforeWait = ltAfterProgress.data.lastAgentActivity;
  await sleep(20);
  await cli('wait', '--session', lt.id, '--timeout', '1'); // times out (no queued event) but still bumps
  const ltAfterWait = await browser(`/api/state?session=${lt.id}`);
  check(
    '/agent/wait bumps lastAgentActivity on receipt, even when it times out',
    typeof ltAfterWait.data.lastAgentActivity === 'number' && ltAfterWait.data.lastAgentActivity >= beforeWait,
    JSON.stringify(ltAfterWait.data.lastAgentActivity)
  );

  await browser(`/api/submit?session=${lt.id}`, { comments: [], choices: {}, note: '' });
  const ltAfterSubmit = await browser(`/api/state?session=${lt.id}`);
  check(
    'submit sets workingSince to ~now and status to working',
    ltAfterSubmit.data.status === 'working' &&
      typeof ltAfterSubmit.data.workingSince === 'number' &&
      Math.abs(Date.now() - ltAfterSubmit.data.workingSince) < 5000,
    JSON.stringify({ status: ltAfterSubmit.data.status, workingSince: ltAfterSubmit.data.workingSince })
  );

  fs.appendFileSync(docA, '\n(lt reworked)\n');
  await cli('present', docA, '--session', lt.id);
  const ltAfterPresent = await browser(`/api/state?session=${lt.id}`);
  check(
    'present clears workingSince back to null, returns to reviewing, and bumps lastAgentActivity again',
    ltAfterPresent.data.workingSince === null &&
      ltAfterPresent.data.status === 'reviewing' &&
      typeof ltAfterPresent.data.lastAgentActivity === 'number' &&
      Math.abs(Date.now() - ltAfterPresent.data.lastAgentActivity) < 5000,
    JSON.stringify({
      workingSince: ltAfterPresent.data.workingSince,
      status: ltAfterPresent.data.status,
      lastAgentActivity: ltAfterPresent.data.lastAgentActivity,
    })
  );
  await cli('stop', '--session', lt.id);

  // The block above only ever reads workingSince/lastAgentActivity back through
  // GET /api/state. A regression that reverted just ONE of the three
  // `broadcast(s, 'status', statusPayload(s))` call sites back to the old
  // `{status: s.status}` shape would pass every check above, since /api/state is
  // a separate code path — but a LIVE, already-connected tab only ever sees the
  // SSE frame. Use captureEvents to assert the actual broadcast payload.
  console.log('liveness tracking: the SSE "status" broadcast frame itself carries workingSince/lastAgentActivity, not just /api/state (issue 009 gap)');
  const sseLt = await cli('start', docA, '--no-open');
  const sseLtEvents = await captureEvents(sseLt.id);
  await sleep(100); // let the SSE connection establish before triggering a broadcast
  await browser(`/api/submit?session=${sseLt.id}`, { comments: [], choices: {}, note: '' });
  await sleep(150);
  const submitFrame = sseLtEvents.events.filter((e) => e.event === 'status').pop();
  const submitData = submitFrame ? JSON.parse(submitFrame.data) : null;
  check(
    'SSE: the "status" broadcast frame for /api/submit carries status:working and a recent workingSince',
    !!submitData &&
      submitData.status === 'working' &&
      typeof submitData.workingSince === 'number' &&
      Math.abs(Date.now() - submitData.workingSince) < 5000,
    JSON.stringify(submitData)
  );

  // Drive /agent/stop (the CLI 'stop' command) on the SAME session, mid-round.
  // Per FM-2/FM-11 a stray non-null workingSince riding along on the terminal
  // 'ended' broadcast is expected and intentional — this just confirms the
  // broadcast frame (not /api/state) really carries it, proving statusPayload(s)
  // is wired at this call site too.
  await cli('stop', '--session', sseLt.id);
  await sleep(150);
  sseLtEvents.close();
  const endedFrame = sseLtEvents.events.filter((e) => e.event === 'status').pop();
  const endedData = endedFrame ? JSON.parse(endedFrame.data) : null;
  check(
    'SSE: the "status" broadcast frame for /agent/stop carries status:ended and still surfaces the stray workingSince (FM-2/FM-11)',
    !!endedData &&
      endedData.status === 'ended' &&
      typeof endedData.workingSince === 'number' &&
      submitData &&
      endedData.workingSince === submitData.workingSince,
    JSON.stringify({ submitData, endedData })
  );

  console.log('answered questions persist across cycles; an un-anchored comment is archived, never dropped');
  const q = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${q.id}`, {
    comments: [{ id: 'x', quote: 'q', text: 't' }], // quote 'q' does not occur in docA — will not re-anchor
    choices: { pick: 'A1' },
  });
  fs.appendFileSync(docA, '\n(another revision)\n');
  await cli('present', docA, '--session', q.id);
  const cyc = await browser(`/api/state?session=${q.id}`);
  check(
    'a re-present keeps prior answers and archives an un-anchored comment (never drops it)',
    cyc.data.review.choices.pick.anonymous === 'A1' &&
      cyc.data.review.comments.length === 1 &&
      cyc.data.review.comments[0].id === 'x' &&
      cyc.data.review.comments[0].archived === true,
    JSON.stringify(cyc.data.review)
  );
  await cli('stop', '--session', q.id);

  console.log('multi-reviewer: comments union across authors; a poster owns only its own');
  const mr = await cli('start', docA, '--no-open');
  const mrid = mr.id;
  // Reviewer A creates a comment, syncing its whole set (just A's).
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'A',
    comments: [{ id: 'a1', quote: 'Body of plan A.', text: 'from A', author: { id: 'A', name: 'Ada' } }],
    choices: {},
  });
  // Reviewer B syncs its own set. B's browser has NOT seen A's comment yet, so B
  // posts only [b1]. A's comment must survive (union across authors).
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'B',
    comments: [{ id: 'b1', quote: 'Body of plan A.', text: 'from B', author: { id: 'B', name: 'Ben' } }],
    choices: {},
  });
  const mrState = await browser(`/api/state?session=${mrid}`);
  const mrComments = mrState.data.review.comments;
  check(
    'both reviewers\' comments coexist, each attributed (B\'s sync did not clobber A\'s)',
    mrComments.length === 2 &&
      mrComments.some((c) => c.id === 'a1' && c.author && c.author.id === 'A') &&
      mrComments.some((c) => c.id === 'b1' && c.author && c.author.id === 'B'),
    JSON.stringify(mrComments)
  );
  // B edits its own comment and, this time, its browser HAS A's comment too (live
  // sync) — B may not edit or drop A's, but its edit to b1 lands.
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'B',
    comments: [
      { id: 'a1', quote: 'Body of plan A.', text: 'TAMPERED', author: { id: 'A', name: 'Ada' } },
      { id: 'b1', quote: 'Body of plan A.', text: 'from B (edited)', author: { id: 'B', name: 'Ben' } },
    ],
    choices: {},
  });
  const mrState2 = await browser(`/api/state?session=${mrid}`);
  const a1 = mrState2.data.review.comments.find((c) => c.id === 'a1');
  const b1 = mrState2.data.review.comments.find((c) => c.id === 'b1');
  check(
    'a poster owns only its own comments: B edits b1 but cannot alter A\'s a1',
    a1 && a1.text === 'from A' && b1 && b1.text === 'from B (edited)',
    JSON.stringify({ a1, b1 })
  );
  // A deletes its own comment (posts a set without a1); B's b1 is untouched.
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'A',
    comments: [],
    choices: {},
  });
  const mrState3 = await browser(`/api/state?session=${mrid}`);
  check(
    'a poster deleting its own comment leaves peers\' comments intact',
    mrState3.data.review.comments.length === 1 &&
      mrState3.data.review.comments[0].id === 'b1',
    JSON.stringify(mrState3.data.review.comments)
  );
  // FM-7: a malformed comment entry (null / no id) must be skipped, never 500.
  const mrBad = await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'B',
    comments: [null, {}, { id: 'b1', quote: 'Body of plan A.', text: 'still here', author: { id: 'B' } }],
    choices: {},
  });
  const mrState4 = await browser(`/api/state?session=${mrid}`);
  check(
    'FM-7: malformed comment entries are skipped (clean 200, not a 500)',
    mrBad.status === 200 &&
      mrState4.data.review.comments.filter((c) => c && c.id === 'b1').length === 1 &&
      mrState4.data.review.comments.every((c) => c && typeof c.id === 'string'),
    JSON.stringify({ status: mrBad.status, comments: mrState4.data.review.comments })
  );
  // A re-creates a1 (it was deleted above) so there's a peer comment for B to reply to.
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'A',
    comments: [{ id: 'a1', quote: 'Body of plan A.', text: 'from A', author: { id: 'A', name: 'Ada' } }],
    choices: {},
  });
  // A reply is open to any reviewer (issue 002 threads): B replies to A's comment by
  // syncing A's comment with a B-authored reply appended. The reply must survive even
  // though B doesn't own the comment — B's browser holds a1 (author A) via live sync.
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'B',
    comments: [
      {
        id: 'a1',
        quote: 'Body of plan A.',
        text: 'from A',
        author: { id: 'A', name: 'Ada' },
        replies: [{ role: 'reviewer', text: 'B replies to A', ts: 111, author: { id: 'B', name: 'Ben' } }],
      },
      { id: 'b1', quote: 'Body of plan A.', text: 'still here', author: { id: 'B' } },
    ],
    choices: {},
  });
  const mrReply = await browser(`/api/state?session=${mrid}`);
  const a1WithReply = mrReply.data.review.comments.find((c) => c.id === 'a1');
  check(
    'a reviewer\'s reply to a PEER\'s comment survives (not dropped by author-scoping)',
    a1WithReply &&
      a1WithReply.text === 'from A' && // A's body untouched
      Array.isArray(a1WithReply.replies) &&
      a1WithReply.replies.some((r) => r.text === 'B replies to A' && r.author && r.author.id === 'B'),
    JSON.stringify(a1WithReply)
  );
  await cli('stop', '--session', mrid);

  console.log('multi-reviewer: per-reviewer choices surface conflict; review-state broadcasts a delta');
  const cf = await cli('start', docA, '--no-open');
  const cfid = cf.id;
  const cfEvents = await captureEvents(cfid); // capture the SSE stream for this session
  await sleep(100);
  // A picks A1, B picks A2 for the same choice — a divergence.
  await browser(`/api/review-state?session=${cfid}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${cfid}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  const cfState = await browser(`/api/state?session=${cfid}`);
  check(
    'choices are per-reviewer: the map holds BOTH divergent picks, neither overwritten',
    cfState.data.review.choices.pick &&
      cfState.data.review.choices.pick.A === 'A1' &&
      cfState.data.review.choices.pick.B === 'A2',
    JSON.stringify(cfState.data.review.choices)
  );
  // A changes its own pick to A2 — only A's entry moves; B's stays.
  await browser(`/api/review-state?session=${cfid}`, { reviewerId: 'A', comments: [], choices: { pick: 'A2' } });
  const cfState2 = await browser(`/api/state?session=${cfid}`);
  check(
    'a reviewer changing its own pick does not touch a peer\'s',
    cfState2.data.review.choices.pick.A === 'A2' && cfState2.data.review.choices.pick.B === 'A2',
    JSON.stringify(cfState2.data.review.choices)
  );
  // Poll until all three deltas have arrived over SSE, rather than a fixed sleep —
  // the third frame's arrival time is what makes lastDelta correct (avoids flakiness).
  let reviewDeltas = [];
  for (let i = 0; i < 40; i++) {
    reviewDeltas = cfEvents.events.filter((e) => e.event === 'review');
    if (reviewDeltas.length >= 3) break;
    await sleep(25);
  }
  check(
    'review-state broadcasts a "review" SSE delta carrying merged comments + choices + author',
    reviewDeltas.length >= 3 &&
      reviewDeltas.every((e) => {
        const d = JSON.parse(e.data);
        return d.author && typeof d.author.id === 'string' && 'comments' in d && 'choices' in d;
      }),
    JSON.stringify(reviewDeltas.map((e) => e.data))
  );
  const lastDelta = JSON.parse(reviewDeltas[reviewDeltas.length - 1].data);
  check(
    'the delta author id identifies the poster (so a tab can ignore its own echo)',
    lastDelta.author.id === 'A' && lastDelta.choices.pick.A === 'A2' && lastDelta.choices.pick.B === 'A2',
    JSON.stringify(lastDelta)
  );
  cfEvents.close();
  // DSM-16: a deselect (A posts a choices map WITHOUT `pick`) clears only A's entry;
  // B's pick survives. The deselect protocol is communicated purely by key-absence.
  await browser(`/api/review-state?session=${cfid}`, { reviewerId: 'A', comments: [], choices: {} });
  const cfDeselect = await browser(`/api/state?session=${cfid}`);
  check(
    'DSM-16: a reviewer deselecting drops only its own pick; the peer\'s remains',
    cfDeselect.data.review.choices.pick &&
      cfDeselect.data.review.choices.pick.A === undefined &&
      cfDeselect.data.review.choices.pick.B === 'A2',
    JSON.stringify(cfDeselect.data.review.choices)
  );
  await cli('stop', '--session', cfid);

  console.log('issue 008: a reviewer resolves a divergent choice; validated, attributed, broadcast');
  const r8 = await cli('start', docA, '--no-open');
  const r8id = r8.id;
  const r8Events = await captureEvents(r8id);
  await sleep(100);
  await browser(`/api/review-state?session=${r8id}`, { reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${r8id}`, { reviewerId: 'B', reviewerName: 'Bo', comments: [], choices: { pick: 'A2' } });
  // A resolves to A2 with a reason.
  await browser(`/api/review-state?session=${r8id}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' },
    resolutions: { pick: { option: 'A2', reason: 'A2 scales better' } },
  });
  const r8State = await browser(`/api/state?session=${r8id}`);
  check(
    'a resolution is recorded with option + attribution (by/byName) + reason; picks untouched',
    r8State.data.review.resolutions.pick &&
      r8State.data.review.resolutions.pick.option === 'A2' &&
      r8State.data.review.resolutions.pick.by === 'A' &&
      r8State.data.review.resolutions.pick.byName === 'Ada' &&
      r8State.data.review.resolutions.pick.reason === 'A2 scales better' &&
      typeof r8State.data.review.resolutions.pick.at === 'string' &&
      r8State.data.review.choices.pick.A === 'A1' && r8State.data.review.choices.pick.B === 'A2',
    JSON.stringify(r8State.data.review)
  );
  // An option not in the block is ignored (validation); unknown choiceId ignored.
  await browser(`/api/review-state?session=${r8id}`, { reviewerId: 'B', comments: [], resolutions: { pick: 'A9', nope: 'A1' } });
  const r8State2 = await browser(`/api/state?session=${r8id}`);
  check(
    'an out-of-options resolve and an unknown choiceId are ignored (prior resolution intact)',
    r8State2.data.review.resolutions.pick.option === 'A2' && r8State2.data.review.resolutions.nope === undefined,
    JSON.stringify(r8State2.data.review.resolutions)
  );
  // A bare-option set (no reason) changes the resolution, re-attributes, and blanks the reason.
  await browser(`/api/review-state?session=${r8id}`, { reviewerId: 'B', reviewerName: 'Bo', comments: [], resolutions: { pick: 'A1' } });
  const r8State3 = await browser(`/api/state?session=${r8id}`);
  check(
    'a bare-option resolve changes option + re-attributes + clears reason',
    r8State3.data.review.resolutions.pick.option === 'A1' && r8State3.data.review.resolutions.pick.by === 'B' &&
      (r8State3.data.review.resolutions.pick.reason === '' || r8State3.data.review.resolutions.pick.reason === undefined),
    JSON.stringify(r8State3.data.review.resolutions)
  );
  // Clear returns the choice to unresolved.
  await browser(`/api/review-state?session=${r8id}`, { reviewerId: 'A', comments: [], resolutions: { pick: null } });
  const r8State4 = await browser(`/api/state?session=${r8id}`);
  check(
    'a null resolve clears the resolution (back to unresolved)',
    r8State4.data.review.resolutions.pick === undefined,
    JSON.stringify(r8State4.data.review.resolutions)
  );
  // The review SSE delta carries resolutions.
  let r8Deltas = [];
  for (let i = 0; i < 40; i++) {
    r8Deltas = r8Events.events.filter((e) => e.event === 'review');
    if (r8Deltas.some((e) => 'resolutions' in JSON.parse(e.data))) break;
    await sleep(25);
  }
  check(
    'the review SSE delta carries resolutions alongside comments + choices',
    r8Deltas.length && r8Deltas.every((e) => 'resolutions' in JSON.parse(e.data)),
    JSON.stringify(r8Deltas.map((e) => e.data))
  );
  r8Events.close();
  await cli('stop', '--session', r8id);

  console.log('issue 008: changing a pick after a resolution leaves the resolution intact');
  const lc8 = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${lc8.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${lc8.id}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  await browser(`/api/review-state?session=${lc8.id}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], resolutions: { pick: { option: 'A2' } },
  });
  // B now changes its own pick — the resolution must NOT be disturbed (only an explicit clear re-opens).
  await browser(`/api/review-state?session=${lc8.id}`, { reviewerId: 'B', comments: [], choices: { pick: 'A1' } });
  const lc8State = await browser(`/api/state?session=${lc8.id}`);
  check(
    'a reviewer changing its own pick does not clear an existing resolution',
    lc8State.data.review.resolutions.pick && lc8State.data.review.resolutions.pick.option === 'A2' &&
      lc8State.data.review.choices.pick.B === 'A1',
    JSON.stringify(lc8State.data.review)
  );
  await cli('stop', '--session', lc8.id);

  console.log('issue 008: a resolution survives even after every raw pick is cleared (no silent loss)');
  const nl8 = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${nl8.id}`, { reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${nl8.id}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  await browser(`/api/review-state?session=${nl8.id}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], resolutions: { pick: { option: 'A2', reason: 'agreed' } },
  });
  // Both reviewers now clear their own picks — the shared resolution must still travel.
  await browser(`/api/review-state?session=${nl8.id}`, { reviewerId: 'A', comments: [], choices: {} });
  await browser(`/api/review-state?session=${nl8.id}`, { reviewerId: 'B', comments: [], choices: {} });
  const nl8Wait = cli('wait', '--session', nl8.id, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${nl8.id}`, { reviewerId: 'A', comments: [], choices: {}, note: 'go' });
  const nl8Ev = await nl8Wait;
  check(
    'a resolved choice with no remaining picks still emits { resolved, picks:{} } (spec: no silent loss)',
    nl8Ev.type === 'submit' &&
      nl8Ev.choices.pick && nl8Ev.choices.pick.resolved && nl8Ev.choices.pick.resolved.option === 'A2' &&
      nl8Ev.choices.pick.resolved.reason === 'agreed' &&
      nl8Ev.choices.pick.picks && Object.keys(nl8Ev.choices.pick.picks).length === 0,
    JSON.stringify(nl8Ev.choices)
  );
  await cli('stop', '--session', nl8.id);

  console.log('issue 008: a __proto__ / non-string resolve intent is ignored, never crashes the request');
  const pp8 = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${pp8.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  // A crafted __proto__ key must not 500 or pollute; a non-string / array option must be ignored.
  // JSON.parse is used so the payload carries a genuine own "__proto__" key (an object
  // literal would set the prototype and drop it) — this is the hostile-direct-POST case.
  const ppResp = await browser(`/api/review-state?session=${pp8.id}`, {
    reviewerId: 'A', comments: [],
    resolutions: JSON.parse('{"__proto__":"A1","pick":42,"other":["A1","A2"]}'),
  });
  const pp8State = await browser(`/api/state?session=${pp8.id}`);
  check(
    'a __proto__ key + non-string option are ignored (200, no resolution recorded, no pollution)',
    ppResp.status === 200 &&
      Object.keys(pp8State.data.review.resolutions).length === 0 &&
      pp8State.data.review.choices.pick.A === 'A1',
    `status=${ppResp.status} resolutions=${JSON.stringify(pp8State.data.review.resolutions)}`
  );
  await cli('stop', '--session', pp8.id);

  console.log('issue 008: the resolution reason is trimmed server-side');
  const tr8 = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${tr8.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${tr8.id}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  await browser(`/api/review-state?session=${tr8.id}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], resolutions: { pick: { option: 'A2', reason: '  spaced out  ' } },
  });
  const tr8State = await browser(`/api/state?session=${tr8.id}`);
  check(
    'the stored reason is trimmed',
    tr8State.data.review.resolutions.pick && tr8State.data.review.resolutions.pick.reason === 'spaced out',
    JSON.stringify(tr8State.data.review.resolutions.pick)
  );
  await cli('stop', '--session', tr8.id);

  console.log('multi-reviewer: reviewer chat carries an author, role stays "reviewer"');
  const ch = await cli('start', docA, '--no-open');
  await browser(`/api/chat?session=${ch.id}`, { text: 'who owns this?', reviewerId: 'A', reviewerName: 'Ada' });
  await browser(`/api/chat?session=${ch.id}`, { text: 'anon here' }); // no identity
  const chState = await browser(`/api/state?session=${ch.id}`);
  const attributed = chState.data.chat.find((m) => m.text === 'who owns this?');
  const anon = chState.data.chat.find((m) => m.text === 'anon here');
  check(
    'a reviewer chat message carries author {id,name} and keeps role "reviewer"',
    attributed && attributed.role === 'reviewer' && attributed.author &&
      attributed.author.id === 'A' && attributed.author.name === 'Ada',
    JSON.stringify(attributed)
  );
  check(
    'an un-identified chat message omits author (renders exactly as today)',
    anon && anon.role === 'reviewer' && !anon.author,
    JSON.stringify(anon)
  );
  // A whitespace-only reviewerId must normalize to 'anonymous' consistently across chat
  // (author omitted) AND review-state (the ownership/choice key), not a stray '   ' key.
  await browser(`/api/review-state?session=${ch.id}`, { reviewerId: '   ', comments: [], choices: { pick: 'A1' } });
  const wsState = await browser(`/api/state?session=${ch.id}`);
  check(
    'a whitespace-only reviewerId folds to the anonymous choice key (not a stray "   " key)',
    wsState.data.review.choices.pick && wsState.data.review.choices.pick.anonymous === 'A1' &&
      wsState.data.review.choices.pick['   '] === undefined,
    JSON.stringify(wsState.data.review.choices)
  );
  await cli('stop', '--session', ch.id);

  console.log('multi-reviewer: submit consolidates every reviewer\'s comments + per-reviewer choices');
  const sb = await cli('start', docA, '--no-open');
  const sbid = sb.id;
  // A syncs a comment + a choice via review-state (the shared draft).
  await browser(`/api/review-state?session=${sbid}`, {
    reviewerId: 'A',
    comments: [{ id: 'a1', quote: 'Body of plan A.', text: 'A says', author: { id: 'A', name: 'Ada' } }],
    choices: { pick: 'A1' },
  });
  // B submits, posting its OWN body (b1 + B's flat pick). The bundle must carry BOTH
  // reviewers' comments and BOTH reviewers' choice entries.
  const sbWait = cli('wait', '--session', sbid, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${sbid}`, {
    reviewerId: 'B',
    comments: [{ id: 'b1', quote: 'Body of plan A.', text: 'B says', author: { id: 'B', name: 'Ben' } }],
    choices: { pick: 'A2' },
    note: 'consolidated',
  });
  const sbEv = await sbWait;
  check(
    'the submit bundle consolidates all reviewers\' comments (no loss), each attributed',
    sbEv.type === 'submit' &&
      sbEv.comments.length === 2 &&
      sbEv.comments.some((c) => c.id === 'a1' && c.author.id === 'A') &&
      sbEv.comments.some((c) => c.id === 'b1' && c.author.id === 'B'),
    JSON.stringify(sbEv.comments)
  );
  check(
    'the submit bundle carries the full per-reviewer choice map under picks (the conflict survives; unresolved so no resolved key)',
    sbEv.choices.pick && sbEv.choices.pick.picks.A === 'A1' && sbEv.choices.pick.picks.B === 'A2' &&
      !('resolved' in sbEv.choices.pick) && sbEv.note === 'consolidated',
    JSON.stringify(sbEv.choices)
  );
  // The submit must NOT have mutated the shared draft (mirror today's behavior): the
  // draft still holds only A's synced comment, not B's submitted one.
  const sbDraft = await browser(`/api/state?session=${sbid}`);
  check(
    'submit leaves the shared review draft unmutated (no side effect on s.review)',
    sbDraft.data.review.comments.length === 1 && sbDraft.data.review.comments[0].id === 'a1',
    JSON.stringify(sbDraft.data.review.comments)
  );
  check(
    'T4: workingSince is session-scoped — set by reviewer B\'s submit exactly like a single-reviewer submit',
    typeof sbDraft.data.workingSince === 'number' && Math.abs(Date.now() - sbDraft.data.workingSince) < 5000,
    JSON.stringify(sbDraft.data.workingSince)
  );
  await cli('stop', '--session', sbid);

  console.log('single-reviewer regression: one reviewer behaves exactly as before (union = just theirs)');
  const one = await cli('start', docA, '--no-open');
  const oneWait = cli('wait', '--session', one.id, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${one.id}`, {
    reviewerId: 'solo',
    comments: [{ id: 's1', quote: 'Body of plan A.', text: 'solo note', author: { id: 'solo' } }],
    choices: { pick: 'A1' },
    note: 'ship',
  });
  const oneEv = await oneWait;
  check(
    'single reviewer: bundle is exactly their one comment + a one-entry picks map (unresolved)',
    oneEv.type === 'submit' &&
      oneEv.comments.length === 1 &&
      oneEv.comments[0].id === 's1' &&
      Object.keys(oneEv.choices.pick.picks).length === 1 &&
      oneEv.choices.pick.picks.solo === 'A1' &&
      !('resolved' in oneEv.choices.pick),
    JSON.stringify({ comments: oneEv.comments, choices: oneEv.choices })
  );
  await cli('stop', '--session', one.id);

  console.log('multi-reviewer: two concurrent submits do not double-enqueue (check-then-act race)');
  const rc = await cli('start', docA, '--no-open');
  // Fire two submits at the same instant. The status guard must let exactly one
  // through; the loser gets a 409 (FM-3) — never two 'submit' events for one round.
  const [r1, r2] = await Promise.all([
    browser(`/api/submit?session=${rc.id}`, { reviewerId: 'A', comments: [], choices: {}, note: 'one' }),
    browser(`/api/submit?session=${rc.id}`, { reviewerId: 'B', comments: [], choices: {}, note: 'two' }),
  ]);
  check(
    'FM-3: exactly one concurrent submit wins; the other 409s',
    r1.ok !== r2.ok && (r1.status === 409 || r2.status === 409),
    JSON.stringify({ r1: r1.status, r2: r2.status })
  );
  const rcEv1 = await cli('wait', '--session', rc.id, '--timeout', '3');
  const rcEv2 = await cli('wait', '--session', rc.id, '--timeout', '1');
  check(
    'FM-3: only ONE submit event was enqueued (agent reworks once)',
    rcEv1.type === 'submit' && rcEv2.type === 'timeout',
    JSON.stringify({ e1: rcEv1.type, e2: rcEv2.type })
  );
  const rcState = await browser(`/api/state?session=${rc.id}`);
  check(
    'FM-6: after the concurrent-submit race, workingSince is set exactly once and status is working',
    rcState.data.status === 'working' &&
      typeof rcState.data.workingSince === 'number' &&
      Math.abs(Date.now() - rcState.data.workingSince) < 5000,
    JSON.stringify({ status: rcState.data.status, workingSince: rcState.data.workingSince })
  );
  await cli('stop', '--session', rc.id);

  console.log('multi-reviewer: a re-present carries every reviewer\'s comments + choices forward');
  const carryDoc = path.join(dir, 'planreview-e2e-carry.md');
  fs.writeFileSync(carryDoc, '# Carry\n\nShared body line.\n');
  const cy = await cli('start', carryDoc, '--no-open');
  await browser(`/api/review-state?session=${cy.id}`, {
    reviewerId: 'A',
    comments: [{ id: 'ca', quote: 'Shared body line.', text: 'A note', author: { id: 'A', name: 'Ada' } }],
    choices: { pick: 'A1' },
  });
  await browser(`/api/review-state?session=${cy.id}`, {
    reviewerId: 'B',
    comments: [{ id: 'cb', quote: 'Shared body line.', text: 'B note', author: { id: 'B', name: 'Ben' } }],
    choices: { pick: 'A2' },
  });
  fs.writeFileSync(carryDoc, '# Carry\n\nShared body line.\n\nA reworked addition.\n');
  await cli('present', carryDoc, '--session', cy.id);
  const carried = await browser(`/api/state?session=${cy.id}`);
  check(
    'DSM-3: loadDoc carries BOTH reviewers\' attributed comments + per-reviewer choices across a re-present',
    carried.data.review.comments.length === 2 &&
      carried.data.review.comments.some((c) => c.id === 'ca' && c.author.id === 'A' && !c.archived) &&
      carried.data.review.comments.some((c) => c.id === 'cb' && c.author.id === 'B' && !c.archived) &&
      carried.data.review.choices.pick.A === 'A1' &&
      carried.data.review.choices.pick.B === 'A2',
    JSON.stringify(carried.data.review)
  );
  await cli('stop', '--session', cy.id);

  console.log('issue 008: a re-present carries a choice resolution forward (persists until cleared)');
  const rcDoc = path.join(dir, 'planreview-e2e-carry-res.md');
  const rcChoice = '\n\n```choice\nid: pick\nprompt: Which one?\noptions:\n  - A1\n  - A2\n```\n';
  fs.writeFileSync(rcDoc, '# Carry Res\n\nShared body line.' + rcChoice);
  const rcr = await cli('start', rcDoc, '--no-open');
  await browser(`/api/review-state?session=${rcr.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${rcr.id}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  await browser(`/api/review-state?session=${rcr.id}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], resolutions: { pick: { option: 'A2', reason: 'carry me' } },
  });
  fs.writeFileSync(rcDoc, '# Carry Res\n\nShared body line.\n\nA reworked addition.' + rcChoice);
  await cli('present', rcDoc, '--session', rcr.id);
  const rcCarried = await browser(`/api/state?session=${rcr.id}`);
  check(
    'loadDoc carries the resolution (option + reason + attribution) forward across a re-present',
    rcCarried.data.review.resolutions.pick &&
      rcCarried.data.review.resolutions.pick.option === 'A2' &&
      rcCarried.data.review.resolutions.pick.by === 'A' &&
      rcCarried.data.review.resolutions.pick.reason === 'carry me',
    JSON.stringify(rcCarried.data.review.resolutions)
  );
  await cli('stop', '--session', rcr.id);

  console.log('version history: bounded ring, arbitrary-pair diff, removals across a span');
  const dv = path.join(dir, 'planreview-e2e-versions.md');
  fs.writeFileSync(dv, '# Ring\n\nKeep one.\n\nDrop me.\n\nKeep two.\n');
  const vs = await cli('start', dv, '--no-open'); // v1
  const vid = vs.id;
  fs.writeFileSync(dv, '# Ring\n\nKeep one.\n\nKeep two.\n'); // v2: remove "Drop me."
  await cli('present', dv, '--session', vid);
  fs.writeFileSync(dv, '# Ring\n\nKeep one.\n\nKeep two.\n\nBrand new.\n'); // v3: add a block
  await cli('present', dv, '--session', vid);

  const vstate = await browser(`/api/state?session=${vid}`);
  check(
    '/api/state exposes the retained version list',
    Array.isArray(vstate.data.doc.versions) && vstate.data.doc.versions.join(',') === '1,2,3',
    JSON.stringify(vstate.data.doc.versions)
  );

  const dDefault = await browser(`/api/diff?session=${vid}`);
  check(
    'default /api/diff compares current vs previous',
    dDefault.ok &&
      dDefault.data.from === 2 &&
      dDefault.data.to === 3 &&
      /data-diff="add"><p>Brand new\./.test(dDefault.data.html),
    JSON.stringify({ from: dDefault.data && dDefault.data.from, to: dDefault.data && dDefault.data.to })
  );

  // arbitrary pair (v1 -> v3), NOT current-vs-previous: the removal from v1->v2 must still surface
  const dPair = await browser(`/api/diff?session=${vid}&from=1&to=3`);
  check(
    'arbitrary retained pair compares, including a removal across the span',
    dPair.ok &&
      dPair.data.from === 1 &&
      dPair.data.to === 3 &&
      /<div data-diff="remove"><p>Drop me\.<\/p><\/div>/.test(dPair.data.html) &&
      /data-diff="add"><p>Brand new\./.test(dPair.data.html),
    dPair.data && dPair.data.html
  );

  const dBad = await browser(`/api/diff?session=${vid}&from=99&to=3`);
  check(
    'diff against a non-retained version 400s with the available list',
    dBad.status === 400 && Array.isArray(dBad.data.versions),
    JSON.stringify(dBad)
  );

  // malformed (non-integer) params are a clean 400, never a 500 or an "undefined" page
  const dMalformed = await browser(`/api/diff?session=${vid}&from=abc&to=3`);
  check(
    'a malformed from= is a 400 (never 500 / undefined render)',
    dMalformed.status === 400 && Array.isArray(dMalformed.data.versions),
    JSON.stringify(dMalformed)
  );
  const dFloat = await browser(`/api/diff?session=${vid}&from=1.5&to=3`);
  check('a non-integer from= is rejected (integer versions only)', dFloat.status === 400, JSON.stringify(dFloat));

  // default `from` is derived from `to` (the version just before it), not the
  // second-newest overall — ?to=2 must diff 1→2, not 2→2
  const dDeriveFrom = await browser(`/api/diff?session=${vid}&to=2`);
  check(
    'omitting from defaults to the version immediately before to',
    dDeriveFrom.ok && dDeriveFrom.data.from === 1 && dDeriveFrom.data.to === 2,
    JSON.stringify({ from: dDeriveFrom.data && dDeriveFrom.data.from, to: dDeriveFrom.data && dDeriveFrom.data.to })
  );

  // from == to is a harmless empty diff over HTTP (200, no markers)
  const dSame = await browser(`/api/diff?session=${vid}&from=2&to=2`);
  check(
    'from == to returns 200 with no diff markers',
    dSame.ok && dSame.data.from === 2 && dSame.data.to === 2 && !/data-diff/.test(dSame.data.html),
    JSON.stringify({ status: dSame.status, from: dSame.data && dSame.data.from })
  );

  // a reversed pick (from > to) is a valid reverse diff, not a crash: the block
  // added in v3 shows as removed when diffing 3 -> 1
  const dRev = await browser(`/api/diff?session=${vid}&from=3&to=1`);
  check(
    'a reversed from>to pair yields a valid reverse diff (200)',
    dRev.ok && dRev.data.from === 3 && dRev.data.to === 1 && /data-diff="remove"><p>Brand new\./.test(dRev.data.html),
    dRev.data && dRev.data.html
  );
  await cli('stop', '--session', vid);

  const rv = path.join(dir, 'planreview-e2e-ring.md');
  fs.writeFileSync(rv, '# Ring2\n\nline 0.\n');
  const rs = await cli('start', rv, '--no-open'); // v1
  const rid = rs.id;
  for (let k = 1; k <= 11; k++) {
    fs.writeFileSync(rv, `# Ring2\n\nline ${k}.\n`);
    await cli('present', rv, '--session', rid); // -> v12
  }
  const rstate = await browser(`/api/state?session=${rid}`);
  check(
    'the version ring keeps at most the last 10 versions (bound is documented + enforced)',
    rstate.data.doc.version === 12 &&
      rstate.data.doc.versions.length === 10 &&
      rstate.data.doc.versions[0] === 3 &&
      rstate.data.doc.versions[9] === 12,
    JSON.stringify(rstate.data.doc.versions)
  );
  const aged = await browser(`/api/diff?session=${rid}&from=1&to=12`);
  check('a diff against an aged-out version 400s', aged.status === 400, JSON.stringify(aged));
  await cli('stop', '--session', rid);

  // version history is per-session: one session's versions/diffs never surface in another
  const isoA = await cli('start', dv, '--no-open'); // A: v1
  await cli('present', dv, '--session', isoA.id); // A: v2
  const isoB = await cli('start', rv, '--no-open'); // B: v1 only
  const isoAState = await browser(`/api/state?session=${isoA.id}`);
  const isoBState = await browser(`/api/state?session=${isoB.id}`);
  check(
    'each session keeps its own version history (no cross-session leak)',
    isoAState.data.doc.versions.join(',') === '1,2' && isoBState.data.doc.versions.join(',') === '1',
    JSON.stringify({ A: isoAState.data.doc.versions, B: isoBState.data.doc.versions })
  );
  const isoBDiff = await browser(`/api/diff?session=${isoB.id}&from=1&to=2`);
  check("B can't diff a version only A has", isoBDiff.status === 400, JSON.stringify(isoBDiff));
  await cli('stop', '--session', isoA.id);
  await cli('stop', '--session', isoB.id);

  console.log('comment threads: the agent replies to a specific comment; threads persist and ride along');
  const docT = path.join(dir, 'planreview-e2e-threads.md');
  fs.writeFileSync(docT, '# Threaded Plan\n\nWe will keep Redis for the limiter.\n');
  const th = await cli('start', docT, '--no-open');
  await browser(`/api/review-state?session=${th.id}`, {
    comments: [{ id: 'k', quote: 'keep Redis', text: 'why not in-process?' }],
    choices: {},
  });

  // (criterion 1) the agent replies to that specific comment via the CLI
  const replyRes = await cli('reply', 'k', 'Because the limiter is process-local.', '--session', th.id);
  check(
    'agent reply returns the stored reply, targeted at the comment id',
    replyRes.ok === true && replyRes.commentId === 'k' && replyRes.reply && replyRes.reply.role === 'agent' &&
      replyRes.reply.text === 'Because the limiter is process-local.',
    JSON.stringify(replyRes)
  );
  const afterReply = await browser(`/api/state?session=${th.id}`);
  const kc = (afterReply.data.review.comments || []).find((c) => c.id === 'k');
  check(
    'the reply is threaded under the comment, not in the global chat',
    !!kc && Array.isArray(kc.replies) && kc.replies.length === 1 &&
      kc.replies[0].role === 'agent' && afterReply.data.chat.length === 0,
    JSON.stringify(afterReply.data.review)
  );
  check(
    'posting an agent reply does not change the session status (state machine unchanged)',
    afterReply.data.status === 'reviewing',
    afterReply.data.status
  );
  const noPhantom = await cli('wait', '--session', th.id, '--timeout', '1');
  check('an agent reply enqueues no agent event (no phantom submit/chat)', noPhantom.type === 'timeout', JSON.stringify(noPhantom));

  // (SSE) a comment-reply event is broadcast to the session's tabs, and survives embedded newlines (TM-2)
  const cap = await captureEvents(th.id);
  await sleep(120);
  await browser(`/agent/reply?session=${th.id}`, { commentId: 'k', text: 'Line one.\n\nLine two.' });
  await sleep(200);
  cap.close();
  const crFrame = cap.events.find((e) => e.event === 'comment-reply');
  const crData = crFrame ? JSON.parse(crFrame.data) : null;
  check(
    'comment-reply SSE frame carries {commentId, reply} and survives embedded newlines',
    !!crData && crData.commentId === 'k' && crData.reply.role === 'agent' &&
      crData.reply.text === 'Line one.\n\nLine two.',
    JSON.stringify(cap.events.map((e) => e.event))
  );

  // validation: empty text, missing id, and unknown/cross-session ids are rejected (no silent no-op)
  const emptyReply = await browser(`/agent/reply?session=${th.id}`, { commentId: 'k', text: '   ' });
  check('an empty reply is rejected (400)', emptyReply.status === 400, `status=${emptyReply.status}`);
  const missingId = await browser(`/agent/reply?session=${th.id}`, { text: 'no id' });
  check('a reply with no comment id is rejected (400)', missingId.status === 400, `status=${missingId.status}`);
  const noComment = await browser(`/agent/reply?session=${th.id}`, { commentId: 'nope', text: 'hi' });
  check('a reply to an unknown comment id 404s', noComment.status === 404, `status=${noComment.status}`);
  const badCli = await cliRaw('reply', 'nope', 'hi', '--session', th.id);
  check('the CLI surfaces an unknown-comment reply error', badCli.code === 2 && /no such comment/i.test(badCli.stderr), badCli.stderr);

  // (isolation, TM-3) a reply cannot target a comment id living in another session
  const other = await cli('start', docB, '--no-open');
  const cross = await browser(`/agent/reply?session=${other.id}`, { commentId: 'k', text: 'leak?' });
  check('a reply cannot reach a comment id from another session (404)', cross.status === 404, `status=${cross.status}`);
  await cli('stop', '--session', other.id);

  // (FMEA merge race) a stale browser sync that raced the SSE must not drop the agent's replies
  await browser(`/api/review-state?session=${th.id}`, {
    comments: [{ id: 'k', quote: 'keep Redis', text: 'why not in-process?' }], // no replies — the racing sync
    choices: {},
  });
  const merged = await browser(`/api/state?session=${th.id}`);
  const km = merged.data.review.comments.find((c) => c.id === 'k');
  check(
    'review-state merge preserves agent replies against a stale browser sync',
    km && km.replies && km.replies.length === 2 && km.replies.every((r) => r.role === 'agent'),
    JSON.stringify(km)
  );

  // (criterion 2) a reviewer follow-up reply rides along in the next submit bundle
  await browser(`/api/review-state?session=${th.id}`, {
    comments: [{
      id: 'k', quote: 'keep Redis', text: 'why not in-process?',
      replies: [{ role: 'reviewer', text: 'ok, but document the tradeoff', ts: Date.now() }],
    }],
    choices: {},
  });
  const preSubmit = await browser(`/api/state?session=${th.id}`);
  const waitSub = cli('wait', '--session', th.id, '--timeout', '5');
  await sleep(200);
  await browser(`/api/submit?session=${th.id}`, { comments: preSubmit.data.review.comments, choices: {}, note: '' });
  const threadSubEv = await waitSub;
  const subK = (threadSubEv.comments || []).find((c) => c.id === 'k');
  check(
    'the submit bundle carries the full thread, including the reviewer follow-up',
    threadSubEv.type === 'submit' && subK && Array.isArray(subK.replies) &&
      subK.replies.some((r) => r.role === 'reviewer' && /document the tradeoff/.test(r.text)) &&
      subK.replies.some((r) => r.role === 'agent'),
    JSON.stringify(subK)
  );

  // (criterion 4 — survival) an anchored comment survives a re-present with its thread intact
  fs.appendFileSync(docT, '\nStill: we will keep Redis for now.\n'); // 'keep Redis' still present
  await cli('present', docT, '--session', th.id);
  const survived = await browser(`/api/state?session=${th.id}`);
  const ks = survived.data.review.comments.find((c) => c.id === 'k');
  check(
    'an anchored comment survives a re-present, thread intact and not archived',
    survived.data.status === 'reviewing' && ks && !ks.archived &&
      Array.isArray(ks.replies) && ks.replies.length === 3,
    JSON.stringify(ks)
  );

  // (criterion 4 — the un-anchored case is explicit) present a doc where the quote is gone
  const docT2 = path.join(dir, 'planreview-e2e-threads-v2.md');
  fs.writeFileSync(docT2, '# Threaded Plan v2\n\nWe switched to an in-process limiter.\n');
  await cli('present', docT2, '--session', th.id);
  const archived = await browser(`/api/state?session=${th.id}`);
  const ka = archived.data.review.comments.find((c) => c.id === 'k');
  check(
    'a comment whose quote vanished is archived but keeps its thread (never dropped)',
    ka && ka.archived === true && Array.isArray(ka.replies) && ka.replies.length === 3,
    JSON.stringify(ka)
  );
  // FM-8: the agent can still reply to an archived comment; stored, archival preserved
  const archReply = await cli('reply', 'k', 'For the record, we changed course.', '--session', th.id);
  check('the agent can reply to an archived comment', archReply.ok === true && archReply.reply.role === 'agent', JSON.stringify(archReply));
  // FM-2: a well-behaved browser sync echoes the archived comment back — it must not be dropped
  const beforeEcho = await browser(`/api/state?session=${th.id}`);
  await browser(`/api/review-state?session=${th.id}`, { comments: beforeEcho.data.review.comments, choices: {} });
  const afterEcho = await browser(`/api/state?session=${th.id}`);
  const ke = afterEcho.data.review.comments.find((c) => c.id === 'k');
  check(
    'a sync that echoes an archived comment preserves it and its thread (no silent drop, no reply dup)',
    ke && ke.archived === true && Array.isArray(ke.replies) && ke.replies.length === 4,
    JSON.stringify(ke)
  );
  // the archived flag is server-authoritative: a browser sync sending archived:false
  // must NOT resurface an un-anchored comment as active
  await browser(`/api/review-state?session=${th.id}`, {
    comments: [{ id: 'k', quote: 'keep Redis', text: 'why not in-process?', archived: false }],
    choices: {},
  });
  const kf = (await browser(`/api/state?session=${th.id}`)).data.review.comments.find((c) => c.id === 'k');
  check('the browser cannot clear the server-set archived flag', kf && kf.archived === true, JSON.stringify(kf));
  // a malformed reply in a sync (null / missing text) is skipped, not a 500, and real replies survive
  const malformed = await browser(`/api/review-state?session=${th.id}`, {
    comments: [{ id: 'k', quote: 'keep Redis', text: 'why not in-process?', replies: [null, { role: 'agent', text: 'valid', ts: 999 }] }],
    choices: {},
  });
  const kg = (await browser(`/api/state?session=${th.id}`)).data.review.comments.find((c) => c.id === 'k');
  check(
    'a malformed reply is dropped without a 500, real replies intact',
    malformed.status === 200 && kg && kg.replies.every((r) => r && typeof r.text === 'string') &&
      kg.replies.some((r) => r.text === 'valid'),
    JSON.stringify({ status: malformed.status, replies: kg && kg.replies })
  );
  // replies merge in timestamp order regardless of the order they arrive in
  await browser(`/api/review-state?session=${th.id}`, {
    comments: [{
      id: 'ord', quote: 'in-process', text: 'ordering',
      replies: [
        { role: 'agent', text: 'third', ts: 300 },
        { role: 'reviewer', text: 'first', ts: 100 },
        { role: 'agent', text: 'second', ts: 200 },
      ],
    }],
    choices: {},
  });
  const ko = (await browser(`/api/state?session=${th.id}`)).data.review.comments.find((c) => c.id === 'ord');
  check(
    'merged replies are ordered by timestamp',
    ko && ko.replies.map((r) => r.text).join(',') === 'first,second,third',
    JSON.stringify(ko && ko.replies)
  );
  await cli('stop', '--session', th.id);

  console.log('no time limit: wait blocks past poll windows until the reviewer acts');
  const np = await cli('start', docA, '--no-open');
  // no --timeout: must keep polling (past several 400ms server windows), not give up
  const blocking = cli('wait', '--session', np.id);
  await sleep(1300); // longer than several poll windows — a bounded wait would have returned
  await browser(`/api/chat?session=${np.id}`, { text: 'after a long pause' });
  const blockedEv = await blocking;
  check(
    'wait with no --timeout keeps polling and returns the real event',
    blockedEv.type === 'chat' && blockedEv.text === 'after a long pause'
  );
  // --warn-after surfaces a "still waiting" note on stderr but keeps waiting
  const warnWait = cliRaw('wait', '--session', np.id, '--warn-after', '0.3');
  await sleep(1300);
  await browser(`/api/chat?session=${np.id}`, { text: 'second' });
  const warnRes = await warnWait;
  check(
    'a long wait warns on stderr yet still delivers the event',
    /still waiting/.test(warnRes.stderr) && /"type":"chat"/.test(warnRes.stdout),
    JSON.stringify(warnRes)
  );
  await cli('stop', '--session', np.id);

  console.log('guard: a session id is required, unknown ids are rejected');
  const guard = await cli('start', docB, '--no-open'); // keep the server up
  const noId = await cliRaw('status');
  check('CLI errors without --session', noId.code === 2 && /--session/.test(noId.stderr), noId.stderr);
  const noIdWait = await cliRaw('wait');
  check('wait errors without --session', noIdWait.code === 2 && /--session/.test(noIdWait.stderr));
  const noSess = await browser('/api/state');
  check('server 404s a request with no session', noSess.status === 404);
  const badSess = await browser('/api/state?session=deadbeef');
  check('server 404s an unknown session', badSess.status === 404);
  const badWait = await cliRaw('wait', '--session', 'deadbeef', '--timeout', '2');
  check('CLI reports a vanished session', badWait.code === 2 && /no such session/.test(badWait.stderr));

  console.log('index + listing: every open session is discoverable');
  const list = await browser('/api/sessions');
  check(
    '/api/sessions lists the open session',
    Array.isArray(list.data) && list.data.some((x) => x.id === guard.id && x.title === 'Plan B'),
    JSON.stringify(list.data)
  );
  const cliList = await cli('list');
  check('CLI list matches /api/sessions', cliList.some((x) => x.id === guard.id));
  const health = await browser('/health');
  check(
    '/health reports session count + code version',
    health.data.ok === true &&
      health.data.sessions >= 1 &&
      typeof health.data.version === 'string' &&
      health.data.version.length > 0
  );
  const index = await text('/');
  check('/ serves the sessions index page', index.ok && /Plan Review/.test(index.body) && /api\/sessions/.test(index.body));
  const appPage = await text(`/s/${guard.id}`);
  check(
    '/s/<id> serves the review app with the submit split-button',
    appPage.ok && /id="doc"/.test(appPage.body) && /split-btn/.test(appPage.body)
  );

  console.log('presence: live roster of who is viewing — join/leave, tab counting, isolation (issue 007)');
  const presenceOf = async (id) => ((await browser(`/api/state?session=${id}`)).data || {}).presence || [];
  const waitPresence = async (id, pred) => {
    let roster = [];
    for (let i = 0; i < 60; i++) {
      roster = await presenceOf(id);
      if (pred(roster)) return roster;
      await sleep(40);
    }
    return roster;
  };
  const byId = (roster, rid) => roster.find((r) => r.id === rid);

  const ps = await cli('start', docA, '--no-open');
  const pid = ps.id;
  // FX-1 / FM-11: a reviewer's SSE connection shows in /api/state (the map mutates
  // synchronously on connect; only the broadcast is debounced).
  const alice1 = await captureEvents(pid, 'alice', 'Ada');
  const j1 = await waitPresence(pid, (r) => byId(r, 'alice'));
  check(
    'presence: a connected reviewer appears with count 1, a name, and a connectedAt',
    (() => { const a = byId(j1, 'alice'); return !!a && a.count === 1 && a.name === 'Ada' && typeof a.connectedAt === 'number'; })(),
    JSON.stringify(j1)
  );
  // FX-2 / AC1: a distinct reviewer joining broadcasts a roster naming BOTH to the
  // already-open tab — "shows the other reviewer present within a second or two".
  const bob1 = await captureEvents(pid, 'bob', 'Bo');
  await waitPresence(pid, (r) => byId(r, 'bob'));
  await sleep(150); // let the debounced frame reach alice's stream
  const aliceFrames = alice1.presenceFrames();
  const latest = aliceFrames[aliceFrames.length - 1] || [];
  check(
    'presence: a second distinct reviewer broadcasts a roster naming both to the first tab (AC1)',
    aliceFrames.length >= 1 && !!byId(latest, 'alice') && !!byId(latest, 'bob'),
    JSON.stringify({ frames: aliceFrames.length, latest })
  );
  // FX-3: a second tab for the SAME reviewer is one entry with a tab count, not a 2nd avatar.
  const alice2 = await captureEvents(pid, 'alice');
  const j2 = await waitPresence(pid, (r) => byId(r, 'alice') && byId(r, 'alice').count === 2);
  check(
    'presence: multiple tabs of one reviewer collapse to a single entry with a tab count',
    (() => { const a = byId(j2, 'alice'); return !!a && a.count === 2 && j2.filter((r) => r.id === 'alice').length === 1; })(),
    JSON.stringify(j2)
  );
  // FX-4: closing one of the two tabs leaves the reviewer present with count 1.
  alice2.close();
  const j3 = await waitPresence(pid, (r) => byId(r, 'alice') && byId(r, 'alice').count === 1);
  check(
    'presence: closing one of a reviewer\'s tabs keeps them present (count decrements)',
    !!byId(j3, 'alice') && byId(j3, 'alice').count === 1,
    JSON.stringify(j3)
  );
  // FX-5 / AC2: closing the reviewer's LAST tab removes them from the roster.
  alice1.close();
  const j4 = await waitPresence(pid, (r) => !byId(r, 'alice'));
  check(
    'presence: closing a reviewer\'s last tab removes them from the roster (AC2)',
    !byId(j4, 'alice') && !!byId(j4, 'bob'),
    JSON.stringify(j4)
  );
  bob1.close();

  // FX-6 / FM-2 / AC3: an anonymous connection (no rid — curl, an old client, the plain
  // test helpers) registers no presence and broadcasts none, on open AND on close. This
  // is the majority path today; a regression here would corrupt every existing SSE test.
  const anonSess = await cli('start', docA, '--no-open');
  const anonId = anonSess.id;
  const anonConn = await captureEvents(anonId); // no rid
  await sleep(180);
  check(
    'presence: an anonymous connection registers no presence and broadcasts none (AC3/FM-2)',
    (await presenceOf(anonId)).length === 0 && anonConn.presenceFrames().length === 0,
    JSON.stringify(await presenceOf(anonId))
  );
  anonConn.close();
  await sleep(150);
  check('presence: closing an anonymous connection still leaves an empty roster', (await presenceOf(anonId)).length === 0);
  await cli('stop', '--session', anonId);

  // FX-9: presence is per-session — a join in one session never leaks into another.
  const isoSess = await cli('start', docB, '--no-open');
  const isoId = isoSess.id;
  const isoConn = await captureEvents(pid, 'carol');
  await waitPresence(pid, (r) => byId(r, 'carol'));
  check(
    'presence: a join in one session never appears in another session\'s roster (FX-9)',
    (await presenceOf(isoId)).length === 0,
    JSON.stringify(await presenceOf(isoId))
  );
  isoConn.close();
  await cli('stop', '--session', isoId);

  // TM-9: rid/rname are truncated server-side so an oversized value can't bloat the
  // roster that gets re-broadcast to every tab.
  const truncSess = await cli('start', docA, '--no-open');
  const truncId = truncSess.id;
  const bigConn = await captureEvents(truncId, 'x'.repeat(300), 'y'.repeat(300));
  const tr = await waitPresence(truncId, (r) => r.length === 1);
  check(
    'presence: an oversized rid/rname is truncated to 100 chars (TM-9)',
    tr.length === 1 && tr[0].id.length === 100 && tr[0].name.length === 100,
    JSON.stringify({ idLen: tr[0] && tr[0].id.length, nameLen: tr[0] && tr[0].name.length })
  );
  bigConn.close();
  await cli('stop', '--session', truncId);

  // FM-4 / TM-7: the roster map is capped (PLANREVIEW_MAX_PRESENCE=4 in this run) so a
  // runaway client can't grow it — and the O(N) broadcast — without bound. Only NEW ids
  // are refused; an already-present reviewer can still add tabs.
  const capSess = await cli('start', docA, '--no-open');
  const capId = capSess.id;
  const capConns = [];
  for (let i = 0; i < 6; i++) capConns.push(await captureEvents(capId, `cap${i}`)); // cap4, cap5 refused at the cap
  const capped = await waitPresence(capId, (r) => r.length >= 4);
  check('presence: a NEW reviewer past the cap is refused so growth is bounded (FM-4/TM-7)', capped.length === 4, `size=${capped.length}`);
  const cap0extra = await captureEvents(capId, 'cap0'); // already present → a further tab is allowed
  const capB = await waitPresence(capId, (r) => byId(r, 'cap0') && byId(r, 'cap0').count === 2);
  check(
    'presence: an already-present reviewer can add a tab past the cap',
    byId(capB, 'cap0').count === 2 && capB.length === 4,
    JSON.stringify(capB.map((x) => [x.id, x.count]))
  );
  // FM-5 / TM-10: free a slot, let a previously-refused id really join, then close its
  // ORIGINAL (refused) connection — whose joined=false must make that close a no-op, never
  // deleting the now-live entry a different connection owns.
  capConns[1].close(); // free cap1's slot
  await waitPresence(capId, (r) => !byId(r, 'cap1'));
  const cap4live = await captureEvents(capId, 'cap4'); // under the cap now → really joins
  await waitPresence(capId, (r) => byId(r, 'cap4'));
  capConns[4].close(); // the original, refused cap4 connection closes
  await sleep(80 * 2);
  const capC = await presenceOf(capId);
  check(
    'presence: a refused connection\'s close never deletes a later real entry for the same id (FM-5/TM-10)',
    !!byId(capC, 'cap4') && byId(capC, 'cap4').count === 1,
    JSON.stringify(capC.map((x) => [x.id, x.count]))
  );
  cap0extra.close();
  cap4live.close();
  for (const c of capConns) c.close();
  await cli('stop', '--session', capId);

  // FM-8: name freshening — a later tab supplying a name updates a nameless entry, a
  // later blank name never blanks an existing one, and leaving a tab never rewrites it.
  const nameSess = await cli('start', docA, '--no-open');
  const nameId = nameSess.id;
  const n1 = await captureEvents(nameId, 'dee', '');
  await waitPresence(nameId, (r) => byId(r, 'dee'));
  const n2 = await captureEvents(nameId, 'dee', 'Dee');
  const nf = await waitPresence(nameId, (r) => byId(r, 'dee') && byId(r, 'dee').name === 'Dee');
  check('presence: a later tab freshens a nameless reviewer\'s label (FM-8a)', !!byId(nf, 'dee') && byId(nf, 'dee').name === 'Dee', JSON.stringify(nf));
  const n3 = await captureEvents(nameId, 'dee', '');
  await waitPresence(nameId, (r) => byId(r, 'dee') && byId(r, 'dee').count === 3);
  check('presence: a later blank name does not wipe an existing name (FM-8b)', byId(await presenceOf(nameId), 'dee')?.name === 'Dee');
  n2.close();
  await waitPresence(nameId, (r) => byId(r, 'dee') && byId(r, 'dee').count === 2);
  check('presence: leaving a tab never rewrites the reviewer\'s name', byId(await presenceOf(nameId), 'dee')?.name === 'Dee');
  n1.close();
  n3.close();
  await cli('stop', '--session', nameId);

  // FM-13: the roster is a Map, so a hostile rid like "__proto__" is an ordinary key.
  const protoSess = await cli('start', docA, '--no-open');
  const protoId = protoSess.id;
  const pc1 = await captureEvents(protoId, '__proto__', 'p');
  const pc2 = await captureEvents(protoId, 'constructor', 'c');
  const pr2 = await waitPresence(protoId, (r) => r.length === 2);
  check(
    'presence: __proto__/constructor rids are ordinary entries, no prototype pollution (FM-13)',
    pr2.length === 2 && !!byId(pr2, '__proto__') && !!byId(pr2, 'constructor') && ({}).p === undefined,
    JSON.stringify(pr2.map((x) => x.id))
  );
  pc1.close();
  pc2.close();
  await cli('stop', '--session', protoId);

  // TM-8: rapid churn coalesces — several joins inside one debounce window produce ONE
  // presence frame (not one per join), so churn can't storm the fan-out.
  const churnSess = await cli('start', docA, '--no-open');
  const churnId = churnSess.id;
  const observer = await captureEvents(churnId); // anonymous — receives frames, adds none
  await sleep(120); // ensure nothing is mid-window before we count
  const churnConns = await Promise.all(['e1', 'e2', 'e3'].map((r) => captureEvents(churnId, r)));
  await sleep(80 + 150); // one debounce window + slack
  check(
    'presence: a burst of joins in one debounce window is a single roster frame (TM-8)',
    observer.presenceFrames().length === 1 && observer.presenceFrames()[0].length === 3,
    JSON.stringify({ frames: observer.presenceFrames().length })
  );
  observer.close();
  for (const c of churnConns) c.close();
  await cli('stop', '--session', churnId);

  // FM-9 / DSM teardown race: stopping a session while presence-tracked tabs are open —
  // whose 'close' fires asynchronously AFTER removeSession has cleared s.sse, dropped the
  // presence timer, and deleted the session — must never crash (the post-teardown
  // presenceLeave hits the sessions.has guard). Also covers a stop raced against a
  // just-armed presence broadcast.
  console.log('presence: stopping a session with open tabs never crashes (teardown race, FM-9)');
  const tdSess = await cli('start', docA, '--no-open');
  const tdId = tdSess.id;
  const td1 = await captureEvents(tdId, 'ann');
  const td2 = await captureEvents(tdId, 'ben');
  await waitPresence(tdId, (r) => r.length === 2);
  const td3 = await captureEvents(tdId, 'cat'); // arms a fresh presence-broadcast window
  await cli('stop', '--session', tdId); // teardown races the armed timer + the closes below
  td1.close();
  td2.close();
  td3.close();
  await sleep(80 * 3);
  check('presence: the server survives a stop raced against open tabs + an armed broadcast', await serverAlive(), 'server crashed on teardown race');
  const tdGone = await browser(`/api/state?session=${tdId}`);
  check('presence: the stopped session is fully gone (no lingering roster/timer)', tdGone.status === 404, `status=${tdGone.status}`);

  // Rapid connect/disconnect churn (each a join+leave broadcast) never destabilizes the
  // fan-out, and a stable subscriber stays correctly rostered through it.
  console.log('presence: rapid connect/disconnect churn keeps the fan-out stable');
  const resSess = await cli('start', docA, '--no-open');
  const resId = resSess.id;
  const survivor = await captureEvents(resId, 'survivor');
  await waitPresence(resId, (r) => byId(r, 'survivor'));
  for (let i = 0; i < 15; i++) {
    const churn = await captureEvents(resId, `churn${i % 3}`); // ≤3 distinct + survivor ≤ cap
    churn.close();
  }
  const survives = await waitPresence(resId, (r) => r.length === 1 && byId(r, 'survivor'));
  check('presence: the server stays up through rapid presence churn', await serverAlive(), 'server crashed under churn');
  check('presence: a stable subscriber is still correctly rostered after churn', !!byId(survives, 'survivor') && byId(survives, 'survivor').count === 1, JSON.stringify(survives));
  survivor.close();
  await cli('stop', '--session', resId);
  await cli('stop', '--session', pid);

  console.log('connected tab shows up in the session\'s client count');
  const tab = await openEventStream(guard.id);
  await sleep(300);
  const withTab = await browser(`/api/state?session=${guard.id}`);
  check('a connected tab is counted on its own session', withTab.data.clients === 1, `clients=${withTab.data.clients}`);
  tab.close();

  console.log('static assets: no-store cache + overlays can hide + client is session-scoped');
  const css = await text('/style.css');
  check('style.css sent no-store', /no-store/.test((await fetch(`${BASE}/style.css`)).headers.get('cache-control') || ''));
  check(
    'css neutralizes [hidden] so overlays can hide',
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css.body),
    'missing [hidden] { display: none !important }'
  );
  {
    // issue 011 #5: the split-button caret must not read as its own block —
    // hovering anywhere in .split-btn should recolor both halves together,
    // in both the default and approve-mode colors, and the hairline divider
    // (the one thing that should still visually separate them) must remain.
    const cssNoComments = css.body.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1].replace(/\s+/g, ' ').trim(),
      body: m[2],
    }));
    const findRule = (pred) => rules.find(pred);
    const hasClass = (sel, cls) => sel.split(',').some((part) => part.includes(cls));
    // The hover-sync condition must be scoped to the two buttons themselves via
    // :has(#submit-btn:hover, .split-caret:hover) — NOT a bare .split-btn:hover,
    // which would also fire while hovering the open dropdown menu (#submit-menu
    // is a .split-btn descendant too, see public/index.html), falsely recoloring
    // the button while the pointer is over a menu item instead.
    // Exact-set check, not just "contains" — a rule with an extra trigger
    // appended (e.g. `.split-item:hover`, reintroducing the menu-hover bug)
    // must fail this, not silently pass because the two required triggers
    // are still present among others.
    const hasSyncedHoverCondition = (sel) => {
      const m = sel.match(/\.split-btn:has\(([^)]*)\)/);
      if (!m) return false;
      const triggers = m[1].split(',').map((s) => s.trim());
      return triggers.length === 2 && triggers.includes('#submit-btn:hover') && triggers.includes('.split-caret:hover');
    };

    const dividerRule = findRule((r) => r.selector === '.split-caret');
    check(
      'stylesheet keeps a border-left hairline divider on the split-caret',
      !!dividerRule && /border-left:\s*1px solid/.test(dividerRule.body),
      'no border-left hairline found on .split-caret'
    );

    check(
      'stylesheet scopes split-btn hover sync away from the dropdown menu (not a bare .split-btn:hover)',
      !/\.split-btn:hover\b/.test(cssNoComments),
      'found a bare .split-btn:hover selector — also matches hovering .split-menu, a .split-btn descendant'
    );

    const defaultHoverRule = findRule(
      (r) =>
        hasSyncedHoverCondition(r.selector) &&
        r.selector.includes('#submit-btn:not(.approve)') &&
        hasClass(r.selector, '.split-caret')
    );
    check(
      'stylesheet recolors submit-btn and the caret together on hover (default mode), scoped away from the menu',
      !!defaultHoverRule && /background:\s*var\(--accent-hover\)/.test(defaultHoverRule.body),
      'no :has()-scoped rule recoloring both #submit-btn and .split-caret on hover'
    );

    const approveHoverRule = findRule(
      (r) =>
        hasSyncedHoverCondition(r.selector) &&
        r.selector.includes('#submit-btn.approve') &&
        hasClass(r.selector, '.split-caret')
    );
    check(
      'stylesheet recolors submit-btn and the caret together on hover (approve mode), scoped away from the menu',
      !!approveHoverRule && /background:\s*var\(--success-hover\)/.test(approveHoverRule.body),
      'no :has()-scoped rule recoloring both halves in approve mode on hover'
    );

    const approveRestRule = findRule(
      (r) =>
        !r.selector.includes(':hover') &&
        r.selector.includes('#submit-btn.approve') &&
        hasClass(r.selector, '.split-caret')
    );
    check(
      'stylesheet recolors the whole split-btn control in approve mode at rest, not just #submit-btn',
      !!approveRestRule && /background:\s*var\(--success\)/.test(approveRestRule.body),
      'no rule recoloring both #submit-btn.approve and its .split-caret at rest'
    );
  }
  const app = await text('/app.js');
  check('client is session-scoped (reads /s/<id> and passes ?session=)', /function api\(/.test(app.body) && /session=/.test(app.body));
  check(
    'client mints a persistent reviewer identity (localStorage + crypto.randomUUID)',
    /pr\.reviewerId/.test(app.body) && /crypto\.randomUUID/.test(app.body) && /localStorage/.test(app.body)
  );
  check(
    'client attaches reviewerId to its mutating posts (review-state / submit / chat)',
    /reviewerId:\s*reviewer\.id/.test(app.body)
  );
  check(
    'client posts only its OWN flat choice picks (server nests them per reviewer)',
    /function myChoices\(/.test(app.body) && /choices:\s*myChoices\(\)/.test(app.body)
  );
  check(
    'client stamps new comments with an author',
    /author:\s*author\(\)/.test(app.body)
  );
  check(
    'client renders comment author badges with an id-derived color',
    /author-badge/.test(app.body) && /function authorColor\(/.test(app.body)
  );
  check(
    'client shows per-option who-picked badges and a muted disagree hint on choices',
    /choice-picks/.test(app.body) && /choice-disagree/.test(app.body)
  );
  // issue 011 item 3: don't echo a lone reviewer's own pick back to them — source-regex
  // smoke check (no DOM rig, matching the suite's convention for choice-block behavior).
  check(
    'client suppresses the picks summary when it would only restate the current reviewer\'s own solo pick',
    /reviewers\.size === 1 && reviewers\.has\(reviewer\.id\)/.test(app.body)
  );
  // issue 008: resolve control — source-regex smoke checks (no DOM rig, matching the suite's convention).
  check(
    'client renders a resolve-to control (renderResolution + choice-resolve class)',
    /function renderResolution\(/.test(app.body) && /choice-resolve/.test(app.body)
  );
  check(
    'the resolve control is gated on divergence or an existing resolution (no-friction guard)',
    /if \(!resolution && !divergent\)/.test(app.body)
  );
  check(
    'resolve/change/clear intent is posted through syncReview (set + null clear)',
    /syncReview\(\{ \[id\]: intent \}\)/.test(app.body) && /postResolution\(null\)/.test(app.body)
  );
  check(
    'the resolved banner colors the resolver name via the shared --author-color convention',
    /setProperty\('--author-color', authorColor\(resolution\.by\)\)/.test(app.body)
  );
  check(
    'css styles the resolve control (choice-resolve + choice-resolved)',
    /\.choice-resolve\b/.test(css.body) && /\.choice-resolved\b/.test(css.body)
  );
  check('client shows the reviewer name on chat lines', /chat-author/.test(app.body));
  // presence (issue 007): identity rides the SSE connection; a presence handler + strip render.
  check(
    'client carries its reviewer identity on the SSE connection (rid/rname on /events)',
    /function eventsUrl\(/.test(app.body) && /rid=/.test(app.body) && /rname=/.test(app.body) && /reviewer\.id/.test(app.body),
  );
  check(
    'client renders a live presence strip on presence events, colored by reviewerId',
    /addEventListener\('presence'/.test(app.body) &&
      /function renderPresence\(/.test(app.body) &&
      /presence-avatar/.test(app.body) &&
      /authorColor\(/.test(app.body),
  );
  check(
    'client guards the presence payload shape and renders names via textContent (not innerHTML)',
    /state\.presence = Array\.isArray/.test(app.body) && /textContent = initials\(/.test(app.body),
  );
  check('review page carries the presence strip container', /id="presence"/.test(appPage.body));
  check('stylesheet styles the presence avatars', /presence-avatar/.test(css.body));
  check('review page carries the "you are <name>" identity affordance', /id="identity"/.test(appPage.body));
  check(
    'stylesheet styles the attribution UI (author badge + choice conflict)',
    /author-badge/.test(css.body) && /choice-disagree/.test(css.body)
  );
  check(
    'client live-syncs on a peer "review" delta and ignores its own echo by author id',
    /addEventListener\('review'/.test(app.body) && /author\.id === reviewer\.id/.test(app.body)
  );
  check(
    'client gates edit/delete to the comment owner (peer comments are read-only)',
    /function ownComment\(/.test(app.body) && /if \(!c\.archived && own\)/.test(app.body)
  );
  check(
    'client offers a "Clear all" bulk action, scoped to the reviewer\'s own archived comments',
    /function clearArchived\(/.test(app.body) && /archived\.some\(ownComment\)/.test(app.body)
  );
  check(
    'the "Clear all" button is gated on owning an archived comment AND an active review status ' +
      '(a peer-only-archived session shows no button; nor does one mid-rework)',
    /archived\.some\(ownComment\) && state\.status === 'reviewing'/.test(app.body)
  );
  check(
    'the archived section (and its "Clear all" button) only ever renders when at least one comment is archived',
    /if \(archived\.length\) commentListEl\.appendChild\(archivedSection\(archived\)\)/.test(app.body)
  );
  check('stylesheet styles the archived "Clear all" action', /\.clear-archived/.test(css.body));
  check('client can post an approve (finish) action', /\/api\/approve/.test(app.body));
  check('client renders live rework progress', /renderProgress/.test(app.body) && /'progress'/.test(app.body));
  check('client highlights + can dismiss doc changes', /data-changed/.test(app.body) && /changes-dismissed/.test(app.body));
  check('client collapses already-answered questions', /choice-summary/.test(app.body) && /'answered'/.test(app.body));
  // working-overlay liveness: the pure helpers are served as their own asset,
  // the client wires a timer that starts on 'working' and resets on progress,
  // and the overlay markup + script are present on the review page.
  const liv = await text('/liveness.js');
  check(
    'liveness helpers are served and expose the pure API',
    liv.ok && /formatElapsed/.test(liv.body) && /stalenessHint/.test(liv.body) && /window\.Liveness/.test(liv.body)
  );
  check(
    'client runs an elapsed timer while working and resets it on progress',
    /startWorkingTimer/.test(app.body) &&
      /stopWorkingTimer/.test(app.body) &&
      /noteAgentSignal/.test(app.body) &&
      /window\.Liveness/.test(app.body)
  );
  check(
    'review page loads the liveness asset and carries the overlay timer/hint markup',
    /src="\/liveness\.js"/.test(appPage.body) &&
      /id="working-elapsed"/.test(appPage.body) &&
      /id="working-stale"/.test(appPage.body)
  );
  check('client offers a version-diff selector', /\/api\/diff/.test(app.body) && /diffing/.test(app.body));
  check(
    'client threads agent replies under comments (comment-reply listener + thread render)',
    /'comment-reply'/.test(app.body) && /renderThread/.test(app.body) && /comment-thread/.test(app.body)
  );
  check('client surfaces un-anchored comments in a distinct archived section', /archived/.test(app.body));
  check(
    'client wires the reviewer follow-up (replyForm → reviewer role → syncReview)',
    /replyForm/.test(app.body) && /role: 'reviewer'/.test(app.body) && /syncReview\(\)/.test(app.body)
  );
  // issue 011 item 2: the author badge gets its own in-flow row above the comment body
  // instead of living inside the absolutely-positioned .card-actions icon row, so it can
  // never overlap the comment text regardless of comment length.
  check(
    'client renders the author badge in its own row, not inside .card-actions',
    /className = 'card-author-row'/.test(app.body) &&
      !/actions\.appendChild\(authorBadge/.test(app.body)
  );
  check(
    'stylesheet keeps the author-row in normal document flow (reserves space instead of overlaying text)',
    /\.card-author-row\s*\{[^}]*\}/.test(css.body) && !/\.card-author-row\s*\{[^}]*position:\s*absolute/.test(css.body)
  );
  check(
    'the author-row reserves the same right-gutter as the ✎/✕ icons, so a long name never grows under them',
    /\.card-author-row\s*\{[^}]*margin:\s*0\s*48px/.test(css.body)
  );

  await cli('stop', '--session', guard.id);

  console.log('lifecycle: the shared server shuts itself down once empty');
  const open = (await browser('/api/sessions')).data || [];
  for (const x of open) await cli('stop', '--session', x.id).catch(() => {});
  let exited = false;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    if (!(await serverAlive())) {
      exited = true;
      break;
    }
  }
  check('server auto-exits after the last session ends', exited, 'still alive after ~6s');

  await persistenceChecks();
}

main()
  .catch((err) => {
    failures++;
    console.error(` FAIL  e2e crashed — ${err.message}`);
  })
  .then(async () => {
    // best-effort cleanup if a check bailed early: stop any stragglers.
    // `browser` is only bound once main() reaches its setup; guard in case main
    // rejected earlier (e.g. freePort failing before the client was built).
    try {
      const open = browser ? (await browser('/api/sessions')).data || [] : [];
      for (const x of open) await cli('stop', '--session', x.id).catch(() => {});
    } catch {
      /* server already down */
    }
    console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
