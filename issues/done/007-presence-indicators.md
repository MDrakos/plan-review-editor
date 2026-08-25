# Enhancement: presence indicators (who is viewing the session now)

**Type:** enhancement (feature)
**Status:** done — merged 2026-07-08 in PR #9
**Area:** `server/server.js` (SSE connect/disconnect, presence set), `public/app.js` (presence UI)
**Builds on:** 004 (reviewer identity + attribution), the existing SSE fan-out

## Problem

After 004, a session can have several attributed reviewers, but nobody can tell who is currently *there*. There is no live roster of active reviewers, so a reviewer cannot see that a colleague just joined, is still watching, or has left. The README lists this as a next step.

## Current behavior (grounding)

- `s.sse` is a Set of open browser connections; `broadcast` already fans out to all of them (`server/server.js`).
- 004 gives each browser a `reviewerId` (+ optional name) in localStorage, sent as `author:{id,name}` on mutations.
- SSE connect registers into `s.sse`; `req.on('close', ...)` removes it. There is no presence tracking keyed by reviewer.

## Proposed enhancement

1. On SSE connect, carry the reviewer's `id` and `name` (query param or first message) so the server can maintain a presence map of active reviewers per session (id, name, connectedAt, tab count).
2. Broadcast a `presence` SSE event when a reviewer joins or leaves (debounced), reusing the existing fan-out.
3. Render a small live presence strip in the client (avatars/initials colored by reviewerId, consistent with 004's attribution colors).
4. Handle multiple tabs per reviewer (one presence entry, N connections) and clean up on the last disconnect.

## Acceptance criteria

- Opening a second tab as a distinct reviewer makes the first tab show that reviewer as present within a second or two.
- Closing all of a reviewer's tabs removes them from the presence strip.
- A single-reviewer session shows just that reviewer (or nothing), with no behavior change to the review loop.
- Presence is derived state, never persisted; a restored session (005) comes back with an empty presence set until tabs reconnect.

## Code pointers

- `server/server.js` — `s.sse` Set, `broadcast`, the SSE connect handler and its `req.on('close')`.
- `public/app.js` — `EventSource('/events')` and the SSE event handlers; 004's reviewer identity + attribution colors.
