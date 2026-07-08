# Archived-Comment Management Implementation Plan

> **For agent executors:** Use [[subagent-driven-development]] (recommended) or [[executing-plans]] to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the reviewer a "Clear all" bulk action for their own archived comments, so a long-running session's dead threads don't accumulate forever without ever silently dropping anything.

**Architecture:** This is a client-only change. Individual dismissal of the reviewer's own archived comments already exists (`deleteComment` wired to the ✕ icon in `viewCard()`, gated by `own`) and the archived section already collapses behind a native `<details>` with a live count in its `<summary>` — both existing pieces already satisfy two of the three things issue 010 asks for. The one real gap is a bulk "clear all at once" action. Add a `clearArchived()` function that filters `state.comments` down to comments that are NOT (archived AND owned by this reviewer), then reuses the existing `syncReview()` → `POST /api/review-state` path — the exact same primitive the existing single-dismiss already uses. Scope it to the reviewer's own comments (never a peer's) for two reasons: it matches the existing edit/delete ownership rule elsewhere in `viewCard()`, and it avoids a resurrection race — see "Why not a server endpoint" below.

**Tech stack:** Vanilla JS (`public/app.js`), no framework. Tests via this project's existing `node test/e2e.js` harness: some checks are static regexes against the served source (`/app.js`, `/style.css`), others (`driveLivenessWiring()`) actually load real `app.js` into a `vm` context with a hand-rolled DOM shim and drive it behaviorally — that's where this plan adds real function-level coverage.

**Why not a server endpoint:** `mergeComments()` (`server/server.js:461-499`) treats "the poster's own comment is absent from the incoming array" as an intentional deletion — but ONLY for comments authored by the poster making that specific request (the `mine`/`emitted` bookkeeping keys everything off `posterId`). If a bulk-clear endpoint deleted a comment authored by reviewer B directly on the server, and reviewer B's browser tab hadn't yet resynced (still holds that comment in its local `state.comments` from before the clear), B's next unrelated `/api/review-state` POST would replay their full stale snapshot — and `mergeComments`' "brand-new poster comment" loop (line 494-498) would re-add it, because from the server's point of view a comment authored by B, present in B's incoming body, and absent from `prev` looks indistinguishable from a genuinely new comment. There's no tombstone. Scoping "clear all" to the reviewer's OWN comments sidesteps this entirely: the only browser that can resurrect a comment is the same one that just deleted it (via its own already-updated local `state.comments`), which is exactly the same shape of interaction the existing single-dismiss already relies on safely.

**Non-goals:** no server endpoint, no change to `deleteComment`, no change to the existing `<details>`/summary collapse-and-count behavior (it already satisfies the issue's "optional" ask).

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
  // Only offer bulk-clear when the reviewer actually owns an archived comment —
  // a session full of a peer's archived comments (multi-reviewer) shows none.
  if (archived.some(ownComment)) {
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

## Spec coverage check

| Acceptance criterion (issue 010) | Covered by |
|---|---|
| Reviewer can explicitly clear archived comments individually | Already shipped (existing `deleteComment` + owner-gated ✕ in `viewCard()`); unchanged by this plan. |
| Reviewer can explicitly clear archived comments all at once; nothing removed without an explicit action | Task 1 (`clearArchived()`, wired to an explicit button click only — no automatic call site added anywhere). |
| Active (anchored) comments and their threads are untouched | Task 1's first behavioral test asserts the active comment survives `clearArchived()` unchanged; `clearArchived()`'s filter predicate only ever matches `c.archived === true`. |
| A session with no archived comments looks exactly as it does today | Unchanged: `archivedSection()` is still only invoked when `archived.length > 0` (`public/app.js` render call site, covered by Task 2's static check); zero archived comments ⇒ the function (and the new button inside it) never runs. |
| Optional collapse-all / count badge | Already shipped (`<details>`/`<summary>` with a live count); no changes needed. |
