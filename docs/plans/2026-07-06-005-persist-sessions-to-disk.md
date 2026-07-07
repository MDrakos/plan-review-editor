# Plan: persist sessions to disk so they survive a server restart (issue 005)

**Path:** Standard · **Source:** `issues/005-persist-sessions-to-disk.md` (design LOCKED, reviewer-approved 2026-07-06) · **File touched:** `server/server.js`, `.gitignore`, `test/e2e.js`

## Objective

Write-through each session's *serializable* state to a per-session file and restore it on
startup, so a crash / restart / idle-shutdown no longer loses an open review. Implement the
LOCKED decisions exactly — do not re-litigate.

## Design (from the locked spec)

- **Serialize** `id, status, doc, review, submissions, chat, progress, queue, touched`.
  Never persist `sse`, `waiters`, or the `res`/timer objects inside them.
- **Storage:** default `path.join(process.cwd(), '.sessions')`; override with
  `PLANREVIEW_STATE_DIR`. `.sessions/` is gitignored.
- **On by default;** `PLANREVIEW_PERSIST=0` disables all disk I/O (no read, no write, no delete).
- **`persist(s)`** — schedule-once debounce (~250ms/session): the first mutation schedules a
  flush 250ms out; further mutations inside the window don't reschedule; the flush serializes
  the *current* session state at fire time (so it captures every mutation up to that point) and
  writes it **atomically** (write `<id>.json.tmp` in the same dir, then `rename`).
- **Delete** a session's file (and cancel any pending debounce timer, so a scheduled write can
  never resurrect a deleted file) in `removeSession` — which is the single teardown path for
  both the abandon sweep and `/agent/stop`.
- **Restore** before `server.listen`: read every `*.json`, rebuild each session with fresh
  empty `sse`/`waiters`, keep the persisted `queue`; a corrupt/unreadable file is logged and
  skipped, never fatal. Restored sessions live in the map so the idle timer doesn't fire and the
  abandon sweep still reaps stale ones.

## Mutation sites that call `persist(s)`

`loadDoc` (covers `/agent/start` + `/agent/present`), `/api/chat`, `/api/end`,
`/api/review-state`, submit/approve, `/agent/progress`. (`/agent/wait` deliberately does **not**
persist — the locked spec omits it; delivery is at-least-once by design.)

## Tasks (TDD — failing test first, watch fail, minimal pass, watch pass, commit)

### T1 — Persistence module scaffolding + config
Add near the other env config: `PERSIST` (default on, `PLANREVIEW_PERSIST=0` off),
`STATE_DIR` (`PLANREVIEW_STATE_DIR` || `process.cwd()/.sessions`), `PERSIST_DEBOUNCE_MS`
(default 250, env-overridable for tests: `PLANREVIEW_PERSIST_MS`).
Helpers: `sessionFile(id)`, `ensureStateDir()`, `serialize(s)`, `writeSession(s)` (atomic),
`persist(s)` (debounced), `deleteSession(s)` (clear timer + unlink), `restoreSessions()`.

### T2 — `serialize(s)` persists exactly the serializable keys, never the live handles
Test: build a session, `serialize` it, assert keys === {id,status,doc,review,submissions,chat,
progress,queue,touched} and that `sse`/`waiters` are absent. (Covers FMEA: leaking a live
handle into JSON would throw or corrupt the file.)

### T3 — atomic write (temp + rename), debounced
Test via e2e: after a mutation, within ~debounce the `<id>.json` appears and parses; a partial
`.tmp` is never what gets loaded (rename is atomic). Bursts coalesce (schedule-once).

### T4 — `kill -9` restore path (**required by brief**)
e2e: spawn `node server/server.js` directly with a temp `PLANREVIEW_STATE_DIR`; start a session,
present a doc with a `choice`, post review-state (comments+choices), submit (→ submissions +
status working), post progress. Wait for the debounce flush. `SIGKILL` the process. Respawn with
the same env. Assert `/api/state` re-hydrates: doc title+version, review comments+choices,
chat, progress, submissions (via a second present round or state), status — and `/s/<id>` 200s.

### T5 — queued-event-survives-restart (**required by brief**)
e2e: start a session, post `/api/chat` (or submit/end) with **no** waiting agent so it queues;
wait for flush; `SIGKILL`; respawn; the next `/agent/wait` returns that exact event.

### T6 — deletion & no-resurrection
e2e: `/agent/stop` deletes `<id>.json`; a debounce timer scheduled just before stop does not
recreate the file. Abandon-sweep removal also deletes the file. `PLANREVIEW_PERSIST=0` writes
nothing to `STATE_DIR`.

### T7 — corrupt file skipped, not fatal
e2e/unit: write a garbage `<id>.json` into `STATE_DIR`, plus one valid file; restart; server
comes up, logs a skip for the bad file, serves the good session. Startup never throws.

### T8 — lifecycle intact
Confirm existing idle-shutdown + abandon-sweep tests still pass; a restored-but-stale session
(old `touched`, no tab, no waiter) is reaped by the sweep.

## Verification

- `npm test` (node test/e2e.js) — all existing checks + new T2–T8 checks pass.
- Manual: `/verify` — drive start → mutate → kill -9 → restart → confirm re-hydration in the app.
- Lint/format per repo convention (Prettier config if present).

## G4 enumeration outcomes (folded into design + tests)

**STRIDE:** not triggered (localhost-only, crypto-random session-id filenames, no user-supplied
paths, no new trust boundary).

**FMEA (18 modes) — the ones that shape the code:**
- **FM-1 (High):** the debounce flush runs in a `setTimeout` callback, *outside* the request
  try/catch → `writeSession` wraps every fs op in try/catch + logs; a disk error never crashes
  the process. Test: point `STATE_DIR` at an unwritable path, drive a mutation, assert `/health`
  still answers.
- **FM-3 (High):** writes are **synchronous** (`writeFileSync`+`renameSync`) — no async in-flight
  window to race `unlink`. `deleteSession` clears the pending debounce timer; the fire callback
  also gates on `sessions.has(id)`. Test: mutate then immediately stop, assert file stays absent.
- **FM-4 (High):** `restoreSessions()` is synchronous and runs before `server.listen`. Test: a
  pre-seeded file resolves on the very first request (no spurious 404).
- **FM-6 (Med):** `serialize` includes `doc.blocks` so the next `present` diff marks only changed
  blocks. Test: present v1 → kill → restore → present v2, assert only the edited block is marked.
- **FM-7 (Med):** restore skips corrupt / 0-byte / missing-id files (log-not-fatal). Test: seed
  garbage + empty + a good file, assert server up + good session served.
- **FM-10 (Med):** flush deletes its timer entry so the *next* mutation reschedules. Test:
  mutate A → flush → mutate B → flush, assert the file reflects B.
- **FM-12 (Med):** `PLANREVIEW_PERSIST=0` does no read/write/delete. Test: mutate under `=0`,
  assert `STATE_DIR` stays empty and stop doesn't throw.
- **FM-13 (Med):** restore honors persisted `touched` so the abandon sweep still reaps a
  restored-but-stale session (and deletes its file). Requires the sweep interval to be
  configurable to test fast — added `PLANREVIEW_SWEEP_MS` (default **unchanged** 60000; only a
  test knob, same as the existing `PLANREVIEW_IDLE_MS`/`PLANREVIEW_ABANDON_MS`).
- **FM-14 (Med):** restore only loads `<id>.json` (so a leftover `<id>.json.tmp` is ignored) and
  best-effort cleans orphan `.tmp` files on startup.
- **FM-15 (Med):** `serialize` is an explicit key allowlist, not copy-and-delete. Test: exact key
  set, `sse`/`waiters`/timers absent.
- **FM-2 (accepted):** the `STATE_DIR` default is cwd-relative per the locked spec; an absolute
  `PLANREVIEW_STATE_DIR` is the robust override. Not changing the CLI spawn (out of locked scope).
- **FM-5 (accepted):** `/agent/wait` deliberately does not persist → at-least-once delivery
  (locked). **FM-17 (accepted):** `/api/end` persists `status:'ended'` but deletion happens at
  `removeSession` (stop/sweep) per locked decision 6 — so an end event survives a restart in the
  end→stop window (a feature, not a leak).

**DSM:** confined to `server.js`; no new cycles. Two Maps keyed by id (`sessions`,
`persistTimers`) with `keys(persistTimers) ⊆ keys(sessions)` — every teardown touches both.
Ordering invariant: `restoreSessions()` before `server.listen`'s `armIdleShutdownIfEmpty()`.
`removeSession` is the single teardown → the only `deleteSession` caller.

## Tests (final set: P1–P7 in a persistence phase appended to `test/e2e.js`)

P1 kill-9 restore (doc/version/review/choices/chat/progress/status + submissions round-trip +
`/s/<id>` 200 + FM-6 blocks diff) · P2 queued-event survives restart · P3 stop deletes file, no
resurrection · P4 corrupt/empty/missing-id skipped, not fatal · P5 `PERSIST=0` writes nothing +
stop no-throw · P6 restore-before-listen first-request 200 (FM-4) · P7 restored-stale session
reaped by sweep + file deleted (FM-13).

## Out of scope

No change to idle-shutdown / abandon-sweep timing, SSE, the CLI, or the wire protocol beyond
persistence. No persistence of live connections. `/agent/wait` stays non-persisting.
