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

const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = path.join(__dirname, '..', 'bin', 'planreview.js');
const { render, renderDiff } = require(path.join(__dirname, '..', 'server', 'markdown'));
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

// simulate the review UI in the browser
async function browser(pathname, body) {
  const res = await fetch(BASE + pathname, {
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
}

async function text(pathname) {
  const res = await fetch(BASE + pathname);
  return { status: res.status, ok: res.ok, body: await res.text() };
}

async function serverAlive() {
  try {
    return (await fetch(`${BASE}/health`)).ok;
  } catch {
    return false;
  }
}

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

async function main() {
  const dir = os.tmpdir();
  const docA = path.join(dir, 'planreview-e2e-a.md');
  const docB = path.join(dir, 'planreview-e2e-b.md');
  fs.writeFileSync(
    docA,
    '# Plan A\n\nBody of plan A.\n\n```choice\nid: pick\nprompt: Which one?\noptions:\n  - A1\n  - A2\n```\n'
  );
  fs.writeFileSync(docB, '# Plan B\n\nBody of plan B — a totally separate document.\n');

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
