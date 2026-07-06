# Enhancement: multiple reviewers on one plan

**Type:** enhancement (feature — likely needs a brainstorming pass first)
**Status:** open — spec written, not yet scheduled
**Area:** `server/server.js` (review model, identity, merge), `public/app.js` (attribution, live sync)

## Problem

A session already *accepts* multiple browser tabs — `s.sse` is a `Set` and `broadcast`
fans out to all of them (`server/server.js:47,121-124`). But the review state underneath
is singular and unattributed, so two people on the same `/s/<id>` URL stomp each other:

- **Comments overwrite wholesale.** `POST /api/review-state` replaces `s.review.comments`
  with the poster's array (`server/server.js:360-366`), last-writer-wins. Reviewer B's
  save clobbers reviewer A's comments.
- **Choices collide.** `s.review.choices` is one shared map; two reviewers picking
  different options for the same choice block silently overwrite each other.
- **No identity.** Every chat message is `role: 'reviewer'` (`server/server.js:344`) and
  every comment is anonymous — you can't tell who said what.
- **Submit mixes everyone.** `reviewBundle` bundles the one shared `s.review` as a single
  submission (`server/server.js:168-176,373-385`); there's no notion of "these are A's,
  these are B's."

## Current behavior (grounding)

- Multiple SSE clients per session already work (`s.sse` Set, `broadcast`).
- `s.review` is a single `{comments, choices}` object (`server/server.js:44`), overwritten
  by `/api/review-state` (`:360`).
- `s.chat` messages carry only `role` and `text` (`server/server.js:344,428`).
- One submit bundles the shared review (`:373-385`).

## Proposed enhancement

1. Introduce a lightweight reviewer identity — ephemeral per-tab id (+ optional display
   name). No auth; this is localhost.
2. Attribute comments, choices, and chat to a reviewer id.
3. Broadcast other reviewers' comments live so reviewers see each other in real time
   (reuse the existing SSE fan-out).
4. Define merge semantics: comments union across reviewers; choice conflicts are
   surfaced (not silently overwritten); submit consolidates without loss.

## Design decisions to settle before implementing (brainstorm)

- **Identity model**: ephemeral per-tab vs. named/remembered reviewers.
- **Choice conflict resolution**: last-writer-wins with attribution, per-reviewer
  choices, or an explicit conflict UI.
- **Submit semantics**: one consolidated bundle for the whole session vs. per-reviewer
  bundles the agent reconciles.

## Acceptance criteria

- Two tabs on one session see each other's comments appear live.
- Each comment / chat message / choice is attributed to a reviewer.
- Submit consolidates all reviewers' input with no silent loss.
- Choice conflicts are surfaced rather than silently overwritten.
- A single-reviewer session behaves exactly as it does today.

## Code pointers

- `server/server.js:47,121-124` — `s.sse` Set + `broadcast` (live sync already fans out).
- `server/server.js:44,360-366` — shared `s.review` and the wholesale `/api/review-state` overwrite.
- `server/server.js:344,428` — chat `role` (identity would attach here).
- `server/server.js:168-176,373-385` — `reviewBundle` + submit (merge semantics live here).
- `public/app.js:403-451` — comment rendering (attribution badges, live inserts).
