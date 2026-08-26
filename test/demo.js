#!/usr/bin/env node
'use strict';

// End-to-end test of demo/demo.js — the self-driving demo — playing the
// reviewer's browser through both of its stages: the plan (with its flow
// diagram) and the code review of the throwaway repo it builds.
//
// Run: node test/demo.js   (own OS-assigned port, cleans itself up).

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let PORT;
let BASE;

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
let fails = 0;
const check = (n, c, d) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : ` — ${d}`)); if (!c) fails++; };

async function api(p, body) {
  const res = await fetch(BASE + p, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function waitFor(fn, label, ms = 30000) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(300); }
}

(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, PLANREVIEW_PORT: String(PORT), PLANREVIEW_NO_OPEN: '1', PLANREVIEW_PERSIST: '0' };
  const demo = spawn(process.execPath, [path.join(ROOT, 'demo', 'demo.js')], { env, cwd: ROOT });
  let out = '';
  demo.stdout.on('data', (c) => { out += c; process.stdout.write('    | ' + c); });
  demo.stderr.on('data', (c) => { out += c; process.stderr.write('    ! ' + c); });
  const exited = new Promise((r) => demo.on('exit', r));

  // ---- stage 1: the plan ----
  const plan = await waitFor(async () => {
    const s = await api('/api/sessions');
    return (s.data || []).find((x) => x.kind !== 'diff');
  }, 'plan session');
  const pid = plan.id;
  const st1 = await api(`/api/state?session=${pid}`);
  check('plan renders the flow diagram as svg', /class="flow-svg"/.test(st1.data.doc.html), 'no flow-svg');
  const anchorId = (st1.data.doc.html.match(/data-anchor-id="([^"]+)"/) || [])[1];
  check('the diagram exposes anchor ids', !!anchorId, 'none found');

  const c1 = { id: 'p1', anchors: [anchorId], quote: 'Mint one-time token',
    text: 'rate limit this before minting', ts: Date.now(), author: { id: 'rev-1', name: 'Smoke' } };
  await api(`/api/review-state?session=${pid}`, { reviewerId: 'rev-1', reviewerName: 'Smoke', comments: [c1] });
  await api(`/api/submit?session=${pid}`, { reviewerId: 'rev-1', comments: [c1], choices: { lifetime: '15 minutes — tightest; fine if email delivery is fast' }, note: 'diagram note' });
  const v2 = await waitFor(async () => {
    const s = await api(`/api/state?session=${pid}`);
    return s.data && s.data.doc.version >= 2 && s.data.status === 'reviewing' ? s.data : null;
  }, 'plan rework');
  check('plan re-presented at v2', v2.doc.version >= 2, String(v2.doc.version));
  check('v2 diagram has the rate-limit box', /Rate limit per email/.test(v2.doc.html), 'missing');
  check('agent replied inline on the diagram comment',
    (v2.review.comments[0].replies || []).length > 0, JSON.stringify(v2.review.comments[0].replies));
  await api(`/api/approve?session=${pid}`, { reviewerId: 'rev-1', comments: [], choices: {}, note: 'looks good' });

  // ---- stage 2: the code ----
  const diff = await waitFor(async () => {
    const s = await api('/api/sessions');
    return (s.data || []).find((x) => x.kind === 'diff');
  }, 'diff session');
  const did = diff.id;
  const cs = await api(`/api/state?session=${did}`);
  const files = cs.data.diff.files.map((f) => f.path).sort();
  check('the diff covers add/modify/delete/untracked',
    JSON.stringify(files) === JSON.stringify(['src/auth.js', 'src/magiclink.js', 'src/password-reset.js', 'test/magiclink.test.js']),
    JSON.stringify(files));
  const ml = cs.data.diff.files.find((f) => f.path === 'src/magiclink.js');
  const ttl = ml.hunks.flatMap((h) => h.lines).find((l) => /TOKEN_TTL_MS = 24/.test(l.text));
  check('the planted 24h lifetime is in the diff', !!ttl, 'not found');
  const bytes = ml.hunks.flatMap((h) => h.lines).find((l) => /TOKEN_BYTES = 32/.test(l.text));

  const c2 = { id: 'c-ttl', file: 'src/magiclink.js', side: 'new', line: ttl.newNo, quote: ttl.text,
    text: 'the plan capped this at 15 minutes', ts: Date.now(), author: { id: 'rev-1', name: 'Smoke' } };
  const c3 = { id: 'c-bytes', file: 'src/magiclink.js', side: 'new', line: bytes.newNo, quote: bytes.text,
    text: 'name it for what it is', suggestion: 'const TOKEN_BYTES = 32; // 256 bits of entropy',
    ts: Date.now(), author: { id: 'rev-1', name: 'Smoke' } };
  await api(`/api/review-state?session=${did}`, { reviewerId: 'rev-1', comments: [c2, c3] });
  await api(`/api/submit?session=${did}`, { reviewerId: 'rev-1', comments: [c2, c3], note: 'two things' });

  const r2 = await waitFor(async () => {
    const s = await api(`/api/state?session=${did}`);
    return s.data && s.data.doc.version >= 2 && s.data.status === 'reviewing' ? s.data : null;
  }, 'code rework');
  const ml2 = r2.diff.files.find((f) => f.path === 'src/magiclink.js');
  const all2 = ml2.hunks.flatMap((h) => h.lines).map((l) => l.text);
  check('the lifetime was fixed to 15 min', all2.some((t) => /TOKEN_TTL_MS = 15 \* 60 \* 1000/.test(t)), all2.join('|').slice(0, 200));
  check('the token is hashed before the store', all2.some((t) => /store\.put\(hash\(token\)/.test(t)), 'not hashed');
  check('the suggestion was applied verbatim', all2.some((t) => /256 bits of entropy/.test(t)), 'suggestion missing');
  const ttlComment = r2.review.comments.find((c) => c.id === 'c-ttl');
  check('the lifetime comment archived (its line is gone)', ttlComment && ttlComment.archived === true,
    JSON.stringify(ttlComment && { line: ttlComment.line, archived: ttlComment.archived }));
  check('agent replied inline on the code comment', (r2.review.comments[0].replies || []).length > 0, 'no reply');

  await api(`/api/approve?session=${did}`, { reviewerId: 'rev-1', comments: [], note: 'ship it' });
  const codeExit = await Promise.race([exited, sleep(20000).then(() => 'timeout')]);
  check('the demo exits cleanly after both stages', codeExit === 0, String(codeExit));
  check('the demo says it is complete', /Demo complete/.test(out), 'no completion banner');
  if (codeExit === 'timeout') demo.kill();

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall demo checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('demo test: ' + e.message);
  process.exit(1);
});
