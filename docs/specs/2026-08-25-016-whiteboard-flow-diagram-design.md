# 016 — flow diagram the reviewer can comment on

**Status:** approved 2026-08-25, prototype built and reviewed
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
| Renderer | ~190 lines of server-side layout emitting SVG | Carry-forward needs the server to see node ids (`server/anchor.js` reads rendered HTML). Client-side Mermaid moves that out of reach, so the server would need its own fence parser regardless, leaving only layout+emit saved for a bundle an order of magnitude past the 127 KB highlight.js one, and the README's "zero runtime dependencies". |
| Comment identity | One new optional field, `anchors`, a list of ids | Acceptance criterion 4 requires the bundle to identify the node. A synthesised text quote cannot satisfy that and collides on duplicate labels. A list rather than a single id because a comment can be about a group (see **Box-select**); a single-item comment is a list of one, so there is one code path, not two. |
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
box size, fixed gaps, no physics.

Edge routing has exactly one rule, which the prototype forced. An edge between **adjacent
layers** drops from bottom-centre to top-centre as a bezier. Anything else, a back edge or
a forward edge spanning more than one layer, would cut straight through the boxes in
between, so it bows out past the side of the whole diagram (whichever side its endpoints
sit nearer) and its label rides on the bow. Back edges are additionally dashed and greyed
so a return arrow reads as one.

The `viewBox` is computed from the boxes **and** the bow extents, with a negative `minX`
when a bow goes left. Sizing off the boxes alone silently clips a bowed edge and its
label, which is what the first prototype did.

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

## Pan and zoom

A diagram bigger than a paragraph is unreadable pinned at one scale, so each diagram is a
viewport, not a picture. Everything drawable sits in a single `<g class="flow-pan">` and
the whole interaction is one `transform` on it: `translate(tx ty) scale(s)`.

- **Drag** anywhere in the frame pans. A drag that moves more than 4px sets a `moved` flag,
  and a capture-phase `click` listener swallows the click that follows, so releasing a pan
  on top of a box does not also open the composer.
- **`setPointerCapture` is taken only once a drag is confirmed, never on `pointerdown`.**
  While capture is held, the browser retargets the subsequent `click` to the capturing
  `<svg>`, so `closest('[data-anchor-id]')` finds nothing and clicking a box silently stops
  opening the composer. This shipped broken in the first prototype pass and is the single
  easiest thing to get wrong here.
- **Cmd/Ctrl + scroll** zooms about the cursor, clamped to 0.4x–5x. A **plain wheel is left
  alone** so the page still scrolls normally, and a trackpad pinch arrives as a `ctrlKey`
  wheel event, so pinch-to-zoom works with no extra code.
- **Double-click**, the **Fit** button, or **0** resets. `+` / `-` and the two buttons step
  by 1.25x about the frame centre. The button cluster and a one-line gesture hint fade in
  on hover.
- Screen-to-user coordinates come from `svg.getScreenCTM()`, never from a width ratio. The
  SVG is wider than its `viewBox` and letterboxes its content, so a ratio silently
  mis-maps the cursor and the diagram drifts as you zoom.
- The frame is the diagram's natural height with a 240px floor, full document width, and
  clips. At 1x a diagram looks exactly as it would with no pan/zoom at all.

View state is per-diagram, in-memory, and **resets on re-present**. Persisting a pan across
a rework round would leave the reviewer looking at empty space where a deleted box used to
be. Touch pinch on a real touchscreen (two live pointers) is not handled; trackpad and
mouse are.

## Box-select

A reviewer's objection is often about a *region* of the flow ("these two are really one
step"), not one box, so a comment can anchor to several items at once.

- A **Box** toggle sits in the control cluster; while it is on, a drag draws a marquee
  instead of panning and the cursor is a crosshair. **Shift+drag** does the same in either
  mode, for people who know the shortcut. The visible toggle is what makes the feature
  findable, and a hidden modifier alone is not enough.
- An item is in the selection when its **bounding-box centre** is inside the marquee, for
  nodes and edges alike. Plain rectangle overlap over-selects wildly: a long bowed edge has
  a bounding box spanning most of the diagram.
- Selection updates live as the marquee is dragged. On release the composer opens against
  the whole group, labelled from the members (`Redis counter, 200 / 429`, or
  `A, B and 4 more` past three).
- A click with the toggle on, or a shift+click, selects the single item under the pointer
  via `elementFromPoint` rather than the click target, which keeps it immune to the capture
  retarget above.

## Anchoring model

The comment record grows one optional field:

```
{ id, quote, text, ts, author, anchors?, replies?, archived? }
```

- `anchors` absent → a prose comment. Anchored by `quote`, unchanged from today.
- `anchors` present → a non-empty list of node/edge ids. One id for a single item, several
  for a box-selected group. `quote` still carries the members' visible labels so the panel
  card and the agent's bundle read naturally, but it is **not** consulted for anchoring.

**Server carry-forward** (`server/server.js:482`) becomes:

```js
archived: c.anchors ? !c.anchors.some((a) => idAnchors(a, html)) : !quoteAnchors(c.quote, html)
```

A group comment survives while **any** member survives, and archives only when the agent
has removed all of them. Archiving a group the moment one box is deleted would throw away a
thread that is still mostly about things that still exist.

`idAnchors` joins `quoteAnchors` in `server/anchor.js` and is a substring test for
`data-anchor-id="<escaped id>"` in the rendered HTML. Same philosophy as the existing
function: read what the browser will see, do not build a second parser.

**Browser** (`public/app.js`): after `renderDoc` sets `innerHTML`, each comment with
`anchors` finds every `[data-anchor-id="…"]` it names and adds a `flow-commented` class
instead of calling `highlightRange`. `anchorByQuote` is untouched.

**Composer**: a click (or Enter on a focused `<g>`, or a completed box-select) opens the
existing composer with `pendingAnchors` set and `pendingQuote` set to the members' labels.
`saveComment` accepts `pendingRange || pendingAnchors` and skips `highlightRange` in the
second case. The text-selection path is untouched.

## Protocol

`docs/PROTOCOL.md` gains `comments[].anchors`: present when the comment is attached to
diagram nodes or edges rather than a passage. It is a non-empty array of
`<fenceId>:node:<id>` / `<fenceId>:edge:<src>-><dst>` values, each matching a statement in
the corresponding `flow` fence so the agent can find what is being talked about. More than
one entry means the reviewer box-selected a group and the comment is about all of them
together. `quote` still holds the members' labels. Absent for every prose comment, so
existing agent integrations are unaffected.

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
- **Pan/zoom/box-select** (in the `public/app.js` vm harness, the pattern `test/reviewvm.js`
  established): zoom about a point leaves that point fixed; a plain wheel changes nothing;
  a drag past the threshold suppresses exactly one following click and a clean click still
  opens the composer; **a `pointerdown` must not capture the pointer**, asserted directly,
  because that regression is invisible except by clicking; reset returns to identity; a
  marquee selects by centre and not by overlap (assert a long bowed edge whose bounding box
  covers the marquee is *not* selected); a group comment carries every member in `anchors`.
- **`test/e2e.js`** (drives the real server over HTTP): present a doc with a flow fence and
  assert the SVG and its `data-anchor-id`s are in the served HTML; post a node comment and
  an edge comment; re-present a doc keeping that node and assert the thread is active;
  re-present without it and assert `archived: true` rather than gone; assert the `submit`
  bundle carries `anchorId`; assert a doc with no flow fence renders byte-identically to
  today.

## Out of scope

Reviewer-editable diagrams, per-node version diffs, persisted view state, two-finger
touchscreen pinch, edge routing that avoids overlaps,
sub-graphs or swimlanes, and any second fence type. 017's prototype fence reuses
`anchorId` and `data-anchor-id` but is not built here.

## Prototype

Built before implementation at the reviewer's request: the real parser, layer assignment
and SVG emitter, wired to a mock comment panel. It confirmed the layout is legible without
a layout library, and caught two defects that are now folded into **Layout and SVG** above:
multi-layer edges cutting through intervening boxes, and a `viewBox` sized off the boxes
alone clipping a bowed edge's label. Reviewing it also added the **Pan and zoom**
requirement above, which in turn caught a third defect: mapping the cursor by width ratio
instead of by the element's CTM makes the diagram drift under the pointer as it zooms. The
parser, layering, emitter, pan/zoom and box-select port across close to as-is; the mock
panel is thrown away.

Reviewing the pan/zoom pass then caught the worst defect of the three: capturing the
pointer on `pointerdown` silently killed click-to-comment, because the browser retargets
the following `click` to the capturing element. It survived a first round of testing
because that round dispatched synthetic clicks straight at the node, which skips the
retarget. **Interaction changes in this feature get verified with real input, not
synthesised events.** The final pass also added the group-comment requirement, which is why
`anchors` is a list.

## Files touched

- `server/markdown.js` — `flow` in the `renderFence` dispatch, plus the parser, layout and
  SVG emitter.
- `server/anchor.js` — `idAnchors`.
- `server/server.js` — one line in the carry-forward.
- `public/app.js` — click/Enter on `[data-anchor-id]`, `pendingAnchors` in the composer,
  `anchors` in the saved comment, class-based re-anchor in `renderDoc`, and the per-diagram
  pan/zoom/box-select binding.
- `public/style.css` — node, edge, hit-strip, focus, selected, commented, marquee, frame and
  control-cluster styles.
- `docs/PROTOCOL.md` — `anchorId`.
- `test/e2e.js`, `package.json` (`selfcheck`).
