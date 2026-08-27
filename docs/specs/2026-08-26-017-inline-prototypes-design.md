# 017 — live prototypes in the plan, commentable like the document

**Status:** implemented 2026-08-26 on `miked/inline-prototypes`. Two things below did not
ship as written; see **What shipped differently** at the end.
**Issue:** `issues/todo/017-inline-prototypes-in-the-plan.md`
**Sibling:** `docs/specs/2026-08-25-016-whiteboard-flow-diagram-design.md` (defined the `anchors` model this reuses)

## What this builds

The agent writes a screen as a `prototype` fence in the plan: real markup, real
CSS, real interaction. The server renders it into a sandboxed iframe. The
reviewer clicks a part of that screen and gets the same comment composer a text
selection gives them, and the resulting thread lives in the same right-hand
panel, carries forward across rework rounds, and rides back in the `submit`
bundle naming the element it is attached to.

016 is the flow between the pieces. This is what one piece looks like.

No new state machine and no new comment type. A prototype is another kind of
block, and an element comment is the `anchors` comment 016 already shipped.

## Decisions taken

The issue listed four open forks. All four were settled in review on 2026-08-26,
along with one the spec added.

| Fork | Decision | Why |
|---|---|---|
| Interactivity | The agent's own scripts run | The click-reporting shim needs `allow-scripts` regardless, so this is free. Without `allow-same-origin` the frame is an opaque origin and cannot reach the parent, so the sandbox already contains the risk. A stripper would prevent reviewer confusion, not an attack, and regex-stripping HTML is imperfect. |
| Markup source | Inline in the fence body | Version history stores the markdown string (`server/server.js:472`), so an inline prototype is captured in history and diffs across rounds for free. A `src:` path would leave history pointing at a file that has since changed, and the plan would stop being one artifact. |
| Sizing | A declared `height:` in the fence, default 400 | Two lines of parsing next to the `id:` the fence needs anyway. A measuring shim is nicer and only about five more lines, but the parent-sets-height-changes-scrollHeight-posts-height loop needs guarding. A wrong height scrolls inside the frame: visible, and fixed in one rework round. |
| Frame boundary | Mirror the ids outside the frame as hidden stubs | Detailed below. Nothing in the existing anchor path changes. |
| Sandbox test | Structural assertion, not a live browser | Detailed under **Testing**. |

## The frame boundary, and why it costs almost nothing

Two facts decide the shape of this feature.

**A sandboxed frame is opaque in both directions.** Clicks inside an iframe do
not bubble to the parent, and the parent cannot read the frame's DOM. So
per-element commenting needs a script inside the frame reporting clicks upward,
which means `allow-scripts`. That is safe: without `allow-same-origin` the frame
gets its own opaque origin, so it cannot touch the reviewer page's DOM, its
session state, the composer, or the submit controls.

**Both halves of the existing anchor path work on the outer document.**
`idAnchors` (`server/anchor.js:44`) does `html.indexOf('data-anchor-id="<id>"')`
against the rendered HTML string, and `flowEl` (`public/app.js:1815`) is a
`docEl.querySelector`. Inside `srcdoc` the inner markup is attribute-escaped, so
the server's string match fails; and the browser cannot select into a frame at
all.

The server renders the fence, so it knows every targetable id *before* it
escapes the markup into `srcdoc`. It emits those ids a second time, outside the
frame, as hidden stubs:

```
<div class="proto-block" data-proto-id="signup" style="--proto-h:400px">
  <iframe class="proto-frame" sandbox="allow-scripts" srcdoc="&lt;style&gt;…"></iframe>
  <div class="proto-anchors" hidden>
    <span data-anchor-id="signup:el:save" data-label="Save"></span>
    <span data-anchor-id="signup:el:cancel" data-label="Cancel"></span>
  </div>
</div>
```

Consequently `idAnchors`, the carry-forward and archiving at
`server/server.js:485-490`, `flowEl`, `flowLabel`, `markFlowAnchors`,
`saveComment` and the panel card all work **unchanged**. `saveComment`
(`public/app.js:1133`) is already generic over `anchors`; it needs no edit at
all. All the genuinely new code is one server module, the shim, and two
postMessage handlers.

## The `prototype` fence

A fence opened with `prototype`, containing a small header and then an HTML
fragment:

````markdown
```prototype
id: signup
height: 320
<style>.card{font:14px system-ui;padding:16px}</style>
<div class="card">
  <h2 data-proto-id="title">Create your account</h2>
  <input data-proto-id="email" placeholder="Email">
  <button data-proto-id="save" data-proto-label="Save button">Save</button>
</div>
```
````

- `id:` is required and namespaces the block. A fence without it, or with an
  empty body, falls back to a plain code block exactly as a malformed `choice`
  does (`server/markdown.js:94-98`).
- `height:` is optional, defaults to 400, and is clamped to 80–2000 so a typo
  cannot produce a zero-height or page-swallowing frame.
- Header lines end at the first line that is not `key: value`. Everything from
  there down is the markup, verbatim.
- `data-proto-id="save"` marks an element targetable and the server expands it
  to `signup:el:save`, mirroring how `flow` turns `name[Label]` into
  `id:node:name`. `el` is the kind, alongside 016's `node` and `edge`.
- `data-proto-label="Save button"` is the human name shown on the comment card
  and in the composer. It defaults to the `data-proto-id` value.
- An element with no `data-proto-id` is simply not targetable. That is the
  escape hatch for layout wrappers and decoration.

## Components

### `server/prototype.js` (new)

Mirrors `server/flow.js` in shape: one module, a `require.main` self-check, no
dependencies beyond `server/escapehtml.js`. Exports `renderPrototype(body)`.

1. Split the header from the markup, read `id` and `height`, bail to a code
   block if `id` is missing or the markup is blank.
2. Scan the markup for `data-proto-id="…"` (and its optional
   `data-proto-label`) to build the stub list. This is an attribute scan, not an
   HTML parse. The markup is agent-authored and well-formed by construction, and
   a missed match costs one untargetable element rather than a wrong render.
3. Rewrite each `data-proto-id="x"` in place to also carry
   `data-anchor-id="<id>:el:x"`, so the shim can report a ready-made anchor id
   and the same attribute names the stub outside.
4. Build the inner document: a small base stylesheet, the markup, then the shim
   in a `<script>`.
5. `escapeHtml` that whole string into the `srcdoc` attribute, and emit the
   block above.

### The shim

A fixed string, injected into every prototype frame. It does three things and
nothing else:

- On click, walk up from the target to the nearest `[data-anchor-id]` and
  `postMessage({ kind: 'proto-click', anchorId, rect }, '*')` to the parent,
  where `rect` is that element's bounding rect within the frame.
- On a `proto-commented` message from the parent, set a `commented` class on the
  named elements so a thread is visibly attached to its element.
- On a `proto-clear` message, drop the `selected` class.

`'*'` is the only possible target origin in both directions, because the frame's
origin is `null` by design. That is not a leak: the messages carry element ids
the parent already knows, and the frame is content the agent itself authored.

### `server/markdown.js`

One line in `renderFence`, alongside `choice` and `flow`.

### `public/app.js`

- `bindProtos()`, called next to `bindFlows()` at the two `renderDoc` sites
  (`:278` and `:422`). It records each block's `contentWindow` so an incoming
  message can be traced to its block.
- A single `window.addEventListener('message', …)` that ignores anything whose
  `event.source` is not one of those frames, then calls `openProtoComposer`.
  Filtering on `source` rather than `origin` is deliberate: a sandboxed frame's
  origin is `null`, which is not a value worth trusting, whereas the window
  reference is exact.
- `openProtoComposer(block, anchorId, rect)` sets `pendingAnchors = [anchorId]`
  and `pendingQuote = flowLabel([anchorId])`, offsets `rect` by the iframe's own
  position, and calls the existing `openComposerAt`. It reuses `flowCommentable()`
  for the state check, and mirrors `openFlowComposer`'s already-commented
  shortcut: a click on an element that already carries `data-cids` on its stub
  focuses that thread instead of starting a second one.
- `markFlowAnchors` (`:1822`) gains a few lines: after marking a stub, if it
  belongs to a prototype block, post `proto-commented` down to that frame. This
  keeps one call site rather than adding a parallel `markProtoAnchors` at both
  places anchors are painted (`:461` and `:1140`).
- `dismissComposer` posts `proto-clear` to the frames, alongside the existing
  `clearFlowSelection()`.

### `public/style.css`

`.proto-block` (a bordered container matching `.flow-block`), `.proto-frame`
(`width:100%`, `height:var(--proto-h)`, no border), and `.proto-anchors`
(`display:none`). Dark mode inherits from the existing block tokens; the frame's
own base stylesheet sets a light surface regardless, since a prototype is a
screen the agent designed and not part of the reviewer chrome.

## Data flow

```
prototype fence in markdown
  → renderFence dispatches to renderPrototype
  → iframe srcdoc (markup + shim)  +  hidden anchor stubs beside it
  → reviewer clicks an element in the frame
  → shim postMessages the anchor id and rect up
  → app.js opens the existing composer at that spot
  → saveComment stores { …, anchors: ['signup:el:save'] }
  → syncReview persists it, unchanged
  → agent re-presents: idAnchors matches the stub in the new render
  → thread carries forward, or is archived if the element is gone
  → submit bundle carries anchors, unchanged
```

## Error handling

- **Malformed fence** (no `id:`, blank markup) renders as a plain code block.
  Nothing throws and the rest of the document renders.
- **Duplicate `data-proto-id`** within one fence: the first wins and the rest are
  dropped from the stub list, so an id never maps to two elements. Two elements
  claiming one anchor would make carry-forward ambiguous.
- **`height:` not a number** falls back to the default rather than erroring.
- **A message from an unknown window** is ignored.
- **A click on a non-targetable element** posts nothing, so the composer does not
  open on a wrapper.
- **No `prototype` fence in a plan** is the existing code path exactly: nothing
  binds and nothing listens.

## Testing

Added to `test/e2e.js`, which drives the real server over HTTP.

1. A `prototype` fence renders a frame carrying `sandbox="allow-scripts"` and
   **not** `allow-same-origin`, and the raw prototype markup appears nowhere
   outside the `srcdoc` attribute.
2. Every `data-proto-id` produces a matching `data-anchor-id` stub outside the
   frame.
3. A comment with `anchors: ['signup:el:save']` survives a re-present that keeps
   the element, and comes back `archived: true` when the element is removed.
4. The `submit` bundle carries the `anchors` list.
5. A malformed fence renders as `<pre><code>` and the surrounding document is
   unaffected.
6. A plan with no prototype fence renders byte-identically to today.

`server/prototype.js` also carries a `require.main` self-check covering header
parsing, id namespacing, the duplicate rule and the height clamp, and joins the
`selfcheck` script alongside `flow.js` and `anchor.js`.

**The limit, stated plainly.** Acceptance criterion 2 asks that script in the
frame be proven unable to reach the reviewer page, by test rather than
inspection. The suite has no real browser — `test/reviewvm.js` is a hand-rolled
mini-DOM — and adding one contradicts the README's zero-runtime-dependency line.
Test 1 is therefore structural: it fails if anyone later adds `allow-same-origin`
or lets prototype markup escape the `srcdoc`, which is the regression actually
worth catching. It is not a live proof that a hostile script bounced off. That
would be its own issue.

## Out of scope

- **Per-element version diff.** `renderVersionDiff` is block-level, so any
  prototype edit reads as one wholly-changed block. A visual diff of two
  rendered screens is a much larger feature.
- **A CSP on the server's responses.** Worth doing and unrelated to this: the
  sandbox attribute is what isolates the frame, and a CSP would not change that.
- **Reviewer-editable prototypes.** Nothing in this tool lets the reviewer mutate
  the document, and this does not start.
- **A measuring shim.** Recorded above as the upgrade path if declared heights
  turn out to be a nuisance in practice.

## What shipped differently

Two things in this document describe behavior the implementation does not have. The
design is left as written, as the record of what was approved; this section is the
correction.

**The frame is not reused across renders.** *Components → `public/app.js`* has
`bindProtos()` keeping a prototype's iframe alive when its `srcdoc` is unchanged, so a
peer reviewer's unrelated comment does not tear the frame down and re-run its script.
That was built and then removed, because it never worked: `renderDoc` and the diff view
both assign `docEl.innerHTML` wholesale *before* calling `bindProtos()`, so every prior
block is already detached by the time the swap runs, and a browser reloads a
detached-then-reattached iframe. Making it real means `renderDoc` patching changed
subtrees instead of replacing the document, which is a larger change than this feature.
The consequence is that a prototype containing a hung script re-hangs on every re-render,
and a prototype's interaction state resets whenever anyone comments.

**The shim has no `proto-clear` handler.** *Components → The shim* lists a `proto-clear`
message dropping a `selected` class. Nothing in the feature ever sets that class — the
selected state lives on the stub outside the frame, not inside it — so the handler was
dead on arrival and was deleted. `dismissComposer` posts no message into the frames.

**`<pre>` is not masked.** *Components → `server/prototype.js`* has the markup scan
skipping comment, `<pre>` and `<script>` regions. `<pre>` was dropped from that list: it
holds ordinary child markup, so a tag inside one is a real tag and must still have a
forged `data-anchor-id` stripped from it. Masking it meant those never were. A code
sample displayed inside a `<pre>` is escaped, so it is text rather than tags and the scan
passes it over regardless — the masking bought nothing and cost the guarantee.
