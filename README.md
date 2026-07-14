# Plan Review Editor

A local, browser-based review surface for AI agent plans.

Terminal agents (like Claude Code) present plans as walls of text in the
terminal. Reviewing them there is lossy: you can't point at a sentence, you
can't leave a note in place, and structured decisions get flattened into
"type 1, 2, or 3". This project replaces that step with a real document
review loop in the browser.

## How a session works

```
┌──────────────┐   present    ┌─────────────────────────────┐
│ terminal      │ ───────────▶ │ browser                     │
│ agent         │              │  · rendered plan document   │
│ (Claude Code) │              │  · select text → comment    │
│               │              │  · choice blocks            │
│               │   feedback   │  · chat sidebar             │
│               │ ◀─────────── │  · Submit review            │
└──────────────┘              └─────────────────────────────┘
        │  rework the plan with the feedback, present again…
        ▼
   repeat until the reviewer ends the session,
   then control returns to the terminal.
```

1. The agent starts a local server and presents a plan (markdown).
2. The plan renders as an HTML document in your browser.
3. You select text and leave inline comments, answer any choice blocks the
   plan embeds, and can chat with the agent in a sidebar about anything —
   related to the document or not.
4. **Submit review** bundles every comment, choice, and note and hands it to
   the agent. The session pauses while the agent reworks the plan.
5. The reworked document loads into the same browser window and the cycle
   continues.
6. **End session** hands control back to the terminal agent.

## Architecture

Three pieces, zero runtime dependencies:

- **`server/`** — one Node.js HTTP server hosting **many isolated sessions**,
  each keyed by a short id (its own document, comments, chat, review status,
  and browser tab). It renders markdown to HTML and bridges browser and agent.
  Browser ⇄ server uses JSON + server-sent events; agent ⇄ server uses a small
  localhost API. Because sessions share nothing, several agents can run reviews
  at once without cross-contamination. Each session's state is **written through
  to disk** (`.sessions/<id>.json`, atomically + debounced), so a crash, reboot,
  or the server's own idle/stale-code restart doesn't lose an open review — it's
  restored on startup and the browser reconnects. Set `PLANREVIEW_PERSIST=0` to
  disable, or `PLANREVIEW_STATE_DIR` to relocate the files (default: `.sessions/`
  in the working directory, gitignored).
- **`public/`** — the review UI (document pane left, comments + chat right),
  served at `/s/<id>`; `/` is an index of every open session.
- **`bin/planreview.js`** — the CLI the agent drives. `start` mints a session
  and prints its `id`; every later command carries `--session <id>`. `present`
  pushes a revised document; `wait` blocks until the reviewer produces an event
  (a chat message, a submitted review, an approval, or the end of the session).
  `start`/`present` also seed the reviewer's display name (from `--reviewer-name`,
  `$PLANREVIEW_REVIEWER_NAME`, or `git config user.name`) so a fresh browser tab
  isn't prompted for it.
  `start` also restarts the shared server if it is running stale code and idle
  (so tool edits take effect); `planreview restart --force` does it on demand.
  After a merge to `main`, `planreview update` pulls the latest into this
  checkout (the one the `planreview` command runs from) and refreshes an idle
  server onto it — a server with live sessions is left running and picks the
  change up on its next idle restart.

## Demo

Want to see the whole loop without wiring up a real agent?

```sh
npm run demo
```

A scripted stand-in "agent" presents a sample plan, opens your browser, and as
you review it replies to your chats, shows live rework progress, re-presents a
revised version with the changes highlighted, and remembers the questions you
already answered. Runs on its own port (4781), so it never touches a real
session. (Great to screen-record for a walkthrough.)

## Quick start

No install, no dependencies — Node 18+ only.

```sh
# try it with the bundled sample plan
node bin/planreview.js start examples/sample-plan.md
# -> {"id":"a1b2c3","url":"http://127.0.0.1:4780/s/a1b2c3", …}
```

Your browser opens the rendered plan in its own tab. Select any text to leave
a comment, answer the storage-decision choice block, chat in the sidebar, then
hit **Submit review**. In another terminal, see what the agent would see —
passing the session `id` that `start` printed:

```sh
node bin/planreview.js wait --session a1b2c3
# {"type":"submit","comments":[…],"choices":{…},"note":"…"}
```

Every session is isolated, so a second `start` opens a separate plan in its
own tab without touching the first. Visit `http://127.0.0.1:4780/` to see all
open sessions.

### Install the `planreview` command

Optional, but it lets you (and any agent) run `planreview` from anywhere
instead of the full `node …/bin/planreview.js` path. Symlink the bin onto a
directory that is on your `PATH`:

```sh
ln -s "$(pwd)/bin/planreview.js" ~/.local/bin/planreview
```

The symlink points at the repo, so tool edits take effect with no reinstall.
(`bin/planreview.js` is already executable and has a `#!/usr/bin/env node`
shebang.) Prefer this over `npm link` / `npm install -g` if your Node lives in
a managed cache dir that could be wiped.

### Automatic invocation from Claude Code

`integration/claude/plan-review/` is a ready-made Claude Code skill. Symlink
it into your personal skills directory and every session can trigger it on
its own whenever it is about to present a plan, options, or a wall of text:

```sh
ln -s "$(pwd)/integration/claude/plan-review" ~/.claude/skills/plan-review
```

To make it non-negotiable rather than model-judged, also add one line to
`~/.claude/CLAUDE.md`:

```
Whenever you are about to present a plan, a set of options, or a long text
document for my review in an interactive session, do not print it to the
terminal — use the plan-review skill and follow its event loop until I end
the session.
```

### Driving it from any other agent

Tell your terminal agent (e.g. in `CLAUDE.md`) to present plans through the
review loop instead of printing them:

```
When you have a plan for the user to review, do not print it. Instead:
1. Write it to plan.md, run `planreview start plan.md`, and capture the
   session id it prints (call it ID below).
2. Run `planreview wait --session ID` and parse the JSON event:
   - {"type":"chat"}   → reply with `planreview say "<answer>" --session ID`,
                          wait again.
   - {"type":"submit"} → rework plan.md using every comment, choice, and note,
                          run `planreview present plan.md --session ID`, wait again.
                          To answer one comment in place (vs the global chat), run
                          `planreview reply <commentId> "<answer>" --session ID`.
   - {"type":"end"}    → run `planreview stop --session ID` and continue.
```

The full event and endpoint reference lives in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

### Choice blocks

Plans can embed decisions that render as clickable options:

````markdown
```choice
id: storage
prompt: Where should limiter state live?
options:
  - Redis
  - In-process
```
````

Each choice comes back in the submit bundle as `choices.storage.picks[reviewerId]`
— a per-reviewer map, so when several reviewers pick differently every pick is
present and the conflict is surfaced rather than overwritten. With one reviewer the
map simply has a single entry.

When reviewers diverge, any of them can **resolve** the block to one shared option
(with an optional reason). The resolution is attributed and reversible: the block
shows "Resolved to \<option\> — by \<name\>" (colored by reviewer) with change/clear
controls, and it syncs live to every tab. A resolution persists until it is
explicitly changed or cleared — changing your own pick never silently undoes it. A
resolved choice travels in the bundle as `choices.storage.resolved` (`{option, by,
byName, reason}`) alongside the raw `picks`, so the agent sees the agreed decision
**and** the underlying split. The resolve control appears only on divergence, so
single-reviewer and all-agree blocks are unchanged.

### Comparing versions

Every rework round is a new version. Above the document, a **Compare** control
lets the reviewer diff any two retained versions and see an annotated single
view with **added, changed, and removed** blocks marked — so deletions between
versions are visible, not just what's new. Each session keeps the last **10**
versions' markdown source (a bounded ring; older versions age out and can no
longer be compared). This is separate from — and doesn't disturb — the
dismissible "what changed since your last review" highlight on each new round.

## Roadmap

- [x] Serve a markdown plan rendered as an HTML document
- [x] Select text to leave inline comments
- [x] Bundle comments and submit them as one review
- [x] Interactive choice blocks inside documents
- [x] Chat sidebar alongside the document
- [x] `planreview` CLI and the blocking agent event loop
- [x] Pause → rework → reload cycle in the same browser window
- [x] End-session handoff back to the terminal
- [x] Concurrent isolated sessions — many agents at once, one tab each
- [x] Diff view between document versions — add/remove/change markers, incl. removals
- [x] Persist sessions to disk so they survive a server restart
- [x] Comment threads with agent replies
- [x] Multiple reviewers on one plan — attribution, live sync, per-reviewer choices
- [x] Presence indicators — a live top-bar strip of who's viewing now, colored by reviewer, with a per-reviewer tab count
- [x] Richer choice-conflict resolution — resolve a divergent choice to one attributed, optionally-reasoned shared decision that travels to the agent alongside the raw picks
