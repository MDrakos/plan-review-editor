---
title: Fixture catalog — 017 inline prototypes
date: 2026-08-26
jira_key: 017-inline-prototypes
version: 1
---

# Fixture catalog — 017 inline prototypes

> Collapses the plan's own acceptance criteria (spec's Testing section, 6 items), the FMEA
> catalog (`.develop/fmea.md`, 17 entries), and the STRIDE catalog (`.develop/stride.md`, 11
> entries) into one canonical fixture per distinct behavior. 34 source entries total; 16
> fixtures below account for all of them — 21 entries collapse directly into a fixture (as
> primary driver or a folded-in note), 13 are explicitly dropped (see **Dropped** at the end).

## FX-1 — sandboxed frame, no `allow-same-origin`, raw markup never escapes `srcdoc`

- **Behavior:** every `prototype` fence renders an `<iframe sandbox="allow-scripts">` with no `allow-same-origin`, and the agent's markup appears nowhere in the outer document except inside the escaped `srcdoc` attribute.
- **Input:** `id: signup\nheight: 320\n<button data-proto-id="save">Save</button>`
- **Expected:** output contains `sandbox="allow-scripts"`, does not match `/allow-same-origin/`, and does not contain the literal substring `<button data-proto-id="save">Save</button>`.
- **Test:** `server/prototype.js` self-check (Task 1 Step 9); `test/e2e.js` "issue 017" section (Task 2 Step 1).
- **Subsumes:** plan acceptance criterion 1; STRIDE TM-1 (already fully mitigated by this same assertion — no new test needed beyond it).

## FX-2 — the frame's CSP is the first thing in the inner document, blocking network egress

- **Behavior:** `renderPrototype` prepends a fixed CSP meta tag (`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`) before the base stylesheet, the shim, and the markup. Inline CSS/script keep working; every URL-loaded subresource and all network egress (`fetch`, `sendBeacon`, a remote `<img>`, a web font) is blocked.
- **Input:** same fence as FX-1.
- **Expected:** decoding the `srcdoc` attribute value, the string starts with `<meta http-equiv="Content-Security-Policy" ...>` and contains `default-src 'none'`.
- **Test:** `server/prototype.js` self-check (Task 1 Step 9); `test/e2e.js` (Task 2 Step 1).
- **Subsumes:** amendment A1; STRIDE TM-5 (its own recommendation — "CSP... is the only lever available" over network egress — is exactly this fix, so TM-5 moves from accepted-risk to resolved). TM-9 (peer activity turning a beacon into an activity oracle) becomes moot: the beacon it depends on can no longer fire at all once network egress is blocked, so no separate test is needed beyond this one. TM-11 (a form field capturing and exfiltrating reviewer input) is substantially reduced: the exfiltration half (the `fetch()` that would send captured data out) is closed by this CSP; the local-capture-without-network-egress residual is unaddressed (see Dropped).

## FX-3 — every `data-proto-id` gets a matching `data-anchor-id` stub

- **Behavior:** each targetable element inside the fence produces a corresponding hidden-free `<span data-anchor-id="...">` stub outside the frame, in DOM order, one per distinct id.
- **Input:** markup with `data-proto-id="title"`, `data-proto-id="email"`, `data-proto-id="save"`.
- **Expected:** output contains `data-anchor-id="signup:el:title"`, `data-anchor-id="signup:el:email"`, `data-anchor-id="signup:el:save"`.
- **Test:** `server/prototype.js` self-check; `test/e2e.js` (Task 2 Step 1, "served document" check).
- **Subsumes:** plan acceptance criterion 2.

## FX-4 — a pre-existing `data-anchor-id` in agent markup is stripped before the server mints its own

- **Behavior:** the server is the only thing allowed to mint `data-anchor-id`. Any `data-anchor-id="..."` or `data-anchor-id='...'` already present on an element (whether or not it also carries `data-proto-id`) is removed before `rewriteMarkup` appends the generated one.
- **Input:** `<button data-anchor-id="other:el:x" data-proto-id="save">Save</button>` (and a single-quoted variant), plus `<div data-anchor-id="signup:el:save">x</div>` and an unquoted `<span data-anchor-id=signup:el:save>` — neither of which carries `data-proto-id` at all.
- **Expected:** the rewritten tag contains exactly one `data-anchor-id`, and it is `signup:el:save` — `other:el:x` never survives. A tag with no `data-proto-id` ends up with no `data-anchor-id` at all, so a decoy element cannot impersonate a real one within its own block.
- **Test:** `server/prototype.js` self-check (Task 1 Step 5).
- **Subsumes:** amendment A2 (server half); FMEA FM-6 (an agent-authored literal `data-anchor-id` shadowing the generated one — the *static*, self-shadowing case this defense also closes).

## FX-5 — `openProtoComposer` rejects an anchor id not scoped to its own block

- **Behavior:** `openProtoComposer(block, anchorId, rect)` only proceeds when `anchorId` is a string prefixed with `${block.dataset.protoId}:el:`. A mismatch (or a non-string) returns silently.
- **Input (source-level):** `openProtoComposer`'s body checked for `dataset.protoId` and `startsWith(prefix)`.
- **Expected:** the check exists and runs before `flowEl`/`openComposerAt` are reached.
- **Test:** `test/e2e.js` source-regex assertion against `public/app.js` (Task 4 Step 1).
- **Subsumes:** amendment A2 (client half); STRIDE TM-3 (a prototype frame forging an anchor id to hijack or misattribute a comment thread onto a different block's element — including the runtime-script variant, since the check runs on every reported click regardless of how the frame produced the id). Partially closes TM-4 (an unvalidated `postMessage` shape leaving stale pending state): the `typeof anchorId !== 'string'` half of that check is a byproduct of this fix. The remaining half of TM-4 — validating `rect`'s numeric shape — is unaddressed (see Dropped).

## FX-6 — the stub container has no `hidden` attribute; CSS alone hides it

- **Behavior:** `renderPrototype` drops the `hidden` attribute from `<div class="proto-anchors">`. The existing zero-size, `overflow: hidden` CSS rule (Task 3, unchanged) hides it instead, so `focusComment`'s `scrollIntoView` still has a laid-out box to scroll to.
- **Input:** same fence as FX-1.
- **Expected:** output contains `class="proto-anchors"` but never `proto-anchors" hidden`.
- **Test:** `server/prototype.js` self-check (Task 1 Step 9); `test/e2e.js` (Task 2 and Task 3 checks).
- **Subsumes:** amendment A3; FMEA FM-16 (the `[hidden] { display: none !important }` app-wide rule beating `.proto-anchors`, making `scrollIntoView` a silent no-op — this is the same defect the CSS-presence test's own gap description names).

## FX-7 — every rewritten element gets `tabindex="0"` and the shim reports Enter/Space like a click

- **Behavior:** `rewriteTag` adds `tabindex="0"` to a `data-proto-id` element unless it already declares a `tabindex`; the shim's `keydown` listener reports Enter or Space on the focused `[data-anchor-id]` element exactly as `click` does.
- **Input:** `<button data-proto-id="x">x</button>` (gets `tabindex="0"`); `<button tabindex="-1" data-proto-id="x">x</button>` (keeps `tabindex="-1"`, no second one added).
- **Expected:** the first case's output matches `/tabindex="0"/`; the second's does not gain a `tabindex="0"` and keeps `tabindex="-1"`. Decoded `srcdoc` contains `addEventListener('keydown'` alongside `addEventListener('click'`.
- **Test:** `server/prototype.js` self-check (Task 1 Step 5, Step 9); `test/e2e.js` (Task 2, tabindex check).
- **Subsumes:** amendment A4; FMEA FM-17 (no targetable prototype element has a keyboard path to the comment composer — parity with `server/flow.js`'s `tabindex="0" role="button"` `<g>` elements, minus `role` since the target here is a native or ordinary HTML element the agent already authored, not a synthetic SVG `<g>`).

## FX-8 — a repeated prototype fence `id:` falls back to a code block; a shared id with `flow` does not collide

- **Behavior:** `renderBlocks` threads a per-document `Set` of prototype fence ids through `renderFence`/`renderPrototype`. A second (or later) `prototype` fence reusing an already-used `id:` falls back to a plain code block, exactly like a missing `id:` does. The `Set` is scoped to prototype fences only, so a `flow` fence may legitimately share an `id:` with a `prototype` fence — `node`/`edge` and `el` keep their anchor ids apart.
- **Input:** two `prototype` fences both declaring `id: signup`; separately, one `flow` fence and one `prototype` fence both declaring `id: signup`.
- **Expected:** in the first case, `data-anchor-id="signup:el:save"` appears exactly once and the second fence's output starts with `<pre><code class="language-prototype">`. In the second case, both `data-anchor-id="signup:node:save"` (flow) and `data-anchor-id="signup:el:save"` (prototype) render normally.
- **Test:** `server/prototype.js` self-check (Task 1 Step 9, `usedIds` assertions); `test/e2e.js` (Task 2, duplicate-id and flow-sharing checks).
- **Subsumes:** amendment A5; FMEA FM-7 and STRIDE TM-8 (the same defect — two fences sharing an `id:` collide on every anchor they emit, and `querySelector`'s first-match semantics resolve every click/paint/carry-forward to the wrong block). **Correction preserved:** TM-8's claim that a `flow` fence and a `prototype` fence sharing an id also collide is wrong and is not "fixed" — the second half of this fixture pins that down as a passing case, not a regression.

## FX-9 — `data-proto-id` inside a comment, `<pre>`, or `<script>` body is never rewritten

- **Behavior:** `scanStubs`/`rewriteMarkup` scan a masked copy of the markup (HTML comments, `<pre>` bodies, and `<script>` bodies blanked out) so a `data-proto-id`-shaped substring inside a JS string literal, an HTML comment, or a `<pre>`-quoted code sample is never mistaken for a real attribute on a real tag.
- **Input:** `<!-- <b data-proto-id="ghost">not real</b> -->`, `<pre>&lt;b data-proto-id="ghost2"&gt;...</pre>`, `<script>var s = "data-proto-id=\"ghost3\"";</script>`.
- **Expected:** none of `ghost`/`ghost2`/`ghost3` appear in `scanStubs`'s output or get a `data-anchor-id` from `rewriteMarkup`.
- **Test:** `server/prototype.js` self-check (Task 1 Step 5).
- **Subsumes:** amendment A6 (masking); FMEA FM-3 (`rewriteMarkup`'s unanchored regex matching `data-proto-id="x"` occurrences that are not real attributes, and disagreeing with the tag-anchored `scanStubs` on exactly this input class — closed here because both functions now scan the same masked, tag-anchored source).

## FX-10 — two `data-proto-id` attributes on one element: first wins, scanner and rewriter agree

- **Behavior:** when a single tag carries `data-proto-id` twice, `scanStubs` and `rewriteMarkup` both use the tag's *first* occurrence — no disagreement, no element left with two different `data-anchor-id`s.
- **Input:** `<button data-proto-id="a" data-proto-id="b">x</button>`.
- **Expected:** `scanStubs` returns exactly `[{id:'a', ...}]`; `rewriteMarkup`'s output contains `data-anchor-id="signup:el:a"` and not `signup:el:b`.
- **Test:** `server/prototype.js` self-check (Task 1 Step 5).
- **Subsumes:** amendment A6 (first-wins rule); FMEA FM-4 (the scanner's greedy match and the rewriter's global replace disagreeing on which duplicate attribute wins, leaving an element with two different `data-anchor-id`s).

## FX-11 — the shim's `<script>` is injected before the agent's markup

- **Behavior:** the inner document's `<script>${SHIM}</script>` is placed before the rewritten markup, not after, so a raw `</script>` inside the agent's own inline script (which prematurely closes *that* script tag) can never orphan the shim appended later in the same string.
- **Input:** decoded `srcdoc` from the FX-1 fixture's render.
- **Expected:** `decoded.indexOf('<script>')` is both found and strictly less than the index of the first rewritten `data-anchor-id`, i.e. the shim's opening tag precedes the markup.
- **Test:** `server/prototype.js` self-check (Task 1 Step 9).
- **Subsumes:** amendment A6 (shim ordering); FMEA FM-14 (a literal `</script>` in the agent's own inline script silently disabling the shim for that block, because the original design appended the shim *after* the markup).

## FX-12 — `bindProtos()` reuses a frame whose `srcdoc` is unchanged instead of tearing it down

- **Behavior:** on each render, a fresh `.proto-block` whose `srcdoc` is byte-identical to the block that carried the same `data-proto-id` last render is swapped back out for the old (already-loaded) block, so an unrelated peer's comment save doesn't recreate — and re-hang, re-run, or re-beacon — an unchanged prototype's iframe.
- **Input (source-level):** `bindProtos`'s body checked for comparing `getAttribute('srcdoc')` and calling `replaceWith`.
- **Expected:** the comparison and the swap both exist, ahead of the fallback path that registers a genuinely new frame.
- **Test:** `test/e2e.js` source-regex assertion against `public/app.js` (Task 4 Step 1) — structural only, per the design's own stated limit (no real browser in this suite).
- **Subsumes:** amendment A7; STRIDE TM-10 (peer review activity defeating "recoverable by reload" for a hung prototype — the primary target). TM-9 (the same unconditional-rebuild root cause turning a network beacon into an activity-correlated oracle) is closed by this same fix as a secondary consequence, though as noted under FX-2 it is already moot once the CSP blocks the beacon outright.

## FX-13 — a prototype comment carries forward across an unrelated re-present, and archives when its element is removed

- **Behavior:** a comment with `anchors: ['signup:el:save']` stays active and unarchived across a re-present that keeps the `save` element, and comes back `archived: true` (never dropped) once the element is removed — unchanged, reused `idAnchors`/carry-forward machinery.
- **Input:** `PROTO_A` (has the `save` button) → re-present with an unrelated addition → still active. Then `PROTO_B` (the `save` button and its stub removed) → re-present → archived.
- **Expected:** `prKept.pn && !prKept.pn.archived` after the first re-present; `prGone.pn.archived === true && prGone.pn.text === 'move this above the fold'` after the second.
- **Test:** `test/e2e.js` (Task 2 Step 1).
- **Subsumes:** plan acceptance criterion 3.

## FX-14 — the submit bundle carries `anchors` naming the prototype element

- **Behavior:** a comment anchored to a prototype element rides the `submit` bundle with its `anchors` array intact; a prose comment in the same document carries no `anchors` key at all.
- **Input:** the same `pn`/`pp` comments as FX-13, submitted via `/api/submit`.
- **Expected:** `prBundled.anchors[0] === 'signup:el:save'`; `'anchors' in (prEv.comments.find(c => c.id === 'pp'))` is `false`.
- **Test:** `test/e2e.js` (Task 2 Step 1).
- **Subsumes:** plan acceptance criterion 4.

## FX-15 — a malformed prototype fence falls back to a plain code block

- **Behavior:** a fence with no `id:` (or blank markup) renders as `<pre><code class="language-prototype">...</code></pre>`, exactly as a malformed `choice`/`flow` does — nothing throws, the rest of the document renders.
- **Input:** `no id here`; a fence whose body is only whitespace after `id: signup`.
- **Expected:** output starts with `<pre><code class="language-prototype">`.
- **Test:** `server/prototype.js` self-check (Task 1 Step 9); `test/e2e.js` (Task 2 Step 1).
- **Subsumes:** plan acceptance criterion 5. Related but distinct, and not fixed by this catalog (see Dropped): FMEA FM-1, a stray `key: value`-shaped line at the top of the markup being silently swallowed rather than triggering this same fallback.

## FX-16 — a document with no prototype fence renders byte-identically to today

- **Behavior:** the feature is fully inert on a document that never opens a `prototype` fence — no `proto-` class, attribute, or id appears anywhere in the output.
- **Input:** `# T\n\nJust prose, and \`code\`.\n\n\`\`\`js\nlet a = 1;\n\`\`\`\n`
- **Expected:** `!/proto-/.test(render(...))`.
- **Test:** `test/e2e.js` (Task 2 Step 1).
- **Subsumes:** plan acceptance criterion 6.

---

## Dropped

Entries from the FMEA/STRIDE catalogs that are **not** fixed by this amendment, because they
fall outside the seven user-approved changes (A1–A7). Each is either a design limitation
already accepted by the spec, or a gap this amendment doesn't touch. Listed so the catalog
stays traceable — nothing here is silently missing.

| Entry | Why dropped |
|---|---|
| FM-1 — a stray `key: value`-shaped line swallowed | Not among A1–A7; `parseHeader`'s header/body split is unchanged. |
| FM-2 — empty `height:` clamps to the minimum, not the default | Already below the FMEA catalog's own severity floor (filtered as `low`); not among A1–A7. |
| FM-5 — attribute-syntax variants (single-quoted, unquoted, spaced `=`) silently non-targetable | Not among A1–A7. The fence's documented syntax is double-quoted attributes, matching `flow.js`'s own scanning convention. |
| FM-8 — an anchor id can survive a rework round while pointing at a semantically different element | Inherent to the reused `idAnchors` pure string-match design; `server/anchor.js` is explicitly zero-changes for this plan. |
| FM-9 — an in-flight click message dropped by a concurrent re-render | Requires real browser timing to reproduce and verify; not among A1–A7. |
| FM-10 — a malformed `rect` payload corrupts pending-comment state | The `anchorId` half is closed as a byproduct of FX-5 (A2); the `rect` shape itself is not validated. Not among A1–A7. Provable only with a real browser per its own test note. |
| FM-11 — focus moving into the iframe strands the composer with no keyboard `Escape` | Not among A1–A7. Provable only with a real browser (focus/iframe semantics this harness can't execute). |
| FM-12 — the fence-language dispatch is case-sensitive | Not among A1–A7; matches existing `choice`/`flow` precedent, which are also case-sensitive. |
| FM-13 — pathological attribute soup degrades regex scan cost | Already below the FMEA catalog's own severity floor (filtered as `low`); not among A1–A7. |
| FM-15 — the diff view emits duplicate stubs for an unchanged sub-element | Already below the FMEA catalog's own severity floor (filtered as `low`); masked today by the unconditional `flowCommentable()` diff-view gate. Not among A1–A7. |
| TM-2 — escaping into `srcdoc` untested against adversarial payloads | A test-coverage recommendation, not a code fix; not among A1–A7. `escapeHtml`'s existing correctness is unchanged. |
| TM-4 (remainder) — `rect`'s numeric shape is unvalidated | Same gap as FM-10's remainder; the `anchorId` half is closed by FX-5. |
| TM-6 — a prototype's own script can hang the reviewer's tab | Orthogonal to A1's CSP (a CPU-bound loop needs no network access) and to A7 (which mitigates only the peer-triggered *re*-hang, filed separately as TM-10). Accepted risk per the STRIDE catalog's own disposition; unreachable without a real browser. |
| TM-7 — a prototype can pixel-clone the review app's chrome | Accepted residual risk per the STRIDE catalog's own disposition — human-factors/social-engineering, no automated test proposed even there. Not among A1–A7. |
| TM-11 (remainder) — local capture of reviewer input without exfiltration | The exfiltration half is closed as a side effect of FX-2 (A1's CSP blocks all network egress). The doc-warning STRIDE recommends (against giving prototype form fields real `type=`/`autocomplete=`/`name=` semantics) is not among A1–A7 and is not added. |
