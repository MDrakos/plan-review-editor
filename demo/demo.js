#!/usr/bin/env node
'use strict';

// Self-driving demo of plan-review-editor. Plays a scripted stand-in "agent" so
// you can see the whole review loop without a real Claude Code session:
//
//   npm run demo        (or: node demo/demo.js)
//
// It presents a sample plan, opens your browser, and as you interact it replies
// to your chats, shows live rework progress, re-presents a revised version with
// the changes highlighted, and remembers the questions you already answered.
//
// Runs on a dedicated port (4781) so it never collides with a real session.

const http = require('http');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PLANREVIEW_PORT || 4781);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const V1 = path.join(__dirname, 'plan.md');
const V2 = path.join(__dirname, 'plan.v2.md');
const NO_OPEN = process.argv.includes('--no-open') || !!process.env.PLANREVIEW_NO_OPEN;

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
const progress = (id, text) => request('POST', `/agent/progress?session=${id}`, { text });
const present = (id, file) => request('POST', `/agent/present?session=${id}`, { path: file });

function banner(url) {
  console.log(`
  plan-review-editor — demo
  ─────────────────────────
  A browser tab just opened:  ${url}

  Try it in the browser:
    • select any text in the plan  → leave an inline comment
    • answer the two questions      (try the "Other" free-text box)
    • chat in the sidebar           → this terminal replies
    • hit "Submit review"           → watch the plan get reworked,
                                      with the changes highlighted
    • the ▾ next to Submit          → "Approve & finish" to wrap up

  This terminal is playing the agent. Press Ctrl-C to quit.
`);
}

function replyTo(text) {
  const t = text.length > 60 ? text.slice(0, 57) + '…' : text;
  return `Noted: "${t}". A real agent would dig in and act on this — for the demo I'll fold it into the next revision. Ask me anything, or submit your review when ready.`;
}

function printSummary(ev) {
  console.log(`\n  ✅ ${ev.type === 'approve' ? 'Approved & finished' : 'Session ended'}. Final decisions:`);
  const choices = ev.choices || {};
  const keys = Object.keys(choices);
  if (keys.length) {
    for (const k of keys) {
      const v = choices[k];
      console.log(`     • ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
  } else {
    console.log('     (no questions answered)');
  }
  if (ev.note) console.log(`     note: ${ev.note}`);
  if (ev.comments && ev.comments.length) console.log(`     ${ev.comments.length} comment(s) received`);
}

async function main() {
  await ensureServer();
  const started = await request('POST', '/agent/start', { path: V1 });
  const id = started.id;
  const url = BASE + started.url;
  if (!NO_OPEN) openBrowser(url);
  banner(url);

  let reworked = false;
  for (;;) {
    let ev;
    try {
      ev = await request('GET', `/agent/wait?session=${id}&timeout=50000`);
    } catch (err) {
      if (/no such session/i.test(err.message)) break; // session gone — stop
      await sleep(500);
      continue;
    }

    if (ev.type === 'timeout') continue;

    if (ev.type === 'chat') {
      console.log(`  💬 you: ${ev.text}`);
      await sleep(600);
      await say(id, replyTo(ev.text));
      console.log('  🤖 replied in the sidebar');
      continue;
    }

    if (ev.type === 'submit') {
      const n = ev.comments.length;
      console.log(`  📝 review submitted — ${n} comment(s)${ev.note ? `, note: "${ev.note}"` : ''}`);
      if (!reworked) {
        const steps = [
          `Reading your ${n} comment${n === 1 ? '' : 's'} and choices`,
          'Revising the context and deferring passkeys to v1.1',
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
          "Reworked and re-presented. Changed blocks are highlighted; the questions you already answered are collapsed (hit Change to revisit). There's one new question — answer it and Approve when you're happy."
        );
        console.log('  🤖 presented the revised plan (changes highlighted)');
      } else {
        await say(id, 'No further changes queued — use the ▾ → "Approve & finish" when you\'re ready.');
        console.log('  🤖 nudged toward Approve & finish');
      }
      continue;
    }

    if (ev.type === 'approve' || ev.type === 'end') {
      printSummary(ev);
      await request('POST', `/agent/stop?session=${id}`).catch(() => {});
      console.log('\n  Demo complete — thanks for watching!\n');
      break;
    }
  }
}

main().catch((err) => {
  console.error(`demo: ${err.message}`);
  process.exit(1);
});
