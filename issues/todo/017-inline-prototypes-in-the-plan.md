# 017 — live prototypes in the plan, commentable like the document

**Type:** feature (needs a brainstorming pass; shares an anchoring decision with 016)
**Status:** open
**Area:** `server/markdown.js` (new fence), `public/app.js` (frame host, element anchoring,
`renderDoc`), `server/server.js` + `server/anchor.js` (carry-forward), `public/style.css`

## Problem

A plan can describe a screen; it cannot show one. So the reviewer approves a description
of a UI, the agent builds it, and the disagreement — *the primary action is buried*,
*this needs an empty state*, *these two fields should be one* — surfaces after the code
exists instead of before it. The tool already solves exactly this problem one step later
for code (`codereview`, `/r/<id>`): put the artifact in the browser *before* it is
committed to. The gap is the step before that, where the artifact is a screen.

Nothing today can render one. The renderer escapes every character of source text
(`escapeHtml`, `server/markdown.js:8`) and has no raw-HTML passthrough at all, so markup
in a plan renders as visible text. A screen mockup can only be described in prose or drawn
in ASCII.

## What this adds

The agent embeds a **working prototype** in the plan — real markup, real CSS, optionally
real interaction — and the reviewer **clicks a part of it to leave a comment**, exactly as
they select a sentence today. Threads carry across rounds, land in the `submit` bundle,
and the agent reworks the prototype and re-presents. Same loop, same panel, new artifact
type.

Paired with 016: 016 is the flow between the pieces, this is what a piece looks like.

## The two problems worth solving before writing code

### 1. The prototype is untrusted markup in a trusted page

`renderDoc` assigns the rendered document straight into the page
(`docEl.innerHTML = doc.html`, `public/app.js:272`, and again at `:414` for the diff
view). Everything that reaches that line today is renderer-escaped, so this is the first
path that would put agent-authored markup — and any script in it — into the reviewer
page's own DOM, where it would share an origin with the session state, the comment
composer, and the review-submit controls. The server sets no CSP (`server/server.js:787-808`
sends `Content-Type` and `Cache-Control` only).

The platform already has the answer: `<iframe sandbox srcdoc="…">`. Sandboxed without
`allow-same-origin`, a prototype cannot touch the parent page even with `allow-scripts` on.
This costs one attribute and is the thing not to be lazy about.

### 2. Sandboxing is what makes commenting hard

That same isolation means the parent page cannot read the iframe's DOM to figure out what
was clicked, and `anchorByQuote` (`public/app.js:1703`) cannot walk into it to re-anchor.
So a comment on "the Save button" needs one of:

- **A shim inside the frame.** A few lines the renderer injects into `srcdoc`: listen for
  clicks, `postMessage` a stable selector or a `data-proto-id` up to the parent. Precise,
  survives layout changes, and the id is a real anchor key — but the prototype must carry
  ids, which pushes work onto whoever authors it.
- **An overlay outside the frame.** Comment pins at (x, y) over the iframe, no
  cooperation needed from the prototype at all. Trivially compatible with any markup, and
  wrong the moment the agent reflows the layout — every pin drifts silently.
- **Whole-prototype comments only.** One thread per prototype block, no targeting. Much
  the smallest, and it throws away most of the value: "the primary action is buried" is a
  comment *about a specific button*.

## Sketch of the smallest version

1. **A `prototype` fence** in the plan, dispatched from `renderFence`
   (`server/markdown.js:28`) alongside `choice` and `flow` — body is an HTML fragment.
2. **Rendered to a sandboxed `<iframe srcdoc>`** with a declared height, plus the
   click-reporting shim.
3. **Click an element → the existing comment composer**, the comment recording the
   element's `data-proto-id` next to the quote it already carries.
4. **Carry-forward keys on that id** — the same active/archived split as today
   (`server/server.js:478-485`), archiving when the agent removes the element.
5. **Malformed / empty fence falls back to plain code**, as `choice` does
   (`server/markdown.js:98-101`).

## Design decisions to settle first

- **Anchor model** — the three options above. This is the same decision 016 faces for
  diagram nodes: both need a comment anchored to *a thing that is not a run of prose*.
  Whichever ships first should introduce the anchor kind (`quote` | `id`) and the other
  should reuse it, rather than each growing its own.
- **How much prototype is a prototype.** Markup + scoped CSS only (static, safe, boring),
  vs. `allow-scripts` for real interaction (a tab bar you can actually click). Scripts are
  safe *inside* the sandbox; the cost is that the reviewer can now change the prototype's
  state, and a comment on a screen the agent never sees in that state is confusing.
- **Where the markup comes from.** Inline in the fence (self-contained, diffable, bloats
  the plan) vs. a path reference to a file the agent writes (plan stays readable, but the
  document is no longer the whole document — `loadDoc` reads one file today).
- **Sizing.** A declared `height:` in the fence, or a shim that measures and posts its own
  height up. The second is nicer and is one more moving part.
- **Version diff.** `renderVersionDiff` (`server/markdown.js:393`) is block-level, so any
  prototype edit reads as one wholly-changed block. Probably fine — a visual diff of two
  rendered screens is a much larger feature than this one.

## Acceptance criteria

- A ```` ```prototype ```` fence in a presented plan renders as a live, sandboxed frame.
- Script inside the frame cannot reach the reviewer page: no access to session state, the
  comment composer, or the submit controls. Covered by a test, not by inspection.
- Clicking a targetable element opens the comment composer and the thread shows in the
  panel, visibly attached to that element.
- The thread survives a re-present that keeps the element, and archives (never disappears)
  when it is removed.
- Element-anchored comments arrive in the `submit` bundle identifying their target.
- A malformed `prototype` fence renders as plain code and breaks nothing.
- A plan with no `prototype` fence behaves exactly as it does today.

## Code pointers

- `public/app.js:272,414` — `docEl.innerHTML`, the two places rendered document HTML
  enters the reviewer page.
- `server/markdown.js:8` — `escapeHtml`; there is no raw-HTML passthrough today.
- `server/markdown.js:28-31` — `renderFence` dispatch (where `prototype` would hook in).
- `server/markdown.js:97-119` — `renderChoice`, the precedent for an interactive fence
  with a fall-back-to-code path.
- `server/server.js:787-808` — response headers (no CSP set today).
- `server/server.js:478-485` — comment carry-forward / archiving on re-present.
- `public/app.js:1121` — the comment record (`{ id, quote, text, ts, author }`).
- `public/app.js:1703` — `anchorByQuote`, which cannot cross into a sandboxed frame.
- `issues/todo/016-whiteboard-flow-diagram.md` — the shared non-text anchor decision.
