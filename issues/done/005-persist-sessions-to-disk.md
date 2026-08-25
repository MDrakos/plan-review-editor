# Enhancement: persist sessions to disk so they survive a server restart

**Type:** enhancement (robustness) — **scheduled for implementation**
**Status:** done — merged 2026-07-07 in PR #5
**Area:** `server/server.js` (session lifecycle, all mutation sites, startup restore)

## Problem

All session state is in-memory (`const sessions = new Map()`, `server/server.js:32`).
If the server process goes away — a crash, a machine restart, or the project's *own*
restart-on-stale-code and idle-shutdown mechanisms — every open review is lost: the
document, in-progress comments, chat, submissions, rework progress, and status all
vanish, and the session id the agent is holding stops resolving (`GET /agent/wait`
returns 404 `no such session`, `server/server.js:312-313`).

Concretely: a reviewer half-way through annotating a plan loses their un-submitted
comments if the server bounces; an agent that presented and is blocked on `wait` loses
the entire session out from under it.

## Current behavior (grounding)

- `createSession` builds an in-memory object (`server/server.js:34-55`) holding
  serializable state (`doc`, `review`, `submissions`, `chat`, `progress`, `status`,
  `touched`) **and** live, non-serializable handles (`sse: Set`, `waiters: []` holding
  live `res` objects and timers, `queue: []` of pending agent-event payloads).
- Nothing is ever written to disk. Lifecycle timers only *remove* sessions:
  `IDLE_SHUTDOWN_MS` exits the process when empty (`:99-105`); the abandon sweep reaps
  stale sessions (`:112-117`); `/admin/shutdown` exits for a stale-code restart (`:274`).
- Mutations happen across many handlers: `loadDoc` (`:149`), `/api/chat` (`:340`),
  `/api/review-state` (`:360`), `/api/end` (`:352`), submit/approve (`:373`),
  `/agent/present` (`:390`), `/agent/progress` (`:437`).

## Proposed enhancement

Write-through each session's **serializable** state to a per-session file and restore on
startup.

1. **Serialize** everything except live handles: persist `id`, `doc`, `review`,
   `submissions`, `chat`, `progress`, `status`, `touched`, and the **pending
   `queue`** of agent events (see decision 3). Never persist `sse`, `waiters`, or the
   `res`/timer objects inside them — they're reconstructed empty on restore.
2. **Write-through, debounced.** A `persist(s)` helper (debounced ~250ms per session)
   called from every mutation site above. Debounce keeps chat/progress bursts from
   hammering the disk while still surviving a hard `kill -9`.
3. **Restore on startup.** Before `server.listen`, load each file, rebuild the session
   with fresh empty `sse`/`waiters`; queued events replay to the next `/agent/wait`.
   Browsers reconnect their SSE and re-hydrate via `/api/state` as they already do.
4. **Delete** a session's file in `removeSession` (`:63`) and on `/agent/stop` (`:448`).
5. Lifecycle timers (idle-shutdown, abandon sweep) are unchanged; a restored-but-stale
   session is still reaped by the abandon sweep.

## Design decisions — LOCKED (reviewer-approved 2026-07-06)

1. **Storage location:** repo-local **`.sessions/`**, gitignored. Self-contained to the
   checkout and easy to inspect. (Allow a `PLANREVIEW_STATE_DIR` override, but default to
   `.sessions/` in the repo/cwd root.)
2. **On by default**, with `PLANREVIEW_PERSIST=0` to disable.
3. **Persist the pending agent-event `queue`: yes.** A restart mid-rework must not
   silently drop the reviewer's already-captured submit/chat/end event. (This is the same
   failure class Issue 001 addresses; persistence must not reintroduce a lost-event path.)
4. **Write strategy:** debounced write-through (~250 ms per session), **atomic** (write a
   temp file + rename). Survives `kill -9`, not just graceful shutdown.

## Acceptance criteria

- `kill -9` the server mid-review, restart it → the session, its document + version,
  in-progress comments, choices, chat, submissions, progress, and status are all
  restored; the `/s/<id>` URL resolves and re-hydrates.
- A queued-but-undelivered agent event (submit/chat/end) survives the restart and is
  delivered to the next `/agent/wait` (decision 3).
- Restored sessions come back with **empty** `sse`/`waiters`; no attempt is made to
  serialize or revive live connections; the browser's own SSE reconnect repopulates them.
- `stop`/removed/ended sessions have their files deleted — no leak, no resurrection.
- Existing idle-shutdown and abandon-sweep behavior is intact.
- Writes are atomic (no torn/partial file ever loaded); a corrupt file is skipped, not
  fatal to startup.

## Code pointers

- `server/server.js:32` — `sessions` Map (the thing being persisted).
- `server/server.js:34-55` — `createSession`; separates serializable state from live handles.
- `server/server.js:63-82` — `removeSession` (delete the file here).
- `server/server.js:149-165` — `loadDoc` (a mutation site).
- `server/server.js:99-117` — idle-shutdown + abandon sweep (unchanged; restore interacts here).
- `server/server.js:340,352,360,373,390,437` — mutation sites that must trigger `persist`.
- `server/server.js:448-455` — `/agent/stop` (delete the file).
- `server/server.js:467-470` — `server.listen` (restore runs before this).
