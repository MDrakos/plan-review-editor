# Archived-Comment Management Implementation Plan

> **For agent executors:** Use [[subagent-driven-development]] (recommended) or [[executing-plans]] to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the reviewer a "Clear all" bulk action for their own archived comments, so a long-running session's dead threads don't accumulate forever without ever silently dropping anything.

**Architecture:** This is a client-only change. Individual dismissal of the reviewer's own archived comments already exists (`deleteComment` wired to the ✕ icon in `viewCard()`, gated by `own`) and the archived section already collapses behind a native `<details>` with a live count in its `<summary>` — both existing pieces already satisfy two of the three things issue 010 asks for. The one real gap is a bulk "clear all at once" action. Add a `clearArchived()` function that filters `state.comments` down to comments that are NOT (archived AND owned by this reviewer), then reuses the existing `syncReview()` → `POST /api/review-state` path — the exact same primitive the existing single-dismiss already uses. Scope it to the reviewer's own comments (never a peer's) for two reasons: it matches the existing edit/delete ownership rule elsewhere in `viewCard()`, and it avoids a resurrection race — see "Why not a server endpoint" below.

**Tech stack:** Vanilla JS (`public/app.js`), no framework. Tests via this project's existing `node test/e2e.js` harness: some checks are static regexes against the served source (`/app.js`, `/style.css`), others (`driveLivenessWiring()`) actually load real `app.js` into a `vm` context with a hand-rolled DOM shim and drive it behaviorally — that's where this plan adds real function-level coverage.

**Why not a server endpoint:** `mergeComments()` (`server/server.js:461-499`) treats "the poster's own comment is absent from the incoming array" as an intentional deletion — but ONLY for comments authored by the poster making that specific request (the `mine`/`emitted` bookkeeping keys everything off `posterId`). If a bulk-clear endpoint deleted a comment authored by reviewer B directly on the server, and reviewer B's browser tab hadn't yet resynced (still holds that comment in its local `state.comments` from before the clear), B's next unrelated `/api/review-state` POST would replay their full stale snapshot — and `mergeComments`' "brand-new poster comment" loop (line 494-498) would re-add it, because from the server's point of view a comment authored by B, present in B's incoming body, and absent from `prev` looks indistinguishable from a genuinely new comment. There's no tombstone. Scoping "clear all" to the reviewer's OWN comments sidesteps the cross-author case entirely: the only browser **tab** that can resurrect a comment is the same tab that just deleted it (via its own already-updated local `state.comments`) — the exact interaction the existing single-dismiss already relies on safely.

**Known, accepted limitation (pre-existing, not introduced by this plan):** `reviewer.id` is persisted in `localStorage` (shared across every tab of the same browser), and the `review` SSE echo-suppression matches on `reviewer.id`, not tab identity. So a *sibling tab* of the same reviewer that hasn't resynced could, in principle, replay a comment this feature just cleared, via the same "brand-new poster comment" path. This risk already exists today for the single ✕ dismiss (`deleteComment`) and for editing/adding comments generally — it is not new to `clearArchived()`, just proportionally larger blast radius per click. Fixing it is a sync-architecture change (tab-scoped identity or a tombstone) out of scope for this plan; noted here so the safety argument above isn't overstated.

**Non-goals:** no server endpoint, no change to `deleteComment`, no change to the existing `<details>`/summary collapse-and-count behavior (it already satisfies the issue's "optional" ask), no fix for the pre-existing cross-tab resurrection limitation above.

---

### Task 1: `clearArchived()` — behavioral test first, then implementation

**Files:**
- Modify: `test/e2e.js` (inside `driveLivenessWiring()`, `test/e2e.js:301` — right after the existing "review: this tab ignores its own echo" check, still inside the same function/scope so `ctx`, `vm`, and `check` are already in hand)
- Modify: `public/app.js:772-781` (`archivedSection()`) and add a new `clearArchived()` function directly after it

**Reuse:** `state.comments`, `ownComment()` (`public/app.js:739-741`), `renderComments()`, `syncReview()` — all existing. `searched, none — NEW` only for `clearArchived()` itself and the button markup in `archivedSection()`.

- [ ] **Step 1: Write the failing behavioral tests**

In `test/e2e.js`, immediately after this existing block (ends at line 301):

```js
  const beforeOwn = fetchCalls;
  fire('review', { author: { id: myId } });
  await flush();
  check('review: this tab ignores its own echo (no re-sync)', fetchCalls === beforeOwn, `Δ=${fetchCalls - beforeOwn}`);
```

add:

```js

  // ---------- archived-comment management (issue 010) ----------
  // Drive clearArchived() against the real, loaded app.js state (not just a
  // source regex) so the "own comments only" scoping and the "active comments
  // untouched" invariant are actually exercised, not merely asserted to exist.
  vm.runInContext(
    `state.comments = [
      { id: 'a1', quote: 'q1', text: 'active', archived: false },
      { id: 'r1', quote: 'q2', text: 'mine, archived', archived: true },
      { id: 'r2', quote: 'q3', text: 'mine too, archived', archived: true },
      { id: 'p1', quote: 'q4', text: "peer's archived", archived: true, author: { id: 'peer-1' } },
    ];`,
    ctx
  );
  vm.runInContext('clearArchived()', ctx);
  const afterClear = vm.runInContext('state.comments', ctx);
  check(
    "clearArchived: removes only the reviewer's own archived comments (a peer's survives)",
    afterClear.length === 2 &&
      afterClear.some((c) => c.id === 'a1') &&
      afterClear.some((c) => c.id === 'p1') &&
      !afterClear.some((c) => c.id === 'r1' || c.id === 'r2'),
    JSON.stringify(afterClear.map((c) => c.id))
  );
  check(
    'clearArchived: the surviving active comment is untouched (still archived: false)',
    afterClear.find((c) => c.id === 'a1').archived === false
  );

  vm.runInContext(`state.comments = [{ id: 'a1', quote: 'q1', text: 'active', archived: false }];`, ctx);
  const beforeNoop = vm.runInContext('state.comments', ctx);
  vm.runInContext('clearArchived()', ctx);
  const afterNoop = vm.runInContext('state.comments', ctx);
  check(
    'clearArchived: a no-op (nothing archived-and-own) leaves state.comments untouched',
    afterNoop === beforeNoop,
    'expected the same array reference when there is nothing to clear'
  );
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test`

Expected: the process aborts before printing `all checks passed` — `clearArchived` does not exist yet in `public/app.js`, so `vm.runInContext('clearArchived()', ctx)` throws `ReferenceError: clearArchived is not defined`, which propagates out of `driveLivenessWiring()` uncaught (this file doesn't wrap that call in try/catch — an uncaught exception is an acceptable, if noisy, "it fails" signal here). Confirm the error message names `clearArchived`.

- [ ] **Step 3: Implement `clearArchived()` and wire the button**

In `public/app.js`, replace the existing `archivedSection()` (lines 772-781):

```js
function archivedSection(archived) {
  const details = document.createElement('details');
  details.className = 'archived-comments';
  const summary = document.createElement('summary');
  const n = archived.length;
  summary.textContent = `${n} unanchored comment${n === 1 ? '' : 's'} — text no longer in the plan`;
  details.appendChild(summary);
  for (const c of archived) details.appendChild(viewCard(c));
  return details;
}
```

with:

```js
function archivedSection(archived) {
  const details = document.createElement('details');
  details.className = 'archived-comments';
  const summary = document.createElement('summary');
  const n = archived.length;
  summary.textContent = `${n} unanchored comment${n === 1 ? '' : 's'} — text no longer in the plan`;
  details.appendChild(summary);
  // Only offer bulk-clear when the reviewer actually owns an archived comment
  // (a session full of a peer's archived comments, multi-reviewer, shows none)
  // AND the session is actively reviewing (mirrors replyForm's status gate,
  // line 800) — a rework in flight could re-anchor one of these comments
  // server-side before its `archived: false` update reaches this tab; clearing
  // mid-flight on stale data would drop that comment for good (FMEA finding).
  if (archived.some(ownComment) && state.status === 'reviewing') {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn clear-archived';
    clearBtn.textContent = 'Clear all';
    clearBtn.title = 'Dismiss all of your archived comments';
    clearBtn.addEventListener('click', clearArchived);
    details.appendChild(clearBtn);
  }
  for (const c of archived) details.appendChild(viewCard(c));
  return details;
}

// Dismiss every archived comment this reviewer owns, in one action — never a
// peer's (mirrors the existing edit/delete ownership rule in viewCard()). Reuses
// the same author-scoped sync path as an individual dismiss (deleteComment):
// filter locally, then let syncReview()/mergeComments do the rest, so a peer's
// stale tab can never resurrect what this reviewer just cleared.
function clearArchived() {
  const keep = state.comments.filter((c) => !(c.archived && ownComment(c)));
  if (keep.length === state.comments.length) return;
  state.comments = keep;
  renderComments();
  syncReview();
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test`
Expected: `all checks passed`, including the three new `clearArchived:` lines as `ok`.

- [ ] **Step 5: Commit**

```bash
git add public/app.js test/e2e.js
git commit -m "feat: add clearArchived bulk action for the reviewer's own archived comments"
```

---

### Task 2: Static coverage + a touch of CSS

**Files:**
- Modify: `test/e2e.js` (inside `main()`, right after the existing check at `test/e2e.js:1860-1863` — `'client gates edit/delete to the comment owner (peer comments are read-only)'`)
- Modify: `public/style.css` (append near `test/e2e.js`'s referenced `.archived-comments` rules, `public/style.css:591`)

**Reuse:** `app` and `css` (`await text('/app.js')` / `await text('/style.css')`, already fetched earlier in `main()` at `test/e2e.js:1817` and `:1824`) — no new fetches needed.

- [ ] **Step 1: Write the failing static-coverage tests**

In `test/e2e.js`, immediately after this existing block:

```js
  check(
    'client gates edit/delete to the comment owner (peer comments are read-only)',
    /function ownComment\(/.test(app.body) && /if \(!c\.archived && own\)/.test(app.body)
  );
```

add:

```js
  check(
    'client offers a "Clear all" bulk action, scoped to the reviewer\'s own archived comments',
    /function clearArchived\(/.test(app.body) && /archived\.some\(ownComment\)/.test(app.body)
  );
  check(
    'the "Clear all" button is gated on owning an archived comment AND an active review status ' +
      '(a peer-only-archived session shows no button; nor does one mid-rework)',
    /archived\.some\(ownComment\) && state\.status === 'reviewing'/.test(app.body)
  );
  check(
    'the archived section (and its "Clear all" button) only ever renders when at least one comment is archived',
    /if \(archived\.length\) commentListEl\.appendChild\(archivedSection\(archived\)\)/.test(app.body)
  );
  check('stylesheet styles the archived "Clear all" action', /\.clear-archived/.test(css.body));
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test`
Expected: the run completes (no crash — these are plain regex checks) but reports 1 failure: `FAIL  stylesheet styles the archived "Clear all" action` (the other two already pass from Task 1's implementation). Confirm the failure count and the failing name.

- [ ] **Step 3: Add the CSS**

In `public/style.css`, immediately after this existing line (`:591`):

```css
.archived-comments .comment-card { margin-top: 8px; }
```

add:

```css
.archived-comments .clear-archived { margin: 4px 0 8px; padding: 4px 10px; font-size: 13px; }
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test`
Expected: `all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add public/style.css test/e2e.js
git commit -m "test: cover the archived-comment Clear-all action + style it"
```

---

## Fixtures

Conformance mode — the story (issue 010's 3 acceptance criteria) and the FMEA/DSM pass above fully specify inputs/outputs; nothing here is expected to shift during implementation. All four are locked now.

### FX-1 — clearArchived removes only the reviewer's own archived comments; a peer's and the active one survive untouched
- **Mode:** conformance
- **Inputs:** `state.comments = [{id:'a1', archived:false}, {id:'r1', archived:true}, {id:'r2', archived:true}, {id:'p1', archived:true, author:{id:'peer-1'}}]`, then call `clearArchived()`
- **Expected:** `state.comments` = `[a1, p1]` (order preserved), `a1.archived` still `false` — `r1`/`r2` gone
- **Source:** issue-010 acceptance criteria 1 ("individually and/or all at once") + 2 ("active comments... untouched")
- **Scope boundary:** `public/app.js` — `clearArchived()` and `archivedSection()` only; no other function's behavior may change to satisfy this
- **Exercised by:** Task 1, Step 1, checks 1–2 (`test/e2e.js`, `driveLivenessWiring()`)

### FX-2 — clearArchived is a true no-op when nothing archived-and-own exists
- **Mode:** conformance
- **Inputs:** `state.comments = [{id:'a1', archived:false}]`, then call `clearArchived()`
- **Expected:** `state.comments` is the *same array reference* afterward (no reassignment, no `renderComments()`/`syncReview()` side effect)
- **Source:** FMEA primary finding #3 (avoid a needless render/POST cycle)
- **Scope boundary:** `clearArchived()`'s early-return guard only
- **Exercised by:** Task 1, Step 1, check 3

### FX-3 — the "Clear all" button never renders in a peer-only-archived session
- **Mode:** conformance
- **Inputs:** archived set = `[{id:'p1', archived:true, author:{id:'peer-1'}}]` (reviewer owns none), `state.status = 'reviewing'`
- **Expected:** `archivedSection()`'s `archived.some(ownComment)` gate evaluates `false` — no `.clear-archived` button is appended
- **Source:** FMEA primary finding #4
- **Scope boundary:** `archivedSection()`'s gate condition only
- **Exercised by:** Task 2's static regex check on the compound gate condition. (The DOM shim in `driveLivenessWiring()` doesn't retain appended children — `appendChild`/`append` are no-op stubs — so this is verified at the source level, not by inspecting rendered output; that's an existing, accepted limitation of this harness, matching how the pre-existing owner-gating check at `test/e2e.js:1861-1863` already verifies its analogous condition.)

### FX-4 — the "Clear all" button never renders mid-rework, even when the reviewer owns an archived comment
- **Mode:** conformance
- **Inputs:** archived set = `[{id:'r1', archived:true}]` (reviewer's own), `state.status = 'working'`
- **Expected:** `archivedSection()`'s `state.status === 'reviewing'` gate evaluates `false` — no `.clear-archived` button is appended
- **Source:** FMEA adversarial finding A (a rework in flight could re-anchor an archived comment before the client learns of it; clearing on stale data would drop it for good)
- **Scope boundary:** `archivedSection()`'s gate condition only
- **Exercised by:** Task 2's static regex check (same gate condition as FX-3, second clause) — same harness limitation noted above applies

### FX-5 — clearArchived matches the realistic comment shape (explicit author), not just the legacy authorless one
- **Mode:** conformance
- **Inputs:** an archived comment with `author: { id: <this tab's reviewer.id> }` (the shape `app.js`'s `author()` actually stamps on every comment created through the normal flow), alongside the FX-1 fixture
- **Expected:** removed by `clearArchived()`, same as an authorless own comment
- **Source:** post-implementation `test-coverage` review (Important finding: FX-1's `r1`/`r2` only exercised `ownComment()`'s `!c.author` fallback, never its `c.author.id === reviewer.id` branch — the one every real comment hits)
- **Scope boundary:** none — test-only addition, no production code changed
- **Exercised by:** `driveLivenessWiring()`, folded into the FX-1 fixture as `r3`

### FX-6 — a real clear syncs to the server; a no-op (own-only or peer-only) does not
- **Mode:** conformance
- **Inputs:** the FX-1 mixed fixture (real clear) and the FX-2 / peer-only fixtures (no-ops), each with `fetchCalls` sampled before/after `clearArchived()`
- **Expected:** the real clear increments `fetchCalls` (the shimmed `fetch()` used by `syncReview()`); both no-op cases leave it unchanged
- **Source:** post-implementation `test-coverage` review (Important finding: no test asserted the persistence side effect — a dropped `syncReview()` call would have passed every prior check)
- **Scope boundary:** none — test-only addition, no production code changed
- **Exercised by:** `driveLivenessWiring()`, reusing the pre-existing `fetchCalls` counter (already used at `test/e2e.js:293-301` for the same purpose)

### FX-7 — a peer-only-archived session (reviewer owns none) is untouched by clearArchived
- **Mode:** conformance
- **Inputs:** `state.comments = [{id:'a1', archived:false}, {id:'p1', archived:true, author:{id:'peer-1'}}]`, then call `clearArchived()`
- **Expected:** same array reference afterward, no sync fired — matches the "Clear all" button's own render gate (`archived.some(ownComment)`)
- **Source:** post-implementation `test-coverage` review (Minor finding: this scenario was previously backed only by the static regex on the render gate, not a behavioral test of `clearArchived()` itself)
- **Scope boundary:** none — test-only addition, no production code changed
- **Exercised by:** `driveLivenessWiring()`, a third fixture alongside FX-1/FX-2

### FX-8 — clearArchived refuses to act once status is no longer 'reviewing', even if its button is stale in the DOM
- **Mode:** conformance
- **Inputs:** `state.status = 'working'`, `state.comments` containing the reviewer's own archived comment, then call `clearArchived()` directly (simulating a click on a button that rendered while `'reviewing'` and never got torn down)
- **Expected:** `state.comments` unchanged (same reference), no sync fired
- **Source:** pre-PR `logic` reviewer (Important finding: `archivedSection()`'s render-time gate is necessary but not sufficient — `setStatus()` never re-renders the sidebar, so a button rendered while reviewing stays present and bound through a status flip to `'working'`; the code's own comment claimed this was closed when it wasn't). Fixed by adding `if (state.status !== 'reviewing') return;` as the first line of `clearArchived()` itself — the same defense-in-depth pattern `submitReview()`/`approveReview()` already use (`public/app.js:1076`, `:1091`).
- **Scope boundary:** `clearArchived()`'s new guard clause only
- **Exercised by:** `driveLivenessWiring()`, a fourth fixture; note this fixture requires resetting `state.status = 'reviewing'` at the top of the whole archived-comment test block first, since the preceding liveness checks leave it as `'ended'`

---

## Spec coverage check

| Acceptance criterion (issue 010) | Covered by |
|---|---|
| Reviewer can explicitly clear archived comments individually | Already shipped (existing `deleteComment` + owner-gated ✕ in `viewCard()`); unchanged by this plan. |
| Reviewer can explicitly clear archived comments all at once; nothing removed without an explicit action | Task 1 (`clearArchived()`, wired to an explicit button click only — no automatic call site added anywhere). |
| Active (anchored) comments and their threads are untouched | Task 1's first behavioral test asserts the active comment survives `clearArchived()` unchanged; `clearArchived()`'s filter predicate only ever matches `c.archived === true`. |
| A session with no archived comments looks exactly as it does today | Unchanged: `archivedSection()` is still only invoked when `archived.length > 0` (`public/app.js` render call site, covered by Task 2's static check); zero archived comments ⇒ the function (and the new button inside it) never runs. |
| Optional collapse-all / count badge | Already shipped (`<details>`/`<summary>` with a live count); no changes needed. |

## G4 enumeration (FMEA + DSM)

Both ran at Standard settings before execution. **DSM:** no structural gaps — the plan's reuse of `ownComment()`/`syncReview()`/`/api/review-state` over a new endpoint is confirmed as the lower-coupling choice; no cycles introduced. **FMEA:** primary pass found no uncovered gaps in the core delete logic; the adversarial pass surfaced two real risks, both folded into the plan above — (1) a working-round race where a bulk clear could drop a comment that just re-anchored server-side, mitigated by gating the button on `state.status === 'reviewing'`; (2) the "why not a server endpoint" safety argument was imprecise ("same browser" → "same browser tab"), corrected, with the residual cross-tab-same-reviewer limitation now called out explicitly as pre-existing and out of scope. A `confirm()` guard on the button (raised by DSM, for parity with "End review") was considered and deliberately **not** added, to stay consistent with the existing single-dismiss (`deleteComment`), which also has no confirmation.
