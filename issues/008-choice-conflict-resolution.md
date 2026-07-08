# Enhancement: richer choice-conflict resolution

**Type:** enhancement (feature, likely a short brainstorm first)
**Status:** open, groomed 2026-07-07
**Area:** `server/server.js` (choice model, submit bundle), `public/app.js` (choice block UI)
**Builds on:** 004 (per-reviewer choices + surfaced split)

## Problem

004 stores choices per reviewer (`{choiceId: {reviewerId: option}}`) and surfaces a divergence as a muted hint, but it does not help reviewers *resolve* the disagreement. When two reviewers pick different options for the same choice block, the split is simply passed to the agent as-is. For a shared decision, reviewers often want to converge before submitting. The README lists richer conflict resolution as a next step.

## Current behavior (grounding)

- Choices are `{choiceId: {reviewerId: option}}`; the block renders per-reviewer picks and a "reviewers disagree" hint (004).
- The submit bundle carries the full per-reviewer map; the agent sees the split.

## Design decisions to settle (short brainstorm)

- **Resolution model:** a lightweight majority/vote tally, an explicit "agree on X" action any reviewer can set (with attribution), or leave it to the agent to adjudicate and explain. Pick one; avoid a heavy locking flow (out of character for a localhost tool).
- **What the agent receives:** the resolved value plus the raw split, or just the raw split with a resolution hint.

## Proposed enhancement (starting point)

1. Add an explicit, attributed "resolve to option X" action on a divergent choice block that any reviewer can set or change; show who resolved it and to what.
2. Include both the raw per-reviewer picks and the resolved value (if any) in the submit bundle so the agent has full context.
3. Keep the un-resolved split behaving exactly as 004 does today when no one resolves it.

## Acceptance criteria

- Two reviewers disagreeing can converge to one option via an explicit, attributed action visible to both.
- The submit bundle carries the resolution plus the original split, with no silent loss.
- A single reviewer, or reviewers who agree, see no new friction; behavior matches 004.

## Code pointers

- `server/server.js` — the `{choiceId: {reviewerId: option}}` choice model, `/api/review-state`, `reviewBundle`.
- `public/app.js` — choice block rendering and the 004 divergence hint.
