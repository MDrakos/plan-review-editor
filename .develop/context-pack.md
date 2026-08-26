# Context pack — 017 inline prototypes

Code this run **does not change** but every task depends on. Read this instead of
re-deriving it. Evict any file here the moment a task's diff touches it.

## Environment gotcha (read first)

`grep` silently returns **nothing** when run against `public/app.js` in this sandbox —
no output, no error. Read that file with `sed -n`, `head`/`tail`, or
`node -e "require('fs').readFileSync('public/app.js','utf8')…"`. Never conclude a
symbol is absent because grep found nothing.

## Interfaces called (unchanged by this work)

### `server/anchor.js:44` — `idAnchors(id, html)`
```js
function idAnchors(id, html) {
  if (!id) return false;
  return String(html).indexOf(`data-anchor-id="${escapeHtml(id)}"`) !== -1;
}
```
A raw string match on the **rendered outer HTML**. This is the entire reason the design
mirrors prototype ids as hidden stubs outside the iframe: inside `srcdoc` the attribute
quotes are escaped to `&quot;` and this match would fail. **Do not modify.**

### `server/server.js:485-490` — carry-forward
```js
const carried = (s.review.comments || []).map((c) => ({
  ...c,
  archived: c.anchors
    ? !c.anchors.some((a) => idAnchors(a, html))
    : !quoteAnchors(c.quote, html),
}));
```
Already generic over `anchors`. A prototype comment carries forward and archives with
**zero changes here.**

### `public/app.js:1133-1149` — `saveComment()`
Already branches on `pendingAnchors` and writes `comment.anchors`. **Zero changes.**
The prototype path's only job is to set `pendingAnchors` + `pendingQuote` and call
`openComposerAt(rect, quote)` before the user hits save.

### `public/app.js:1815-1846` — the anchor helpers
- `flowEl(id)` → `docEl.querySelector('[data-anchor-id="…"]')`. Finds a hidden stub just
  as happily as a flow `<g>`.
- `markFlowAnchors(anchors, cid)` → adds `.commented` and accumulates `dataset.cids`.
  **This is the one existing function that gains lines**, to also postMessage down into
  the owning frame. Editing it here keeps a single call site rather than adding a
  parallel painter at both `:461` and `:1140`.
- `flowLabel(ids)` → reads `dataset.label`, abbreviates past three. Works on stubs.
- `flowCommentable()` → `state.status === 'reviewing' && !state.diffing`. Reuse verbatim.

### `server/escapehtml.js` — `escapeHtml`
Escapes `& < > "`. Lives in its own module, **not** in `markdown.js`. The whole inner
document (base CSS + markup + shim) goes through this once, into the `srcdoc` attribute.

## One worked neighbour: `server/flow.js`

The structural model for `server/prototype.js`. Copy its shape, not its layout maths:

- One module, 323 lines, no dependency beyond `server/escapehtml.js`.
- Emits `data-anchor-id="${escapeHtml(aid)}"` and `data-label="${escapeHtml(label)}"`
  on each targetable element (`flow.js:214`, `:234`).
- Namespaces every id as `` `${spec.id}:${kind}:${localId}` `` — `node` / `edge` there,
  `el` here (`flow.js:210`, `:230`).
- Ends in a `require.main === module` assert-based self-check that asserts on the emitted
  HTML string (`flow.js:307-309`). `server/prototype.js` must do the same and be added to
  `package.json`'s `selfcheck` script.

## Conventions with `path:line`

- **Fence dispatch:** `server/markdown.js:23-28`. One `if (lang === 'x') return renderX(body);`
  line per fence, then the generic `<pre><code>` fallthrough.
- **Malformed-fence fallback:** `server/markdown.js:93-98` (`renderChoice`). A bad block
  renders as `<pre><code class="language-x">` + escaped body. Never throws.
- **Binding after render:** `bindFlows()` is called at `public/app.js:278` (live doc) and
  `:422` (diff view). `bindProtos()` goes next to **both**. Both guard re-binding with a
  `dataset.*Bound` flag (`app.js:1872`).
- **Composer teardown:** `dismissComposer()` (`app.js:1116-1122`) nulls `pendingRange` /
  `pendingAnchors` / `pendingQuote` and calls `clearFlowSelection()`.
- **Painting on state sync:** `app.js:459-463` walks non-archived comments and calls
  `markFlowAnchors(c.anchors, c.id)` when `c.anchors` is set. Prototype comments flow
  through this untouched.
- **Comments** follow `~/.claude/CLAUDE.md`: say what the code does, one or two sentences,
  reference nothing outside the code they sit in. No ticket keys, no design-doc pointers.

## Blast radius

| File | Change |
|---|---|
| `server/prototype.js` | **new** |
| `server/markdown.js` | one dispatch line |
| `public/app.js` | `bindProtos`, a `message` listener, `openProtoComposer`, additions inside `markFlowAnchors` and `dismissComposer` |
| `public/style.css` | three rules |
| `package.json` | `selfcheck` gains one file |
| `test/e2e.js` | six scenarios |
| `docs/PROTOCOL.md`, `integration/claude/plan-review/SKILL.md`, `README.md` | document the fence |

**Untouched, and must stay untouched:** `server/anchor.js`, `server/server.js`,
`server/flow.js`, `saveComment`, `flowLabel`, `flowCommentable`, `anchorByQuote`.
A task that edits one of these is a design deviation — stop and escalate.

## Security posture, stated once

The frame is `sandbox="allow-scripts"` and **never** `allow-same-origin`. That combination
gives the frame an opaque (`null`) origin, so it cannot reach the parent's DOM, storage,
session state, composer, or submit controls. Consequences that follow and must not be
"fixed":

- Both directions of `postMessage` use target origin `'*'`. There is no other possible
  value for an opaque origin. The messages carry only element ids the parent already knows.
- The parent's `message` listener filters on **`event.source`** (matched against each
  frame's `contentWindow`), never on `event.origin`, which is the useless string `"null"`.
- The agent's own scripts run inside the frame by design. Do not add a `<script>` stripper.
