# 016 — flow diagram the reviewer can comment on

**Status:** design, awaiting approval
**Issue:** `issues/todo/016-whiteboard-flow-diagram.md`
**Sibling:** `issues/todo/017-inline-prototypes-in-the-plan.md` (reuses the anchor field defined here)

## What this builds

The agent writes a flow as a `flow` fence in the plan. The server renders it to
inline SVG. The reviewer clicks a box or an arrow and gets the same comment composer they
get from selecting a sentence, and the resulting thread lives in the same right-hand
panel, carries forward across rework rounds, and rides back in the `submit` bundle
naming the thing it is attached to.

No new state machine, no new round trip. A diagram is another kind of block in the
document, and a node comment is another kind of comment.

## Decisions taken

The issue listed five open forks. Four are settled by the existing code and the issue's
own acceptance criteria; the fifth was the user's call.

| Fork | Decision | Why |
|---|---|---|
| Who authors the diagram | The agent, from a text fence | Round-trips the existing present/review/rework loop for free. A reviewer-editable canvas means the reviewer mutates the document, which nothing in this tool does. |
| Renderer | ~150 lines of server-side layout emitting SVG | Carry-forward needs the server to see node ids (`server/anchor.js` reads rendered HTML). Client-side Mermaid moves that out of reach, so the server would need its own fence parser regardless, leaving only layout+emit saved for a bundle an order of magnitude past the 127 KB highlight.js one, and the README's "zero runtime dependencies". |
| Comment identity | One new optional field, `anchorId` | Acceptance criterion 4 requires the bundle to identify the node. A synthesised text quote cannot satisfy that and collides on duplicate labels. |
| Version diff | Stays block-level | `renderVersionDiff` compares rendered blocks. Per-node diff marks are a separate feature with its own issue. |
| Nodes vs nodes + edges | **Both** | The arrows are where a lot of the wrongness lives. Because an edge carries the same kind of id as a node, click handling, anchoring, carry-forward and the panel card are one code path; the only extra is a transparent hit strip so a thin line is clickable. |

## The `flow` fence

A fence opened with `flow`, containing:

```
id: ratelimit
request[Incoming request] -> limiter[Token bucket]: 1 token
limiter -> store: read count
store -> limiter
limiter -> response[200 / 429]
```

Grammar, one statement per line, everything else ignored:

- `id: <slug>` — required, exactly as `choice` requires one. Namespaces this
  diagram's anchor ids so inserting a second diagram above does not rename the first
  one's nodes and archive its comments.
- `SRC -> DST` — an edge. Optional `: label` after the destination.
- `SRC` alone — declares a node with no edges.
- `name[Human label]` — a node token. `name` is the id (bare word, `[A-Za-z0-9_-]+`) and
  is what anchors survive on. The bracketed label is optional and taken from the first
  mention; without one the label is the id. Explicit ids mean two boxes both labelled
  "validate" never collide.

Anything unparseable, a missing `id:`, or no statements makes the block malformed, and it
renders as plain code, exactly as `renderChoice` already falls back
(`server/markdown.js:98-101`).

### Anchor ids

One namespace, one attribute:

- node: `ratelimit:node:limiter`
- edge: `ratelimit:edge:limiter->store`

Repeated edges between the same pair get `#2`, `#3` by order of appearance. Ceiling
accepted: reordering two parallel edges between the same pair reshuffles those two ids,
so their comments archive. Rare enough to not pay for.

## Layout and SVG

Layered top to bottom. Layer of a node is `1 + max(layer of its predecessors)` by
longest path; an edge pointing back to an equal or earlier layer is a back edge and does
not raise anything. Within a layer, nodes sit in first-appearance order, centred. Fixed
box size, fixed gaps, no physics, no routing cleverness. Forward edges are straight lines
from bottom-centre to top-centre with an arrow marker; back edges are a bezier bowed out
to the right so they are visibly distinct.

Each node and each edge is a `<g>` carrying the anchor id on a **generic** attribute:

```html
<div class="flow-block">
  <svg class="flow-svg" viewBox="0 0 W H" role="img" aria-label="Flow diagram">
    <g class="flow-edge" data-anchor-id="ratelimit:edge:limiter-&gt;store" tabindex="0" aria-label="edge limiter to store">
      <path class="flow-hit" d="…"/>
      <path class="flow-line" d="…" marker-end="url(#flow-arrow)"/>
      <text class="flow-edge-label">read count</text>
    </g>
    <g class="flow-node" data-anchor-id="ratelimit:node:limiter" tabindex="0" aria-label="Token bucket">
      <rect/><text>Token bucket</text>
    </g>
  </svg>
</div>
```

`data-anchor-id` rather than the issue's sketched `data-node` / `data-edge`: one attribute
carries the anchor key directly, keeps `server/anchor.js` from knowing anything about
diagrams, and is the attribute 017's prototype shim reuses for elements.

The whole diagram is one rendered block, so `markChanges` and `renderVersionDiff` treat a
diagram edit as one changed block with no changes to either.

## Anchoring model

The comment record grows one optional field:

```
{ id, quote, text, ts, author, anchorId?, replies?, archived? }
```

- `anchorId` absent → a prose comment. Anchored by `quote`, unchanged from today.
- `anchorId` present → anchored to that node or edge. `quote` still carries the element's
  visible label so the panel card and the agent's bundle read naturally, but it is **not**
  consulted for anchoring.

**Server carry-forward** (`server/server.js:482`) becomes:

```js
archived: c.anchorId ? !idAnchors(c.anchorId, html) : !quoteAnchors(c.quote, html)
```

`idAnchors` joins `quoteAnchors` in `server/anchor.js` and is a substring test for
`data-anchor-id="<escaped id>"` in the rendered HTML. Same philosophy as the existing
function: read what the browser will see, do not build a second parser.

**Browser** (`public/app.js`): after `renderDoc` sets `innerHTML`, each comment with an
`anchorId` finds its `[data-anchor-id="…"]` and adds a `flow-commented` class instead of
calling `highlightRange`. `anchorByQuote` is untouched.

**Composer**: a click (or Enter on a focused `<g>`) on any `[data-anchor-id]` inside the
document opens the existing composer with `pendingAnchorId` set and `pendingQuote` set to
the element's label. `saveComment` accepts `pendingRange || pendingAnchorId` and skips
`highlightRange` in the second case. The text-selection path is untouched.

## Protocol

`docs/PROTOCOL.md` gains `comments[].anchorId`: present when the comment is attached to a
diagram node or edge rather than a passage; the value is `<fenceId>:node:<id>` or
`<fenceId>:edge:<src>-><dst>`, matching a statement in the corresponding `flow` fence
so the agent can find what is being talked about. `quote` still holds the element's label.
Absent for every prose comment, so existing agent integrations are unaffected.

## Error handling

- Malformed or empty fence, missing `id:`, duplicate `id:` across fences, a node id that
  is not a bare word, an edge to an undeclared node (it is declared implicitly), a cycle:
  none of these throw. A malformed fence degrades to code; a cycle just stops raising
  layers.
- A reserved id (`__proto__`) is rejected the same way `parseChoiceSpecs` already rejects
  it.
- Labels and ids are escaped through `escapeHtml` on the way into the SVG. Nothing in a
  fence reaches the page unescaped.
- An `anchorId` on an incoming comment that matches nothing in the current render archives
  the comment. It is never dropped, matching today's behaviour for a stale quote.

## Testing

- **`server/markdown.js` self-check** (`require.main === module`, the pattern
  `server/gitdiff.js` and `server/diffanchor.js` already use, added to
  `npm run selfcheck`): fence parsing, id generation, layering including a cycle and a
  back edge, malformed fallback to code, escaping.
- **`server/anchor.js`**: `idAnchors` finds a present id, misses an absent one, and is not
  fooled by a prefix (`…:node:store` must not match `…:node:store2`).
- **`test/e2e.js`** (drives the real server over HTTP): present a doc with a flow fence and
  assert the SVG and its `data-anchor-id`s are in the served HTML; post a node comment and
  an edge comment; re-present a doc keeping that node and assert the thread is active;
  re-present without it and assert `archived: true` rather than gone; assert the `submit`
  bundle carries `anchorId`; assert a doc with no flow fence renders byte-identically to
  today.

## Out of scope

Reviewer-editable diagrams, per-node version diffs, edge routing that avoids overlaps,
sub-graphs or swimlanes, and any second fence type. 017's prototype fence reuses
`anchorId` and `data-anchor-id` but is not built here.

## Files touched

- `server/markdown.js` — `flow` in the `renderFence` dispatch, plus the parser, layout and
  SVG emitter.
- `server/anchor.js` — `idAnchors`.
- `server/server.js` — one line in the carry-forward.
- `public/app.js` — click/Enter on `[data-anchor-id]`, `pendingAnchorId` in the composer,
  `anchorId` in the saved comment, class-based re-anchor in `renderDoc`.
- `public/style.css` — node, edge, hit-strip, focus and commented styles.
- `docs/PROTOCOL.md` — `anchorId`.
- `test/e2e.js`, `package.json` (`selfcheck`).
