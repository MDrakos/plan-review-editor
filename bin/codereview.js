#!/usr/bin/env node
'use strict';

// The agent-facing CLI for reviewing CODE — a git diff, in the browser, before
// it is pushed. Same shared server and same event loop as `planreview`; the
// difference is what is under review and which UI renders it.
//
//   codereview start                       # -> {"id":"a1b2c3","url":"…/r/a1b2c3", …}
//   codereview wait --session a1b2c3        # block until the reviewer acts
//   ... {"type":"chat"}    -> codereview say "answer" --session a1b2c3 ; wait
//   ... {"type":"submit"}  -> fix the code ; codereview present --session a1b2c3 ; wait
//   ... {"type":"approve"} -> codereview stop --session a1b2c3 ; push / open the PR
//   ... {"type":"end"}     -> codereview stop --session a1b2c3
//
// `present` takes no file: a code review's document IS the repo, so the server
// re-reads the diff. Comment threads carry across rounds, re-anchored by file +
// quoted line, and the new round marks what moved.
//
// The plumbing both front ends share lives in bin/cli-core.js.

const core = require('./cli-core');
const {
  BASE,
  request,
  ensureServer,
  handledInterrupt409,
  openBrowser,
  parseArgs,
  requireSession,
  resolveReviewerName,
  scoped,
} = core;

// What slice of the repo is under review. Nothing here talks to git — the server
// resolves it (server/gitdiff.js), which is why `cwd` must travel explicitly:
// the shared server's own working directory is wherever it happened to be
// spawned, not the repo the agent is working in.
function specFrom(opts) {
  const spec = { cwd: opts.cwd ? require('path').resolve(opts.cwd) : process.cwd() };
  if (opts.base) spec.base = opts.base;
  if (opts.range) spec.range = opts.range;
  if (opts.staged) spec.staged = true;
  if (Number.isFinite(opts.context)) spec.context = opts.context;
  return spec;
}

function summarize(out) {
  return { files: out.files, additions: out.additions, deletions: out.deletions };
}

const commands = {
  // start = begin a NEW isolated session on the current diff and open a tab.
  async start(argv) {
    const { opts } = parseArgs(argv);
    await ensureServer();
    const out = await request('POST', '/agent/start', {
      kind: 'diff',
      spec: specFrom(opts),
      reviewerName: resolveReviewerName(opts),
    });
    const url = BASE + out.url;
    if (!opts.noOpen) openBrowser(url);
    console.log(
      JSON.stringify({
        ok: true,
        id: out.id,
        url,
        version: out.version,
        title: out.title,
        label: out.label,
        ...summarize(out),
      })
    );
  },

  // present = next round in the SAME session: re-read the diff after addressing
  // the review. No file argument — the repo is the document. Flags are only
  // needed to CHANGE what is under review (e.g. after committing, to move the
  // base); otherwise the session's original spec is reused.
  async present(argv) {
    const { opts } = parseArgs(argv);
    const id = requireSession(opts, 'present');
    const respec = opts.base || opts.range || opts.staged || opts.cwd || Number.isFinite(opts.context);
    let out;
    try {
      out = await request('POST', scoped('/agent/present', id), {
        ...(respec ? { spec: specFrom(opts) } : {}),
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
    const diff = s.diff || { files: [], additions: 0, deletions: 0 };
    console.log(
      JSON.stringify({
        id,
        status: s.status,
        title: s.doc.title,
        version: s.doc.version,
        label: diff.label,
        files: (diff.files || []).length,
        additions: diff.additions,
        deletions: diff.deletions,
        comments: s.review.comments.filter((c) => !c.archived).length,
        chat: s.chat.length,
        clients: s.clients,
      })
    );
  },

  ...core.sharedCommands({ sessionPath: '/r/' }),
};

function usage() {
  console.error(`usage: codereview <command>

  start [--base <ref>] [--range a..b] [--staged] [--cwd <dir>] [--no-open]
                                     put the current diff under review and open a tab;
                                     prints {"id":…} — pass that id to every later command.
                                     Default: everything since this branch left its upstream
                                     (merge-base with origin/main) plus uncommitted work.
  present --session <id>             re-read the diff and start the next round, after
          [--base/--range/--staged]  addressing the review. No file: the repo IS the document.
                                     Pass a flag only to CHANGE what is under review.
  wait --session <id>                block until the reviewer's next event (no time limit),
       [--timeout s] [--warn-after s]  print it as JSON: chat | submit | approve | interrupt | end
  say <message> --session <id>       send a chat message to the reviewer
  reply <commentId> <message>        reply to one review comment (threaded under it);
        --session <id>               ids come from the submitted bundle's comments
  progress <message> --session <id>  report a step while addressing the review
  status --session <id>              print session status (files, +/-, open comments)
  list                               list all open sessions (code reviews and plans)
  open --session <id>                (re)open this review's tab in the browser
  stop --session <id>                end and drop the session
  restart [--force]                  reload the server's code (auto on start when the
                                     server is stale + idle; --force drops live sessions)
  update [--no-pull]                 pull latest main into this checkout, then refresh an
                                     idle server onto it (a busy server is left running)

The reviewer's verdict arrives as an event: 'submit' means fix it and \`present\` again,
'approve' means you may push. This tool never touches git remotes.

To review a PLAN (markdown) instead of code, use \`planreview\` — same server, same event
loop. The shared server (default port 4780) exits on its own once no sessions remain.`);
  process.exit(2);
}

core.run(commands, usage);
