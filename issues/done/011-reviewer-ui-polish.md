# Polish: reviewer UI cleanup (identity, sidebar, choice inputs, submit button)

**Type:** polish (five small, independent frontend fixes)
**Status:** done — all five items merged 2026-07-09 in PRs #13–#17
**Area:** `public/app.js`, `public/style.css`, `public/index.html`, `server/markdown.js`
**Source:** reviewer-UI screenshot review, 2026-07-08

## Problem

A pass over the reviewer screen surfaced five small rough edges. They are independent and each can land on its own, but they are grouped here because they are all reviewer-UI polish visible on the same screen. Pick them up individually or as one batch.

---

## 1. "you are" shows a hash, not a name

**Current:** `renderIdentity()` (`public/app.js:1388`) builds `you are ${authorLabel(...)}`. `authorLabel()` (`public/app.js:881-885`) falls back to `a.id.slice(0, 8)` when the reviewer has no name, so a fresh reviewer reads as `you are 2cf83d89` — the first 8 chars of the `crypto.randomUUID()` id minted in `loadReviewerId()` (`public/app.js:28-46`). An `edit` button already exists to set a name (`public/app.js:1390-1399`), but the default is the hash.

**Want:** a default that reads like a name, not an id.

**Design decision to settle:** either (a) generate a friendly default name (e.g. adjective-animal, or "Reviewer 1") at id-mint time and let `edit` override it, or (b) prompt for a name on first load. Keep it lightweight; the hash can remain as the disambiguating suffix in tooltips/badges where two reviewers collide.

**Acceptance:** a first-time reviewer sees a human-readable name in the header, not a hex slice; the existing `edit` flow still works; author attribution elsewhere stays stable.

---

## 2. Sidebar comments overlap the author-color badge

**Current:** the author badge is appended into `.card-actions` (`public/app.js:1068`, `authorBadge()` at `:930-936`), and `.card-actions` is `position: absolute; top: 6px; right: 6px` (`public/style.css:500-506`). The card body only clears the ✎/✕ icons (blockquote `margin: 0 48px 6px 0`, `public/style.css:477`), so the wider name pill overruns the comment text and reads as sloppy overlap.

**Want:** the badge and the comment text never overlap.

**Fix direction:** give the badge its own row / reserve vertical space above the comment body, or stop absolutely positioning it on top of the text. No overlap at any comment length.

**Acceptance:** at short and long comment lengths the green name badge is fully clear of the comment body; the ✎/✕ actions still reachable.

---

## 3. Custom "Other" answer is echoed back redundantly

**Current:** when a reviewer types a free-text "Other" answer, `valueOf()` (`public/app.js:747-748`) returns that text, `sync()` writes it into `state.choices`, and `renderPicks()` (`public/app.js:615-636`) then echoes it below the block as `1 · <the exact text I just typed>`. For a single reviewer this just repeats their own input verbatim.

**Want:** don't echo my own custom answer straight back to me.

**Fix direction:** suppress the picks summary line when it would only restate the current reviewer's own single pick (especially free text). Keep the summary meaningful when it adds information — multiple reviewers, or divergence (the "reviewers disagree" hint at `:630-634` stays).

**Acceptance:** a lone reviewer typing an Other answer sees no redundant `1 · <text>` line; the multi-reviewer tally and disagreement hint are unaffected.

---

## 4. Custom-answer field should wrap and auto-expand

**Current:** the Other field is a single-line `<input type="text" class="choice-other-text">`, server-rendered in `server/markdown.js:113` and read via `.value` in `public/app.js:748` / `:565`. CSS `.choice-other-text` (`public/style.css:1018-1030`) is a fixed single-line height with no wrap and no resize; the row parent `.choice-other` uses `white-space: nowrap` (`public/style.css:1015-1016`). Long answers scroll horizontally inside a one-line box.

**Want:** the field wraps text and grows in height as I type.

**Fix direction:** switch the element to a `<textarea>` (update the server render in `server/markdown.js` and the client read to keep using `.value`, which works for both), auto-grow its height on input, and drop the `nowrap` on the row so it wraps.

**Acceptance:** typing a multi-line / long Other answer wraps and the field grows vertically; the value still round-trips into `state.choices` and the submit bundle exactly as before.

---

## 5. Submit button should be one block with only a divider line

**Current:** the submit control is a split button — `#submit-btn` plus a separate `.split-caret` toggle (`public/index.html:70-83`). CSS already gives the caret a single `border-left` divider (`public/style.css:648`) and strips the shared radii (`:640-651`), but the caret still reads as a visually distinct second block (its own hover, its own padded box) rather than one continuous button with a hairline divider before the arrow.

**Want:** one constant button block, with only a thin divider line marking off the down-arrow — not two blocks butted together.

**Fix direction:** unify the two halves visually — shared background/hover so the caret is not its own block, keep just the `border-left` hairline as the divider. The dropdown menu behavior (`public/app.js:1228-1251`) is unchanged.

**Acceptance:** the submit control looks like a single button with a hairline divider before the ▾; approve-mode recolor (`public/style.css:654-661`) still recolors the whole control; the menu still opens.

---

## Code pointers (summary)

- `public/app.js` — `renderIdentity()` (:1382-1401), `authorLabel()` (:881-885), `loadReviewerId()` (:28-46), `authorBadge()` (:930-936), `viewCard()` (:1060-1102), `renderPicks()`/`pickCounts()`/`valueOf()` (:598-762), submit wiring (:1210-1251).
- `public/style.css` — `.card-actions` (:500-506), `.author-badge` (:1033-1044), `.choice-other`/`.choice-other-text` (:1015-1030), split button (:633-693).
- `public/index.html` — identity span (:15), submit split button (:70-83).
- `server/markdown.js:113` — the `choice-other-text` input render.
