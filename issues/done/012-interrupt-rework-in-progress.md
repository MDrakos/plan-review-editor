# Feature: interrupt an in-progress rework

**Type:** feature
**Status:** done — merged 2026-07-14 in PR #21
**Area:** `server/server.js` (status state machine, new `/api/interrupt`, `/agent/present` + `/agent/progress` guards), `public/app.js` + `public/index.html`/`style.css` (reworking overlay control), `docs/PROTOCOL.md`

## Problem

Once a reviewer submits a round, the session goes to `status: 'working'` and the
browser drops the "reworking" overlay over the whole panel. The reviewer is now
locked out: comments, choices, and the submit controls are all behind the
overlay until the agent finishes reworking and calls `present`. If the reviewer
realizes, a second after submitting, that they forgot a comment or picked the
wrong option, they have no recourse. They must wait a full rework round, then
add the forgotten feedback and submit *again* — a wasted round for the agent and
a slow round-trip for the reviewer.

There is no reviewer-initiated way to abort the current round and get back to
editing.

## Proposed feature

Add a reviewer-initiated **interrupt** of an in-progress rework. While
`status === 'working'`, the reworking overlay shows an "Interrupt" control. When
the reviewer triggers it, the session returns to `reviewing` **on the same
document the agent was handed** (the pre-rework doc — which is still `s.doc`,
since the agent has not presented the reworked version yet). All prior comments,
choices, and resolutions are intact. The reviewer adds the forgotten feedback
and re-submits, folding old and new into one bundle.

The agent's now-stale rework is discarded the moment it tries to hand it back:
`present` (and `progress`) are only valid during an active `working` round, so a
`present` after an interrupt returns `409` and the agent loops back to `wait`
for the next round instead of overwriting the doc the reviewer is editing.

### Flow

```
reviewing --submit--> working --interrupt--> reviewing (same doc, feedback intact)
                                   |
                                   +--> agent's stale present()/progress() -> 409
                                        agent goes back to wait for the next round
```

## Design

### Server (`server/server.js`)

1. **New endpoint** `POST /api/interrupt?session=` (browser):
   - `409` unless `s.status === 'working'` (nothing to interrupt otherwise;
     mirrors the submit/approve guard-after-await pattern so two clients racing
     an interrupt are safe).
   - Revert the round: `s.status = 'reviewing'`, `s.workingSince = null`,
     `s.progress = []` (the interrupted round's steps are done).
   - Bump a per-session round marker so a late `present`/`progress` from the
     interrupted round is rejected — e.g. increment `s.roundSeq` (captured into
     each `submit`) and/or simply rely on the `status !== 'working'` guard below,
     which is sufficient because `present` is only ever a rework re-present.
   - `touch(s)`, `broadcast(s, 'status', statusPayload(s))`, `persist(s)`.
   - Enqueue an `interrupt` agent event so a timeout-looping agent that happens
     to be back on `wait` learns immediately (see protocol note below). The doc
     is untouched, so the browser's existing `status` SSE handler clears the
     overlay with no new doc load.

2. **Guard `/agent/present`**: reject with `409 { error: 'no active rework round
   (interrupted); wait for the next round' }` when `s.status !== 'working'`.
   Today `present` calls `loadDoc` unconditionally, and `loadDoc` sets status to
   `reviewing`; without this guard a stale rework would silently replace the
   document the reviewer is now editing. `present` is only ever the rework
   re-present (the initial doc comes from `/agent/start`), so gating it on
   `working` is safe.

3. **Guard `/agent/progress`**: same `409` when `s.status !== 'working'`, so the
   agent notices the interrupt promptly rather than pushing steps into a
   cleared, no-longer-visible overlay.

### Client (`public/app.js`, `index.html`, `style.css`)

- Add an "Interrupt" button to the reworking overlay (near the elapsed timer /
  "still working" advisory). `POST /api/interrupt`; on `409` it just means the
  agent already presented — ignore and let the incoming `doc`/`status` settle.
- The existing `status` SSE handler already transitions the UI out of `working`;
  a `working -> reviewing` with no new `doc` version must land cleanly on the
  current document with the panel editable and prior comments/choices rendered
  (this is the same resync path a `review` delta uses; verify it does not wait
  for a `doc` event).
- Optional confirm ("Interrupt rework and go back to editing?") to avoid a
  fat-finger abort — keep it light.

### Protocol (`docs/PROTOCOL.md`)

- Document the new `interrupt` event in the events section: the reviewer aborted
  the current round; stop reworking, do **not** present, go back to `wait`. Note
  it may also surface as a `409` from `present`/`progress` for an agent that was
  busy (not waiting) when the interrupt landed — treat that `409` identically:
  discard the in-flight rework and `wait` again.
- Add `POST /api/interrupt` and the `present`/`progress` `working`-only guards to
  the HTTP reference table.

## Acceptance criteria

- While `status === 'working'`, the reviewer can interrupt; the overlay clears
  and the panel returns to `reviewing` on the **same document**, with all
  comments, choices, and resolutions intact.
- After an interrupt, `POST /agent/present` and `POST /agent/progress` return
  `409` and do **not** mutate the document or status; the agent's flow is to
  `wait` again.
- The reviewer can then add feedback and submit a new round normally; the new
  bundle carries the prior feedback plus the additions.
- `POST /api/interrupt` returns `409` when the session is not `working`
  (`reviewing`, `done`, `ended`, `idle`).
- `workingSince`/`lastAgentActivity` liveness and the state machine are
  otherwise unchanged; a browser refresh right after an interrupt shows
  `reviewing`, not a stuck overlay.
- Multi-reviewer: any reviewer may interrupt; the `status` broadcast clears the
  overlay for every open tab.
- Interrupt state round-trips a server restart (persisted like the rest of the
  session state, 005).

## Code pointers

- `server/server.js:998` — `/api/submit` + `/api/approve`: the guard-after-await
  pattern and the `reviewing -> working` transition to mirror.
- `server/server.js:422` — `loadDoc` sets `status = 'reviewing'`; the reason
  `present` needs a `working` guard.
- `server/server.js:1021` — `/agent/present`; `server/server.js:1092` —
  `/agent/progress`.
- `public/app.js:181,447,461` — the working overlay, its elapsed timer, and the
  "still working" advisory where the Interrupt control belongs.
- `docs/PROTOCOL.md:69` (`submit` event) and the HTTP reference table (line ~329).
- `issues/done/009-server-side-liveness-accuracy.md` — the liveness timestamps this
  must leave unchanged.

## Out of scope

- Delivering an addendum to a *still-running* agent (the "pause and amend"
  variant). This feature discards the in-flight rework; it does not fold
  mid-flight feedback into it.
- Interrupting anything other than a rework (`approve`/`end` are already
  terminal).
