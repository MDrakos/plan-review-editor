# Plan: interrupt an in-progress rework (issue 012)

**Source:** `issues/done/012-interrupt-rework-in-progress.md`
**Branch:** `miked/interrupt-rework-in-progress`
**Path:** Standard

## Summary

Add a reviewer-initiated interrupt of an in-progress rework. While
`status === 'working'`, a control in the reworking overlay posts
`/api/interrupt`; the session returns to `reviewing` **on the same document**
(the pre-rework doc is still `s.doc` — the agent has not presented the reworked
version yet), with all comments/choices/resolutions intact. The agent's stale
rework is discarded when it tries to hand it back: `present` and `progress` are
gated to an active `working` round and return `409` otherwise, so the agent
loops back to `wait` for the next round.

## Design decisions (grounded in current code)

- **No document restore needed.** During `working`, `s.doc` is unchanged — the
  agent presents the reworked doc only at the end of the round. Interrupt just
  flips status back; the "prior doc" is already the live doc. (server.js:1010 —
  `submit` sets `working` without touching `s.doc`; server.js:1027 — `present`'s
  `loadDoc` is what would replace it.)
- **No new persistence field.** `serialize` already writes `status` and
  `workingSince` (server.js:174,176) and restore reads them
  (server.js:268,304). An interrupted session (`reviewing`, `workingSince:null`)
  round-trips a restart with the existing machinery.
- **Guard-after-await, then mutate synchronously** — mirror the submit/approve
  race fix (server.js:1002-1006) so two reviewers racing an interrupt, or an
  interrupt racing a submit, cannot both take effect.
- **`present`/`progress` gated on `working`.** `present` is only ever a rework
  re-present (the initial doc comes from `/agent/start`, server.js:836), so
  requiring `status === 'working'` is safe and is the mechanism that discards the
  stale rework after an interrupt.
- **Overlay reveals the existing panel.** The comments/choices are already in the
  DOM under the overlay; `setStatus('reviewing')` (app.js:191) hides the overlay
  and re-enables input. Add a `fetchState()` on the `working → reviewing`
  transition as a resync safety net (peer edits, agent replies).

## Tasks (TDD — each starts with a failing test in `test/e2e.js`)

### Task 1 — `POST /api/interrupt` endpoint + state revert (server)

Files: `server/server.js`.

- Add route handler after the submit/approve block (~server.js:1017):
  ```js
  if (method === 'POST' && pathname === '/api/interrupt') {
    await readBody(req); // drain; body carries reviewerId but interrupt needs no author scoping
    // Guard AFTER await, mutate synchronously — same race closure as submit (FM-3 family).
    if (s.status !== 'working')
      return sendJson(res, 409, { error: `cannot interrupt while ${s.status}` });
    s.status = 'reviewing';
    s.workingSince = null;      // the working round is aborted (parallels loadDoc, server.js:455)
    s.progress = [];            // the aborted round's steps are done
    touch(s);
    broadcast(s, 'status', statusPayload(s));
    enqueueAgentEvent(s, { type: 'interrupt' });
    persist(s);
    return sendJson(res, 200, { ok: true });
  }
  ```

Tests:
- interrupt while `working` → 200, subsequent `/api/state` shows `status:'reviewing'`, `workingSince:null`, `progress:[]`.
- a `status` SSE event with `status:'reviewing'` is broadcast.
- an `interrupt` agent event is delivered to a waiting `/agent/wait`.
- interrupt while `reviewing` / `done` / `ended` → 409, state unchanged.

### Task 2 — gate `/agent/present` on an active working round (server)

Files: `server/server.js` (~1021).

- At the top of the `/agent/present` handler, after the `body.path` check:
  ```js
  if (s.status !== 'working')
    return sendJson(res, 409, { error: 'no active rework round (interrupted); wait for the next round' });
  ```

Tests:
- submit → interrupt → `present` returns 409 and does **not** change `s.doc.version` or status.
- normal submit → `present` (status `working`) still succeeds (regression).

### Task 3 — gate `/agent/progress` on an active working round (server)

Files: `server/server.js` (~1092).

- At the top of `/agent/progress`, after the empty-text check:
  ```js
  if (s.status !== 'working')
    return sendJson(res, 409, { error: 'no active rework round (interrupted)' });
  ```

Tests:
- submit → interrupt → `progress` returns 409; `s.progress` stays `[]`.
- normal working round → `progress` still appends (regression).

### Task 4 — Interrupt control in the reworking overlay (client)

Files: `public/index.html`, `public/app.js`, `public/style.css`.

- `index.html`: add a button inside `#working-overlay .overlay-card` (after the
  stale hint, ~line 44):
  `<button id="interrupt-btn" class="overlay-action" type="button">Interrupt & keep editing</button>`
  Adjust the overlay hint copy so "End session" is no longer the only escape.
- `app.js`: bind the click — confirm, then `POST /api/interrupt`; ignore a 409
  (the agent already presented — the incoming `doc`/`status` settles the UI):
  ```js
  document.getElementById('interrupt-btn').addEventListener('click', async () => {
    if (!confirm('Interrupt the rework and go back to editing? The agent will discard this round.')) return;
    await fetch(api('/api/interrupt'), { method: 'POST', headers: reviewerHeaders() }).catch(() => {});
  });
  ```
  (Use whatever the file's existing reviewer-header/body helper is; interrupt
  needs no author payload but stays consistent with peers.)
- `app.js` status handler (~line 584): on a `working → reviewing` transition,
  `fetchState()` to resync the panel (peer comments, agent replies) before the
  reviewer edits. Guard on the prior state so a normal `present` (which arrives
  as a `doc` event + `reviewing` status) doesn't double-fetch.
- `style.css`: style `.overlay-action` to match existing overlay buttons.

Tests (Node-level assertion of the served HTML, matching existing client tests):
- `/s/<id>` HTML contains `id="interrupt-btn"`.
- (Behavioral overlay wiring is covered by the server-state e2e above; keep the
  client test at the served-markup level as the existing suite does.)

### Task 5 — protocol docs

Files: `docs/PROTOCOL.md`.

- New `interrupt` event under "Events": reviewer aborted the round; stop
  reworking, do **not** present, go back to `wait`. Note it may instead surface
  as a `409` from `present`/`progress` when the agent was busy (not waiting) at
  interrupt time — treat that `409` identically (discard the in-flight rework,
  `wait` again).
- Extend the `submit` section's present/progress bullets with the working-only
  guard.
- HTTP reference table: add `POST /api/interrupt`; annotate `/agent/present` and
  `/agent/progress` as `working`-only.

## Verification

- `npm test` (full `node test/e2e.js`) green, including the new cases.
- Manual/e2e drive: start a session, submit, interrupt, confirm the browser
  panel is editable on the same doc and a subsequent agent `present` 409s.

## Out of scope

Per the work item: no addendum-to-a-running-agent ("pause and amend"); no
interrupt of non-rework states.

## G4 enumeration outcomes (FMEA + DSM) — dispositions

| Finding | Disposition |
|---|---|
| **FM-1** stale `present` from an aborted round accepted during a *later* round (needs a round token) | **Accept as documented residual risk.** The protocol is one agent per session running one synchronous `present` then `wait`; a cross-round stale `present` requires a duplicate/zombie agent request the documented loop never issues. A round token adds protocol + CLI surface disproportionate to the risk. Noted as a follow-up in the work item's out-of-scope. |
| **FM-2** agent gets no structured recovery signal on a 409 (`present`/`progress` → CLI `exit(2)`, looks fatal) | **Fix — new Task 2b.** Attach `statusCode` to the CLI's request error; `present`/`progress` treat a 409 as the documented "round interrupted, wait again" path: print a clear message, exit 0 (so `present && wait` chains proceed). |
| **FM-3** interrupt lost if a hard kill lands inside the persist debounce window | **Accept.** Identical to the durability contract every mutation already has (server.js:205-208); making interrupt eagerly-flushed would make it inconsistent with submit. |
| **FM-4** no audit trail of an interrupted round | **Accept / out of scope.** Nice-to-have transcript marker; not required by the work item. |
| **FM-5** guard-after-await invariant rests on convention | **Fix — loud comment at the interrupt call site + a concurrent regression test (see FM-9).** |
| **FM-6** client double-click / swallowed 409 | **Fix — Task 4.** Disable the button while in flight; treat 409 as benign no-op, surface any other non-2xx. |
| **FM-7** client resync guard misfires (double-fetch or stale peer) | **Fix — Task 4.** Resync only on a `working → reviewing` transition (prior status was `working`), so a normal `present` (arrives as `doc` + `reviewing`) does not double-fetch. |
| **FM-8** interrupt on terminal/absent session — 409 vs 404 distinct | **Test only.** Server already distinguishes; add tests for `done`/`ended`/removed-session. |
| **FM-9 / FM-10** concurrent interrupt‖submit, interrupt‖present, interrupt‖progress, two-reviewer interrupt | **Fix — add `Promise.all` concurrent tests** asserting exactly one side effect lands and state (status/workingSince/progress/queued events) is consistent. |
| **DSM** `loadDoc` and interrupt both reset the `status`/`workingSince`/`progress` trio (duplication) | **Fix — extract `endWorkingRound(s)`** (sets `status='reviewing'`, `workingSince=null`, `progress=[]`), called by both `loadDoc` and `/api/interrupt`. Serves the code-reuse policy. |

### Revised / added tasks from G4

- **Task 1** now calls the extracted `endWorkingRound(s)` helper and carries a loud
  guard-after-await invariant comment.
- **Task 2b (new)** — CLI 409 handling in `bin/planreview.js`: `request()` attaches
  `err.statusCode`; `present`/`progress` catch a 409, print
  `{"interrupted": true, "message": "round interrupted; wait again"}`, exit 0.
- **Test additions** — concurrent cases (FM-9/FM-10), terminal/absent-session 409/404
  (FM-8), CLI-level interrupt recovery (FM-2).

<!-- G4 catalogs appended below by the FMEA and DSM enumeration agents -->

## Failure Modes (FMEA)

(Full catalog from the FMEA enumeration agent — see the dispositions table above
for how each is handled. FM-1..FM-10 cover: stale cross-round present, agent 409
recovery, persist-window durability, audit trail, guard-after-await invariant,
client double-click, client resync misfire, terminal/absent-session codes, and
the concurrent interrupt‖submit / ‖present / ‖progress / two-reviewer races.)

## Structural Analysis (DSM)

Verdict: **clean.** The new endpoint and guards reuse every existing primitive
(`statusPayload`, `broadcast`, `enqueueAgentEvent`, `persist`, `touch`) and copy
the guard-after-await idiom from `/api/submit`. No new imports, no new session
fields, no new persistence surface (`status`/`workingSince` already round-trip).
Only structural cost: three more touch points on the already-central
`status`/`workingSince`/`progress` trio, and a duplicate of `loadDoc`'s
round-reset — addressed by extracting `endWorkingRound(s)` (see dispositions).
