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
// with a real session and cleans itself up fast)

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');

const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = path.join(__dirname, '..', 'bin', 'planreview.js');
const { render, renderDiff, renderVersionDiff } = require(path.join(__dirname, '..', 'server', 'markdown'));
const liveness = require(path.join(__dirname, '..', 'public', 'liveness'));
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
        before.review.choices.pick === 'Two' &&
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
        restored.data.review.choices.pick === 'Two' &&
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
        doc: { path: null, title: 'Preseeded', html: '<p>Hi</p>', version: 3, blocks: ['<p>Hi</p>'] },
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
      subEv.choices.pick === 'a custom third option' &&
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

  console.log('answered questions persist across cycles (not re-asked); comments still reset');
  const q = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${q.id}`, {
    comments: [{ id: 'x', quote: 'q', text: 't' }],
    choices: { pick: 'A1' },
  });
  fs.appendFileSync(docA, '\n(another revision)\n');
  await cli('present', docA, '--session', q.id);
  const cyc = await browser(`/api/state?session=${q.id}`);
  check(
    'a re-present keeps prior answers but clears comments',
    cyc.data.review.choices.pick === 'A1' && cyc.data.review.comments.length === 0,
    JSON.stringify(cyc.data.review)
  );
  await cli('stop', '--session', q.id);

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
