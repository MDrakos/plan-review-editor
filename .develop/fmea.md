---
title: FMEA — 017 inline prototypes
date: 2026-08-26
jira_key: 017-inline-prototypes
path_tier: standard
generated_by: fmea-analysis
version: 1
---

# FMEA — 017 inline prototypes

> **This catalog supplements the functional tests derived from the plan's `## Tasks`. It does not replace them.**

## Orientation

**17 failure modes catalogued** (15 primary / 2 adversarial). Read these first, ranked by how much they change what you do:

1. `FM-8`: An anchor id can survive a rework round unchanged while pointing at a semantically different element — a carried-forward comment silently attaches to the wrong thing. Write the regression test *before* touching `idAnchors`/carry-forward wiring, even though those files are nominally untouched.
2. `FM-7`: Two `prototype` fences sharing one `id:` collide on every anchor id they emit; `flowEl`'s first-match `querySelector` paints/focuses the wrong block. Task 1 needs a same-document uniqueness check, or Task 4's click handling needs to defend against it.
3. `FM-3`: `rewriteMarkup`'s regex is unanchored to tag context — it rewrites *any* occurrence of `data-proto-id="x"`, including one sitting inside a `<script>` string, an HTML comment, or a `<pre>` block, potentially corrupting the agent's own script. `scanStubs` (tag-anchored) disagrees with it on exactly this input class.
4. `FM-14`: A literal `</script>` inside the agent's own inline script silently kills the click-reporting shim for that whole block (the shim is appended *after* the markup). No error anywhere — the block just stops being commentable.
5. `FM-4`: Two `data-proto-id` attributes on one element make `scanStubs` (greedy, picks one) and `rewriteMarkup` (rewrites both) disagree, leaving one element with two different `data-anchor-id`s and a stub list that only names one of them.

> 5 entries, ranked, one line each, every line naming an `FM-N` id. The full catalog follows below. Additive only.

## Coverage

| Category               | Status                                                        |
|------------------------|-----------------------------------------------------------------|
| boundary conditions    | 3 entries (FM-1, FM-2, FM-12)                                   |
| resource exhaustion    | 1 entry (FM-13)                                                 |
| concurrency            | 1 entry (FM-9)                                                  |
| auth/authz             | N/A — no authentication, authorization, or role/scope boundary exists anywhere in the fence-render or click-to-comment pipeline; it reuses the existing unauthenticated reviewer-identity model with zero new privilege checks. |
| state machine          | 5 entries (FM-8, FM-10, FM-11, FM-16, FM-17)                    |
| time/clock             | N/A — no timestamps, TTLs, schedules, or clock-dependent behavior anywhere in render or click handling. |
| network/dependency     | N/A — `renderPrototype` and the click bridge are fully local/synchronous; no network call or external service is introduced, and the existing SSE/session transport is reused untouched. |
| data integrity         | 7 entries (FM-3, FM-4, FM-5, FM-6, FM-7, FM-14, FM-15)          |
| security               | N/A — investigated the attribute-scan and srcdoc-escaping boundary for injection paths outside the sandbox's own guarantees; found none. Per the calling brief, `allow-same-origin` and target-origin `'*'` are settled decisions and out of scope for this catalog. |

> A bare `N/A` with no reason is a self-lint failure. Re-enumerate the category and retry.

## Catalog

### FM-1 — a stray `key: value`-shaped line at the top of the markup is silently swallowed

- **Category:** boundary conditions
- **Severity:** medium <!-- bad-impact (silent content loss) true, likelihood moderate-but-not-dominant: markup commonly opens with a tag, not a colon-shaped text line, so only one anchor is clearly true -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `parseHeader`)
- **Trigger:** `parseHeader('id: signup\nNote: this is a draft mockup\n<div data-proto-id="x">hi</div>')`. The header-line regex `^(\w+):\s*(.*)$` matches *any* `word: value`-shaped line, not just `id:`/`height:` — including a line the agent meant as the first line of visible markup (a plain sentence that happens to start with a word and a colon).
- **Expected:** the returned `markup` preserves `Note: this is a draft mockup\n<div data-proto-id="x">hi</div>` in full. Currently it does not — that line is consumed as an unrecognized header field and permanently dropped, with no warning and no fallback to a code block (parsing still "succeeds" because `id:` was found on the line before).

### FM-2 — `height:` with an empty value silently becomes the *minimum* clamp, not the documented default

- **Category:** boundary conditions
- **Severity:** low <!-- minor impact (frame renders at 80px instead of 400px, visibly wrong but not broken) AND unlikely (requires writing `height:` with literally nothing after the colon rather than omitting the line) -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `parseHeader` height branch)
- **Trigger:** `parseHeader('id: signup\nheight:\n<div data-proto-id="x">hi</div>').height`. `Number('')` is `0` in JS, which passes `Number.isFinite`, so the empty-string branch is *not* treated as "non-numeric" the way `height: nope` is.
- **Expected:** an empty `height:` value falls back to `DEFAULT_HEIGHT` (400), exactly like a non-numeric value does per the spec ("`height:` not a number falls back to the default rather than erroring"). Currently it clamps to `MIN_HEIGHT` (80) instead.
- **Filter reason:** below the Standard floor (`high`+`medium` only) — listed here in the main Catalog for traceability since it directly extends the Step-1 self-check assertions already in the plan, but see Filtered section for the floor bookkeeping. *(Duplicated pointer only — full entry lives here; not repeated in Filtered.)*

### FM-3 — `rewriteMarkup`'s unanchored regex can rewrite `data-proto-id="x"` occurrences that are not real attributes

- **Category:** data integrity
- **Severity:** high <!-- bad impact (can corrupt the agent's own script, silently) AND likely (script content, HTML comments, and <pre>-quoted example markup are all plausible in agent-authored prototypes) -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `rewriteMarkup` vs `scanStubs` regex mismatch)
- **Trigger:** render a fence whose markup is `<script>var s = 'data-proto-id="fake"';</script>` (or the same substring inside an HTML comment, or inside a `<pre>` code sample). `scanStubs`'s regex is tag-anchored (`<[a-zA-Z][^>]*\bdata-proto-id="([^"]*)"[^>]*>`) and will *not* match this (there is no real tag boundary containing it), but `rewriteMarkup`'s regex (`/data-proto-id="([^"]*)"/g`) matches the bare substring anywhere in the string and inserts ` data-anchor-id="signup:el:fake"` right after it — inside the JS string literal.
- **Expected:** `renderPrototype`'s output markup is unchanged inside `<script>` bodies, HTML comments, and `<pre>` blocks unless the `data-proto-id` occurrence is a genuine attribute on a real tag — i.e., `scanStubs` and `rewriteMarkup` agree on what counts as a targetable occurrence. Currently they use two different regexes with different match sets, so the two functions can disagree on the very same input.

### FM-4 — two `data-proto-id` attributes on one element make the scanner and the rewriter disagree

- **Category:** data integrity
- **Severity:** high <!-- bad impact (an element ends up with two different data-anchor-id values, one of which has no matching stub) AND plausible via a simple copy-paste duplication mistake in agent-authored markup -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `scanStubs` greedy match vs `rewriteMarkup` global replace)
- **Trigger:** `scanStubs('<button data-proto-id="a" data-proto-id="b">x</button>', 'signup')`. The tag-anchored regex's greedy `[^>]*` before `\bdata-proto-id="` backtracks to the *last* occurrence it can still satisfy, so `scanStubs` records `{id:'b', anchorId:'signup:el:b'}` only — while `rewriteMarkup` (a global, non-anchored replace) appends a `data-anchor-id` after *both* occurrences, giving the element two different `data-anchor-id` attributes (`signup:el:a` and `signup:el:b`).
- **Expected:** exactly one `data-anchor-id` value is associated with the element, and it matches the one entry in the stub list — whichever `data-proto-id` "wins," both functions must agree on it. Currently `scanStubs` and `rewriteMarkup` can each pick a different one.

### FM-5 — attribute-syntax variants (`'single quotes'`, unquoted, spaced `=`) are silently non-targetable

- **Category:** data integrity
- **Severity:** medium <!-- bad impact (the element quietly loses commentability, no error) but only "maybe" likely since the fence body is agent-authored HTML where quoting style is a stylistic choice, not adversarial input -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `scanStubs`/`rewriteMarkup` regexes)
- **Trigger:** render a fence whose markup uses `<button data-proto-id='save'>Save</button>` (single quotes), `<button data-proto-id=save>Save</button>` (unquoted), or `<button data-proto-id = "save">Save</button>` (spaced `=`) — all valid HTML attribute syntax.
- **Expected:** at minimum, the element is deterministically either targetable or not, with the same answer from `scanStubs` and `rewriteMarkup`; ideally all valid HTML attribute-value syntaxes are recognized. Currently all three forms are silently dropped by both the double-quote-only regexes, with no signal to the agent that the element it clearly intended to be commentable is not.

### FM-6 — an agent-authored literal `data-anchor-id` attribute can shadow the generated one

- **Category:** data integrity
- **Severity:** medium <!-- bad impact (a click silently fails to open the composer) but requires the agent to have independently written a literal data-anchor-id attribute, which is unlikely absent a copy-paste from rendered output -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `rewriteMarkup`) and Task 4 (`public/app.js`, shim click reporting)
- **Trigger:** markup contains `<button data-anchor-id="literal" data-proto-id="save">Save</button>` — an author-supplied `data-anchor-id` positioned before the `data-proto-id` occurrence that `rewriteMarkup` appends its own `data-anchor-id="signup:el:save"` after. The element now carries two `data-anchor-id` attributes; per HTML parsing rules the *first* wins and the second is discarded.
- **Expected:** a click on the element reports `signup:el:save` (the generated, namespaced anchor with a real outer stub). Currently the shim's `el.dataset.anchorId` resolves to whichever `data-anchor-id` the browser's parser kept — which can be the author's literal, stub-less value — so `flowEl` finds nothing and the composer silently never opens.

### FM-7 — two `prototype` fences sharing an `id:` collide on every anchor they emit

- **Category:** data integrity
- **Severity:** high <!-- bad impact (a comment can attach to the wrong prototype block entirely, misleading the reviewer and the agent) AND plausible (nothing enforces fence-id uniqueness within a document, and an agent copy-pasting a prototype fence as a starting point for a second screen is a natural authoring pattern) -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, no cross-fence `id:` uniqueness check) and Task 4 (`public/app.js`, `flowEl`'s `docEl.querySelector` first-match semantics)
- **Trigger:** a document with two `prototype` fences both declaring `id: signup`, each with a `data-proto-id="save"` element. Both fences render a `data-anchor-id="signup:el:save"` stub. Click the `save` element inside the *second* fence's iframe.
- **Expected:** the click either reports an error/no-op, or is unambiguously attributed to the second fence's block. Currently `flowEl('signup:el:save')` (`docEl.querySelector`) returns the *first* matching stub in DOM order, so `markFlowAnchors`'s new `proto-commented` postMessage is sent to the *first* fence's frame and its stub is the one painted `.commented` — silently misattributing the comment to the wrong prototype.

### FM-8 — an anchor id can survive a rework round while pointing at a different element

- **Category:** state machine
- **Severity:** high <!-- bad impact (a reviewer's comment silently reads as being about the wrong element after rework — actively misleading, not just lossy) AND likely (an agent renaming an element's role/label while keeping its data-proto-id is a completely ordinary edit, not an edge case) -->
- **Source:** primary
- **Linked to:** Task 1 / Task 2 — carry-forward semantics via the reused, untouched `idAnchors` (`server/anchor.js:44`)
- **Trigger:** round 1: `<button data-proto-id="save" data-proto-label="Save button">Save</button>`; reviewer comments "move this above the fold" anchored to `signup:el:save`. Round 2 (rework): the agent repurposes the same slot as `<button data-proto-id="save" data-proto-label="Delete account">Delete</button>` — same `data-proto-id`, different meaning.
- **Expected:** ideally the reviewer sees some signal that the element behind their comment changed identity (label, role) even though the id string didn't. Currently `idAnchors` does a pure string match on `data-anchor-id="signup:el:save"`, finds it present, and carries the comment forward as active/unarchived with zero indication that it now points at a "Delete" button instead of the "Save" button the comment was actually about.

### FM-9 — an in-flight click message can be silently dropped by a concurrent re-render

- **Category:** concurrency
- **Severity:** medium <!-- bad impact (the reviewer's click vanishes with no feedback) but narrow window (requires a re-present/diff-toggle landing in the same tick as an unprocessed click message) -->
- **Source:** primary
- **Linked to:** Task 4 (`public/app.js`, `bindProtos`/`protoFrames`/the `message` listener)
- **Trigger:** a `proto-click` postMessage is sent by the shim but not yet processed by the parent's `message` listener when `docEl.innerHTML` is reassigned by a concurrent `renderDoc`/`showDiff` call (an agent's `doc` SSE event arriving, or the reviewer toggling into/out of diff view). `bindProtos()` clears `protoFrames` and rebuilds it keyed on the *new* iframes' `contentWindow`s before the old message is delivered.
- **Expected:** either the click is queued/retried, or the reviewer gets some indication their click didn't register. Currently `protoFrames.get(e.source)` returns `undefined` for the stale window and the listener's `if (!block) return;` silently discards it — indistinguishable from a message from an untrusted/foreign window, with no way to tell the two apart from the reviewer's side.

### FM-10 — a malformed `rect` payload corrupts pending-comment state without opening the composer

- **Category:** state machine
- **Severity:** medium <!-- bad impact (stale pendingAnchors/pendingQuote left set with no visible composer) but requires a malformed message payload, which only a bug elsewhere (or hostile script inside the sandboxed frame, already assumed untrusted) would produce -->
- **Source:** primary
- **Linked to:** Task 4 (`public/app.js`, `openProtoComposer`)
- **Trigger:** deliver a `{ kind: 'proto-click', anchorId: 'signup:el:save' }` message with `rect` omitted (or `null`). `openProtoComposer` sets `pendingRange = null; pendingAnchors = [anchorId]; pendingQuote = flowLabel(...)` *before* evaluating `{ left: frameRect.left + rect.left, bottom: frameRect.top + rect.bottom }` for `openComposerAt` — and `rect.left` throws on `null`/`undefined` `rect`.
- **Expected:** either the module's pending-comment state is left unchanged when the payload is malformed, or the composer opens with a sane fallback position. Currently the exception is thrown *after* `pendingAnchors`/`pendingQuote` are already mutated but *before* `openComposerAt` ever runs, leaving `pendingAnchors` pointed at a real anchor with no composer visibly open — a later, unrelated save action could pick up this stale pending target.
- **Test note:** this is pure client-side module state; `test/e2e.js` drives the server over HTTP with no browser and cannot execute `public/app.js` directly. Closest structural test: a source-pattern assertion (in the style of the existing Task 4 checks) confirming `openProtoComposer` validates `rect`'s shape before assigning to `pendingAnchors`/`pendingQuote`/`pendingRange` — full behavioral proof needs a real browser.

### FM-11 — focus moving into an opaque iframe can strand the composer with no keyboard dismissal

- **Category:** state machine
- **Severity:** medium <!-- bad impact (composer stuck open, unreachable by Escape) but narrow trigger (requires clicking a second prototype element specifically while the composer from a first click is still open, before typing) -->
- **Source:** primary
- **Linked to:** Task 4 (`public/app.js`, composer `Escape` handling scope, `dismissComposer`)
- **Trigger:** click a prototype element (composer opens, `composerTextEl` has focus). Without typing, click a *different* targetable element inside a prototype iframe (same block or another). The click is a normal DOM interaction the sandboxed frame is free to accept, and receiving it moves keyboard focus into that iframe's own (opaque, `null`-origin) document.
- **Expected:** `Escape` still dismisses the composer regardless of where focus currently is. Currently the `Escape` handler is bound only to `composerTextEl`'s own `keydown` listener (`public/app.js:1128-1129`), not to `document`/`window`; once focus is inside the iframe, the parent has no way to observe or intercept `Escape` at all (the frame's opaque origin means the parent can't even confirm focus moved there), and the composer stays open with only the Cancel button left to close it.
- **Test note:** requires real browser focus/iframe semantics to observe end to end; this harness has no browser. Closest structural test: confirm no `document`/`window`-level Escape handling was added anywhere in `public/app.js` for this feature (pinning the current single-element-scoped binding as a known, explicit gap) rather than asserting the desired behavior directly.

### FM-12 — the fence-language dispatch is case-sensitive with a silent fallback

- **Category:** boundary conditions
- **Severity:** medium <!-- bad impact (the live-preview feature silently doesn't activate) but unlikely in practice since the spec and every worked example consistently use lowercase `prototype`, matching existing `choice`/`flow` precedent -->
- **Source:** primary
- **Linked to:** Task 2 (`server/markdown.js`, `renderFence` dispatch)
- **Trigger:** a fence opened as ` ```Prototype ` or ` ```PROTOTYPE ` instead of ` ```prototype `.
- **Expected:** ideally a case mismatch is either normalized or produces some visible signal. Currently `if (lang === 'prototype')` is an exact match, so any other casing falls through to the generic `<pre><code class="language-Prototype">…</code></pre>` path with zero warning that the intended live prototype never rendered — indistinguishable from an agent deliberately writing a plain code block.

### FM-13 — pathological attribute soup degrades the regex scan's cost

- **Category:** resource exhaustion
- **Severity:** low <!-- minor impact in practice (bounded by plan-document size, and agent-authored content is not adversarial) AND unlikely (requires an unusually large single attribute value or many long tag spans in one fence) -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `scanStubs`/`rewriteMarkup` regex passes)
- **Trigger:** a fence whose markup contains one very large attribute value (e.g., a multi-megabyte inlined data URI on an `<img>`, or thousands of short tags) inside a single `prototype` block.
- **Expected:** render time for a single pathological fence stays roughly linear in the markup's length and doesn't noticeably slow rendering of the rest of the plan document. Not verified today; the tag-anchored `[^>]*...[^>]*` regex re-scans from every `<` occurrence, so a long run of near-miss tag-like text costs more than proportionally.

### FM-14 — a literal `</script>` in the agent's own inline script silently disables the shim for that block

- **Category:** data integrity
- **Severity:** high <!-- bad impact (the entire click-to-comment mechanism for the block silently stops working, with zero error anywhere) AND likely (agents routinely write JS string literals or comments that could plausibly contain the substring "</script>", and this class of HTML-authoring hazard is easy to overlook when a script IS expected to run, as it is here by design) -->
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `renderPrototype` — the shim's `<script>` tag is appended *after* the markup in the inner document)
- **Trigger:** markup includes `<script>var s = "</scr" + "ipt>"; /* real code would need to avoid the literal */</script>` written *without* the escaping workaround, i.e. containing the literal substring `</script>` inside the script body (e.g. `<script>var s = "</script>";</script>`).
- **Expected:** the click-reporting shim keeps working regardless of what the agent's own script contains. Currently, when the iframe's HTML parser decodes the srcdoc content, a raw `</script>` inside the agent's script body terminates that `<script>` element early; everything after it — including the shim's own trailing `<script>${SHIM}</script>` block, appended later in the same string — is parsed as inert text/HTML instead of executing, and the block becomes silently non-interactive.
- **Test note:** this is a two-stage HTML-parsing effect (the browser's attribute-value decode of `srcdoc`, then the iframe's own HTML parse of the decoded string) that this harness cannot execute — there is no real browser in `test/e2e.js` or the self-check harness. Closest structural test: decode `renderPrototype`'s emitted `srcdoc` value the same way a browser's attribute decoder would (reverse of `escapeHtml`: `&amp;`→`&` last), then assert that when markup contains a literal `</script>`, the decoded string's *first* `</script>` occurrence appears before the shim's own opening `<script>` tag — pinning the current (broken) ordering rather than proving the runtime effect.

### FM-15 — the diff view emits duplicate `data-anchor-id` stubs for an unchanged sub-element of a changed prototype block

- **Category:** data integrity
- **Severity:** low <!-- bad impact in kind (same ambiguity as FM-7) but fully inert today: `flowCommentable()` unconditionally blocks all prototype/flow interaction while `state.diffing` is true, so the duplication has no reachable consequence under current behavior -->
- **Source:** primary
- **Linked to:** Task 2 (`server/markdown.js`, `renderVersionDiff` is block-level) and Task 4 (`bindProtos` scanning the diff-rendered document)
- **Trigger:** rework a prototype fence so the block is classified as `change` (e.g., edit the button's label but leave an `email` input untouched), then open the version diff between those two versions.
- **Expected:** no reachable UI ambiguity — currently there isn't one, because commenting is disabled outright in diff view. But `renderVersionDiff` wraps *both* the old and new full `renderPrototype` output (`data-diff="change"` → `diff-removed`/`diff-added`), so the untouched `email` element's `data-anchor-id="…:el:email"` stub appears twice in the same document, and `bindProtos()` registers both frames. This is the same `flowEl`/`querySelector`-first-match hazard as FM-7, currently masked only by the unrelated `flowCommentable()` gate — it would surface immediately if diff-view commenting were ever enabled.

### FM-16 — the anchor-stub `hidden` attribute is `!important`-forced invisible, so `focusComment`'s `scrollIntoView` on a prototype comment is a silent no-op

- **Category:** state machine
- **Severity:** medium <!-- deterministic (fires on every prototype comment, not a rare edge case) but bounded impact: the comment/thread itself is intact and still visible in the panel, only the auto-scroll convenience is lost, with a manual-scroll workaround always available -->
- **Source:** adversarial
- **Linked to:** Task 1 (`server/prototype.js`, `renderPrototype` — emits `<div class="proto-anchors" hidden>${stubHtml}</div>`) and Task 3 (`public/style.css`, the `.proto-anchors {}` rule)
- **Trigger:** leave a comment on any `data-proto-id` element, then click that comment's card in the right-hand panel, so `focusComment(id)` runs `docEl.querySelector('[data-cids~="…"]').scrollIntoView(...)` against the matching `.proto-anchors` stub.
- **Expected:** per Task 3's own explanatory comment ("keep a zero-size box inside the block rather than `display: none`, so `focusComment`'s `scrollIntoView` lands on the prototype instead of doing nothing"), the reviewer's viewport scrolls to that prototype block. It cannot: `public/style.css:104` already declares `[hidden] { display: none !important; }` app-wide, and Task 3's `.proto-anchors {}` rule sets `position`/`top`/`left`/`width`/`height`/`overflow` but never `display` — so nothing in the cascade opposes the `!important` rule on the one property (`display`) that determines whether the element has a box at all. The stub stays `display: none` exactly as a bare `hidden` div would, and `scrollIntoView()` on a non-rendered element is a documented no-op. Clicking a prototype comment's card produces zero scroll and zero error.
- **Test note:** fully checkable without a browser, unlike FM-10/FM-11. Read `public/style.css`, confirm the `[hidden] { display: … !important; }` rule, then assert the `.proto-anchors {}` rule itself declares an explicit non-`none` `display` (with matching `!important` to actually win the cascade) rather than merely asserting — as Task 3's own Step 1 test does today — the absence of the literal substring `display: none` inside that rule's body. That existing assertion passes on the plan's actual CSS even though the described behavior does not occur.

### FM-17 — no targetable prototype element has a keyboard path to the comment composer

- **Category:** state machine
- **Severity:** medium <!-- a real, always-true structural gap for any non-natively-interactive targetable element (the spec's own worked example, `<h2 data-proto-id="title">`, is one) but bounded: it's a missing input modality, not incorrect behavior, on a brand-new fence type with an obvious mouse-driven workaround -->
- **Source:** adversarial
- **Linked to:** Task 1 (`server/prototype.js` — `scanStubs`/`rewriteMarkup` add `data-anchor-id` but never `tabindex`/`role`, and `SHIM` registers only a `click` listener, never `keydown`/`keyup`) contrasted with the reused, unchanged `server/flow.js` (every node/edge `<g>` carries `tabindex="0" role="button"`) and `public/app.js:2100-2106` (the existing `docEl` `keydown` delegation that opens the composer on Enter for any `[data-anchor-id]` element)
- **Trigger:** a prototype fence whose targetable elements are ordinary markup (`<h2>`, `<div>`, `<span>` — not a native `<button>`/`<a>`/`<input>`), reviewed by someone using only a keyboard or other non-pointer input.
- **Expected:** parity with flow diagrams, where `tabindex="0" role="button"` plus the existing `docEl` Enter-key delegation already lets a keyboard-only reviewer reach and open the composer on any node or edge. Currently no task gives a prototype's targetable elements (inside the sandboxed frame) or their outer stubs any keyboard affordance at all, and the shim never listens for a key event — so a non-natively-interactive targetable element has no keyboard path to the composer, full stop, not merely a degraded one. Neither the design's Decisions table nor its Error handling/Out-of-scope sections name this as a deliberate cut, unlike "Reviewer-editable prototypes" or "A measuring shim," which are explicitly called out.
- **Test note:** structural only, this harness has no browser. Confirm neither `renderPrototype`'s stub markup nor `rewriteMarkup`'s output ever emits `tabindex`/`role`, and that `SHIM` contains no `keydown`/`keyup` listener — contrasted with `server/flow.js`'s node/edge emission, which does. Full behavioral proof (whether Tab reaches into the sandboxed frame at all, or whether a native `<button>`'s own Enter/Space-to-click synthesis rescues the interactive-element case) needs a real browser.

## Filtered (below severity floor)

> Entries enumerated but dropped by the Standard path's severity floor (`high` + `medium` kept; `low` dropped here).

### FM-2 — `height:` with an empty value silently becomes the *minimum* clamp, not the documented default

- **Category:** boundary conditions
- **Severity:** low
- **Filter reason:** minor visual impact (80px vs 400px frame), unlikely trigger shape (`height:` with a truly empty value rather than omitting the line).
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`, `parseHeader`)
- **Trigger:** see full entry above (kept in the main Catalog for traceability alongside the Step-1 self-check it extends).
- **Expected:** see full entry above.

### FM-13 — pathological attribute soup degrades the regex scan's cost

- **Category:** resource exhaustion
- **Severity:** low
- **Filter reason:** bounded by realistic plan-document size and non-adversarial (agent-authored) content.
- **Source:** primary
- **Linked to:** Task 1 (`server/prototype.js`)
- **Trigger:** see full entry above.
- **Expected:** see full entry above.

### FM-15 — the diff view emits duplicate `data-anchor-id` stubs for an unchanged sub-element of a changed prototype block

- **Category:** data integrity
- **Severity:** low
- **Filter reason:** fully mitigated today by the unconditional `flowCommentable()` gate on diff-view interaction; latent, not reachable.
- **Source:** primary
- **Linked to:** Task 2 / Task 4
- **Trigger:** see full entry above.
- **Expected:** see full entry above.

## Adversarial pass

> Always present, even when empty. Silent omission is invalid.

- **Standard:** 1 subagent dispatched. Returned **2 deltas** (FM-16, FM-17). Both verified against the actual `public/style.css` and `server/flow.js` on disk before being merged in.
