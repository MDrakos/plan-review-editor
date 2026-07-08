# Enhancement: auto-isolate the e2e test port so parallel runs never collide

**Type:** enhancement (dev-experience / test reliability)
**Status:** open, groomed 2026-07-07, recommended first pick
**Area:** `test/e2e.js` (port selection), the shared server it drives

## Problem

The e2e suite binds a fixed port: `const PORT = Number(process.env.PLANREVIEW_TEST_PORT) || 4799;` (`test/e2e.js:23`), and passes it to the CLI it drives via `PLANREVIEW_PORT` (`:31`). Every worktree that runs `npm test` therefore shares one server on 4799 unless the operator sets `PLANREVIEW_TEST_PORT` by hand.

When two runs overlap (which happens constantly during parallel multi-crew work), one run's `planreview start` restarts or reuses the shared server and drops the other run's sessions. The failing run reports `no such session`, a false red that has nothing to do with the code under test. This bit gate validation repeatedly during the 001 to 005 batch.

The port was made *overridable* (002), but the default still collides. The goal here is to remove the manual step: a run should pick a free port on its own.

## Proposed enhancement

1. Default to an OS-assigned free port: bind to port `0`, read the actual port back from the listening socket, and thread that into the CLI's `PLANREVIEW_PORT` for that run. Keep `PLANREVIEW_TEST_PORT` as an explicit override.
2. Ensure the second inline server in the suite (`test/e2e.js:291`, currently `4798`) is isolated the same way so the two never clash with each other or with a sibling run.
3. Confirm each run tears its server down (idle-shutdown already does this) so free ports do not leak across runs.

## Acceptance criteria

- Two `npm test` runs started at the same time from different worktrees both pass, with no `no such session` failures and no manual env var.
- A single run still passes and still cleans up its server.
- `PLANREVIEW_TEST_PORT` still forces a specific port when set.

## Code pointers

- `test/e2e.js:23,24,31` — fixed `PORT` and the `PLANREVIEW_PORT` it exports to the CLI.
- `test/e2e.js:291,302` — the second inline server (`4798`) and its `PLANREVIEW_PORT`.
- `server/server.js` — `PORT = Number(process.env.PLANREVIEW_PORT || 4780)` and `server.listen`.
