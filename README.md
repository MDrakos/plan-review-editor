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

- **`server/`** — a Node.js HTTP server that holds session state (document,
  comments, chat, review status), renders markdown to HTML, and bridges the
  browser and the agent. Browser ⇄ server uses JSON + server-sent events;
  agent ⇄ server uses a small localhost API.
- **`public/`** — the review UI: document pane on the left, comments and
  chat on the right.
- **`bin/planreview.js`** — the CLI the agent drives. `present` pushes a
  document; `wait` blocks until the reviewer produces an event (a chat
  message, a submitted review, or the end of the session).

## Quick start

No install, no dependencies — Node 18+ only.

```sh
# try it with the bundled sample plan
node bin/planreview.js start examples/sample-plan.md
```

Your browser opens the rendered plan. Select any text to leave a comment,
answer the storage-decision choice block, chat in the sidebar, then hit
**Submit review**. In another terminal, see what the agent would see:

```sh
node bin/planreview.js wait
# {"type":"submit","comments":[…],"choices":{…},"note":"…"}
```

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
1. Write it to plan.md and run `planreview start plan.md`.
2. Run `planreview wait` and parse the JSON event:
   - {"type":"chat"}   → reply with `planreview say "<answer>"`, wait again.
   - {"type":"submit"} → rework plan.md using every comment, choice, and
                          note, run `planreview present plan.md`, wait again.
   - {"type":"end"}    → run `planreview stop` and continue in the terminal.
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

The reviewer's selection comes back in the submit bundle as
`choices.storage`.

## Roadmap

- [x] Serve a markdown plan rendered as an HTML document
- [x] Select text to leave inline comments
- [x] Bundle comments and submit them as one review
- [x] Interactive choice blocks inside documents
- [x] Chat sidebar alongside the document
- [x] `planreview` CLI and the blocking agent event loop
- [x] Pause → rework → reload cycle in the same browser window
- [x] End-session handoff back to the terminal

Possible next steps: comment threads with agent replies, diff view between
document versions, multiple reviewers, persisting sessions to disk.
