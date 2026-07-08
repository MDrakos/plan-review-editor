# Presence Indicators (who is viewing now) — Implementation Plan

> **For agent executors:** Use [[subagent-driven-development]] (recommended) or [[executing-plans]] to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live roster of who is currently viewing a review session. On SSE connect, a browser carries its `reviewerId` (+ optional name); the server keeps a per-session presence map keyed by `reviewerId` (one entry, N tab connections) and broadcasts a debounced `presence` SSE event on join/leave. The client renders a small avatar strip in the top bar, colored by `reviewerId` consistent with 004's attribution colors. Presence is derived/live state — never persisted; a restored session (005) starts with an empty roster until tabs reconnect. A single-reviewer session shows just that reviewer (or nothing), with no change to the review loop.

**Architecture:** Each session gains two live-only handles — `presence: Map<reviewerId, {id, name, connectedAt, count}>` and `presenceTimer` — added to `blankSession` alongside `sse`/`waiters`, and (like them) **excluded from `serialize()`**. The `/events` handler reads `rid`/`rname` query params: a non-empty `rid` registers presence (`presenceJoin`) and stashes the id on the response (`res._presenceId`) so `req.on('close')` can `presenceLeave`. Join/leave mutate the map synchronously and arm a per-session debounce (`schedulePresenceBroadcast`) that fans the **full current roster** out once via the existing `broadcast`. `GET /api/state` also returns the roster so a freshly (re)connected tab hydrates immediately. `removeSession` clears the presence timer. Client: `connectEvents` appends `rid`/`rname` to the EventSource URL; a `presence` SSE handler + `renderPresence()` paint an avatar strip (`#presence` in the top bar) reusing `authorColor(id)`.

**Tech stack:** Node's built-in `http` (no framework), vanilla browser JS (two classic `<script>`s: `liveness.js` + `app.js`), `node test/e2e.js` as the whole suite. Run tests with a **unique** port so parallel worktrees never collide — the suite auto-selects a free port; `PLANREVIEW_TEST_PORT=<port> npm test` pins one.

**Design source:** `issues/007-presence-indicators.md` (groomed 2026-07-07). Builds on 004 (`docs/plans/2026-07-07-multiple-reviewers.md`) and 005 persistence.

**Key data shapes (after this plan):**
- Session (live handles, not serialized): `presence: Map<reviewerId, { id, name, connectedAt, count }>`, `presenceTimer: NodeJS.Timeout | null`.
- Presence roster (in `/api/state.presence` and the `presence` SSE payload): `[{ id, name, connectedAt, count }]` — one entry per reviewer, `count` = number of open tabs.
- `/events` query params: `rid` (reviewerId, optional), `rname` (display name, optional). Absent/blank `rid` → the connection is anonymous and registers **no** presence (curl / old client / existing test helpers behave exactly as before).
- Client `state.presence`: the roster array, replaced wholesale on each `presence` event and on `fetchState`.

**Config knob:** `PLANREVIEW_PRESENCE_MS` (default `200`) — the join/leave broadcast debounce window. Coalesces reconnect churn and multi-tab bursts into one roster broadcast; well within the "within a second or two" acceptance bar.

**Invariants (from 005 / 004, must not regress):**
- Presence never appears in a persisted session file, nor in `serialize()`'s allowlist. A restart yields an empty roster until tabs reconnect.
- Anonymous connections (no `rid`) never create presence entries and never trigger a `presence` broadcast.
- The review loop (comments/choices/chat/submit/approve) is untouched; single-reviewer behavior is identical to today aside from the new (optional) strip.
- Reviewer name is rendered via `textContent` / element `title` only — never `innerHTML` (no injection surface from an attacker-chosen name).

**Testing convention (follow the repo):** server presence logic proved via HTTP e2e (`browser()`/`captureEvents()`/`cli()` in `test/e2e.js`), including a persistence-phase check that presence does not survive restart; client wiring proved via regex presence checks on the served `/app.js` + a smoke pass through the existing `driveLivenessWiring` DOM shim (fire a `presence` event, assert no throw and the strip renders).

**Fixtures (conformance, locked before execution) — see `## Fixtures` below.**

---

### Task 1: Server — presence map, join/leave, debounced roster broadcast, `/api/state` roster

**Files:**
- Modify: `server/server.js` — `blankSession` (`:57`), `removeSession` (`:92`), the `/events` handler (`:717`), `/api/state` (`:663`); add presence helpers + `PRESENCE_DEBOUNCE_MS` const near the SSE section (`:288`).
- Test: `test/e2e.js` — new presence server-logic checks in `main()`; a new `capturePresence(id, rid, rname)` helper beside `captureEvents` (`:134`).

**Reuse:** reuses `broadcast` (`:290`), `sessions` map, `readBody`/`sendJson`; mirrors the `persistTimers` debounce-once pattern (`:177`) and the `sse`/`waiters` "live handle, never serialized" convention. `presenceJoin`/`presenceLeave`/`presenceRoster`/`schedulePresenceBroadcast` are NEW (no existing equivalent — presence keying is the new concept).

- [ ] **Step 1: Write failing tests (HTTP contract).**
  Add a `capturePresence` helper (like `captureEvents` but appends `&rid=&rname=` and exposes the parsed `presence` frames). Then, in `main()`, cover:
  1. **Join + roster in `/api/state` (AC1):** open an SSE with `rid=alice` → poll `GET /api/state` until `presence` contains one `alice` entry with `count === 1` and a numeric `connectedAt`. Open a second capture with `rid=bob` → the first stream receives a `presence` event whose roster contains both `alice` and `bob`.
  2. **Multiple tabs, one entry (tab counting):** open two SSE connections with `rid=alice` → `/api/state.presence` has exactly one `alice` entry with `count === 2`. Close one → poll until `count === 1` (still present). Close the other → poll until `alice` is absent (AC2).
  3. **Anonymous connection registers nothing (AC3 "or nothing"):** open `/events` with no `rid` → `/api/state.presence` stays `[]`; no `presence` frame is broadcast.
  4. **Isolation:** a presence join in session X never appears in session Y's roster (reuse the two-session pattern).
  Run: `PLANREVIEW_TEST_PORT=4791 npm test` → the new checks FAIL (no presence yet).

- [ ] **Step 2: Watch them fail** (presence undefined / roster absent).

- [ ] **Step 3: Implement.**
  - `blankSession`: add `presence: new Map(),` and `presenceTimer: null,` beside `sse`/`waiters` (both live handles).
  - Add near `:288`:
    ```javascript
    const PRESENCE_DEBOUNCE_MS = Number(process.env.PLANREVIEW_PRESENCE_MS || 200);

    // Live roster of who is viewing this session, keyed by reviewerId: one entry per
    // reviewer, `count` open tabs. Derived state — never serialized (a restart comes
    // back empty until tabs reconnect). Join/leave mutate synchronously; the broadcast
    // is debounced so reconnect churn / multi-tab bursts collapse to one roster frame.
    function presenceRoster(s) {
      return [...s.presence.values()].map((p) => ({
        id: p.id, name: p.name, connectedAt: p.connectedAt, count: p.count,
      }));
    }
    function presenceJoin(s, id, name) {
      const entry = s.presence.get(id);
      if (entry) {
        entry.count += 1;
        if (name) entry.name = name; // freshen the label if a later tab supplies one
      } else {
        s.presence.set(id, { id, name, connectedAt: Date.now(), count: 1 });
      }
      schedulePresenceBroadcast(s);
    }
    function presenceLeave(s, id) {
      const entry = s.presence.get(id);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count <= 0) s.presence.delete(id); // last tab closed — they've left
      schedulePresenceBroadcast(s);
    }
    // Schedule-once debounce (mirrors persist()): first change arms the flush; further
    // changes inside the window don't re-arm; the flush broadcasts the CURRENT roster.
    function schedulePresenceBroadcast(s) {
      if (s.presenceTimer) return;
      s.presenceTimer = setTimeout(() => {
        s.presenceTimer = null;
        if (!sessions.has(s.id)) return; // torn down before the flush
        broadcast(s, 'presence', presenceRoster(s));
      }, PRESENCE_DEBOUNCE_MS);
    }
    ```
  - `/events` handler: after `s.sse.add(res)`, read + register:
    ```javascript
    const rid = (reqUrl.searchParams.get('rid') || '').trim();
    const rname = (reqUrl.searchParams.get('rname') || '').trim();
    if (rid) {
      res._presenceId = rid;
      presenceJoin(s, rid, rname);
    }
    ```
    and change the close handler to `req.on('close', () => { s.sse.delete(res); if (res._presenceId) presenceLeave(s, res._presenceId); });`
  - `/api/state` response: add `presence: presenceRoster(s),`.
  - `removeSession`: add `clearTimeout(s.presenceTimer);` (null-safe) so a torn-down session leaves no dangling timer.

- [ ] **Step 4: Watch them pass.** `PLANREVIEW_TEST_PORT=4791 npm test`.

- [ ] **Step 5: Commit** — `feat: server-side presence map + debounced roster broadcast`.

---

### Task 2: Persistence — presence is derived, never persisted (AC4)

**Files:**
- Modify: none expected (`serialize()` at `:141` is already an allowlist that omits `sse`/`waiters`; presence rides the same convention). If a check fails, the fix is to ensure presence is not added to the allowlist.
- Test: `test/e2e.js` — extend `persistenceChecks()` (the persistence phase near the tail).

**Reuse:** reuses the existing persistence-phase harness (its own second server on a separate port, restore-before-listen pattern).

- [ ] **Step 1: Write failing test.** In `persistenceChecks()`: start a session, open an SSE with `rid=alice`, confirm `/api/state.presence` has `alice`; then read the on-disk session JSON and assert it has **no** `presence` key; then trigger a restore (the phase's existing restart pattern) and assert the restored session's `/api/state.presence` is `[]`.
- [ ] **Step 2: Watch it fail** if presence leaked into the file (it should already pass structurally — this test locks the invariant so a future edit can't regress it).
- [ ] **Step 3: Implement** only if needed (keep presence out of `serialize()`).
- [ ] **Step 4: Watch it pass.**
- [ ] **Step 5: Commit** — `test: lock presence out of persisted session state`.

---

### Task 3: Client — carry identity on SSE connect + render the presence strip

**Files:**
- Modify: `public/app.js` — `connectEvents` (`:469`), `state` (`:120`), `fetchState` (`:290`); add `renderPresence`/`initials` near `authorColor` (`:722`); call `renderPresence()` in boot (`:1178`).
- Modify: `public/index.html` — add `<div id="presence">` to the top bar (`:10-16`).
- Modify: `public/style.css` — add `.presence` / `.presence-avatar` rules near the attribution block (`:1030`).
- Test: `test/e2e.js` — regex wiring checks on served `/app.js`; extend `driveLivenessWiring` to fire a `presence` event.

**Reuse:** reuses `authorColor(id)` (`:722`) and `authorLabel` (`:729`) for color/label consistency with 004; reuses the `api()` helper and the `--author-color` CSS custom-property pattern (`.author-badge`).

- [ ] **Step 1: Write failing wiring tests.** Assert the served `/app.js` body: EventSource URL includes `rid=` (and conditionally `rname=`); an `addEventListener('presence'` handler exists; a `renderPresence` function exists and uses `authorColor`. Extend `driveLivenessWiring` (add a `#presence` shim element) to `fire('presence', [{id:'x',name:'X',connectedAt:1,count:1}])` and assert no throw.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement.**
  - `state`: add `presence: []`.
  - `connectEvents`: build the URL with identity —
    ```javascript
    function eventsUrl() {
      let u = api('/events') + `&rid=${encodeURIComponent(reviewer.id)}`;
      if (reviewer.name) u += `&rname=${encodeURIComponent(reviewer.name)}`;
      return u;
    }
    const es = new EventSource(eventsUrl());
    ```
    add handler: `es.addEventListener('presence', (e) => { state.presence = JSON.parse(e.data); renderPresence(); });`
  - `fetchState`: after chat/progress, `state.presence = s.presence || []; renderPresence();`
  - Add helpers:
    ```javascript
    // Two-letter monogram for an avatar: initials from the name, else the id's head.
    function initials(name, id) {
      const n = (name || '').trim();
      if (n) {
        const parts = n.split(/\s+/);
        return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
      }
      return (id || '?').slice(0, 2).toUpperCase();
    }
    // The live "who's viewing now" strip: one color-coded avatar per present reviewer
    // (you included), colored by reviewerId to match 004's attribution. Names are
    // untrusted — set via textContent / title only.
    function renderPresence() {
      const el = document.getElementById('presence');
      if (!el) return;
      el.innerHTML = '';
      for (const p of state.presence || []) {
        const av = document.createElement('span');
        av.className = 'presence-avatar';
        if (p.id === reviewer.id) av.classList.add('you');
        av.textContent = initials(p.name, p.id);
        if (p.id) av.style.setProperty('--author-color', authorColor(p.id));
        const label = authorLabel(p);
        const tabs = p.count > 1 ? ` · ${p.count} tabs` : '';
        av.title = `${label}${p.id === reviewer.id ? ' (you)' : ''}${tabs}`;
        el.appendChild(av);
      }
    }
    ```
  - `index.html`: insert before `#identity`:
    `<div id="presence" class="presence" aria-label="Reviewers viewing now"></div>`
  - boot: call `renderPresence();` beside `renderIdentity();`.
  - `style.css`: avatar strip near `:1030`:
    ```css
    .presence { display: inline-flex; align-items: center; }
    .presence-avatar {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; margin-left: -6px;
      border-radius: 50%; font-size: 10px; font-weight: 700; color: #fff;
      background: var(--author-color, var(--ink-soft));
      border: 2px solid var(--surface); box-sizing: border-box;
    }
    .presence-avatar:first-child { margin-left: 0; }
    .presence-avatar.you { outline: 2px solid var(--accent); outline-offset: -2px; }
    ```
- [ ] **Step 4: Watch them pass**, and eyeball the served page.
- [ ] **Step 5: Commit** — `feat: client presence strip carried on the SSE connection`.

---

### Task 4: README — record presence as shipped

**Files:** Modify `README.md` (the section that lists presence as a next step; the issue notes "The README lists this as a next step").

- [ ] **Step 1:** Move presence from "next steps" to shipped/feature list; one line describing the roster + multi-tab behavior. (No test; docs.)
- [ ] **Step 2: Commit** — `docs: note presence indicators as shipped`.

---

## Fixtures (conformance — locked before execution)

| ID | Input | Expected |
|----|-------|----------|
| FX-1 | SSE connect `rid=alice` (no other tabs) | roster `[{id:'alice',name:'',connectedAt:<num>,count:1}]`; `/api/state.presence` reflects it immediately |
| FX-2 | `alice` connected, then SSE connect `rid=bob` | debounced `presence` frame → roster contains both `alice` and `bob` |
| FX-3 | two SSE connects `rid=alice` | one entry, `count:2` |
| FX-4 | of the two `alice` tabs, close one | `count:1`, `alice` still present |
| FX-5 | close alice's last tab | `alice` removed from roster (leave) |
| FX-6 | SSE connect with **no** `rid` | roster stays `[]`; no `presence` broadcast |
| FX-7 | connect `rid=alice&rname=Ada` | entry `name:'Ada'`; strip avatar shows `AD` (or `A`) colored by `authorColor('alice')` |
| FX-8 | persisted session file after an `alice` join | JSON has no `presence` key; restored session `/api/state.presence === []` |
| FX-9 | presence in session X | never appears in session Y's roster |

---

## Verification

- `PLANREVIEW_TEST_PORT=4791 npm test` → all checks pass (new presence checks included).
- Manual smoke: `node bin/planreview.js start <doc>` (or the demo), open `/s/<id>` in two browser windows with distinct reviewer names → each shows the other's avatar within ~1s; close one window → its avatar disappears; open two tabs as the same reviewer → one avatar, tooltip "· 2 tabs".
- Restart the server with a session open → the strip empties, then repopulates as tabs' EventSource reconnects.

---

## G4 Enumeration Outcome (FMEA + DSM + STRIDE)

Ran in parallel before execution. Adopted changes and their locking tests:

**Adopted as code (beyond the base plan):**
- **FM-3 (crash-safety), corrected after the pre-PR review:** the first attempt (a `try/catch` in `broadcast`) was proven ineffective by the reviewers' mutation testing — verified with a standalone repro that in Node 22 a dead-socket write does not throw synchronously, and the one real crash class (`ERR_STREAM_WRITE_AFTER_END`) surfaces as an **async** `'error'` event a `try/catch` can't catch. Tracing the real code, that class isn't even reachable (`removeSession` `s.sse.clear()`s ended clients together, so `broadcast` never writes to an ended res). So `broadcast` was reverted to its original form, and the correct, minimal hardening was added instead: **`res.on('error', cleanup)` on every SSE connection** (verified in the repro that it neutralizes the crash class; a listener is standard practice for a long-lived response stream). Covered by a teardown-race + rapid-churn resilience test asserting the server stays up.
- **FM-4 / TM-7:** `MAX_PRESENCE` cap (env `PLANREVIEW_MAX_PRESENCE`, default 200) — a runaway client can't grow the roster Map (or the O(N) frame). New ids refused at the cap; existing reviewers can still add tabs. Test: 6 distinct rids under a cap of 4 → roster stays 4.
- **TM-9:** `rid`/`rname` truncated to 100 chars at the read site. Test: 300-char values → entry id/name length 100.
- **FM-5 / TM-10 + DSM hotspot 3:** the close handler captures `rid` in a per-connection closure with a `joined` flag (idempotent release, no `res` mutation) — a duplicate `close` can't double-decrement; the cap-then-free-slot desync can't delete a still-open reviewer.
- **FM-12:** `state.presence = Array.isArray(parsed) ? parsed : []` on both the SSE handler and `fetchState`; `renderPresence`/`initials`/`authorLabel` tolerate malformed entries. Test: fire `[{}]`, `[{id}]`, `null` → no throw.
- **DSM hotspot 1:** `schedulePresenceBroadcast` guards `sessions.has(s.id)` *before* arming (plus the in-flush guard) — a `close` that fires after teardown can't arm a zombie timer. `removeSession` also clears `presenceTimer`.
- **TM-3:** reviewer name reaches the DOM only via `textContent` / `title`, never `innerHTML`. Test: fire a `<img onerror>` name through the DOM shim → never appears in `innerHTML`.
- **FM-8:** name freshening (a later tab supplies a name; a blank name never wipes one; leaving never rewrites it). **FM-13:** roster is a `Map`, so `__proto__`/`constructor` rids are ordinary keys. **TM-8:** debounce → one frame per window under churn. All locked by tests.

**Accepted / documented, not fixed:**
- **FM-1 — ghost presence on a truly silent socket black-hole** (a tab that dies without a TCP FIN/RST): its `close` never fires, so the entry and the session both linger. Rare on localhost (closes are prompt) and a heartbeat/TTL is a larger design addition out of scope for this issue. Documented limitation; the browser's own `retry: 1000` reconnect and the abandon sweep cover the ordinary cases.
- **FM-7 / TM-1 / TM-2 — unauthenticated `rid` impersonation and last-writer-wins name** — same no-auth, localhost, single-operator trust model 004 already accepted for comment/chat identity. TM-2 behavior is locked by a test so a future change is deliberate.
- **TM-12 — no `Origin`/CSRF check on `/events`** — pre-existing property of the whole server, not new to this feature; flagged for any future network-exposure hardening.
