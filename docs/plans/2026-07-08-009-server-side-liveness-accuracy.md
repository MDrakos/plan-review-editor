# Plan: server-side liveness accuracy (issue 009)

**Path:** Standard · **Source:** `issues/done/009-server-side-liveness-accuracy.md` (the deferred
"optional server assist" from `issues/done/001-working-overlay-liveness-hint.md`) · **Files touched:**
`server/server.js`, `public/app.js`, `test/e2e.js`

## Objective

001 shipped a client-only liveness cue for the `working` overlay: an elapsed timer and a
staleness hint, both driven purely by the browser's own clock and SSE events. Neither survives a
page refresh (the elapsed timer resets to `0:00`), and the staleness hint only resets on
`progress` events even though `wait` and `present` are equally valid signs the agent is alive.
This plan adds the server-side timestamp tracking 001 deferred, without changing the status state
machine or the normal (non-refreshed) on-screen behavior.

## Design

Two new fields on the session, alongside the existing `status`:

- **`lastAgentActivity`** (ms epoch | `null`) — the last time the agent did something server-side:
  bumped in `loadDoc` (shared by `/agent/start` and `/agent/present`), in `GET /agent/wait` (on
  receipt, whether the event resolves immediately or later), and in `POST /agent/progress`.
- **`workingSince`** (ms epoch | `null`) — when the *current* `working` round began. Set in the
  submit/approve handler exactly when a submit (not an approve) flips status to `working`; cleared
  back to `null` in `loadDoc` when the round ends (status returns to `reviewing`).

These are deliberately separate. `lastAgentActivity` answers "is the agent still alive" (the
staleness hint); `workingSince` answers "how long has this round been running" (the elapsed
timer). Collapsing them into one field would make the elapsed timer jump backwards every time the
agent reports progress — a real behavioral change AC3 rules out. The staleness reference the
client should use is `max(workingSince, lastAgentActivity)`, so a stale `lastAgentActivity` left
over from a *previous* round can never make a brand-new round look instantly stale (mirrors 001's
original "entering working also counts as a signal" design).

**Exposure:** both fields go on `GET /api/state` and on every `status` SSE broadcast (all three
call sites — `/api/end`, submit/approve, `/agent/stop`). Extra fields are harmless on broadcasts
that leave `working`; the client only reads them when handling a transition *into* `working`.

**Persistence (005):** both fields join the serializable allowlist (`blankSession` default,
`serialize`, `restoreSessions`), restored defensively (wrong type / missing → `null`, same pattern
as the other restore guards) so a hand-edited or pre-009 session file never booby-traps startup.

**Client (`public/app.js`):** `setStatus(status, activity)` gains an optional second argument;
`startWorkingTimer(activity)` seeds `workingStartTs` and `lastSignalTs` from it, validating each
field with `Number.isFinite` (not a bare `??`/`||`) before use, falling back to `Date.now()` /
`workingStartTs` respectively on anything missing or non-numeric — see FM-4 below for why a loose
fallback isn't safe here. Two call sites pass `activity`: `fetchState()` (boot / refresh — the case
that's currently broken) and the `status` SSE handler (already carries the fields from the
broadcast). Everything else — `noteAgentSignal()`, `tickWorking()`, `updateStaleHint()`, the
progress-event wiring — is untouched, so a live (non-refreshed) tab behaves exactly as it does
today (AC3): the existing DOM-shim test (`driveLivenessWiring` in `test/e2e.js`), which fires bare
`{status: 'working'}` events with no timestamps, must keep passing unmodified.

## Failure Modes (FMEA)

- **FM-1 — Restore guard gap.** A hand-edited or pre-009 session file has either field missing or
  as a non-number. `restoreSessions` type-guards each field exactly like `touched`
  (`typeof === 'number' ? value : null`). Test: a fixture file with `lastAgentActivity: "yesterday"`
  and no `workingSince` key restores both as `null`.
- **FM-2 / FM-11 — Stale `workingSince` on a non-`working` status.** `/agent/stop` can fire while
  `status === 'working'`, and the `status` broadcast now carries `workingSince` on *every*
  transition including into `ended`/`done`. Resolved by construction, not by scrubbing the field on
  write: `setStatus` only ever calls `startWorkingTimer` on a transition *into* `working` (existing
  `wasWorking` guard), so a stray `workingSince` alongside `status: 'ended'` is inert. T3 adds an
  explicit test proving this (stop mid-working → clean teardown, not just "doesn't crash").
- **FM-3 — `/agent/wait`'s bump is never separately flushed.** `/agent/wait` calls `touch(s)` but,
  per 005's locked design, deliberately never calls `persist(s)` (a hot polling path). Bumping
  `lastAgentActivity` there inherits the same trade-off: a crash after a run of bare `wait` calls
  with no other mutation loses that one timestamp on disk. Accepted, not fixed — `/agent/wait`
  structurally can't fire while `status === 'working'` anyway (001's own note: a legitimate rework
  holds no open wait), so the gap can't affect the staleness hint in the state where it matters.
- **FM-4 — NaN propagation into the staleness hint.** `Math.max(x, y)` coerces a non-numeric string
  to `NaN`, and `stalenessHint`'s guard `!(msSinceSignal >= threshold)` evaluates a `NaN` comparison
  as `false` → hint fires *unconditionally* ("No updates for NaN s"). Resolved by validating with
  `Number.isFinite` before the seed, not a bare nullish/OR fallback (those only catch
  `null`/`undefined`/`0`, not garbage strings). T3 tests this directly.
- **FM-5 — `approve` must not set `workingSince`.** Test asserts `workingSince === null` after
  approve, not merely that the overlay is hidden (the field is exposed on `/api/state` regardless
  of status, so a leak here is observable even if invisible today).
- **FM-6 — Concurrent submit/approve race.** The existing check-then-act guard already serializes
  `status` writes for the two-concurrent-submits case (`test/e2e.js` "FM-3: exactly one concurrent
  submit wins"); extend that test to assert `workingSince` is set exactly once and consistent with
  the winning status, since the new write rides the same synchronous block.
- **FM-7 — Multi-reviewer parity** — see T4.
- **FM-8 / FM-10 — Backward/forward compatibility.** An old cached `app.js` ignores the two new
  JSON keys (no behavior change); a new `app.js` against an old server (or the DOM-shim's bare
  `fakeState`/SSE payloads, which carry neither field) must degrade to exactly today's
  stamp-`Date.now()`-on-transition behavior. This is what makes `driveLivenessWiring` the
  regression gate for the whole change — it is the one test allowed zero behavioral drift.
- **FM-9 — Clock skew (future timestamp).** A restored/skewed `workingSince` in the future yields a
  negative delta; already handled downstream by `formatElapsed`'s and `stalenessHint`'s existing
  negative/NaN clamps (`test/liveness.js` pure tests) — T3 adds a seed-path test to confirm the
  clamp still holds when the *input* is a future timestamp, not just a negative computed delta.

## Structural notes (DSM)

- **Session-shape quadruple.** `blankSession` / `serialize` / `restoreSessions` / the mutation
  sites must all agree on the two new fields — `serialize`'s allowlist is deliberately silent on a
  forgotten field (by design, per its own comment), so this is a manual-diligence risk, not one the
  code catches for you.
- **Shared `statusPayload(s)` helper.** The three `status` broadcast call sites (`/api/end`,
  submit/approve, `/agent/stop`) plus `/api/state` currently each build their own status-shaped
  object inline. Rather than duplicate `{status, lastAgentActivity, workingSince}` four times
  (exactly the kind of spot where one site gets missed), add one helper and use it at all four.
- **The actual `/agent/wait` write site.** "Bump on receipt" means *inside the `/agent/wait`
  handler itself*, at the top alongside the existing `touch(s)` — NOT inside `enqueueAgentEvent`'s
  waiter-resolution branch (which fires later, from `/api/chat`/`/api/end`/submit, and represents
  the *browser's* action, not new agent activity). One write site, no duplication across
  `enqueueAgentEvent`'s three callers.
- **`workingSince` clears unconditionally in `loadDoc`**, alongside the existing
  `s.status = 'reviewing'` line — not as a conditional on the prior status. `loadDoc` always means
  "the round that was running, if any, just ended."
- **Blast radius confirmed clear:** `bin/planreview.js`'s `status` command reads an explicit field
  whitelist off `/api/state` (unaffected by two new keys); `sessionSummary`/`/api/sessions` doesn't
  touch this shape at all; `public/liveness.js`'s pure helpers take relative ms deltas, never see
  the new absolute timestamps directly. The one real hazard is `test/e2e.js`'s `EXPECTED_KEYS`
  exact-match test (line ~400) — covered by T2.

## Fixtures (locked, conformance)

Concrete input → expected-output pairs the tests above assert against, so "correct" is defined
before the code is written, not read off whatever the implementation happens to do:

| # | Scenario | Input | Expected |
|---|---|---|---|
| FX-1 | Fresh session | `blankSession()` | `lastAgentActivity: null`, `workingSince: null` |
| FX-2 | Agent presents | `/agent/present` at `t=1000` | `lastAgentActivity === 1000`, `workingSince === null`, `status === 'reviewing'` |
| FX-3 | Reviewer submits | `/api/submit` at `t=2000` | `workingSince === 2000`, `status === 'working'` |
| FX-4 | Reviewer approves | `/api/approve` at `t=2000` | `workingSince === null`, `status === 'done'` |
| FX-5 | Agent reworks silently, then presents | submit at `t=2000`, present at `t=9000` | after present: `workingSince === null`, `lastAgentActivity === 9000` |
| FX-6 | Refresh mid-round | server has `workingSince=2000`, `lastAgentActivity=5000`; client boots at `t=9000` | elapsed paints `0:07` (9000−2000) on first tick, staleness reference is `5000` (`max(2000,5000)`), not `2000` |
| FX-7 | Refresh before any signal | server has `workingSince=2000`, `lastAgentActivity=null` (stale from a prior round, say `500`) | staleness reference is `max(2000, 500) = 2000` — the stale prior-round value never wins |
| FX-8 | Malformed activity payload | `startWorkingTimer({ workingSince: 't', lastAgentActivity: 't' })` at `t=9000` | seeds `workingStartTs = 9000` (fallback), no `NaN` anywhere |

## Tasks (TDD — failing test first, watch fail, minimal pass, watch pass, commit)

### T1 — server: track + expose `lastAgentActivity` / `workingSince`
Add both fields to `blankSession`; add a `statusPayload(s)` helper; bump `lastAgentActivity` in
`loadDoc`, at the top of the `/agent/wait` handler, and in `/agent/progress`; set `workingSince`
only on the submit (not approve) branch of the submit/approve handler, cleared unconditionally in
`loadDoc`; use `statusPayload(s)` in `/api/state` and all three `status` broadcasts.
e2e tests: `/api/state` starts with both `null`; a `progress` call, a `wait` call, and a `present`
call each bump `lastAgentActivity` to a recent timestamp; a `submit` sets `workingSince` to a
recent timestamp while status is `working`; the next `present` clears `workingSince` back to
`null` while status is `reviewing`; `approve` does **not** set `workingSince` (FM-5 — assert the
field directly, not just status); extend the existing "FM-3: exactly one concurrent submit wins"
test (FM-6) to assert `workingSince` is set exactly once and consistent with the winning status.

### T2 — persistence round-trip
Extend the existing kill-9 restore e2e test: submit a round (so `workingSince` is set) and call
`/agent/progress` (so `lastAgentActivity` is set) before the crash; after restart, `/api/state`
reports the same two values. Update `EXPECTED_KEYS` in the "on-disk file is exactly the
serializable allowlist" test to include `lastAgentActivity` and `workingSince`. Add a restore-guard
test (FM-1): a hand-written session file with `lastAgentActivity: "yesterday"` and no
`workingSince` key restores both as `null`, not a crash or a passed-through string.

### T3 — client: refresh-accurate elapsed timer + staleness hint
Extend `setStatus`/`startWorkingTimer` per the design above (`Number.isFinite` validation, not a
bare `??`). Add DOM-shim scenarios alongside `driveLivenessWiring`:
  - Boots `fetchState()` directly into `status: 'working'` with a `workingSince` several seconds in
    the past and a `lastAgentActivity` closer to now; asserts the elapsed timer paints the real
    (non-zero) elapsed value on the very first tick — not `0:00` — and the staleness hint reflects
    `lastAgentActivity`, not the round-start time.
  - FM-4: seeds `startWorkingTimer` with non-numeric `workingSince`/`lastAgentActivity` (e.g. a
    string) and asserts the hint stays hidden — never "NaN s".
  - FM-9: seeds `workingSince` a few seconds in the *future* and asserts the first tick paints
    `0:00`, no stale hint (proves the clamp holds on the seed path, not just the tick path).
  - FM-2/11: fires `status: 'ended'` carrying a stray non-null `workingSince` mid-`working` and
    asserts the same clean teardown as today's bare `{status: 'ended'}` case.
The existing `driveLivenessWiring` scenario (no server timestamps on its `status`/`progress`
fires) must still pass byte-for-byte, proving normal live-tab behavior is unchanged (FM-8/FM-10).

### T4 — multi-reviewer parity
Extend the existing "multi-reviewer: submit consolidates" test (`test/e2e.js`, session `sbid`):
after reviewer B's submit, assert `workingSince` on the follow-up `/api/state` read (`sbDraft`) is
a recent timestamp — the field is session-scoped, set by B's submit exactly as a single-reviewer
submit would set it (FM-7). Closes AC4 by construction, not just by inspection.

## Verification

`npm test` (node test/e2e.js) — all existing checks plus the new T1–T4 checks pass.
