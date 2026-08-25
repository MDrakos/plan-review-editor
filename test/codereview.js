#!/usr/bin/env node
'use strict';

// End-to-end test of the CODE review loop, driven the way an agent drives it
// (through bin/codereview.js) with the browser side simulated over HTTP.
//
// The headline guarantee: a reviewer's line comment survives the agent editing
// the file — it re-anchors to the line the code moved to, and the round that
// brought it back is marked as changed. Around that: the diff model itself
// (added / modified / deleted / untracked / renamed), context expansion and its
// path guard, the submit/approve bundle, and a code session coexisting with a
// plan session on the same server.
//
// Run: node test/codereview.js   (own git fixture repo in a temp dir, own
// OS-assigned port, cleans itself up).

const { execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const CLI = path.join(__dirname, '..', 'bin', 'codereview.js');
const PLAN_CLI = path.join(__dirname, '..', 'bin', 'planreview.js');

let PORT;
let BASE;
let env;
let repo;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(bin, ...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], { env, cwd: repo }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim() ? JSON.parse(stdout.trim()) : {});
    });
  });
}
const code = (...args) => cli(CLI, ...args);
const plan = (...args) => cli(PLAN_CLI, ...args);

// The browser side: JSON in, JSON out, against one session.
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
    /* no body */
  }
  return { status: res.status, data };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`   ok  ${name}`);
  } else {
    failures += 1;
    console.log(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------- fixture repo ----------

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo() {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codereview-e2e-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test Reviewer');
  fs.writeFileSync(
    path.join(repo, 'auth.js'),
    ['function verify(req) {', '  const token = old(req);', '  return token;', '}', '', 'module.exports = { verify };', ''].join('\n')
  );
  fs.writeFileSync(path.join(repo, 'doomed.js'), 'module.exports = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  // A "main" to be the upstream the default spec measures against.
  git('branch', 'work');
  git('checkout', '-q', 'work');
}

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  env = {
    ...process.env,
    PLANREVIEW_PORT: String(PORT),
    PLANREVIEW_IDLE_MS: '1500',
    PLANREVIEW_POLL_MS: '400',
    PLANREVIEW_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'codereview-state-')),
  };
  makeRepo();

  // The branch's work: one modified file, one new file, one deletion, one
  // untracked file — every status the model has to get right.
  const authPath = path.join(repo, 'auth.js');
  fs.writeFileSync(
    authPath,
    ['function verify(req) {', '  const token = jwt(req);', '  return token;', '}', '', 'module.exports = { verify };', ''].join('\n')
  );
  fs.writeFileSync(path.join(repo, 'jwt.js'), 'module.exports = function jwt(req) {\n  return req.headers.authorization;\n};\n');
  fs.unlinkSync(path.join(repo, 'doomed.js'));
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n');
  git('add', 'auth.js', 'jwt.js');
  git('rm', '-q', '--cached', 'doomed.js');
  git('commit', '-qm', 'wip: use jwt');

  console.log('start: the current branch diff goes under review');
  const started = await code('start', '--base', 'main', '--no-open');
  const id = started.id;
  check('start mints a diff session with an /r/ url', /\/r\//.test(started.url), started.url);
  check('start reports the files it found', started.files >= 4, JSON.stringify(started));

  const s1 = await browser(`/api/state?session=${id}`);
  const model = s1.data.diff;
  const byPath = Object.fromEntries(model.files.map((f) => [f.path, f]));
  check('the session is a diff session', s1.data.kind === 'diff', s1.data.kind);
  check('a modified file is parsed with hunks', (byPath['auth.js'].hunks || []).length === 1);
  check('an added file is marked added', byPath['jwt.js'].status === 'added');
  check('a deleted file is marked deleted', byPath['doomed.js'].status === 'deleted');
  check('an untracked file rides along as all-additions', byPath['notes.txt'] && byPath['notes.txt'].untracked === true);
  check(
    'new-side line numbers are real',
    byPath['auth.js'].hunks[0].lines.some((l) => l.type === 'add' && l.newNo === 2 && /jwt\(req\)/.test(l.text)),
    JSON.stringify(byPath['auth.js'].hunks[0].lines)
  );
  check('the model totals the diff', model.additions > 0 && model.deletions > 0, `${model.additions}/${model.deletions}`);

  console.log('the reviewer comments on a line, with a suggestion');
  const comment = {
    id: 'c-token',
    file: 'auth.js',
    side: 'new',
    line: 2,
    quote: '  const token = jwt(req);',
    text: 'this throws when the header is missing',
    suggestion: '  const token = jwt(req) || null;',
    ts: Date.now(),
    author: { id: 'rev-1', name: 'Test Reviewer' },
  };
  await browser(`/api/review-state?session=${id}`, { reviewerId: 'rev-1', reviewerName: 'Test Reviewer', comments: [comment] });
  const s2 = await browser(`/api/state?session=${id}`);
  check('the comment is stored against file+line', s2.data.review.comments[0].line === 2);
  check('the suggestion travels with it', s2.data.review.comments[0].suggestion === '  const token = jwt(req) || null;');

  console.log('context expansion');
  const exp = await browser(`/api/expand?session=${id}&file=auth.js&from=1&to=99`);
  check('expand returns the new side and its total', exp.data.total === 6, JSON.stringify(exp.data.total));
  const bad = await browser(`/api/expand?session=${id}&file=../../etc/passwd&from=1&to=2`);
  check('expand refuses a path that is not in the diff', bad.status === 404, String(bad.status));

  console.log('submit: the bundle reaches the agent with the anchor intact');
  const waiting = code('wait', '--session', id, '--timeout', '20');
  await sleep(150);
  await browser(`/api/submit?session=${id}`, {
    reviewerId: 'rev-1',
    reviewerName: 'Test Reviewer',
    comments: [comment],
    note: 'one fix then ship it',
  });
  const event = await waiting;
  check('the agent gets a submit event', event.type === 'submit', event.type);
  check('the bundle carries file/side/line', event.comments[0].file === 'auth.js' && event.comments[0].line === 2);
  check('the bundle carries the quoted line', event.comments[0].quote === '  const token = jwt(req);');
  check('the bundle carries the suggestion', event.comments[0].suggestion === '  const token = jwt(req) || null;');
  check('the overall note travels', event.note === 'one fix then ship it');

  console.log('round 2: the agent fixes the code and re-presents');
  // Apply the suggestion AND insert two lines above it, so the commented line
  // moves — the case that makes positional-only anchoring useless.
  fs.writeFileSync(
    authPath,
    [
      '// added a guard',
      'const REQUIRED = true;',
      'function verify(req) {',
      '  const token = jwt(req) || null;',
      '  return token;',
      '}',
      '',
      'module.exports = { verify };',
      '',
    ].join('\n')
  );
  const round2 = await code('present', '--session', id);
  check('present reports the re-read diff', round2.files >= 4, JSON.stringify(round2));

  const s3 = await browser(`/api/state?session=${id}`);
  const c = s3.data.review.comments[0];
  check('the comment is archived once its line is gone', c.archived === true, JSON.stringify(c));
  const files3 = Object.fromEntries(s3.data.diff.files.map((f) => [f.path, f]));
  check('the edited file is marked changed this round', files3['auth.js'].round === 'changed', files3['auth.js'].round);
  check('an untouched file carries no round marker', files3['jwt.js'].round === undefined, files3['jwt.js'].round);
  check(
    'lines added this round are marked fresh',
    files3['auth.js'].hunks.some((h) => h.lines.some((l) => l.fresh && /REQUIRED/.test(l.text))),
    JSON.stringify(files3['auth.js'].hunks)
  );

  console.log('a comment whose line merely MOVED follows it');
  const moving = {
    id: 'c-return',
    file: 'auth.js',
    side: 'new',
    line: 5,
    quote: '  return token;',
    text: 'why not return the whole session?',
    ts: Date.now(),
    author: { id: 'rev-1', name: 'Test Reviewer' },
  };
  await browser(`/api/review-state?session=${id}`, { reviewerId: 'rev-1', comments: [moving] });
  const waiting2 = code('wait', '--session', id, '--timeout', '20');
  await sleep(150);
  await browser(`/api/submit?session=${id}`, { reviewerId: 'rev-1', comments: [moving], note: '' });
  await waiting2;
  // Push the commented line three lines further down.
  fs.writeFileSync(
    authPath,
    [
      '// added a guard',
      'const REQUIRED = true;',
      '',
      '// three',
      '// more',
      'function verify(req) {',
      '  const token = jwt(req) || null;',
      '  return token;',
      '}',
      '',
      'module.exports = { verify };',
      '',
    ].join('\n')
  );
  await code('present', '--session', id);
  const s4 = await browser(`/api/state?session=${id}`);
  const followed = s4.data.review.comments.find((x) => x.id === 'c-return');
  check('a moved line re-anchors instead of archiving', followed.archived === false, JSON.stringify(followed));
  check('it re-anchors to the line the code moved to', followed.line === 8, String(followed.line));

  console.log('a reply from the agent lands on the thread');
  await code('reply', 'c-return', 'kept it a token for now', '--session', id);
  const s5 = await browser(`/api/state?session=${id}`);
  const replied = s5.data.review.comments.find((x) => x.id === 'c-return');
  check('the agent reply is threaded under the comment', (replied.replies || []).some((r) => r.role === 'agent'));

  console.log('the reviewer pulls in a commit made after the round');
  // The agent's `present` is gated to an active working round, so an edit made
  // AFTER the round it belonged to is invisible until the reviewer submits and
  // the agent presents again (issue 015). Refresh re-reads the diff in place.
  const beforeRefresh = (await browser(`/api/state?session=${id}`)).data;
  fs.writeFileSync(
    authPath,
    [
      '// refreshed after the round',
      '// added a guard',
      'const REQUIRED = true;',
      '',
      '// three',
      '// more',
      'function verify(req) {',
      '  const token = jwt(req) || null;',
      '  return token;',
      '}',
      '',
      'module.exports = { verify };',
      '',
    ].join('\n')
  );
  const refreshed = await browser(`/api/refresh?session=${id}`, { reviewerId: 'rev-1' });
  check('refresh is accepted while reviewing', refreshed.status === 200, JSON.stringify(refreshed));
  check(
    'refresh answers with its documented body, not just a status',
    refreshed.data.ok === true &&
      refreshed.data.version === beforeRefresh.doc.version + 1 &&
      refreshed.data.files === beforeRefresh.diff.files.length &&
      typeof refreshed.data.additions === 'number' &&
      typeof refreshed.data.deletions === 'number',
    JSON.stringify(refreshed.data)
  );

  const s7 = (await browser(`/api/state?session=${id}`)).data;
  const files7 = Object.fromEntries(s7.diff.files.map((f) => [f.path, f]));
  check(
    'the refresh re-read the diff',
    files7['auth.js'].hunks.some((h) => h.lines.some((l) => /refreshed after the round/.test(l.text))),
    JSON.stringify(files7['auth.js'].hunks)
  );
  const moved = s7.review.comments.find((x) => x.id === 'c-return');
  check('the comment survives a refresh instead of archiving', moved.archived === false, JSON.stringify(moved));
  check('the comment re-anchors to the line the refresh moved it to', moved.line === 9, String(moved.line));
  check('the refresh does not end the round', s7.status === 'reviewing', s7.status);
  check(
    'the refresh is not agent activity',
    s7.lastAgentActivity === beforeRefresh.lastAgentActivity,
    `${s7.lastAgentActivity} vs ${beforeRefresh.lastAgentActivity}`
  );
  // The round the reviewer is IN did not restart: the baseline is still the
  // model the agent presented against, so the round-3 additions stay fresh and
  // a file untouched since then still carries no marker.
  check(
    'the refresh keeps the round baseline',
    files7['auth.js'].hunks.some((h) => h.lines.some((l) => l.fresh && /\/\/ more/.test(l.text))),
    JSON.stringify(files7['auth.js'].hunks)
  );
  check('an untouched file still carries no round marker', files7['jwt.js'].round === undefined, files7['jwt.js'].round);

  // The working round belongs to the agent: refresh is refused until it hands back.
  const waitingR = code('wait', '--session', id, '--timeout', '20');
  await sleep(150);
  await browser(`/api/submit?session=${id}`, { reviewerId: 'rev-1', comments: [], note: '' });
  await waitingR;
  const busy = await browser(`/api/refresh?session=${id}`, { reviewerId: 'rev-1' });
  check('refresh is refused while the agent is working', busy.status === 409, String(busy.status));
  check('the refusal says which state blocked it', /working/.test((busy.data || {}).error || ''), JSON.stringify(busy.data));
  await browser(`/api/interrupt?session=${id}`, { reviewerId: 'rev-1' });
  await code('wait', '--session', id, '--timeout', '20'); // drain the interrupt event

  // FM-6: the handler guards AFTER its await and mutates with none in between,
  // the same race closure /api/submit and /api/interrupt use. Submit's
  // precondition cannot be defeated by a racing refresh (refresh never changes
  // status), so submit always lands — but a refresh that lands must have landed
  // while still `reviewing`, never under the working round it raced.
  const versionBeforeRace = (await browser(`/api/state?session=${id}`)).data.doc.version;
  const [raceRefresh, raceSubmit] = await Promise.all([
    browser(`/api/refresh?session=${id}`, { reviewerId: 'rev-1' }),
    browser(`/api/submit?session=${id}`, { reviewerId: 'rev-1', comments: [], note: '' }),
  ]);
  check('CONCURRENT refresh‖submit: the submit always lands', raceSubmit.status === 200, String(raceSubmit.status));
  check(
    'CONCURRENT refresh‖submit: the refresh either wins cleanly or 409s — never anything else',
    raceRefresh.status === 200 || raceRefresh.status === 409,
    String(raceRefresh.status)
  );
  const raceState = (await browser(`/api/state?session=${id}`)).data;
  check('CONCURRENT refresh‖submit: the working round the submit opened stands', raceState.status === 'working', raceState.status);
  check(
    'CONCURRENT refresh‖submit: the diff was re-read exactly as often as the refresh won',
    raceState.doc.version === versionBeforeRace + (raceRefresh.status === 200 ? 1 : 0),
    `${raceState.doc.version} vs ${versionBeforeRace}, refresh ${raceRefresh.status}`
  );
  await code('wait', '--session', id, '--timeout', '20'); // drain the submit event
  await browser(`/api/interrupt?session=${id}`, { reviewerId: 'rev-1' });
  await code('wait', '--session', id, '--timeout', '20'); // drain the interrupt event

  // FM-7: a git failure inside the re-read must surface as a 400, not an
  // uncaught 500 that takes the session with it. Broken on its OWN session and
  // its own throwaway base ref, so nothing else in this file is disturbed.
  git('branch', 'fm7-base', 'main');
  const doomedSession = await code('start', '--base', 'fm7-base', '--no-open');
  git('branch', '-qD', 'fm7-base');
  const brokenRefresh = await browser(`/api/refresh?session=${doomedSession.id}`, { reviewerId: 'rev-1' });
  check('a git failure during refresh is a 400, not a 500', brokenRefresh.status === 400, String(brokenRefresh.status));
  check('the 400 carries the git error', Boolean((brokenRefresh.data || {}).error), JSON.stringify(brokenRefresh.data));
  const survived = await browser(`/api/state?session=${doomedSession.id}`);
  check('the session survives a failed refresh', survived.status === 200 && survived.data.status === 'reviewing', String(survived.status));
  await code('stop', '--session', doomedSession.id);

  console.log('a plan review and a code review coexist on one server');
  const planDoc = path.join(os.tmpdir(), 'codereview-e2e-plan.md');
  fs.writeFileSync(planDoc, '# A plan\n\nSome plan text.\n');
  const planSession = await plan('start', planDoc, '--no-open');
  const list = await browser('/api/sessions');
  const kinds = Object.fromEntries(list.data.map((x) => [x.id, x]));
  check('the code session is listed as a diff at /r/', kinds[id].kind === 'diff' && kinds[id].url === `/r/${id}`);
  check('the plan session is listed as a plan at /s/', kinds[planSession.id].kind === 'plan' && kinds[planSession.id].url === `/s/${planSession.id}`);
  check('the code session is unaffected by the plan session', (await browser(`/api/state?session=${id}`)).data.kind === 'diff');
  const planRefresh = await browser(`/api/refresh?session=${planSession.id}`, { reviewerId: 'rev-1' });
  check('refresh is refused on a plan session', planRefresh.status === 400, String(planRefresh.status));
  check(
    'the plan-session refusal says refresh is code-review only',
    /code review/.test((planRefresh.data || {}).error || ''),
    JSON.stringify(planRefresh.data)
  );
  await plan('stop', '--session', planSession.id);

  console.log('approve: the agent is told to proceed, not to re-present');
  const waiting3 = code('wait', '--session', id, '--timeout', '20');
  await sleep(150);
  await browser(`/api/approve?session=${id}`, { reviewerId: 'rev-1', comments: [], note: 'ship it' });
  const approve = await waiting3;
  check('the agent gets an approve event', approve.type === 'approve', approve.type);
  const s6 = await browser(`/api/state?session=${id}`);
  check('the session is done, not working', s6.data.status === 'done', s6.data.status);

  console.log('teardown');
  await code('stop', '--session', id);
  await sleep(400); // /agent/stop lets its response + SSE frame flush before dropping the session
  const gone = await browser(`/api/state?session=${id}`);
  check('a stopped session is gone', gone.status === 404, String(gone.status));

  // A bad spec must not leave a half-built session behind.
  let badSpec = null;
  try {
    await code('start', '--range', 'nope-not-a-ref..alsono', '--no-open');
  } catch (err) {
    badSpec = err.message;
  }
  check('an unresolvable range fails loudly', !!badSpec, String(badSpec));
  const after = await browser('/api/sessions');
  check('and leaves no session behind', Array.isArray(after.data) && after.data.length === 0, JSON.stringify(after.data));

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(env.PLANREVIEW_STATE_DIR, { recursive: true, force: true });
  fs.rmSync(planDoc, { force: true });

  console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
