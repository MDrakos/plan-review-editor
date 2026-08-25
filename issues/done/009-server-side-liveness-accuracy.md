# Enhancement: server-side liveness accuracy (the 001 optional server assist)

**Type:** enhancement (robustness)
**Status:** done — merged 2026-07-08 in PR #11
**Area:** `server/server.js` (session activity timestamp, status/events payload), `public/app.js` (liveness hint)
**Builds on:** 001 (client-only working-overlay liveness)

## Problem

001 shipped a client-only liveness cue: while `status === 'working'`, the overlay shows an elapsed timer and, past a threshold with no `progress` event, a "may be stuck" hint. Because it has no server timestamp, the elapsed timer restarts from `0:00` on a page refresh, and the staleness hint keys only off `progress` (which a healthy agent may legitimately not send during a silent rework). 001 called this out and deferred the server assist as optional.

## Proposed enhancement (the deferred assist)

1. Track `lastAgentActivity` on the session, bumped in `/agent/wait`, `/agent/progress`, and `/agent/present`.
2. Expose it on the status / `/events` payload the client already consumes.
3. Base the client's elapsed timer and staleness hint on real agent activity rather than progress alone, so the timer is exact and survives a refresh.
4. Persist `lastAgentActivity` with the rest of the serializable state (005) so it round-trips a restart.

## Acceptance criteria

- Refreshing the page mid-rework shows the correct elapsed time, not a reset to `0:00`.
- The staleness hint reflects real agent activity (wait/progress/present), not just progress events.
- No change to the status state machine; normal rework and terminal states look as they do today.
- Single-reviewer and multi-reviewer sessions behave identically with respect to liveness.

## Code pointers

- `issues/done/001-working-overlay-liveness-hint.md` — the "Optional server assist" section this implements.
- `server/server.js` — `/agent/wait`, `/agent/progress`, `/agent/present`, the status/events payload, and `persist`/restore (005).
- `public/app.js` — the working overlay timer and staleness hint from 001.
