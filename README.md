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

## Roadmap

- [ ] Serve a markdown plan rendered as an HTML document
- [ ] Select text to leave inline comments
- [ ] Bundle comments and submit them as one review
- [ ] Interactive choice blocks inside documents
- [ ] Chat sidebar alongside the document
- [ ] `planreview` CLI and the blocking agent event loop
- [ ] Pause → rework → reload cycle in the same browser window
- [ ] End-session handoff back to the terminal
