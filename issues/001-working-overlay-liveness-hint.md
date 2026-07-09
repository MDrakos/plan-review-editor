# Enhancement: surface agent liveness while the review is in the "working" state

**Type:** enhancement (UX robustness)
**Status:** done — merged 2026-07-07 in PR #2
**Area:** `public/app.js` (working overlay), `server/server.js` (session status)

## Problem

After a reviewer submits a round, the session goes to `status: 'working'` and the
browser shows the "agent is reworking the plan" overlay (a spinner). That spinner has
**no upper bound and no liveness signal** — it looks identical whether the agent is
busy reworking or has silently died.

If the agent consumes the `submit` event off `GET /agent/wait` but then never calls
`/agent/present` or `/agent/stop` — because it crashed, emitted a tool call the harness
rejected, or is doing a long rework without reporting progress — the reviewer is left
staring at a spinner with no way to tell "still thinking" from "stuck." They have to
guess, and eventually nudge the agent out of band.

### Motivating incident

A reviewer submitted a round; the server captured it and `/agent/wait` returned it
correctly (nothing was lost). The agent then failed to act on it (a malformed tool call
on its side), so it never re-presented. The reviewer's page showed the reworking
spinner indefinitely with no indication anything was wrong, until they manually asked
the agent what was going on. The event pipeline behaved correctly — the gap is purely
that the UI gives the reviewer no visibility into agent liveness during `working`.

## Why it's not trivially detectable server-side

Note for whoever picks this up: during a *legitimate* rework the agent holds **no**
`/agent/wait` long-poll (see `s.waiters`, `server/server.js:49`) — it only reconnects
to `wait` *after* it presents. So "no active waiter" is **not** a death signal; a
healthy reworking agent also has none. The channel that actually indicates life during
`working` is `/agent/progress` (`server/server.js:437`), which the agent calls
voluntarily. Absence of progress is therefore the best available staleness proxy, but
it's soft — an agent can legitimately rework silently.

## Proposed enhancement

Give the reviewer a liveness cue in the working overlay:

1. **Always show elapsed time** in the overlay once `status === 'working'` (e.g.
   "reworking… 0:48"). The client already learns the transition via the `status` SSE
   event (`public/app.js:245`), so it can start a ticking timer with no server change.
2. **Show a staleness hint past a threshold.** Track the timestamp of the last signal
   of life — entering `working`, or the most recent `progress` event
   (`public/app.js:171-182` already renders these). If more than ~30–45 s elapse with
   no new progress, render a muted line under the spinner: "No updates for N s — the
   agent may be stuck." Keep it advisory; do not change status.

### Optional server assist (higher accuracy, more work)

Track `lastAgentActivity` on the session (bump it in `/agent/wait`, `/agent/progress`,
`/agent/present`) and expose it on `/events` / the status payload
(`server/server.js:88, :318`). The client can then base the hint on real agent activity
rather than progress alone. Not required for a first cut — the client-only version
above already closes the visibility gap.

## Acceptance criteria

- While `status === 'working'`, the overlay shows a live elapsed timer.
- After a configurable threshold with no `progress` event, a non-alarming "may be
  stuck / no updates for N s" hint appears; it clears when a `progress` event arrives
  or the reworked document loads (`public/app.js:235`).
- No change to the status state machine; purely additive UI. Terminal states
  (`done` / `ended`) and normal rework (progress → present) look exactly as today.
- Works with the existing SSE stream; no new required server endpoint (server assist is
  optional).

## Code pointers

- `public/app.js:61-69` — `setStatus`; toggles `working-overlay` on `status === 'working'`.
- `public/app.js:171-182` — rework progress rendering (the heartbeat the hint keys off).
- `public/app.js:222, :245-251` — `EventSource('/events')` and `status` event handling.
- `server/server.js:41` — session status states.
- `server/server.js:373-388` — submit → `status: 'working'` + `status` broadcast.
- `server/server.js:437-444` — `/agent/progress` → `progress` broadcast.
- `server/server.js:158-165` — present → `status: 'reviewing'` (clears the overlay).
