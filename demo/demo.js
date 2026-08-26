#!/usr/bin/env node
'use strict';

// Self-driving demo of plan-review-editor. Plays a scripted stand-in "agent" so
// you can see the whole review loop without a real Claude Code session:
//
//   npm run demo                 both stages
//   npm run demo -- plan         the plan review only
//   npm run demo -- code         the code review only
//
// Stage 1 presents a sample plan (with a flow diagram you can comment on) and
// replies to your chats, shows live rework progress, and re-presents a revised
// version with the changes highlighted. Stage 2 builds a throwaway git repo
// holding "the code that plan produced" and puts its diff in the code-review UI,
// where your line comments and suggestions get applied and handed back.
//
// Runs on a dedicated port (4781) so it never collides with a real session.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const PORT = Number(process.env.PLANREVIEW_PORT || 4781);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const V1 = path.join(__dirname, 'plan.md');
const V2 = path.join(__dirname, 'plan.v2.md');
const ARGS = process.argv.slice(2);
const NO_OPEN = ARGS.includes('--no-open') || !!process.env.PLANREVIEW_NO_OPEN;
const STAGES = ARGS.includes('plan') ? ['plan'] : ARGS.includes('code') ? ['code'] : ['plan', 'code'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      BASE + pathname,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
          if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
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

async function health() {
  try {
    return await request('GET', '/health');
  } catch {
    return null;
  }
}

function openBrowser(url) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(opener, [url], () => {});
}

async function ensureServer() {
  if (await health()) return;
  spawn(process.execPath, [SERVER], {
    env: { ...process.env, PLANREVIEW_PORT: String(PORT) },
    detached: true,
    stdio: 'ignore',
  }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await health()) return;
  }
  throw new Error(`demo server did not come up on ${BASE}`);
}

const say = (id, text) => request('POST', `/agent/say?session=${id}`, { text });
const reply = (id, commentId, text) =>
  request('POST', `/agent/reply?session=${id}`, { commentId, text });
const progress = (id, text) => request('POST', `/agent/progress?session=${id}`, { text });
const present = (id, file) =>
  request('POST', `/agent/present?session=${id}`, file ? { path: file } : {});

function replyTo(text) {
  const t = text.length > 60 ? text.slice(0, 57) + '…' : text;
  return `Noted: "${t}". A real agent would dig in and act on this — for the demo I'll fold it into the next revision. Ask me anything, or submit your review when ready.`;
}

function printSummary(ev, { choices: showChoices }) {
  console.log(`\n  ✅ ${ev.type === 'approve' ? 'Approved & finished' : 'Session ended'}.`);
  if (showChoices) {
    console.log('  Final decisions:');
    const choices = ev.choices || {};
    const keys = Object.keys(choices);
    if (keys.length) {
      for (const k of keys) {
        // 008 bundle shape: choices[k] = { picks: {reviewerId: option}, resolved? }.
        const c = choices[k] || {};
        if (c.resolved && c.resolved.option) {
          const who = c.resolved.byName || c.resolved.by || 'someone';
          const why = c.resolved.reason ? ` — ${c.resolved.reason}` : '';
          console.log(`     • ${k}: ${c.resolved.option} (resolved by ${who})${why}`);
        } else {
          const picks = c.picks && typeof c.picks === 'object' ? Object.values(c.picks) : [];
          const flat = [...new Set(picks.flatMap((v) => (Array.isArray(v) ? v : [v])))];
          console.log(`     • ${k}: ${flat.length ? flat.join(', ') : '(no pick)'}`);
        }
      }
    } else {
      console.log('     (no questions answered)');
    }
  }
  if (ev.note) console.log(`     note: ${ev.note}`);
  if (ev.comments && ev.comments.length) console.log(`     ${ev.comments.length} comment(s) received`);
}

// The event loop both stages run: chat is answered the same way everywhere, and
// only what happens on a submitted review differs.
async function runLoop(id, { onSubmit, choices }) {
  for (;;) {
    let ev;
    try {
      ev = await request('GET', `/agent/wait?session=${id}&timeout=50000`);
    } catch (err) {
      if (/no such session/i.test(err.message)) return; // session gone — stop
      await sleep(500);
      continue;
    }

    if (ev.type === 'timeout' || ev.type === 'interrupt') continue;

    if (ev.type === 'chat') {
      console.log(`  💬 you: ${ev.text}`);
      await sleep(600);
      await say(id, replyTo(ev.text));
      console.log('  🤖 replied in the sidebar');
      continue;
    }

    if (ev.type === 'submit') {
      await onSubmit(ev);
      continue;
    }

    if (ev.type === 'approve' || ev.type === 'end') {
      printSummary(ev, { choices });
      await request('POST', `/agent/stop?session=${id}`).catch(() => {});
      return;
    }
  }
}

// ---------- stage 1: the plan ----------

function planBanner(url) {
  console.log(`
  plan-review-editor — demo, stage 1 of ${STAGES.length}: reviewing a plan
  ──────────────────────────────────────────────────────────────
  A browser tab just opened:  ${url}

  Try it in the browser:
    • select any text in the plan  → leave an inline comment
    • click a box or an arrow in the flow diagram → comment on that
      (drag a box around several; drag to pan, ⌘/ctrl-scroll to zoom,
       double-click to fit)
    • answer the two questions      (try the "Other" free-text box)
    • chat in the sidebar           → this terminal replies
    • hit "Submit review"           → watch the plan get reworked,
                                      with the changes highlighted
    • the ▾ next to Submit          → "Approve & finish" to wrap up

  This terminal is playing the agent. Press Ctrl-C to quit.
`);
}

async function planStage() {
  const started = await request('POST', '/agent/start', { path: V1 });
  const id = started.id;
  const url = BASE + started.url;
  if (!NO_OPEN) openBrowser(url);
  planBanner(url);

  let reworked = false;
  await runLoop(id, {
    choices: true,
    async onSubmit(ev) {
      const n = ev.comments.length;
      const anchored = ev.comments.filter((c) => c.anchors && c.anchors.length).length;
      console.log(
        `  📝 review submitted — ${n} comment(s)${anchored ? `, ${anchored} on the diagram` : ''}${ev.note ? `, note: "${ev.note}"` : ''}`
      );
      // answer the first inline comment in place, so it threads under that
      // comment instead of landing in the global chat
      if (n) {
        await reply(
          id,
          ev.comments[0].id,
          "Good point — here's my thinking on this specific line; reply back if it still needs work."
        );
        console.log('  🤖 replied inline under your first comment');
      }
      if (!reworked) {
        const steps = [
          `Reading your ${n} comment${n === 1 ? '' : 's'} and choices`,
          'Revising the context and deferring passkeys to v1.1',
          'Adding a rate-limit step to the sign-in diagram',
          'Adding a rollout question for you to weigh in on',
        ];
        for (const step of steps) {
          await progress(id, step);
          await sleep(1100);
        }
        await present(id, V2);
        reworked = true;
        await say(
          id,
          "Reworked and re-presented. Changed blocks are highlighted, the diagram has a new rate-limit box, and the questions you already answered are collapsed (hit Change to revisit). There's one new question — answer it and Approve when you're happy."
        );
        console.log('  🤖 presented the revised plan (changes highlighted)');
      } else {
        await say(id, 'No further changes queued — use the ▾ → "Approve & finish" when you\'re ready.');
        console.log('  🤖 nudged toward Approve & finish');
      }
    },
  });
}

// ---------- stage 2: the code ----------

// A throwaway repo holding the change the plan asked for: auth switched over to
// magic links, the password-reset path deleted, a new module added, and an
// untracked test. Two things in it are wrong on purpose (a 24-hour lifetime the
// plan capped at 15 minutes, and a raw token in the store) so round two has
// something real to fix.
const BEFORE = {
  'src/auth.js': `'use strict';

const { verifyPassword } = require('./password');

// Sign in with an email and a password.
async function signIn(email, password) {
  const user = await users.byEmail(email);
  if (!user) throw new Error('no such user');
  if (!verifyPassword(user, password)) throw new Error('bad password');
  return sessions.create(user);
}

module.exports = { signIn };
`,
  'src/password-reset.js': `'use strict';

// Emails a reset link. Our #1 support ticket generator.
async function requestReset(email) {
  const user = await users.byEmail(email);
  if (!user) return;
  await sendEmail(email, resetUrl(await tokens.mint(user)));
}

module.exports = { requestReset };
`,
};

const AFTER = {
  'src/auth.js': `'use strict';

const { mintLink, exchange } = require('./magiclink');

// Ask for a sign-in link. Always returns quietly, so an unknown address can't
// be told apart from a known one.
async function requestLink(email) {
  const user = await users.byEmail(email);
  if (user) await mintLink(user);
}

// Trade the token from the emailed link for a session.
async function signInWithLink(token) {
  const user = await exchange(token);
  if (!user) throw new Error('link expired or already used');
  return sessions.create(user);
}

module.exports = { requestLink, signInWithLink };
`,
  'src/magiclink.js': `'use strict';

const { randomBytes, createHash } = require('crypto');

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const hash = (token) => createHash('sha256').update(token).digest('hex');

// Mint a one-time token and email the sign-in link that carries it.
async function mintLink(user) {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await store.put(token, { userId: user.id, exp: Date.now() + TOKEN_TTL_MS });
  await sendEmail(user.email, \`\${BASE}/auth/magic?t=\${token}\`);
}

// Exchange a token for its user, burning it on the way through.
async function exchange(token) {
  const row = await store.get(hash(token));
  if (!row || row.exp < Date.now()) return null;
  await store.del(hash(token));
  return users.byId(row.userId);
}

module.exports = { mintLink, exchange };
`,
  'test/magiclink.test.js': `'use strict';

// Untracked on purpose — the diff shows it as an add, same as a real one.
const { mintLink, exchange } = require('../src/magiclink');

test('a token works once', async () => {
  const token = await captureEmailedToken(() => mintLink(user));
  expect(await exchange(token)).toEqual(user);
  expect(await exchange(token)).toBe(null);
});
`,
};

let repoDir = null;

function buildRepo() {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-demo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  const write = (rel, body) => {
    fs.mkdirSync(path.join(repoDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, rel), body);
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'user.name', 'Demo');
  for (const [rel, body] of Object.entries(BEFORE)) write(rel, body);
  git('add', '-A');
  git('commit', '-qm', 'password login');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

  for (const [rel, body] of Object.entries(AFTER)) write(rel, body);
  fs.unlinkSync(path.join(repoDir, 'src/password-reset.js'));
  git('add', 'src/auth.js', 'src/magiclink.js');
  git('rm', '-q', '--cached', 'src/password-reset.js');
  return base;
}

// Suggestions are the reviewer's literal replacement for the lines a comment
// covers, so they go in verbatim — bottom-up, so earlier line numbers hold.
function applySuggestions(comments) {
  const byFile = new Map();
  for (const c of comments) {
    if (c.archived || c.side !== 'new' || typeof c.suggestion !== 'string' || !c.line) continue;
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  let applied = 0;
  for (const [file, list] of byFile) {
    const abs = path.join(repoDir, file);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    for (const c of list.sort((a, b) => b.line - a.line)) {
      const end = c.endLine || c.line;
      lines.splice(c.line - 1, end - c.line + 1, ...c.suggestion.split('\n'));
      applied++;
    }
    fs.writeFileSync(abs, lines.join('\n'));
  }
  return applied;
}

// The scripted round-two fix: honour the plan's 15-minute cap and stop storing
// the raw token. Skipped where a suggestion already rewrote that line.
function fixPlantedBugs() {
  const abs = path.join(repoDir, 'src/magiclink.js');
  const before = fs.readFileSync(abs, 'utf8');
  const after = before
    .replace('const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;', 'const TOKEN_TTL_MS = 15 * 60 * 1000;')
    .replace('await store.put(token, {', 'await store.put(hash(token), {');
  if (after !== before) fs.writeFileSync(abs, after);
  return after !== before;
}

function codeBanner(url, started) {
  console.log(`
  plan-review-editor — demo, stage ${STAGES.length}: reviewing the code
  ──────────────────────────────────────────────────────────────
  A browser tab just opened:  ${url}
  ${started.files} file(s), +${started.additions} −${started.deletions}  (${started.label})
  Throwaway repo: ${repoDir}

  Try it in the browser:
    • click a line number → comment on that line
      (drag down the gutter for a range)
    • switch a comment to "Suggest" → type the exact replacement;
      this terminal applies it verbatim
    • the lifetime in src/magiclink.js is 24h, but the plan said 15 min
    • expand hidden context, mark a file "Viewed", flip Inline ⇄ Side-by-side
    • hit "Request changes"  → the agent fixes the code and re-presents;
                               changed lines are marked and your comments
                               follow the code they were about
    • "Approve" when it looks right

  This terminal is playing the agent. Press Ctrl-C to quit.
`);
}

async function codeStage() {
  const base = buildRepo();
  const started = await request('POST', '/agent/start', {
    kind: 'diff',
    spec: { cwd: repoDir, base },
  });
  const id = started.id;
  const url = BASE + started.url;
  if (!NO_OPEN) openBrowser(url);
  codeBanner(url, started);

  let fixed = false;
  await runLoop(id, {
    choices: false,
    async onSubmit(ev) {
      const n = ev.comments.length;
      console.log(`  📝 changes requested — ${n} comment(s)${ev.note ? `, note: "${ev.note}"` : ''}`);
      if (n) {
        await reply(
          id,
          ev.comments[0].id,
          "Taken — see the next round; if I read this one wrong, say so and I'll redo it."
        );
        console.log('  🤖 replied inline under your first comment');
      }
      const steps = [`Reading your ${n} comment${n === 1 ? '' : 's'}`];
      const applied = applySuggestions(ev.comments);
      if (applied) steps.push(`Applying ${applied} suggestion${applied === 1 ? '' : 's'} verbatim`);
      if (!fixed && fixPlantedBugs()) {
        steps.push('Capping the token lifetime at 15 minutes, per the plan');
        steps.push('Hashing the token before it hits the store');
        fixed = true;
      }
      steps.push('Re-reading the diff');
      for (const step of steps) {
        await progress(id, step);
        await sleep(1100);
      }
      const out = await present(id);
      await say(
        id,
        `Re-presented: ${out.files} file(s), +${out.additions} −${out.deletions}. Lines that moved since your last round are marked, and your comments moved with the code they were about. Approve when it looks right.`
      );
      console.log('  🤖 re-presented the diff (changed lines marked)');
    },
  });
}

function cleanupRepo() {
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  repoDir = null;
}

async function main() {
  await ensureServer();
  for (const stage of STAGES) {
    if (stage === 'plan') await planStage();
    else await codeStage();
  }
  console.log('\n  Demo complete — thanks for watching!\n');
}

process.on('SIGINT', () => {
  cleanupRepo();
  process.exit(130);
});

main()
  .then(cleanupRepo)
  .catch((err) => {
    cleanupRepo();
    console.error(`demo: ${err.message}`);
    process.exit(1);
  });
