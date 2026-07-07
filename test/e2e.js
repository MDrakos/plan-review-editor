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
// Run: node test/e2e.js   (port 4799 + a short idle window so it never clashes
// with a real session and cleans itself up fast). Set PLANREVIEW_TEST_PORT to
// run on a different port — useful when several git worktrees run this suite at
// once, since a shared fixed port would otherwise collide.

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');

const PORT = Number(process.env.PLANREVIEW_TEST_PORT) || 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = path.join(__dirname, '..', 'bin', 'planreview.js');
const { render, renderDiff, renderVersionDiff } = require(path.join(__dirname, '..', 'server', 'markdown'));
const liveness = require(path.join(__dirname, '..', 'public', 'liveness'));
const { quoteAnchors } = require(path.join(__dirname, '..', 'server', 'anchor'));
const env = {
  ...process.env,
  PLANREVIEW_PORT: String(PORT),
  PLANREVIEW_IDLE_MS: '1500',
  PLANREVIEW_POLL_MS: '400', // short internal poll window so tests can exercise the wait loop
};

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

const { json: browser, text, alive: serverAlive } = makeClient(BASE);

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
// assert what the server broadcast (used for the comment-reply path).
async function captureEvents(id) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/events?session=${id}`, { signal: controller.signal });
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
  return { events, close: () => controller.abort() };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.error(` FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
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
  let timers = [];
  let tid = 1;
  const pump = () => { for (const t of [...timers]) t.fn(); }; // one tick of every live interval

  const makeEl = () => ({
    textContent: '', innerHTML: '', hidden: false, disabled: false, value: '',
    className: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    append() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
    scrollIntoView() {}, focus() {}, setSelectionRange() {},
    querySelector: () => makeEl(), querySelectorAll: () => [], contains: () => false,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), cloneRange() { return this; },
  });
  const els = {};
  const getEl = (id) => (els[id] || (els[id] = makeEl()));

  let es = null;
  const fakeState = { doc: { title: 'T', html: '<p>x</p>', version: 1 }, status: 'reviewing', review: { comments: [], choices: {} }, chat: [], progress: [] };
  const fire = (type, data) => es && es._h[type] && es._h[type]({ data: JSON.stringify(data) });

  const ctx = vm.createContext({
    window: {},
    document: {
      getElementById: getEl, querySelector: () => makeEl(), querySelectorAll: () => [], addEventListener() {},
      createElement: () => makeEl(), createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({}) }),
      createTreeWalker: () => ({ nextNode: () => null, currentNode: null }), title: '',
    },
    location: { pathname: '/s/abc' },
    EventSource: function () { es = { onopen: null, _h: {}, addEventListener(t, fn) { this._h[t] = fn; } }; return es; },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fakeState) }),
    setInterval: (fn) => { const id = tid++; timers.push({ id, fn }); return id; },
    clearInterval: (id) => { timers = timers.filter((t) => t.id !== id); },
    setTimeout: () => 0, clearTimeout: () => {},
    Date: { now: () => now }, NodeFilter: { SHOW_TEXT: 4 }, confirm: () => true,
    JSON, Math, Number, String, Array, Object, Boolean, console, Promise, encodeURIComponent, decodeURIComponent,
  });

  const load = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), ctx, { filename: file });
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

  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
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
}

// ---------- persistence: sessions survive a server restart (issue 005) ----------
//
// Unlike the checks above (which drive the CLI-managed shared server on PORT),
// these need to control the server process directly — start it, kill -9, and
// restart it — with a temp PLANREVIEW_STATE_DIR. So this phase spawns
// `node server/server.js` itself on a separate port and talks HTTP directly.
async function persistenceChecks() {
  const SERVER = path.join(__dirname, '..', 'server', 'server.js');
  const PPORT = 4798;
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
      'doc',
      'id',
      'progress',
      'queue',
      'review',
      'status',
      'submissions',
      'touched',
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

    await killP();
    spawnP();
    check('persist: server restarts after kill -9', await waitHealth(true));

    const restored = await p(`/api/state?session=${id}`);
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
  const noOther = render('```choice\nid: q\nprompt: Pick\nother: false\noptions:\n  - A\n  - B\n```\n');
  check(
    'other: false omits the free-text input',
    !/data-other/.test(noOther) && /choice-option/.test(noOther)
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
    'submit delivers comments, note, and a free-text Other choice value',
    subEv.type === 'submit' &&
      subEv.comments.length === 1 &&
      subEv.choices.pick.anonymous === 'a custom third option' &&
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
  const apEv = await cli('wait', '--session', ap.id, '--timeout', '3');
  check(
    'agent gets an approve event carrying the final bundle',
    apEv.type === 'approve' && apEv.note === 'ship it' && apEv.comments.length === 1
  );
  const reApprove = await browser(`/api/approve?session=${ap.id}`, {});
  check('cannot approve again once done', reApprove.status === 409, `status=${reApprove.status}`);
  await cli('stop', '--session', ap.id);

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
  await sleep(150);
  const reviewDeltas = cfEvents.events.filter((e) => e.event === 'review');
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
    'the submit bundle carries the full per-reviewer choice map (the conflict survives)',
    sbEv.choices.pick && sbEv.choices.pick.A === 'A1' && sbEv.choices.pick.B === 'A2' && sbEv.note === 'consolidated',
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
    'single reviewer: bundle is exactly their one comment + a one-entry choice map',
    oneEv.type === 'submit' &&
      oneEv.comments.length === 1 &&
      oneEv.comments[0].id === 's1' &&
      Object.keys(oneEv.choices.pick).length === 1 &&
      oneEv.choices.pick.solo === 'A1',
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
  const app = await text('/app.js');
  check('client is session-scoped (reads /s/<id> and passes ?session=)', /function api\(/.test(app.body) && /session=/.test(app.body));
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
    // best-effort cleanup if a check bailed early: stop any stragglers
    try {
      const open = (await browser('/api/sessions')).data || [];
      for (const x of open) await cli('stop', '--session', x.id).catch(() => {});
    } catch {
      /* server already down */
    }
    console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
