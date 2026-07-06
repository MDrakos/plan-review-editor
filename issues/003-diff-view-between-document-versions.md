# Enhancement: diff view between document versions

**Type:** enhancement (feature)
**Status:** open — spec written, not yet scheduled
**Area:** `server/markdown.js` (diff rendering), `server/server.js` (version retention),
`public/app.js` (diff toggle)

## Problem

Today's "what changed" cue is one-sided. When the agent re-presents, `renderDiff`
marks *added and changed* blocks in the new document versus the immediately-previous
render, and the reviewer can dismiss the highlight (`public/app.js:102`). That is a
"what's new since last cycle" hint, not a diff:

- **Removals are invisible.** `markChanges` only wraps added/changed blocks in the new
  document; a block that was *deleted* simply isn't there, with no marker
  (`server/markdown.js:217-244`).
- **You can only see one delta.** Only the previous render's block array is retained
  (`s.doc.blocks`, `server/server.js:42`); prior versions' markdown/HTML are discarded
  on each `loadDoc`. There's no way to compare, say, v4 against v1.
- **The delta is ephemeral.** Once dismissed, or after the next round, the change
  highlighting is gone.

## Current behavior (grounding)

- `renderDiff(markdown, prevBlocks)` returns `{ html, blocks }`; `markChanges` wraps
  new/changed blocks only (`server/markdown.js:223-244`).
- `loadDoc` keeps only the latest `blocks` for next time and bumps `s.doc.version`
  (`server/server.js:149-165`); it does not retain prior versions.
- Submissions record `docVersion` (`server/server.js:174`) but not the document content
  at that version.
- Client reloads the whole doc on the `doc` SSE event (`public/app.js:236`); the
  changed-block highlight is dismissible (`public/app.js:102`).

## Proposed enhancement

1. Retain a bounded history of prior versions per session (markdown source is cheapest;
   re-render on demand). A small ring (e.g. last N versions) caps memory.
2. Extend the diff to mark **removed** blocks too — either by teaching `markChanges` to
   emit removal markers between surviving blocks, or a proper line/word diff.
3. Add a UI affordance: "show changes since v N" that renders a before/after (or an
   annotated single view with add/remove/change markers) for a chosen version pair —
   at minimum current-vs-previous, ideally any retained pair.

## Design decisions to settle before implementing

- **Retain source vs. rendered blocks**, and how many versions (memory bound).
- **Diff granularity**: reuse block-level `markChanges` (cheap, coarse) vs. line/word
  diff (finer, more work).
- **Presentation**: annotated single document vs. side-by-side.

## Acceptance criteria

- The reviewer can see what changed between the current version and a prior one,
  **including removals**.
- Arbitrary retained version pairs can be compared (not only current-vs-previous), up
  to the retention bound.
- The existing dismissible per-round highlight still works unchanged.
- Version retention is bounded and documented.

## Code pointers

- `server/markdown.js:223-247` — `markChanges` / `renderDiff` / exports (removals go here).
- `server/server.js:42,149-165` — `doc.blocks` retention and `loadDoc`.
- `server/server.js:174` — submissions carry `docVersion` (candidate anchor for history).
- `public/app.js:87,236` — doc hydration and the `doc` SSE reload.
- `public/app.js:96-113` — the changed-block highlight + dismiss (must keep working).
