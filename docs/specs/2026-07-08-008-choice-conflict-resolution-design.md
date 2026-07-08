# Design: richer choice-conflict resolution (issue 008)

**Status:** approved (Captain, 2026-07-08, via plan-review) · **Builds on:** 004 (per-reviewer choices + surfaced split)
**Files:** `server/server.js` (choice model, `/api/review-state`, `reviewBundle`), `public/app.js` (choice block UI + 004 divergence hint)

## Problem

004 stores choices per reviewer as `{ choiceId: { reviewerId: option } }` and shows a muted "reviewers disagree" hint when picks diverge, but gives reviewers no way to *resolve* the disagreement — the raw split is passed to the agent as-is. 008 lets reviewers converge on a shared decision before submitting, without a heavy locking flow (this is a localhost, collaborative-but-trusting tool).

## Decisions settled (brainstorm, 2026-07-08)

1. **Resolution model:** an explicit, **attributed "resolve to option X"** action. Any reviewer can set or change it; it is visible to all and reversible. No voting, no agent adjudication, no locking.
2. **What the agent receives:** the **resolved value (with who resolved it) *plus* the raw per-reviewer split** — no silent loss. Unresolved choices behave exactly as 004 today (raw split only).
3. **Lifecycle:** a resolution **persists until explicitly changed or cleared** — it is independent of the raw picks, so a reviewer changing their own pick never silently undoes an agreed resolution. Re-opening is a deliberate clear.
4. **Optional reasoning:** a resolution may carry an optional free-text **`reason`** (why this option) — surfaced in the UI and passed to the agent. Optional and low-friction; empty when not provided.

## Architecture

A resolution is a **single shared value per choice** (not per-reviewer), stored parallel to the existing per-reviewer picks so 004's data and code paths are untouched.

### Data model (server)

New parallel map on the in-progress review:

```
s.review.resolutions = { choiceId: { option, by: reviewerId, byName, at, reason } }
```

`reason` is an optional free-text string (why this option was chosen); omitted/empty when the reviewer doesn't supply one.

- Absent entry = unresolved (the 004 default). Single-reviewer and all-agree sessions never create one → no behavior change.
- The resolution is orthogonal to `s.review.choices`; 004's `mergeChoices` is unchanged.

### Server endpoints

- **`/api/review-state` (POST)** gains an optional `resolutions` field carrying the poster's set/clear intent: `{ choiceId: { option, reason? } }` (or a bare `{ choiceId: option }`) to set/change, `{ choiceId: null }` to clear. The server:
  - validates `option` is one of that choice block's options (ignore otherwise),
  - records `{ option, by: posterId, byName, at, reason }` (last-writer-wins on the shared slot; `reason` optional),
  - broadcasts the review delta to peers over the existing SSE fan-out (same path 004 uses for choice picks).
- **`reviewBundle(s, body, posterId)`** emits, per choice:
  - resolved → `{ resolved: { option, by, reason }, picks: { reviewerId: option } }` (`reason` omitted/empty when absent)
  - unresolved → `{ picks: { reviewerId: option } }` (exactly as 004 today).

### UI (client, `public/app.js`)

In a choice block that is currently divergent (the existing "reviewers disagree" condition):
- render a **"Resolve to:"** control listing the block's options;
- clicking sets the resolution, with an **optional reason input** the reviewer may fill (why this option); the block then shows **"Resolved to <option> — by <name>"** (name colored by reviewerId, matching 004 attribution) and the reason if given, with controls to **change** (pick another / edit reason) or **clear**;
- any reviewer can change/clear; updates sync live to peers via 004's peer-review SSE (visible within a second or two).

**No-friction guard:** the resolve control appears **only on divergence**. A single reviewer, or reviewers who agree, see the block exactly as they do in 004 today.

### Persistence (005)

`s.review.resolutions` is added to the serializable review state, so a resolution round-trips a server restart alongside comments and choices.

## Resolution lifecycle (decided: persists)

A resolution **persists until a reviewer explicitly changes or clears it** — it is an explicit shared decision, independent of the raw picks. Changing your own pick after a resolution never silently undoes it; the raw picks still travel in the bundle so the change stays visible, and re-opening the choice is a deliberate **clear**. (Rejected: auto-clearing on any pick change, which can silently discard an agreed decision.)

## Error handling

- Resolve for an unknown `choiceId`, or an `option` not in the block → ignored (validated server-side).
- Concurrent resolves → last-writer-wins on the single shared slot; the SSE broadcast keeps all tabs consistent.
- A pre-008 persisted session (no `resolutions` key) restores as all-unresolved.

## Testing (e2e, `test/e2e.js`)

- Two reviewers diverge → one resolves (with a `reason`) → both tabs show the resolution + attribution + reason.
- Change the resolution → reflected on both; clear → back to the unresolved split + "disagree" hint.
- Submit bundle: resolved choice carries `resolved` (incl. `reason` when set) + raw `picks`; unresolved choice carries `picks` only (matches 004).
- Single reviewer / all-agree → no resolve control, behavior identical to 004.
- Persistence: a resolution (with its `reason`) round-trips a restart.
- Lifecycle: after a resolution, a reviewer changing their pick leaves the resolution intact; only an explicit clear re-opens it.

## Out of scope (YAGNI)

Voting/tallies, agent adjudication, per-reviewer resolutions, resolving a non-divergent choice, locking/ownership of a resolution.
