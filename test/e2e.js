#!/usr/bin/env node
'use strict';

// End-to-end test of a full review session, driven exactly the way an agent
// drives it (through the CLI) with the browser side simulated over HTTP.
//
// Covers the stale-session regression: a reviewer who clicks "End session"
// in an abandoned session leaves an unconsumed `end` event on the server;
// the next agent's first `wait` must NOT receive it and declare the new
// session over.
//
// Run: node test/e2e.js   (uses port 4799 so it never clashes with a real session)

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = path.join(__dirname, '..', 'bin', 'planreview.js');
const env = { ...process.env, PLANREVIEW_PORT: String(PORT) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { env }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim() ? JSON.parse(stdout.trim()) : {});
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
  return res.json();
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.error(` FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// simulate a review tab's SSE connection
async function openEventStream() {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/events`, { signal: controller.signal });
  const chunks = [];
  const reader = res.body.getReader();
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value).toString());
      }
    } catch {
      /* aborted */
    }
  })();
  return { text: () => chunks.join(''), close: () => controller.abort() };
}

async function main() {
  const doc = path.join(os.tmpdir(), 'planreview-e2e.md');
  fs.writeFileSync(
    doc,
    '# E2E plan\n\nBody paragraph.\n\n```choice\nid: pick\nprompt: Which one?\noptions:\n  - A\n  - B\n```\n'
  );

  console.log('regression: abandoned session must not leak into the next one');
  await cli('start', doc, '--no-open');
  await browser('/api/end', {}); // reviewer ends it; no agent ever consumes the event
  // session abandoned, server still running — a new agent session begins:
  const started = await cli('start', doc, '--no-open');
  check('start reuses the live server and presents', started.ok === true && started.version >= 1);
  const first = await cli('wait', '--timeout', '2');
  check('first wait sees no stale end event', first.type === 'timeout', `got ${JSON.stringify(first)}`);
  const st = await cli('status');
  check(
    'fresh session: reviewing, empty chat',
    st.status === 'reviewing' && st.chat === 0,
    JSON.stringify(st)
  );

  console.log('full cycle: chat -> submit -> rework -> end');
  const waitChat = cli('wait', '--timeout', '10');
  await sleep(300);
  await browser('/api/chat', { text: 'why option B?' });
  const chatEv = await waitChat;
  check('chat event delivered to wait', chatEv.type === 'chat' && chatEv.text === 'why option B?');
  await cli('say', 'Because of X.');

  const waitSubmit = cli('wait', '--timeout', '10');
  await sleep(300);
  await browser('/api/submit', {
    comments: [{ id: 'c1', quote: 'Body paragraph.', text: 'expand this' }],
    choices: { pick: 'B' },
    note: 'almost there',
  });
  const subEv = await waitSubmit;
  check(
    'submit bundle delivered with comments, choices, note',
    subEv.type === 'submit' &&
      subEv.comments.length === 1 &&
      subEv.comments[0].quote === 'Body paragraph.' &&
      subEv.choices.pick === 'B' &&
      subEv.note === 'almost there'
  );
  const stWorking = await cli('status');
  check('session paused while agent reworks', stWorking.status === 'working');

  fs.appendFileSync(doc, '\n## Revisions\n\nExpanded the body paragraph.\n');
  const rep = await cli('present', doc);
  check('re-present bumps the doc version', rep.version === started.version + 1);
  const s2 = await browser('/api/state');
  check(
    'rework starts a fresh round: review cleared, chat kept',
    s2.status === 'reviewing' && s2.review.comments.length === 0 && s2.chat.length === 2
  );

  const waitEnd = cli('wait', '--timeout', '10');
  await sleep(300);
  await browser('/api/end', {});
  const endEv = await waitEnd;
  check('end event delivered to wait', endEv.type === 'end');
  await cli('stop');
  await sleep(400);
  const alive = await fetch(`${BASE}/api/state`).then(() => true).catch(() => false);
  check('server shut down after stop', !alive);

  console.log('stale tab: a connected tab is pulled into the next session');
  await cli('start', doc, '--no-open');
  const tab = await openEventStream();
  await sleep(300);
  const sTab = await browser('/api/state');
  check('server reports the connected tab', sTab.clients === 1, `clients=${sTab.clients}`);
  await browser('/api/end', {}); // reviewer ends; the tab now shows "session ended"
  // a new agent session begins on the same server while the tab stays open:
  await cli('start', doc, '--no-open');
  await sleep(300);
  const frames = tab.text();
  check(
    'tab receives the reset and the new document',
    frames.includes('"status":"idle"') && frames.includes('event: doc'),
    `frames: ${frames.replace(/\n/g, ' ').slice(-200)}`
  );
  tab.close();
  await cli('stop');
}

main()
  .catch((err) => {
    failures++;
    console.error(` FAIL  e2e crashed — ${err.message}`);
  })
  .then(async () => {
    // best-effort cleanup if a check bailed early
    await fetch(`${BASE}/agent/stop`, { method: 'POST' }).catch(() => {});
    console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
