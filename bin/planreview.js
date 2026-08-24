#!/usr/bin/env node
'use strict';

// The agent-facing CLI for reviewing a PLAN (a markdown document). Each plan
// under review is an isolated SESSION, so multiple agents can drive their own
// reviews at once without clobbering each other. `start` mints a session and
// prints its id; every later command for that review must carry it via
// `--session <id>`:
//
//   planreview start plan.md            # -> {"id":"a1b2c3","url":"…/s/a1b2c3", …}
//   planreview wait --session a1b2c3    # block until the reviewer does something
//   ... {"type":"chat"}    -> planreview say "answer" --session a1b2c3 ; wait
//   ... {"type":"submit"}  -> rework plan.md ; planreview present plan.md --session a1b2c3 ; wait
//   ... {"type":"end"}     -> planreview stop --session a1b2c3
//
// One shared server (default port 4780) holds every session — plans here, code
// diffs under `codereview`. Every command prints JSON to stdout so agents can
// parse results directly. The plumbing both front ends share lives in
// bin/cli-core.js.

const core = require('./cli-core'); // shared plumbing
const {
  BASE,
  request,
  ensureServer,
  handledInterrupt409,
  openBrowser,
  parseArgs,
  requireSession,
  resolveDoc,
  resolveReviewerName,
  scoped,
} = core;

const commands = {
  // start = begin a NEW isolated session and present the plan in a fresh tab.
  async start(argv) {
    const { opts, positionals } = parseArgs(argv);
    const file = resolveDoc(positionals[0]);
    await ensureServer();
    const out = await request('POST', '/agent/start', {
      path: file,
      reviewerName: resolveReviewerName(opts),
    });
    const url = BASE + out.url;
    if (!opts.noOpen) openBrowser(url);
    console.log(JSON.stringify({ ok: true, id: out.id, url, version: out.version, title: out.title }));
  },

  // present = next round in the SAME session (keeps chat history).
  async present(argv) {
    const { opts, positionals } = parseArgs(argv);
    const id = requireSession(opts, 'present');
    const file = resolveDoc(positionals[0]);
    let out;
    try {
      out = await request('POST', scoped('/agent/present', id), {
        path: file,
        reviewerName: resolveReviewerName(opts),
      });
    } catch (err) {
      if (handledInterrupt409(err)) return;
      throw err;
    }
    console.log(JSON.stringify({ ok: true, id, ...out }));
  },

  async status(argv) {
    const { opts } = parseArgs(argv);
    const id = requireSession(opts, 'status');
    const s = await request('GET', scoped('/api/state', id));
    console.log(
      JSON.stringify({
        id,
        status: s.status,
        title: s.doc.title,
        version: s.doc.version,
        comments: s.review.comments.length,
        chat: s.chat.length,
        clients: s.clients,
      })
    );
  },

  ...core.sharedCommands({ sessionPath: '/s/' }),
};

function usage() {
  console.error(`usage: planreview <command>

  start <file.md> [--no-open]        create an isolated session, present the plan, open a tab;
                                     prints {"id":…} — pass that id to every later command
  present <file.md> --session <id>   (re)present a plan into an existing session
  wait --session <id>                block until the reviewer's next event (no time limit),
       [--timeout s] [--warn-after s]  print it as JSON. --timeout returns {"type":"timeout"}
                                     after s seconds (for shell-capped agents that re-loop);
                                     --warn-after notes a long wait on stderr (default 300s)
  say <message> --session <id>       send a chat message to the reviewer
  reply <commentId> <message>        reply to a specific inline comment (threaded under it);
        --session <id>               the id comes from the submitted bundle's comments
  progress <message> --session <id>  report a rework step (shown live while reworking)
  status --session <id>              print session status
  list                               list all open sessions (plans and code reviews)
  open --session <id>                (re)open a session's review tab in the browser
  stop --session <id>                end and drop the session
  restart [--force]                  reload the server's code (auto on start when the
                                     server is stale + idle; --force drops live sessions)
  update [--no-pull]                 pull latest main into this checkout, then refresh an
                                     idle server onto it (a busy server is left running);
                                     run after a merge to main. --no-pull skips the git step

To review CODE (a git diff) instead of a plan, use \`codereview\` — same server, same
event loop, its own UI. The shared server (default port 4780) exits on its own once
no sessions remain.`);
  process.exit(2);
}

core.run(commands, usage);
