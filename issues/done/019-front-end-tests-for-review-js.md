# 019 — put `public/review.js` under the vm test harness

**Status:** done — merged 2026-08-25 in c93dcf9 (local merge, no PR)

## What happens now

`test/e2e.js` already loads real front-end code in-process: `buildLivenessVm` /
`driveLivenessWiring` run `public/liveness.js` and `public/app.js` under
`vm.runInContext` against a DOM and EventSource shim, then assert DOM state
across a simulated SSE-driven re-render. So the repo does have a front-end
harness. It just stops at the plan side.

Nothing loads `public/review.js`. The code-review UI is tested only by hand.

## Why it matters now

Issue 015 added the comment-draft machinery in `review.js`: `composerDraft`,
the restore path through `renderAll`, the `!row` branch that holds a draft while
its file is folded, the quote-drift comparison, and the rule that an untouched
suggestion baseline gets re-based on drift while a hand-edited one is left alone.

That is a data-loss path with branches, and it has no automated coverage. It was
verified by driving a real browser three times, which caught two real bugs — but
a browser pass is not a regression guard, and the pre-PR review suite flagged
the gap in all three rounds.

## What would fix it

Extend the existing vm approach to `review.js`, in `test/codereview.js` (or a
shared helper both test files use, since `buildLivenessVm` would want to move):

- fold the composer's file, unfold, assert the draft and its text come back
- a re-read that shifts the anchor line: assert the drift notice appears
- drift with an untouched suggestion: assert it re-bases on the new code
- drift with a hand-edited suggestion: assert the edit survives
- two `doc` events resolving out of order: assert the older read is dropped
- the cross-tab case: two reviewer contexts on one session, assert a re-read in
  one repaints the other (this is where the reverted `by` self-echo guard broke)

## Notes

The shared helper is the interesting decision. `buildLivenessVm` was written for
one page and hardcodes parts of its shim. Lifting it into something both pages
can use is most of the work here; the assertions above are cheap once it exists.

## What shipped

`test/reviewvm.js`: a zero-dependency mini-DOM (real tree, real
`querySelector`/`closest` over the simple compound selectors review.js uses)
plus a VM loader that runs the real `public/liveness.js` + `public/review.js`.
It has its own selector self-check, wired into `npm run selfcheck`. The six
scenarios above are 21 checks at the head of `test/codereview.js`.

The shared-helper decision went the other way: `buildLivenessVm` stayed in
`test/e2e.js`. Its elements are hollow (`append` is a no-op, `querySelector`
returns a fresh orphan every call), which is fine for app.js — it only reads and
writes known nodes by id — and nowhere near enough for review.js, which builds
the diff table and then navigates it. Making that shim real means changing it
under 4000 lines of passing plan tests. Two harnesses, e2e.js untouched. If a
third page ever needs a DOM, `test/reviewvm.js` is the one to move.

Each of the six behaviours was mutation-tested: breaking it one at a time makes
the new checks fail.
