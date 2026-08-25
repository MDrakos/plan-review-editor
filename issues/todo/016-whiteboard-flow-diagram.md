# 016 — a whiteboard flow diagram the reviewer can comment on

**Type:** feature (needs a brainstorming pass before implementing)
**Status:** open
**Area:** `server/markdown.js` (new fence + SVG render), `server/anchor.js` + `server/server.js`
(comment carry-forward), `public/app.js` (node selection, comment anchoring), `public/style.css`

## Problem

A plan explains a flow in prose, and prose is the wrong shape for a flow. The reviewer
has to hold "request → limiter → store → response" in their head while reading four
paragraphs that describe it, and the disagreements that matter — *that arrow is
backwards*, *nothing writes to the store here*, *this step is missing* — have no place to
land. Today the only way to point at a step is to select the sentence that mentions it
(`public/app.js:1703`, `anchorByQuote`), so a comment about a *box* is attached to a
*sentence*, and it survives the next round only if the agent happens to keep that
sentence's wording (`server/server.js:478-481`).

There is no diagram support at all today: no `mermaid`, no SVG, no canvas anywhere in
`server/` or `public/`. A plan that wants a picture draws it in an ASCII code fence, which
renders as inert `<pre>` (`server/markdown.js:28-31`) — uncommentable except as text, and
invisible to the version diff as anything but a changed block.

## What this adds

The agent presents the flow as a **diagram in the plan document**, and the reviewer
comments **on a node or an edge** the same way they comment on a sentence — a thread in
the right-hand panel, carried forward across rounds, bundled into `submit`.

This is a *whiteboard* in the sense of "the shared picture everyone argues over", not a
freehand drawing tool: the diagram has a text source the agent authors and reworks, so it
round-trips the existing present → review → rework loop with no new state machine.

## Sketch of the smallest version

1. **A `flow` fence.** `renderFence` already dispatches on language and `choice` is the
   precedent for a fence that renders to interactive HTML rather than code
   (`server/markdown.js:28,97`). A malformed block falls back to plain code, as `choice`
   does.

   ````markdown
   ```flow
   request -> limiter: token bucket
   limiter -> store: read count
   store -> limiter
   limiter -> response: 200 / 429
   ```
   ````

2. **Rendered server-side to SVG**, one `<g data-node="limiter">` per box and
   `<g data-edge="limiter->store">` per arrow. Layered top-to-bottom; no physics, no
   routing cleverness.

3. **Click a node or an edge → the existing comment composer**, with `nodeId` recorded on
   the comment alongside the quote it already carries.

4. **Carry-forward keys on the node id**, not the text: a comment stays anchored while its
   node still exists in the reworked diagram, and archives when the agent deletes that box
   — the same active/archived split as today (`server/server.js:478-485`,
   `server/anchor.js`).

## Design decisions to settle first

- **Who draws it.** Agent-authored from a text fence (above — round-trips the existing
  loop for free) vs. reviewer-editable on the canvas (a second, opposite direction of
  edit: the reviewer would be mutating the document, which nothing in the tool does today).
- **Renderer.** A ~100-line layered layout emitting SVG from `server/markdown.js`, or
  vendor Mermaid into `public/vendor/` next to highlight.js. The vendored bundle is the
  faster path to a pretty diagram; it is also an order of magnitude larger than the 127 KB
  highlight.js bundle, moves rendering into the browser (so `server/anchor.js` can no
  longer see node ids without parsing the fence itself), and dents the README's
  "zero runtime dependencies".
- **Comment identity.** A node-anchored comment has no text quote. Either the comment
  model grows an anchor *kind* (`quote` | `node`), or a node comment synthesises a quote
  from the node's label and keeps one anchoring path. The second is smaller and lossier —
  two boxes labelled "validate" collide.
- **Version diff.** `renderVersionDiff` (`server/markdown.js:393`) compares rendered
  blocks, so any diagram edit shows as one wholly-changed block. Good enough, or does a
  changed flow deserve per-node changed/added/removed marks?
- **Anchor kind.** A node-anchored comment is the same shape of problem
  `issues/todo/017-inline-prototypes-in-the-plan.md` has for prototype elements. Whichever
  ships first should introduce the anchor kind (`quote` | `id`) and the other reuse it.
- **Scope of "comment on an edge".** Nodes only is materially less work; the arrows are
  where a lot of the wrongness actually lives.

## Acceptance criteria

- A ```` ```flow ```` fence in a presented plan renders as a diagram, not as code.
- Clicking a node opens the comment composer and the resulting thread shows in the panel,
  visibly attached to that node.
- The thread survives a re-present that keeps the node, and archives (never disappears)
  when the node is removed.
- Node-anchored comments arrive in the `submit` bundle identifying their node.
- A malformed `flow` fence renders as plain code and breaks nothing.
- A plan with no `flow` fence behaves exactly as it does today.

## Code pointers

- `server/markdown.js:28-31` — `renderFence` dispatch (where `flow` would hook in).
- `server/markdown.js:97-119` — `renderChoice`, the precedent for an interactive fence.
- `server/markdown.js:66-95` — `parseChoiceSpecs`, the precedent for the server re-parsing
  a fence to validate reviewer input against it.
- `server/markdown.js:290,393` — `renderDiff` / `renderVersionDiff`, block-level.
- `server/anchor.js` — server-side anchoring, text-only today.
- `server/server.js:478-485` — comment carry-forward / archiving on re-present.
- `public/app.js:1121` — the comment record (`{ id, quote, text, ts, author }`).
- `public/app.js:1703` — `anchorByQuote`, the browser-side re-anchor.
- `public/index.html:10,139` + `public/vendor/README.md` — the vendoring precedent.
- `issues/todo/017-inline-prototypes-in-the-plan.md` — the shared non-text anchor decision.
