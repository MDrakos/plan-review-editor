# Multiple Reviewers on One Plan — Implementation Plan

> **For agent executors:** Use [[subagent-driven-development]] (recommended) or [[executing-plans]] to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two or more browser tabs review one plan session concurrently — every comment, chat message, and choice attributed to a reviewer; peers' comments appear live; choice conflicts are surfaced; submit consolidates everyone's input with no loss — while a single-reviewer session behaves exactly as it does today.

**Architecture:** The server's `s.review` becomes multi-author. `mergeComments` is rescoped so a POST is authoritative **only** over its own author's comments (union across authors). `s.review.choices` moves from `{choiceId: option}` to `{choiceId: {reviewerId: option}}` via a new `mergeChoices`. `/api/review-state` broadcasts a new `review` SSE delta so other tabs re-sync live. `/api/chat` attributes reviewer messages. Submit builds a consolidated bundle (poster's body merged over the shared review, without mutating it). The client mints an ephemeral `reviewerId` (localStorage) + optional name, attaches `author:{id,name}` to mutations, posts only its own flat choice picks, renders attribution UI, and re-syncs on peers' `review` deltas.

**Tech stack:** Node's built-in `http` (no framework), vanilla browser JS (two classic `<script>`s: `liveness.js` + `app.js`), `node test/e2e.js` as the whole test suite. Run tests with a **unique** port: `PLANREVIEW_TEST_PORT=<port> npm test` (avoids the shared-4799 collision across worktrees).

**Design source:** `docs/specs/2026-07-07-multiple-reviewers-design.md` (locked/approved). Issue: `issues/done/004-multiple-reviewers-on-one-plan.md`.

**Key data shapes (after this plan):**
- Comment: `{ id, quote, text, ts, author?: {id, name?}, replies?: [{role:'agent'|'reviewer', text, ts, author?}], archived? }`
- `s.review.choices`: `{ [choiceId]: { [reviewerId]: option } }` where `option` is a string or `string[]` (multi)
- Chat message: `{ role: 'reviewer'|'agent', text, ts, author?: {id, name?} }`
- A browser's POST carries top-level `reviewerId` + `reviewerName`, per-comment `author`, and its **own flat** choice picks `{ [choiceId]: option }`.
- Absent `reviewerId` (old client / curl) → synthetic author id `'anonymous'`.

**Testing convention (follow the repo):** server logic is proved via HTTP e2e (`browser()`/`captureEvents()`/`cli()` helpers in `test/e2e.js`); client wiring is proved via regex presence checks on the served `/app.js` and `/s/<id>` page text, plus the one `driveLivenessWiring` DOM shim (not extended here). This plan keeps that split: all merge/union/bundle correctness is HTTP-tested; client attribution wiring is regex-tested.

---

### Task 1: Server — author helpers + author-scoped comment union

**Files:**
- Modify: `server/server.js` (`mergeComments` at `:379-391`; `/api/review-state` at `:622-632`; add helpers near `:359`)
- Test: `test/e2e.js` (new server-logic checks; place near the existing `mergeComments`/review-state coverage)

**Reuse:** extends the existing `mergeComments` + `mergeReplies` (`server/server.js:359-391`); reuses `broadcast`, `readBody`, `sendJson`. `authorId`/`posterIdOf`/`reconcileComment` are NEW small helpers (no existing equivalent — author-scoping is the core new concept).

- [ ] **Step 1: Write failing tests for author-scoped `mergeComments`**

`mergeComments` is a module-internal function, so test it through the `/api/review-state` HTTP surface (the real contract). Add this block inside `main()` in `test/e2e.js`, right after the "answered questions persist across cycles" block (currently ending near `:1005`, after its `await cli('stop', '--session', q.id);`):

```javascript
  console.log('multi-reviewer: comments union across authors; a poster owns only its own');
  const mr = await cli('start', docA, '--no-open');
  const mrid = mr.id;
  // Reviewer A creates a comment, syncing its whole set (just A's).
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'A',
    comments: [{ id: 'a1', quote: 'Body of plan A.', text: 'from A', author: { id: 'A', name: 'Ada' } }],
    choices: {},
  });
  // Reviewer B syncs its own set. B's browser has NOT seen A's comment yet, so B
  // posts only [b1]. A's comment must survive (union across authors).
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'B',
    comments: [{ id: 'b1', quote: 'Body of plan A.', text: 'from B', author: { id: 'B', name: 'Ben' } }],
    choices: {},
  });
  const mrState = await browser(`/api/state?session=${mrid}`);
  const mrComments = mrState.data.review.comments;
  check(
    'both reviewers\' comments coexist, each attributed (B\'s sync did not clobber A\'s)',
    mrComments.length === 2 &&
      mrComments.some((c) => c.id === 'a1' && c.author && c.author.id === 'A') &&
      mrComments.some((c) => c.id === 'b1' && c.author && c.author.id === 'B'),
    JSON.stringify(mrComments)
  );
  // B edits its own comment and, this time, its browser HAS A's comment too (live
  // sync) — B may not edit or drop A's, but its edit to b1 lands.
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'B',
    comments: [
      { id: 'a1', quote: 'Body of plan A.', text: 'TAMPERED', author: { id: 'A', name: 'Ada' } },
      { id: 'b1', quote: 'Body of plan A.', text: 'from B (edited)', author: { id: 'B', name: 'Ben' } },
    ],
    choices: {},
  });
  const mrState2 = await browser(`/api/state?session=${mrid}`);
  const a1 = mrState2.data.review.comments.find((c) => c.id === 'a1');
  const b1 = mrState2.data.review.comments.find((c) => c.id === 'b1');
  check(
    'a poster owns only its own comments: B edits b1 but cannot alter A\'s a1',
    a1 && a1.text === 'from A' && b1 && b1.text === 'from B (edited)',
    JSON.stringify({ a1, b1 })
  );
  // A deletes its own comment (posts a set without a1); B's b1 is untouched.
  await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'A',
    comments: [],
    choices: {},
  });
  const mrState3 = await browser(`/api/state?session=${mrid}`);
  check(
    'a poster deleting its own comment leaves peers\' comments intact',
    mrState3.data.review.comments.length === 1 &&
      mrState3.data.review.comments[0].id === 'b1',
    JSON.stringify(mrState3.data.review.comments)
  );
  // FM-7: a malformed comment entry (null / no id) must be skipped, never 500.
  const mrBad = await browser(`/api/review-state?session=${mrid}`, {
    reviewerId: 'B',
    comments: [null, {}, { id: 'b1', quote: 'Body of plan A.', text: 'still here', author: { id: 'B' } }],
    choices: {},
  });
  const mrState4 = await browser(`/api/state?session=${mrid}`);
  check(
    'FM-7: malformed comment entries are skipped (clean 200, not a 500)',
    mrBad.status === 200 &&
      mrState4.data.review.comments.filter((c) => c && c.id === 'b1').length === 1 &&
      mrState4.data.review.comments.every((c) => c && typeof c.id === 'string'),
    JSON.stringify({ status: mrBad.status, comments: mrState4.data.review.comments })
  );
  await cli('stop', '--session', mrid);
```

- [ ] **Step 2: Run the tests, expect failure**

Run: `PLANREVIEW_TEST_PORT=4831 npm test 2>&1 | grep -A1 "multi-reviewer: comments union"`
Expected: FAIL — today's `mergeComments` takes the browser's whole set, so B's second sync (with `TAMPERED`) overwrites A's `a1.text`, and B's set-without-a1 does not preserve peers.

- [ ] **Step 3: Add the helpers and rewrite `mergeComments`**

In `server/server.js`, add these helpers just above `mergeComments` (after `mergeReplies`, ~`:371`):

```javascript
// A comment's (or a POST body's) author id, defaulting to a synthetic 'anonymous'
// so an old client / curl with no identity still round-trips without breaking.
function authorId(c) {
  return (c && c.author && typeof c.author.id === 'string' && c.author.id) || 'anonymous';
}

// The reviewer id a POST claims for itself (top-level, per the design). Determines
// which comments in the body this POST is authoritative over.
function posterIdOf(body) {
  return (body && typeof body.reviewerId === 'string' && body.reviewerId) || 'anonymous';
}

// Reconcile ONE browser comment against the server's copy: union replies, and keep
// the server-authoritative archived flag (the browser can clobber neither). This is
// the per-comment step lifted out of the old mergeComments so mergeComments can
// choose, per author, whether to apply it.
function reconcileComment(prev, incoming) {
  const replies = mergeReplies(prev && prev.replies, incoming.replies);
  const merged = { ...incoming };
  if (replies.length) merged.replies = replies;
  else delete merged.replies;
  delete merged.archived; // server-authoritative — never trust the browser's copy
  if (prev && prev.archived) merged.archived = true;
  return merged;
}
```

Then replace the whole `mergeComments` function (`:379-391`) with:

```javascript
// Author-scoped union — the CORE multi-reviewer change. A POST is authoritative
// ONLY over its own author's comments (create / edit / delete): those in `incoming`
// whose author.id === posterId. Every OTHER author's comment is preserved from
// `prev` untouched, so reviewer B's sync can never drop or edit reviewer A's
// comments — even when B's browser holds A's comments (from live sync) and posts
// them back. Order follows `prev` (peers stay put; a peer's card never jumps when
// you edit yours), with the poster's brand-new comments appended.
function mergeComments(prev, incoming, posterId) {
  // Drop malformed entries up front (a null / non-object / id-less comment from a
  // buggy client or curl) so no downstream `.id` deref can throw — FM-7. Mirrors the
  // defensive filtering mergeReplies already does for reply objects.
  const ok = (c) => c && typeof c === 'object' && typeof c.id === 'string';
  const cleanIncoming = (incoming || []).filter(ok);
  const cleanPrev = (prev || []).filter(ok);
  const mine = new Map(cleanIncoming.filter((c) => authorId(c) === posterId).map((c) => [c.id, c]));
  const prevById = new Map(cleanPrev.map((c) => [c.id, c]));
  const emitted = new Set();
  const out = [];
  for (const p of cleanPrev) {
    if (authorId(p) === posterId) {
      const inc = mine.get(p.id);
      if (!inc) continue; // the poster deleted their own comment
      out.push(reconcileComment(p, inc));
    } else {
      out.push(p); // another reviewer's comment — never touched by this poster
    }
    emitted.add(p.id);
  }
  for (const c of cleanIncoming) {
    if (authorId(c) !== posterId || emitted.has(c.id)) continue;
    out.push(reconcileComment(prevById.get(c.id), c)); // brand-new poster comment
    emitted.add(c.id);
  }
  return out;
}
```

Also tighten `mergeReplies`' dedup key (`server/server.js:359-371`) to include the author, so two reviewers whose replies collide on `role|ts|text` (e.g. a fixed-ts race) don't dedup one away — FM-18. Change the `key` line inside `mergeReplies`:

```javascript
    const key = `${r.role}|${r.ts}|${r.text}|${authorId(r)}`;
```

(Agent replies have no author → `authorId` returns `'anonymous'` on both the server-appended and browser-synced copies, so the existing agent-reply dedup still works.)

Now update the `/api/review-state` handler (`:622-632`) to compute and pass the poster id (only the comments line changes in this task; choices stays as-is for now):

```javascript
    if (method === 'POST' && pathname === '/api/review-state') {
      const body = await readBody(req);
      const posterId = posterIdOf(body);
      // Author-scoped merge: preserves peers' comments (and agent replies + the
      // server's archived flag) against a browser sync that only owns its author's set.
      if (Array.isArray(body.comments))
        s.review.comments = mergeComments(s.review.comments, body.comments, posterId);
      if (body.choices && typeof body.choices === 'object') s.review.choices = body.choices;
      touch(s);
      persist(s);
      return sendJson(res, 200, { ok: true });
    }
```

- [ ] **Step 4: Run the tests, expect pass (and no regressions)**

Run: `PLANREVIEW_TEST_PORT=4831 npm test 2>&1 | tail -3`
Expected: `all checks passed`. (Existing comment tests still pass: an anonymous/single poster's `incoming` are all `author.id === 'anonymous' === posterId`, so the union reduces to today's behavior.)

- [ ] **Step 5: Commit**

```bash
git add server/server.js test/e2e.js
git commit -m "feat(server): author-scoped comment union for multiple reviewers"
```

---

### Task 2: Server — per-reviewer choice map + live `review` broadcast

**Files:**
- Modify: `server/server.js` (`/api/review-state` at `:622-632`; add `mergeChoices` near the other merge helpers)
- Test: `test/e2e.js` (new choice-conflict + live-sync checks; UPDATE the persistence + answered-questions assertions that encode the old scalar choice shape)

**Reuse:** reuses `broadcast` (`:281-284`), `posterIdOf`/`authorId` (Task 1), the `captureEvents` SSE helper (`:113`). `mergeChoices` is NEW (per-reviewer choice shape has no existing equivalent).

- [ ] **Step 1: Write failing tests — choice conflict + `review` SSE delta**

Add this block in `test/e2e.js` immediately after the Task 1 block you just added (after `await cli('stop', '--session', mrid);`):

```javascript
  console.log('multi-reviewer: per-reviewer choices surface conflict; review-state broadcasts a delta');
  const cf = await cli('start', docA, '--no-open');
  const cfid = cf.id;
  const cfEvents = await captureEvents(cfid); // capture the SSE stream for this session
  await sleep(100);
  // A picks A1, B picks A2 for the same choice — a divergence.
  await browser(`/api/review-state?session=${cfid}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${cfid}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  const cfState = await browser(`/api/state?session=${cfid}`);
  check(
    'choices are per-reviewer: the map holds BOTH divergent picks, neither overwritten',
    cfState.data.review.choices.pick &&
      cfState.data.review.choices.pick.A === 'A1' &&
      cfState.data.review.choices.pick.B === 'A2',
    JSON.stringify(cfState.data.review.choices)
  );
  // A changes its own pick to A2 — only A's entry moves; B's stays.
  await browser(`/api/review-state?session=${cfid}`, { reviewerId: 'A', comments: [], choices: { pick: 'A2' } });
  const cfState2 = await browser(`/api/state?session=${cfid}`);
  check(
    'a reviewer changing its own pick does not touch a peer\'s',
    cfState2.data.review.choices.pick.A === 'A2' && cfState2.data.review.choices.pick.B === 'A2',
    JSON.stringify(cfState2.data.review.choices)
  );
  await sleep(150);
  const reviewDeltas = cfEvents.events.filter((e) => e.event === 'review');
  check(
    'review-state broadcasts a "review" SSE delta carrying merged comments + choices + author',
    reviewDeltas.length >= 3 &&
      reviewDeltas.every((e) => {
        const d = JSON.parse(e.data);
        return d.author && typeof d.author.id === 'string' && 'comments' in d && 'choices' in d;
      }),
    JSON.stringify(reviewDeltas.map((e) => e.data))
  );
  const lastDelta = JSON.parse(reviewDeltas[reviewDeltas.length - 1].data);
  check(
    'the delta author id identifies the poster (so a tab can ignore its own echo)',
    lastDelta.author.id === 'A' && lastDelta.choices.pick.A === 'A2' && lastDelta.choices.pick.B === 'A2',
    JSON.stringify(lastDelta)
  );
  cfEvents.close();
  // DSM-16: a deselect (A posts a choices map WITHOUT `pick`) clears only A's entry;
  // B's pick survives. The deselect protocol is communicated purely by key-absence.
  await browser(`/api/review-state?session=${cfid}`, { reviewerId: 'A', comments: [], choices: {} });
  const cfDeselect = await browser(`/api/state?session=${cfid}`);
  check(
    'DSM-16: a reviewer deselecting drops only its own pick; the peer\'s remains',
    cfDeselect.data.review.choices.pick &&
      cfDeselect.data.review.choices.pick.A === undefined &&
      cfDeselect.data.review.choices.pick.B === 'A2',
    JSON.stringify(cfDeselect.data.review.choices)
  );
  await cli('stop', '--session', cfid);
```

- [ ] **Step 2: Run the tests, expect failure**

Run: `PLANREVIEW_TEST_PORT=4832 npm test 2>&1 | grep -E "per-reviewer|review-state broadcasts|delta author" | head`
Expected: FAIL — today `s.review.choices = body.choices` stores `{pick:'A2'}` (last-writer-wins, no per-reviewer nesting) and `/api/review-state` broadcasts nothing.

- [ ] **Step 3: Add `mergeChoices` and wire the handler**

In `server/server.js`, add `mergeChoices` right after `mergeComments`:

```javascript
// Per-reviewer choice map: { choiceId: { reviewerId: option } }. A POST carries the
// poster's OWN flat picks ({ choiceId: option }); we replace ONLY the poster's entries
// (a divergent pick by reviewer B never overwrites reviewer A's) and drop any of the
// poster's prior picks it no longer sends (a deselect). A prev entry that isn't a plain
// object — e.g. a pre-004 persisted `{choiceId: <string>}` — is dropped rather than
// mangled: a one-time loss only for a session already open across the upgrade.
function mergeChoices(prev, incoming, posterId) {
  const out = {};
  for (const [choiceId, byReviewer] of Object.entries(prev || {})) {
    if (!byReviewer || typeof byReviewer !== 'object' || Array.isArray(byReviewer)) continue;
    const kept = {};
    for (const [rid, opt] of Object.entries(byReviewer)) if (rid !== posterId) kept[rid] = opt;
    if (Object.keys(kept).length) out[choiceId] = kept;
  }
  for (const [choiceId, opt] of Object.entries(incoming || {})) {
    if (opt === undefined || opt === null || opt === '' || (Array.isArray(opt) && opt.length === 0)) continue;
    (out[choiceId] || (out[choiceId] = {}))[posterId] = opt;
  }
  return out;
}
```

Update the `/api/review-state` handler so choices merge per-reviewer and a `review` delta broadcasts (this replaces the version from Task 1 Step 3):

```javascript
    if (method === 'POST' && pathname === '/api/review-state') {
      const body = await readBody(req);
      const posterId = posterIdOf(body);
      // Author-scoped merge: preserves peers' comments (and agent replies + the
      // server's archived flag) against a browser sync that only owns its author's set.
      if (Array.isArray(body.comments))
        s.review.comments = mergeComments(s.review.comments, body.comments, posterId);
      // Per-reviewer choices: record only the poster's picks; peers' picks survive.
      if (body.choices && typeof body.choices === 'object')
        s.review.choices = mergeChoices(s.review.choices, body.choices, posterId);
      touch(s);
      // Live sync: fan the merged review out so other tabs render peers' comments and
      // choice picks. The poster ignores its own echo by author.id (see the client).
      broadcast(s, 'review', {
        comments: s.review.comments,
        choices: s.review.choices,
        author: { id: posterId },
      });
      persist(s);
      return sendJson(res, 200, { ok: true });
    }
```

Finally, harden `restoreSessions` so a pre-004 (or hand-edited) session file can't feed a bad `s.review` shape downstream (FM-4 / DSM-4 / DSM-13). Currently only `if (data.review && typeof data.review === 'object') s.review = data.review;` guards it (`:242`). Right after that line, coerce the fields and **migrate** a legacy flat choice value to the per-reviewer shape (attributing the pre-upgrade answer to `'anonymous'` so it's preserved, not dropped or mis-rendered):

```javascript
      if (data.review && typeof data.review === 'object') s.review = data.review;
      // A restored review must have the exact shapes the merge/render code assumes.
      if (!Array.isArray(s.review.comments)) s.review.comments = [];
      if (!s.review.choices || typeof s.review.choices !== 'object' || Array.isArray(s.review.choices))
        s.review.choices = {};
      // Migrate a pre-004 flat choice value ({choiceId: option|options[]}) to the
      // per-reviewer shape { reviewerId: option }, keeping the legacy answer under
      // 'anonymous' rather than dropping it on the first post-upgrade merge/render.
      for (const [cid, v] of Object.entries(s.review.choices)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) s.review.choices[cid] = { anonymous: v };
      }
```

- [ ] **Step 4: Update the existing tests that encode the OLD scalar choice shape (and add the migration test)**

Three existing assertions read `review.choices.pick` as a scalar; posts without a `reviewerId` now nest under `'anonymous'`. Update them:

In the persistence block — `test/e2e.js:380`:
```javascript
        before.review.choices.pick.anonymous === 'Two' &&
```
and `test/e2e.js:397`:
```javascript
        restored.data.review.choices.pick.anonymous === 'Two' &&
```

In the "answered questions persist across cycles" block — `test/e2e.js:999`:
```javascript
    cyc.data.review.choices.pick.anonymous === 'A1' &&
```

Then add a **pre-004 migration** test to `persistenceChecks()`, following the existing pre-seed pattern (P6, `test/e2e.js:584-613`). Insert a new block right before the `// ----- P7:` marker (`:615`):

```javascript
    // ----- P6b: a pre-004 legacy choice shape migrates on restore -----
    console.log('persistence: a pre-004 flat choice value migrates to the per-reviewer shape on restore');
    await killP();
    const stateDir6b = fs.mkdtempSync(path.join(os.tmpdir(), 'planreview-legacy-'));
    const legacyId = 'legacy1';
    fs.writeFileSync(
      path.join(stateDir6b, `${legacyId}.json`),
      JSON.stringify({
        id: legacyId,
        status: 'reviewing',
        doc: { path: null, title: 'Legacy', html: '<p>Hi</p>', version: 1, blocks: ['<p>Hi</p>'], history: [] },
        // OLD shape: choices is { choiceId: option } / { choiceId: options[] }, NOT nested.
        review: { comments: [], choices: { single: 'Two', multi: ['A', 'B'] } },
        submissions: [],
        chat: [],
        progress: [],
        queue: [],
        touched: Date.now(),
      })
    );
    spawnP({ PLANREVIEW_STATE_DIR: stateDir6b });
    check('persist: server up (legacy-migration case)', await waitHealth(true));
    const migrated = await p(`/api/state?session=${legacyId}`);
    check(
      'a pre-004 flat choice value migrates to { reviewerId: option } under anonymous (answer preserved, not garbage)',
      migrated.status === 200 &&
        migrated.data.review.choices.single &&
        migrated.data.review.choices.single.anonymous === 'Two' &&
        Array.isArray(migrated.data.review.choices.multi.anonymous) &&
        migrated.data.review.choices.multi.anonymous.join(',') === 'A,B',
      JSON.stringify(migrated.data.review.choices)
    );
    await stop(legacyId);
    await sleep(300);
    fs.rmSync(stateDir6b, { recursive: true, force: true });
```

- [ ] **Step 5: Run the tests, expect pass**

Run: `PLANREVIEW_TEST_PORT=4832 npm test 2>&1 | tail -3`
Expected: `all checks passed`.

- [ ] **Step 6: Commit**

```bash
git add server/server.js test/e2e.js
git commit -m "feat(server): per-reviewer choice map + live review broadcast"
```

---

### Task 3: Server — reviewer chat attribution

**Files:**
- Modify: `server/server.js` (`/api/chat` at `:600-611`; add an `authorOf` helper near the others)
- Test: `test/e2e.js` (new chat-attribution check)

**Reuse:** reuses `posterIdOf` shape (Task 1) via a small sibling `authorOf`; reuses `broadcast`, `enqueueAgentEvent`, `persist`. The `role: 'reviewer'` rendering contract is unchanged.

- [ ] **Step 1: Write a failing test for chat author attribution**

Add after the Task 2 block in `test/e2e.js`:

```javascript
  console.log('multi-reviewer: reviewer chat carries an author, role stays "reviewer"');
  const ch = await cli('start', docA, '--no-open');
  await browser(`/api/chat?session=${ch.id}`, { text: 'who owns this?', reviewerId: 'A', reviewerName: 'Ada' });
  await browser(`/api/chat?session=${ch.id}`, { text: 'anon here' }); // no identity
  const chState = await browser(`/api/state?session=${ch.id}`);
  const attributed = chState.data.chat.find((m) => m.text === 'who owns this?');
  const anon = chState.data.chat.find((m) => m.text === 'anon here');
  check(
    'a reviewer chat message carries author {id,name} and keeps role "reviewer"',
    attributed && attributed.role === 'reviewer' && attributed.author &&
      attributed.author.id === 'A' && attributed.author.name === 'Ada',
    JSON.stringify(attributed)
  );
  check(
    'an un-identified chat message omits author (renders exactly as today)',
    anon && anon.role === 'reviewer' && !anon.author,
    JSON.stringify(anon)
  );
  await cli('stop', '--session', ch.id);
```

- [ ] **Step 2: Run the test, expect failure**

Run: `PLANREVIEW_TEST_PORT=4833 npm test 2>&1 | grep -E "reviewer chat message carries|un-identified chat" | head`
Expected: FAIL — today `/api/chat` builds `{ role: 'reviewer', text, ts }` with no author.

- [ ] **Step 3: Add `authorOf` and attribute the chat message**

Add `authorOf` next to `posterIdOf` in `server/server.js`:

```javascript
// The author object for a chat/reply from a POST body: {id, name?} when the body
// carries a reviewerId, else null (an un-identified message stays un-attributed and
// renders exactly as it did before this feature).
function authorOf(body) {
  const id = body && typeof body.reviewerId === 'string' ? body.reviewerId.trim() : '';
  if (!id) return null;
  const name = body && typeof body.reviewerName === 'string' ? body.reviewerName.trim() : '';
  return name ? { id, name } : { id };
}
```

Update the `/api/chat` handler (`:600-611`):

```javascript
    if (method === 'POST' && pathname === '/api/chat') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'empty message' });
      const author = authorOf(body);
      const msg = { role: 'reviewer', text, ts: Date.now(), ...(author ? { author } : {}) };
      s.chat.push(msg);
      touch(s);
      broadcast(s, 'chat', msg);
      enqueueAgentEvent(s, { type: 'chat', text, ts: msg.ts, ...(author ? { author } : {}) });
      persist(s);
      return sendJson(res, 200, { ok: true });
    }
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `PLANREVIEW_TEST_PORT=4833 npm test 2>&1 | tail -3`
Expected: `all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add server/server.js test/e2e.js
git commit -m "feat(server): attribute reviewer chat messages to an author"
```

---

### Task 4: Server — submit/approve consolidation (no-loss bundle)

**Files:**
- Modify: `server/server.js` (`reviewBundle` at `:344-352`; submit/approve handler at `:639-653`)
- Test: `test/e2e.js` (new two-reviewer consolidation + single-reviewer parity checks; UPDATE the full-cycle submit assertion that encodes the old scalar choice shape)

**Reuse:** reuses `mergeComments`/`mergeChoices`/`posterIdOf` (Tasks 1–2) and Node's global `structuredClone` (Node ≥ 17; `engines` requires ≥ 18) to snapshot the bundle.

**Why a consolidated snapshot (not a mutation):** today `/api/submit` does NOT write into `s.review` — it only bundles the body into `s.submissions` (the full-cycle test at `:928` relies on `s.review.comments` staying empty after a submit-without-review-state). Yet the bundle must contain the poster's body comments (`:914`) AND every peer's comments already in `s.review`. So `reviewBundle` merges the body **over** `s.review` into a throwaway consolidated set and `structuredClone`s it — no loss, no side effect on the draft.

- [ ] **Step 1: Write failing tests — two-reviewer consolidation + single-reviewer parity**

Add after the Task 3 block in `test/e2e.js`:

```javascript
  console.log('multi-reviewer: submit consolidates every reviewer\'s comments + per-reviewer choices');
  const sb = await cli('start', docA, '--no-open');
  const sbid = sb.id;
  // A syncs a comment + a choice via review-state (the shared draft).
  await browser(`/api/review-state?session=${sbid}`, {
    reviewerId: 'A',
    comments: [{ id: 'a1', quote: 'Body of plan A.', text: 'A says', author: { id: 'A', name: 'Ada' } }],
    choices: { pick: 'A1' },
  });
  // B submits, posting its OWN body (b1 + B's flat pick). The bundle must carry BOTH
  // reviewers' comments and BOTH reviewers' choice entries.
  const sbWait = cli('wait', '--session', sbid, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${sbid}`, {
    reviewerId: 'B',
    comments: [{ id: 'b1', quote: 'Body of plan A.', text: 'B says', author: { id: 'B', name: 'Ben' } }],
    choices: { pick: 'A2' },
    note: 'consolidated',
  });
  const sbEv = await sbWait;
  check(
    'the submit bundle consolidates all reviewers\' comments (no loss), each attributed',
    sbEv.type === 'submit' &&
      sbEv.comments.length === 2 &&
      sbEv.comments.some((c) => c.id === 'a1' && c.author.id === 'A') &&
      sbEv.comments.some((c) => c.id === 'b1' && c.author.id === 'B'),
    JSON.stringify(sbEv.comments)
  );
  check(
    'the submit bundle carries the full per-reviewer choice map (the conflict survives)',
    sbEv.choices.pick && sbEv.choices.pick.A === 'A1' && sbEv.choices.pick.B === 'A2' && sbEv.note === 'consolidated',
    JSON.stringify(sbEv.choices)
  );
  // The submit must NOT have mutated the shared draft (mirror today's behavior): the
  // draft still holds only A's synced comment, not B's submitted one.
  const sbDraft = await browser(`/api/state?session=${sbid}`);
  check(
    'submit leaves the shared review draft unmutated (no side effect on s.review)',
    sbDraft.data.review.comments.length === 1 && sbDraft.data.review.comments[0].id === 'a1',
    JSON.stringify(sbDraft.data.review.comments)
  );
  await cli('stop', '--session', sbid);

  console.log('single-reviewer regression: one reviewer behaves exactly as before (union = just theirs)');
  const one = await cli('start', docA, '--no-open');
  const oneWait = cli('wait', '--session', one.id, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${one.id}`, {
    reviewerId: 'solo',
    comments: [{ id: 's1', quote: 'Body of plan A.', text: 'solo note', author: { id: 'solo' } }],
    choices: { pick: 'A1' },
    note: 'ship',
  });
  const oneEv = await oneWait;
  check(
    'single reviewer: bundle is exactly their one comment + a one-entry choice map',
    oneEv.type === 'submit' &&
      oneEv.comments.length === 1 &&
      oneEv.comments[0].id === 's1' &&
      Object.keys(oneEv.choices.pick).length === 1 &&
      oneEv.choices.pick.solo === 'A1',
    JSON.stringify({ comments: oneEv.comments, choices: oneEv.choices })
  );
  await cli('stop', '--session', one.id);

  console.log('multi-reviewer: two concurrent submits do not double-enqueue (check-then-act race)');
  const rc = await cli('start', docA, '--no-open');
  // Fire two submits at the same instant. The status guard must let exactly one
  // through; the loser gets a 409 (FM-3) — never two 'submit' events for one round.
  const [r1, r2] = await Promise.all([
    browser(`/api/submit?session=${rc.id}`, { reviewerId: 'A', comments: [], choices: {}, note: 'one' }),
    browser(`/api/submit?session=${rc.id}`, { reviewerId: 'B', comments: [], choices: {}, note: 'two' }),
  ]);
  check(
    'FM-3: exactly one concurrent submit wins; the other 409s',
    r1.ok !== r2.ok && (r1.status === 409 || r2.status === 409),
    JSON.stringify({ r1: r1.status, r2: r2.status })
  );
  const rcEv1 = await cli('wait', '--session', rc.id, '--timeout', '3');
  const rcEv2 = await cli('wait', '--session', rc.id, '--timeout', '1');
  check(
    'FM-3: only ONE submit event was enqueued (agent reworks once)',
    rcEv1.type === 'submit' && rcEv2.type === 'timeout',
    JSON.stringify({ e1: rcEv1.type, e2: rcEv2.type })
  );
  await cli('stop', '--session', rc.id);

  console.log('multi-reviewer: a re-present carries every reviewer\'s comments + choices forward');
  const carryDoc = path.join(dir, 'planreview-e2e-carry.md');
  fs.writeFileSync(carryDoc, '# Carry\n\nShared body line.\n');
  const cy = await cli('start', carryDoc, '--no-open');
  await browser(`/api/review-state?session=${cy.id}`, {
    reviewerId: 'A',
    comments: [{ id: 'ca', quote: 'Shared body line.', text: 'A note', author: { id: 'A', name: 'Ada' } }],
    choices: { pick: 'A1' },
  });
  await browser(`/api/review-state?session=${cy.id}`, {
    reviewerId: 'B',
    comments: [{ id: 'cb', quote: 'Shared body line.', text: 'B note', author: { id: 'B', name: 'Ben' } }],
    choices: { pick: 'A2' },
  });
  fs.writeFileSync(carryDoc, '# Carry\n\nShared body line.\n\nA reworked addition.\n');
  await cli('present', carryDoc, '--session', cy.id);
  const carried = await browser(`/api/state?session=${cy.id}`);
  check(
    'DSM-3: loadDoc carries BOTH reviewers\' attributed comments + per-reviewer choices across a re-present',
    carried.data.review.comments.length === 2 &&
      carried.data.review.comments.some((c) => c.id === 'ca' && c.author.id === 'A' && !c.archived) &&
      carried.data.review.comments.some((c) => c.id === 'cb' && c.author.id === 'B' && !c.archived) &&
      carried.data.review.choices.pick.A === 'A1' &&
      carried.data.review.choices.pick.B === 'A2',
    JSON.stringify(carried.data.review)
  );
  await cli('stop', '--session', cy.id);
```

- [ ] **Step 2: Run the tests, expect failure**

Run: `PLANREVIEW_TEST_PORT=4834 npm test 2>&1 | grep -E "submit bundle consolidates|full per-reviewer choice map|single reviewer:" | head`
Expected: FAIL — today `reviewBundle` reads only `body.comments`/`body.choices`, so B's submit bundles only `[b1]` and `{pick:'A2'}` (A's input is lost, choices not nested).

- [ ] **Step 3: Rewrite `reviewBundle` to consolidate, and pass the poster id from the handler**

Replace `reviewBundle` (`:344-352`) with:

```javascript
// Build the review bundle a submit/approve hands the agent. It CONSOLIDATES: the
// submitter's posted body is merged over the shared review (every peer's already-synced
// comments + the full per-reviewer choice map) into a throwaway snapshot — so nothing
// is lost — WITHOUT mutating s.review (the draft's carry-forward behavior is unchanged).
// structuredClone de-aliases the snapshot from live session objects (e.g. a later
// /agent/reply mutating a comment's replies must not rewrite a historical submission).
function reviewBundle(s, body, posterId) {
  const comments = mergeComments(
    s.review.comments,
    Array.isArray(body.comments) ? body.comments : [],
    posterId
  );
  const choices = mergeChoices(
    s.review.choices,
    body.choices && typeof body.choices === 'object' ? body.choices : {},
    posterId
  );
  return {
    comments: structuredClone(comments),
    choices: structuredClone(choices),
    note: typeof body.note === 'string' ? body.note : '',
    docVersion: s.doc.version,
    submittedAt: new Date().toISOString(),
  };
}
```

Update the submit/approve handler (`:639-653`). Read the body FIRST, then guard, then mutate — so there is NO `await` between the `s.status` check and the `s.status` write. `reviewBundle` is synchronous, so the check→mutate window is atomic and two concurrent submits can't both pass the guard (FM-3):

```javascript
    if (method === 'POST' && (pathname === '/api/submit' || pathname === '/api/approve')) {
      const approve = pathname === '/api/approve';
      const verb = approve ? 'approve' : 'submit';
      const body = await readBody(req);
      // Guard AFTER the await, then mutate synchronously — closes the check-then-act
      // race where two reviewers submitting at once both pass a pre-await guard and
      // each enqueue a round (FM-3). reviewBundle below performs no I/O / await.
      if (s.status !== 'reviewing')
        return sendJson(res, 409, { error: `cannot ${verb} while ${s.status}` });
      const bundle = reviewBundle(s, body, posterIdOf(body));
      s.submissions.push(bundle);
      s.progress = []; // start the rework round with a clean progress log
      s.status = approve ? 'done' : 'working';
      touch(s);
      broadcast(s, 'status', { status: s.status });
      enqueueAgentEvent(s, { type: verb, ...bundle });
      persist(s);
      return sendJson(res, 200, { ok: true });
    }
```

- [ ] **Step 4: Update the full-cycle submit assertion for the nested choice shape**

`test/e2e.js:915` currently asserts `subEv.choices.pick === 'a custom third option'`. That submit posts no `reviewerId`, so the pick now nests under `'anonymous'`:

```javascript
      subEv.choices.pick.anonymous === 'a custom third option' &&
```

- [ ] **Step 5: Run the tests, expect pass**

Run: `PLANREVIEW_TEST_PORT=4834 npm test 2>&1 | tail -3`
Expected: `all checks passed`.

- [ ] **Step 6: Commit**

```bash
git add server/server.js test/e2e.js
git commit -m "feat(server): consolidate all reviewers' input into the submit bundle"
```

---

### Task 5: Client — reviewer identity + attach authors + nested-choice plumbing

**Files:**
- Modify: `public/app.js` (identity block near `:9`; `saveComment` `:565-575`; `replyForm` `:640-648`; chat submit `:371-383`; `syncReview` `:778-784`; client `reviewBundle` `:838-845`; `bindChoices` `:435-501`; `state.choices` doc-comment `:54`)
- Test: `test/e2e.js` (regex presence checks on served `/app.js`, following the existing static-asset convention near the file's tail)

**Reuse:** extends the existing `state`, `syncReview`, `bindChoices`, `saveComment`, chat/reply handlers in `public/app.js`. `crypto.randomUUID` is a Web API (secure context — `127.0.0.1` qualifies), with a `Date.now()`+`Math.random()` fallback. NEW: identity module + `myChoices()`/`myPick()` helpers (no existing equivalent).

**Runtime coherence note:** this task changes `state.choices` from a scalar-per-choice map to the nested `{choiceId:{reviewerId:option}}` shape, so `bindChoices`' own read/write MUST move to the poster's own entry in the SAME commit (Task 6 layers the peer-facing UI on top). Post only the flat own-picks — the server nests them.

- [ ] **Step 1: Write failing regex checks for the client identity wiring**

In `test/e2e.js`, find the static-asset block near the tail (the `const app = await text('/app.js');` around `:~` after "static assets: no-store…"). Add these checks right after the existing `check('client is session-scoped …')`:

```javascript
  check(
    'client mints a persistent reviewer identity (localStorage + crypto.randomUUID)',
    /pr\.reviewerId/.test(app.body) && /crypto\.randomUUID/.test(app.body) && /localStorage/.test(app.body)
  );
  check(
    'client attaches reviewerId to its mutating posts (review-state / submit / chat)',
    /reviewerId:\s*reviewer\.id/.test(app.body)
  );
  check(
    'client posts only its OWN flat choice picks (server nests them per reviewer)',
    /function myChoices\(/.test(app.body) && /choices:\s*myChoices\(\)/.test(app.body)
  );
  check(
    'client stamps new comments with an author',
    /author:\s*author\(\)/.test(app.body)
  );
```

- [ ] **Step 2: Run, expect failure**

Run: `PLANREVIEW_TEST_PORT=4835 npm test 2>&1 | grep -E "reviewer identity|reviewerId to its mutating|OWN flat choice|stamps new comments" | head`
Expected: FAIL — none of this wiring exists yet.

- [ ] **Step 3: Add the identity module**

In `public/app.js`, just after the `SESSION`/`api()` block (after `:14`), add:

```javascript
// ---------- reviewer identity ----------
//
// Ephemeral and per-browser. reviewerId persists in localStorage so a refresh keeps
// the same identity (and thus authorship of this tab's comments); reviewerName is an
// optional, editable display label. No accounts, no server roster — identity rides
// along on every mutating request as a top-level reviewerId/reviewerName and, on
// comments/replies, an author:{id,name}. Absent identity, the server treats the
// poster as 'anonymous' and everything behaves as it did before this feature.

const REVIEWER_ID_KEY = 'pr.reviewerId';
const REVIEWER_NAME_KEY = 'pr.reviewerName';

function loadReviewerId() {
  let id = '';
  try {
    id = localStorage.getItem(REVIEWER_ID_KEY) || '';
  } catch {
    /* storage blocked (private mode) — fall through to a fresh per-load id */
  }
  if (!id) {
    id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      localStorage.setItem(REVIEWER_ID_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

const reviewer = {
  id: loadReviewerId(),
  get name() {
    try {
      return localStorage.getItem(REVIEWER_NAME_KEY) || '';
    } catch {
      return '';
    }
  },
  set name(v) {
    try {
      localStorage.setItem(REVIEWER_NAME_KEY, v || '');
    } catch {
      /* ignore */
    }
  },
};

// The author stamp for a comment/reply this tab creates.
function author() {
  return reviewer.name ? { id: reviewer.id, name: reviewer.name } : { id: reviewer.id };
}

// This tab's OWN flat picks pulled out of the nested per-reviewer choice map — the
// shape the server expects a POST to carry (it re-nests them under reviewer.id).
function myChoices() {
  const out = {};
  for (const [id, byReviewer] of Object.entries(state.choices || {})) {
    if (byReviewer && typeof byReviewer === 'object' && byReviewer[reviewer.id] !== undefined)
      out[id] = byReviewer[reviewer.id];
  }
  return out;
}

// This tab's own current pick for one choice block (undefined if it hasn't chosen).
function myPick(id) {
  const byReviewer = state.choices[id];
  return byReviewer && typeof byReviewer === 'object' ? byReviewer[reviewer.id] : undefined;
}
```

Update the `state.choices` doc-comment (`:54`) to reflect the new shape:

```javascript
  choices: {}, // choiceId -> { reviewerId -> value(string) | values(string[]) when multi }
```

- [ ] **Step 4: Attach identity to every mutation**

`saveComment` (`:570`) — stamp the author:

```javascript
  state.comments.push({ id, quote: pendingQuote, text, ts: Date.now(), author: author() });
```

Reviewer follow-up in `replyForm` (`:645`) — stamp the author:

```javascript
    (c.replies || (c.replies = [])).push({ role: 'reviewer', text, ts: Date.now(), author: author() });
```

Chat submit handler (`:378-382`) — send identity:

```javascript
  await fetch(api('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, reviewerId: reviewer.id, reviewerName: reviewer.name }),
  }).catch(() => {});
```

`syncReview` (`:778-784`) — send identity + own flat picks:

```javascript
async function syncReview() {
  await fetch(api('/api/review-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewerId: reviewer.id,
      reviewerName: reviewer.name,
      comments: state.comments,
      choices: myChoices(),
    }),
  }).catch(() => {});
}
```

Client `reviewBundle` (`:838-845`) — send identity + own flat picks:

```javascript
function reviewBundle() {
  return {
    reviewerId: reviewer.id,
    reviewerName: reviewer.name,
    comments: state.comments,
    choices: myChoices(),
    note: overallNoteEl.value.trim(),
    docVersion: state.version,
  };
}
```

- [ ] **Step 5: Move `bindChoices` to read/write the poster's own entry**

In `bindChoices` (`:435-501`), the four places that read/write `state.choices[id]` as a scalar must go through the reviewer's own entry. Replace the `refreshSummary`, `sync`, `saved` restore, and the answered-collapse tail:

`refreshSummary` (`:458-460`):
```javascript
    const refreshSummary = () => {
      summaryVal.textContent = answerText(myPick(id));
    };
```

`sync` (`:466-471`):
```javascript
    const sync = () => {
      const vals = boxes.filter((i) => i.checked).map(valueOf).filter((v) => v !== '');
      const pick = multi ? vals : vals[0];
      const byReviewer = state.choices[id] || (state.choices[id] = {});
      if (pick === undefined || (Array.isArray(pick) && pick.length === 0)) delete byReviewer[reviewer.id];
      else byReviewer[reviewer.id] = pick;
      refreshSummary();
      syncReview();
    };
```

`saved` restore (`:474`):
```javascript
    const saved = myPick(id);
```

Answered-collapse tail (`:498-499`):
```javascript
    refreshSummary();
    if (hasAnswer(myPick(id))) block.classList.add('answered'); // collapse if already answered
```

- [ ] **Step 6: Run the tests, expect pass**

Run: `PLANREVIEW_TEST_PORT=4835 npm test 2>&1 | tail -3`
Expected: `all checks passed`. (The regex checks pass; server-side tests unaffected.)

- [ ] **Step 7: Sanity-drive the client in a real browser flow (no test asserts this at runtime)**

Because runtime client behavior isn't covered by the DOM shim, exercise it manually once with the CLI + curl to confirm the nested-choice plumbing round-trips:

```bash
PLANREVIEW_PORT=4899 node server/server.js &
SRV=$!; sleep 0.6
ID=$(curl -s -XPOST localhost:4899/agent/start -d "{\"path\":\"$(pwd)/README.md\"}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -s -XPOST "localhost:4899/api/review-state?session=$ID" -d '{"reviewerId":"A","comments":[],"choices":{"x":"one"}}' >/dev/null
curl -s -XPOST "localhost:4899/api/review-state?session=$ID" -d '{"reviewerId":"B","comments":[],"choices":{"x":"two"}}' >/dev/null
curl -s "localhost:4899/api/state?session=$ID" | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d).review.choices)))"
kill $SRV
```
Expected: `{"x":{"A":"one","B":"two"}}` (both picks retained, nested per reviewer).

- [ ] **Step 8: Commit**

```bash
git add public/app.js test/e2e.js
git commit -m "feat(client): reviewer identity + per-reviewer choice plumbing"
```

---

### Task 6: Client — attribution UI (badges, colors, chat/reply names, choice conflict)

**Files:**
- Modify: `public/app.js` (`viewCard` `:662-696`, `renderThread` `:614-625`, `appendChatMessage` `:249-255`, `bindChoices` `:435-501`; add `authorColor`/badge helpers; add an identity affordance near boot `:960-963`)
- Modify: `public/index.html` (add a small "you are …" affordance container in the topbar `:10-15`)
- Modify: `public/style.css` (styles for `.author-badge`, `.choice-picks`, `.choice-disagree`, `.identity`)
- Test: `test/e2e.js` (regex presence checks on served `/app.js`, `/s/<id>` page, and `/style.css`)

**Reuse:** extends existing render functions in `public/app.js`; reuses the `.choice-block` DOM `bindChoices` already walks. NEW: `authorColor` (deterministic hue from id), attribution DOM builders (no existing equivalent).

- [ ] **Step 1: Write failing regex checks for the attribution UI**

Add to the static-asset block in `test/e2e.js` (after the Task 5 checks):

```javascript
  check(
    'client renders comment author badges with an id-derived color',
    /author-badge/.test(app.body) && /function authorColor\(/.test(app.body)
  );
  check(
    'client shows per-option who-picked badges and a muted disagree hint on choices',
    /choice-picks/.test(app.body) && /choice-disagree/.test(app.body)
  );
  check(
    'client shows the reviewer name on chat lines',
    /chat-author/.test(app.body)
  );
  check(
    'review page carries the "you are <name>" identity affordance',
    /id="identity"/.test(appPage.body)
  );
  check(
    'stylesheet styles the attribution UI (author badge + choice conflict)',
    /author-badge/.test(css.body) && /choice-disagree/.test(css.body)
  );
```

(`appPage` and `css` are already fetched earlier in this block; if `appPage` isn't in scope, reuse the existing `const appPage = await text('/s/...')` fetch used by the liveness checks.)

- [ ] **Step 2: Run, expect failure**

Run: `PLANREVIEW_TEST_PORT=4836 npm test 2>&1 | grep -E "author badges|who-picked|reviewer name on chat|identity affordance|styles the attribution" | head`
Expected: FAIL — none of these class hooks exist yet.

- [ ] **Step 3: Add attribution helpers + badge to comments**

In `public/app.js`, add near the other utils (before `renderComments`, ~`:577`):

```javascript
// A stable, legible color per reviewer id — a hashed hue so the same reviewer gets
// the same badge color across cards without any server-assigned palette.
function authorColor(id) {
  let h = 0;
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

// The display label for an author stamp: their name, else a short id, else 'anonymous'.
function authorLabel(a) {
  if (!a) return 'anonymous';
  if (a.name) return a.name;
  return a.id ? a.id.slice(0, 8) : 'anonymous';
}

// A small colored badge naming an author (used on comment cards, replies, chat).
function authorBadge(a) {
  const badge = document.createElement('span');
  badge.className = 'author-badge';
  badge.textContent = authorLabel(a);
  if (a && a.id) badge.style.setProperty('--author-color', authorColor(a.id));
  return badge;
}
```

In `viewCard` (`:662-696`), add the badge to the actions row. After building `actions` and before appending the icon buttons (i.e. right after `actions.className = 'card-actions';` at `:668`):

```javascript
  if (c.author) actions.appendChild(authorBadge(c.author));
```

In `renderThread` (`:614-625`), prefix each reply with its author when present. Replace the reply loop body:

```javascript
  for (const r of c.replies || []) {
    const reply = document.createElement('div');
    reply.className = `reply ${r.role === 'agent' ? 'agent' : 'reviewer'}`;
    if (r.role !== 'agent' && r.author) reply.appendChild(authorBadge(r.author));
    const body = document.createElement('span');
    body.className = 'reply-text';
    body.textContent = r.text;
    reply.appendChild(body);
    thread.appendChild(reply);
  }
```

- [ ] **Step 4: Show the reviewer name on chat lines**

In `appendChatMessage` (`:249-255`), attribute reviewer messages:

```javascript
function appendChatMessage(msg) {
  const el = document.createElement('div');
  el.className = `chat-msg ${msg.role}`;
  if (msg.role !== 'agent' && msg.author) {
    const who = document.createElement('span');
    who.className = 'chat-author';
    who.textContent = authorLabel(msg.author);
    who.style.setProperty('--author-color', authorColor(msg.author.id));
    el.appendChild(who);
  }
  const body = document.createElement('span');
  body.className = 'chat-text';
  body.textContent = msg.text;
  el.appendChild(body);
  chatListEl.appendChild(el);
  chatListEl.scrollTop = chatListEl.scrollHeight;
}
```

- [ ] **Step 5: Render per-option who-picked badges + a disagree hint on choices**

In `bindChoices` (`:435-501`), after the `summary`/`refreshSummary` setup and before `refreshSummary()` at the tail, build a picks display driven by the full per-reviewer map. Add a `renderPicks` closure and call it from `sync` and once at the end:

```javascript
    // Who picked what across ALL reviewers (not just this tab): a badge per option
    // with the reviewers who chose it, plus a muted hint when picks diverge. No lock.
    const picksEl = document.createElement('div');
    picksEl.className = 'choice-picks';
    block.appendChild(picksEl);
    const renderPicks = () => {
      const byReviewer = state.choices[id];
      // Guard the shape (DSM-13): a pre-004 restored session can still hold a legacy
      // scalar/array here until its first post-restore sync; Object.entries on a string
      // would yield per-character garbage badges. Only a plain nested object renders.
      const entries =
        byReviewer && typeof byReviewer === 'object' && !Array.isArray(byReviewer)
          ? Object.entries(byReviewer) // [reviewerId, option]
          : [];
      picksEl.innerHTML = '';
      if (!entries.length) {
        picksEl.hidden = true;
        return;
      }
      picksEl.hidden = false;
      // count per option label, skipping empty/non-string labels (FM-10)
      const counts = new Map();
      for (const [rid, opt] of entries) {
        for (const label of Array.isArray(opt) ? opt : [opt]) {
          if (typeof label !== 'string' || label === '') continue;
          if (!counts.has(label)) counts.set(label, []);
          counts.get(label).push(rid);
        }
      }
      for (const [label, rids] of counts) {
        const tag = document.createElement('span');
        tag.className = 'choice-pick';
        tag.textContent = `${rids.length} · ${label}`;
        tag.title = rids.map((r) => (r === reviewer.id ? 'you' : r.slice(0, 8))).join(', ');
        picksEl.appendChild(tag);
      }
      if (counts.size > 1) {
        const hint = document.createElement('span');
        hint.className = 'choice-disagree';
        hint.textContent = 'reviewers disagree';
        picksEl.appendChild(hint);
      }
    };
```

Call `renderPicks()` inside `sync` (append after `refreshSummary();`) and once at the tail (append after the existing final `refreshSummary();` at `:498`):

```javascript
    refreshSummary();
    renderPicks();
    if (hasAnswer(myPick(id))) block.classList.add('answered');
```

(and inside `sync`, after `refreshSummary();`:)
```javascript
      renderPicks();
```

- [ ] **Step 6: Add the "you are <name> (edit)" affordance**

In `public/index.html`, add an identity chip into the topbar between the status pill and the End button (`:13-14`):

```html
    <span class="pill" id="status-pill" data-status="idle">idle</span>
    <span id="identity" class="identity" title="Your reviewer name — visible to others on this plan"></span>
    <button id="end-btn" class="btn danger">End session</button>
```

In `public/app.js`, wire the affordance near boot (before `fetchState();` at `:962`):

```javascript
// ---------- identity affordance ----------
// A small "you are <name> (edit)" chip. Editing the name updates localStorage and
// re-syncs so peers see the new label on this tab's future mutations.
function renderIdentity() {
  const el = document.getElementById('identity');
  if (!el) return;
  el.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'identity-name';
  label.textContent = `you are ${authorLabel({ id: reviewer.id, name: reviewer.name })}`;
  label.style.setProperty('--author-color', authorColor(reviewer.id));
  const edit = document.createElement('button');
  edit.className = 'btn identity-edit';
  edit.textContent = 'edit';
  edit.addEventListener('click', () => {
    const next = prompt('Your reviewer name (shown to others on this plan):', reviewer.name);
    if (next === null) return;
    reviewer.name = next.trim();
    renderIdentity();
    syncReview(); // re-stamp future work; existing comments keep their prior author
  });
  el.append(label, edit);
}
renderIdentity();
```

- [ ] **Step 7: Style the attribution UI**

Append to `public/style.css`:

```css
/* ---------- multi-reviewer attribution ---------- */
.author-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  padding: 1px 7px;
  margin-right: 6px;
  border-radius: 999px;
  color: #fff;
  background: var(--author-color, var(--ink-soft));
  vertical-align: middle;
}
.chat-author {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  margin-right: 6px;
  color: var(--author-color, var(--ink-soft));
}
.reply-text,
.chat-text { vertical-align: middle; }
.choice-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.choice-pick {
  font-size: 12px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-soft);
  background: var(--surface);
}
.choice-disagree {
  font-size: 12px;
  font-style: italic;
  color: var(--ink-soft);
  align-self: center;
}
.identity {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.identity-name { color: var(--author-color, var(--ink-soft)); font-weight: 600; }
.identity-edit { padding: 1px 8px; font-size: 12px; }
```

- [ ] **Step 8: Run the tests, expect pass**

Run: `PLANREVIEW_TEST_PORT=4836 npm test 2>&1 | tail -3`
Expected: `all checks passed`.

- [ ] **Step 9: Commit**

```bash
git add public/app.js public/index.html public/style.css test/e2e.js
git commit -m "feat(client): attribution UI — author badges, names, choice conflict"
```

---

### Task 7: Client — live peer sync via the `review` SSE delta

**Files:**
- Modify: `public/app.js` (`connectEvents` at `:387-428`)
- Test: `test/e2e.js` (regex presence check on served `/app.js`)

**Reuse:** reuses the existing `EventSource`/`connectEvents` machinery and `fetchState` (`:218-245`), which already re-anchors comments and re-renders comments/choices from `/api/state`. NEW: only the `review` listener.

**Why re-fetch instead of applying the delta in place:** `fetchState` already rebuilds the doc HTML (clearing + re-anchoring all comment highlights) and re-renders comments + choices from the authoritative `s.review`. A peer `review` delta means "the shared review changed"; the simplest correct response — mirroring how the existing `doc` event and `es.onopen` heal — is to re-fetch. The poster ignores its own echo (by `author.id`) so its own in-flight composer state is never yanked out from under it.

- [ ] **Step 1: Write a failing regex check for the review listener**

Add to the static-asset block in `test/e2e.js` (after the Task 6 checks):

```javascript
  check(
    'client live-syncs on a peer "review" delta and ignores its own echo by author id',
    /addEventListener\('review'/.test(app.body) && /author\.id === reviewer\.id/.test(app.body)
  );
```

- [ ] **Step 2: Run, expect failure**

Run: `PLANREVIEW_TEST_PORT=4837 npm test 2>&1 | grep "peer .review. delta" | head`
Expected: FAIL — there's no `review` listener yet.

- [ ] **Step 3: Add the `review` listener**

In `connectEvents` (`public/app.js`), add alongside the other `es.addEventListener(...)` handlers (e.g. after the `comment-reply` handler at `:408`):

```javascript
  // another reviewer changed the shared review (a comment or a choice pick): re-sync
  // from the server so their comment/pick renders live. Ignore our own echo — we are
  // the source of truth for our in-flight edits and must not clobber the composer.
  es.addEventListener('review', (e) => {
    const d = JSON.parse(e.data);
    if (d.author && d.author.id === reviewer.id) return; // our own change — already local
    fetchState();
  });
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `PLANREVIEW_TEST_PORT=4837 npm test 2>&1 | tail -3`
Expected: `all checks passed`.

- [ ] **Step 5: Verify live sync end-to-end over SSE (server proof of the delta reaching a peer)**

The client re-fetch isn't runtime-asserted, but the server-side delta delivery is already proven in Task 2 (`captureEvents` sees `review` frames). Confirm once more that a second connected tab receives a peer's delta:

```bash
PLANREVIEW_TEST_PORT=4838 npm test 2>&1 | grep -E "review-state broadcasts|delta author" 
```
Expected: both checks `ok`.

- [ ] **Step 6: Commit**

```bash
git add public/app.js test/e2e.js
git commit -m "feat(client): live-sync on peer review deltas over SSE"
```

---

### Task 8: Full regression + single-reviewer parity sweep

**Files:**
- Test: `test/e2e.js` (no new code required beyond Tasks 1–7; this task is the whole-suite gate)

**Reuse:** the single-reviewer parity assertions were added in Task 4; the existing full-cycle / approve / persistence / isolation suites are the regression backstop.

- [ ] **Step 1: Run the entire suite on a unique port**

Run: `PLANREVIEW_TEST_PORT=4839 npm test 2>&1 | tail -5`
Expected: `all checks passed` with zero `FAIL` lines.

- [ ] **Step 2: Confirm the single-reviewer regression checks are present and green**

Run: `PLANREVIEW_TEST_PORT=4840 npm test 2>&1 | grep -E "single reviewer:|single-reviewer regression"`
Expected: the parity checks report `ok`.

- [ ] **Step 3: Grep for any accidental old-shape choice assertions left behind**

Run: `grep -nE "choices\.pick ===|choices\.pick\.pick" test/e2e.js`
Expected: no output (every `choices.pick` assertion now reads a nested `{reviewerId: option}` entry).

- [ ] **Step 4: Commit any final test tidy-ups (if Step 3 surfaced anything)**

```bash
git add test/e2e.js
git commit -m "test: finish multi-reviewer coverage + single-reviewer parity sweep"
```

---

## Spec coverage check

| Design / acceptance item | Task(s) |
|---|---|
| Ephemeral per-tab identity (reviewerId in localStorage + optional name) | 5 |
| `author:{id,name}` rides on comments / replies / chat | 3, 5, 6 |
| Comments union across authors; a poster owns only its own (create/edit/delete) | 1 |
| Choices become `{choiceId:{reviewerId:option}}`; conflict surfaced, not overwritten | 2, 6 |
| Live sync: `review` SSE delta; a tab ignores its own echo | 2, 7 |
| Submit consolidates all reviewers' comments + per-reviewer choices, no loss | 4 |
| Chat message attributed; role stays `reviewer`/`agent` | 3, 6 |
| Attribution UI: comment badge+color, chat name, choice who-picked + disagree hint | 6 |
| Absent reviewerId → synthetic `anonymous`, nothing breaks | 1, 2, 3 (defaults) |
| Single-reviewer session behaves exactly as today | 4 (parity test), 8 (sweep) |
| Persistence: author + per-reviewer choices round-trip via existing `persist(s)` | 2 (updated persistence assertions prove the round-trip) |
| Archived flag stays server-authoritative | 1 (`reconcileComment` preserves it) |
| Deletion scoped to author | 1 |
| Use a unique `PLANREVIEW_TEST_PORT` to avoid the 4799 collision | every run step |

---

## G4 enumeration — FMEA catalog (failure modes → tests)

Adversarial FMEA (Sonnet) enumerated failure modes against the plan. Those that were real defects in the new code are folded into the tasks above as failing tests first. Legend: **T** = which task covers it.

| FM | Sev | Failure mode | Disposition |
|---|---|---|---|
| FM-7 | High | Malformed top-level comment (`null` / `{}` / id-less) → `c.id` deref throws → 500 | **Fixed** — `mergeComments` filters malformed entries (T1); test posts `[null,{}]` and asserts a clean 200. |
| FM-3 | High | `/api/submit` + `/api/approve` check status *before* `await readBody` → two concurrent submits both pass the guard, double-enqueue a round | **Fixed** — guard moved after `readBody`, check→mutate now await-free/atomic (T4); concurrent-submit test asserts one 409 + one queued event. |
| FM-4 | High | Pre-004 persisted session (flat `{choiceId:option}`) restored by new code → reads as unanswered / renders garbage | **Fixed** — `restoreSessions` migrates legacy choices to `{anonymous:option}` (T2); `renderPicks` also guards the shape (T6); pre-seed migration test added. |
| FM-18 | Low | `mergeReplies` dedup key ignores author → two reviewers' replies colliding on `role\|ts\|text` drop one | **Fixed** — dedup key now includes `authorId(r)` (T1). |
| FM-10 | Low | Multi-select choice array with `null`/`''`/object entries → blank / `[object Object]` pick badges | **Fixed** — `renderPicks` skips non-string/empty labels (T6). |
| FM-1 | High | `reviewerId` lives in localStorage → two tabs of the **same browser** share one identity | **Accepted** — the locked design explicitly persists `reviewerId` in localStorage ("survives refresh"); the intended multi-reviewer model is distinct browsers/machines. Same-browser tabs are one reviewer by design. See Accepted limitations. |
| FM-2 | High | Comment-id collision across two different authors → second silently dropped (`emitted` keyed by id) | **Accepted** — ids are client-minted `c<ts><rand>`; cross-author collision is astronomically unlikely, and this is a trusted single-host tool. Documented. |
| FM-5/FM-8 | Med | Multiple un-identified posters coalesce onto `'anonymous'` (spoofable sentinel) | **Accepted** — no-auth localhost by design (auth is explicitly OUT OF SCOPE). Every real browser client has a localStorage id; `'anonymous'` is the curl/old-client fallback only. |
| FM-6 | Med | A peer `review` delta triggers `fetchState()` that can momentarily repaint over a local optimistic edit not yet synced | **Accepted** — transient, localhost-only, self-heals on the next event; no data loss (the edit still reaches the server). Documented. |
| FM-9 | Med | Reverse rollback (new-shape data, server binary rolled back to pre-004) throws in old `bindChoices` | **Accepted** — rolling the binary back under live new-shape sessions is an operational edge; we don't ship the old code. Documented. |
| FM-11 | Low | Comment display order now follows server order, not the poster's `incoming` order | **Accepted** — new order is *better* for multi-reviewer (peers stay put); no reorder UI exists, so single-reviewer order is unchanged in every reachable case. |
| FM-12 | Low | No cap on `reviewerId` length | **Accepted** — 5 MB body cap already bounds a single request; no adversary on localhost. |

## G4 enumeration — DSM catalog (structural / coupling)

DSM (Sonnet) mapped the touched units. Key findings and dispositions:

- **DSM-8 (hotspot, High):** `s.review` shape has the highest fan-in (~12 server + client sites). **Mitigation honored:** the plan sequences all server-side shape changes (T1–T2, T4) *before* any client change (T5), so no forward references exist; the `/api/state` round-trip tests catch drift.
- **DSM-4 / DSM-13 (shape-coupling, High/Med):** `restoreSessions` and `renderPicks` lacked the type guard their siblings (`mergeChoices`/`myPick`) carry. **Fixed** in T2 (migration + coercion) and T6 (guard).
- **DSM-16 (shape-coupling, Med):** the choice-deselect protocol (key-absence) was untested. **Fixed** — deselect test added in T2.
- **DSM-3 (edge, Low):** `loadDoc` carries `s.review` forward but no test proved multi-reviewer comments+choices survive a re-present. **Fixed** — carry-forward test added in T4.
- **DSM-1 (edge, Med):** `reviewBundle` must snapshot (not alias) live objects. **Honored** — `structuredClone` in T4; the "draft unmutated" test guards it.
- **DSM-6 (cycle, Low):** traced `syncReview → broadcast('review') → peer listener → fetchState → GET` — **no feedback loop** (`fetchState` is read-only; restoring a checkbox sets `.checked` without firing a `change` event). Confirmed safe.
- **DSM-7 (Med):** echo-suppression keys on `reviewerId`, so same-browser tabs suppress each other's live updates — same root as FM-1; **Accepted** per the locked identity model.
- **DSM-15 (Low):** the `review` delta payload carries `comments`/`choices` the client currently ignores (it re-fetches). **Kept** — matches the design's stated delta shape and T2's assertion; harmless, and lets a future client consume it.

## Accepted limitations (documented, consistent with the locked localhost/no-auth design)

1. **Identity is per-browser, not per-tab** (FM-1/DSM-7): `reviewerId` persists in localStorage (a locked design decision — "survives refresh"). Two tabs of the *same* browser on one session are the same reviewer and may not see each other's edits live until the next event. The intended multi-reviewer scenario is distinct browsers/machines, where this is correct.
2. **`'anonymous'` coalescing** (FM-2/FM-5/FM-8): callers without a `reviewerId` (curl, a pre-feature client) all map to `'anonymous'` and are not isolated from one another. Acceptable: no-auth localhost tool; real browser clients always carry an id.
3. **Transient optimistic re-render** (FM-6): a peer's delta arriving in the sub-second window between a local optimistic edit and its sync landing can briefly repaint stale state; it self-heals and never loses data (the edit reaches the server regardless).
4. **No reverse-rollback migration** (FM-9): downgrading the server binary under live new-shape sessions is unsupported.
