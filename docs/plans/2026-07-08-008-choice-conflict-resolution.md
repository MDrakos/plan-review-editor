# Richer Choice-Conflict Resolution (issue 008) — Implementation Plan

> **For agent executors:** Use [[subagent-driven-development]] or [[executing-plans]] to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reviewers converge a divergent `choice` block on a single, attributed, optionally-reasoned shared decision that travels to the agent alongside the raw per-reviewer split, without touching 004's per-reviewer pick model.

**Architecture:** Add a parallel map `s.review.resolutions = { choiceId: { option, by, byName, at, reason } }` next to 004's untouched `s.review.choices`. `POST /api/review-state` gains an optional `resolutions` field (set/change/clear), validated against the choice block's declared options (captured at render time into `s.doc.choiceSpecs`), recorded with poster attribution, and broadcast over the existing SSE `review` fan-out. `reviewBundle` emits each choice as `{ picks, resolved? }`. The client renders a "Resolve to:" control only on a divergent block. Everything persists via the existing `serialize()` allowlist (review + doc are already included wholesale).

**Tech stack:** Node.js (no framework), plain-DOM client JS, custom `test/e2e.js` harness (`check` / `browser` / `cli` / `p` / `render` helpers; server-level + markdown unit tests — there is no DOM test rig, so client rendering is spec-implemented and manually verified).

**Spec:** `docs/specs/2026-07-08-008-choice-conflict-resolution-design.md` (approved).

---

## File map

- `server/server.js` — data model (`blankSession`, restore normalization, `loadDoc` carry-forward + choiceSpecs capture), `POST /api/review-state` resolutions branch, `reviewBundle` per-choice shape. Persistence is automatic (serialize already includes `review` and `doc`).
- `server/markdown.js` — extract `parseChoiceSpec(body)` from `renderChoice` (reuse) and export `parseChoiceSpecs(markdown)` returning `{ choiceId: { options, multi, other } }` for server-side option validation.
- `public/app.js` — `state.resolutions`, resolve control on divergent blocks, `syncReview` carries `resolutions` delta, SSE `review` already triggers `fetchState`.
- `test/e2e.js` — new server-level + markdown-unit tests; update the one existing bundle-shape assertion (choices now nested under `picks`).

---

### Task 1: `parseChoiceSpecs` — capture a choice block's declared options

**Files:**
- Modify: `server/markdown.js` (extract spec parse from `renderChoice`, add + export `parseChoiceSpecs`)
- Test: `test/e2e.js` (unit test, alongside the existing `render`-based markdown tests near line 1417)

**Reuse:** extend `renderChoice`'s existing per-block spec parser (`server/markdown.js:47-62`) — extract it to `parseChoiceSpec(body)` and call it from both `renderChoice` and the new `parseChoiceSpecs`. No new parser.

- [ ] **Step 1: Write the failing test** — add near the other markdown-render tests (after line ~1425), reusing the `render`/`parseChoiceSpecs` require at the top of the file.

```js
  // issue 008: server captures each choice block's declared options for resolve-validation
  const specs = parseChoiceSpecs(
    '# T\n\n```choice\nid: pick\nprompt: Which one?\noptions:\n  - A1\n  - A2\n```\n\n```choice\nid: multi\nmulti: true\noptions:\n  - X\n  - Y\n```\n'
  );
  check(
    'parseChoiceSpecs returns declared options per choice id',
    specs.pick && specs.pick.options.join(',') === 'A1,A2' && specs.pick.multi === false &&
      specs.multi && specs.multi.multi === true && specs.multi.options.join(',') === 'X,Y',
    JSON.stringify(specs)
  );
  check(
    'parseChoiceSpecs ignores a malformed choice (no id or no options)',
    Object.keys(parseChoiceSpecs('```choice\nprompt: no id\noptions:\n  - A\n```\n')).length === 0,
    JSON.stringify(parseChoiceSpecs('```choice\nprompt: no id\n```\n'))
  );
```

Add `parseChoiceSpecs` to the destructured `require('../server/markdown')` at the top of `test/e2e.js` (the same import that already pulls in `render`).

- [ ] **Step 2: Run, expect failure**

Run: `node test/e2e.js 2>&1 | grep -i "parseChoiceSpecs\|FAIL\|is not a function" | head`
Expected: FAIL — `parseChoiceSpecs is not a function`.

- [ ] **Step 3: Implement** in `server/markdown.js`. Extract the spec loop from `renderChoice` into `parseChoiceSpec`, then add `parseChoiceSpecs`.

```js
// Parse ONE ```choice fence body into its spec. Shared by renderChoice (which
// then builds HTML) and parseChoiceSpecs (which the server uses to validate a
// resolve against the block's declared options).
function parseChoiceSpec(body) {
  const spec = { id: '', prompt: '', multi: false, other: true, options: [] };
  let inOptions = false;
  for (const raw of body.split('\n')) {
    const opt = raw.match(/^\s*-\s+(.*)$/);
    if (inOptions && opt) {
      spec.options.push(opt[1].trim());
      continue;
    }
    const kv = raw.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      inOptions = kv[1] === 'options';
      if (kv[1] === 'multi') spec.multi = kv[2].trim() === 'true';
      else if (kv[1] === 'other') spec.other = kv[2].trim() !== 'false';
      else if (kv[1] === 'id' || kv[1] === 'prompt') spec[kv[1]] = kv[2].trim();
    }
  }
  return spec;
}

// Scan a markdown document for every well-formed ```choice fence and return
// { choiceId: { options, multi, other } }. Malformed blocks (no id / no options,
// exactly what renderChoice falls back to code on) are skipped. Fence detection
// mirrors renderBlocks so the two never disagree about what a fence is.
function parseChoiceSpecs(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^```(\S*)\s*$/);
    if (!fence) { i++; continue; }
    const body = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
    i++; // closing fence
    if (fence[1] !== 'choice') continue;
    const spec = parseChoiceSpec(body.join('\n'));
    if (spec.id && spec.options.length) out[spec.id] = { options: spec.options, multi: spec.multi, other: spec.other };
  }
  return out;
}
```

Then change `renderChoice` to reuse it — replace its inline parse loop (lines ~47-62) with:

```js
function renderChoice(body) {
  const spec = parseChoiceSpec(body);
  // ... unchanged from `if (!spec.id || !spec.options.length)` onward
```

Add `parseChoiceSpecs` to `module.exports` in `server/markdown.js` (keep `render, renderDiff, renderVersionDiff, escapeHtml`).

- [ ] **Step 4: Run, expect pass**

Run: `node test/e2e.js 2>&1 | grep -i "parseChoiceSpecs" `
Expected: two `ok` lines.

- [ ] **Step 5: Commit**

```bash
git add server/markdown.js test/e2e.js
git commit -m "feat(markdown): expose parseChoiceSpecs for server-side resolve validation"
```

---

### Task 2: Data model — `resolutions` on blankSession, restore normalization, loadDoc capture + carry-forward

**Files:**
- Modify: `server/server.js` (`blankSession` ~line 70-73, restore ~line 265-274, `loadDoc` ~line 399-424)
- Test: `test/e2e.js` (persistence-restore section, near the pre-004 migration test ~line 1180)

**Reuse:** mirror the existing `s.review.choices` normalization (`server/server.js:268`) and the choices carry-forward at re-present (`server/server.js:424`); reuse `isReviewerMap` shape guard for `resolutions` (a plain object).

- [ ] **Step 1: Write the failing test** — a pre-008 persisted file (no `resolutions` key, no `doc.choiceSpecs`) must restore as all-unresolved. Add a restore case modeled on the existing pre-004 migration test.

```js
  console.log('persistence: a pre-008 session (no resolutions) restores as all-unresolved');
  {
    const dir = freshStateDir();
    const sid = 'pre008';
    writeSessionFile(dir, sid, {
      id: sid,
      status: 'reviewing',
      doc: { title: 'T', html: '<p>x</p>', version: 1, blocks: [] },
      review: { comments: [], choices: { pick: { A: 'A1', B: 'A2' } } }, // 004 shape, NO resolutions key
    });
    const srv = await startServer({ stateDir: dir });
    const restored = await browser(`/api/state?session=${sid}`);
    check(
      'a pre-008 file restores with review.resolutions === {} (unresolved)',
      restored.data.review.resolutions && Object.keys(restored.data.review.resolutions).length === 0 &&
        restored.data.review.choices.pick.A === 'A1',
      JSON.stringify(restored.data.review)
    );
    await srv.stop();
  }
```

> Executor note: match the exact restore-test scaffolding already in `test/e2e.js` (how it seeds a state dir, writes a session file, and boots a server that restores it — see the "pre-004 flat choice value migrates" test around line 1180 and the "externally-written session file restores" test). Reuse those existing helpers verbatim rather than the placeholder names above; adjust the seed body to omit `resolutions`.

- [ ] **Step 2: Run, expect failure**

Run: `node test/e2e.js 2>&1 | grep -i "pre-008\|resolutions === {}"`
Expected: FAIL — `resolutions` is `undefined`.

- [ ] **Step 3: Implement** three edits in `server/server.js`:

`blankSession` (line ~70-73):
```js
    doc: { path: null, title: '', html: '', version: 0, blocks: null, history: [], choiceSpecs: {} },
    // ...
    review: { comments: [], choices: {}, resolutions: {} }, // in-progress review, survives refreshes
```

Restore normalization (after line 268's `s.review.choices` guard):
```js
      if (!isReviewerMap(s.review.choices)) s.review.choices = {};
      // 008: a resolutions map parallel to choices; a pre-008 file (or a bad type)
      // restores as all-unresolved rather than a booby-trap.
      if (!isReviewerMap(s.review.resolutions)) s.review.resolutions = {};
```
(`s.doc.choiceSpecs` needs no restore branch: the `s.doc = { ...s.doc, ...data.doc }` merge at line 263 already carries it, falling back to blankSession's `{}` for a pre-008 file.)

`loadDoc` — capture specs, and preserve resolutions across a rework round (line 402 and 424):
```js
  const { html, blocks } = renderDiff(markdown, s.doc.blocks);
  s.doc.choiceSpecs = parseChoiceSpecs(markdown); // 008: options for resolve-validation
  // ...
  s.review = { comments: carried, choices: s.review.choices || {}, resolutions: s.review.resolutions || {} };
```
Add `parseChoiceSpecs` to the `require('./markdown')` destructure at the top of `server/server.js`.

- [ ] **Step 4: Run, expect pass**

Run: `node test/e2e.js 2>&1 | grep -i "pre-008"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add server/server.js test/e2e.js
git commit -m "feat(review): add parallel resolutions map to the review model + choiceSpecs capture"
```

---

### Task 3: `POST /api/review-state` accepts, validates, records, and broadcasts `resolutions`

**Files:**
- Modify: `server/server.js` (`/api/review-state` handler ~line 859-878; add an `applyResolutions` helper near `mergeChoices` ~line 604)
- Test: `test/e2e.js` (multi-reviewer section, after the divergence test ~line 1935)

**Reuse:** `posterIdOf` / `authorOf` (poster id + name), `broadcast` (existing `review` SSE), `isReviewerMap` (shape guard). New helper `applyResolutions` mirrors `mergeChoices`' set/clear-by-key protocol.

- [ ] **Step 1: Write the failing test** — set-with-reason, invalid option ignored, unknown choiceId ignored, clear, and that the `review` broadcast carries `resolutions`. Use `docA` (choice `pick`, options `A1`/`A2`).

```js
  console.log('issue 008: a reviewer resolves a divergent choice; validated, attributed, broadcast');
  const rs = await cli('start', docA, '--no-open');
  const rsid = rs.id;
  const rsEvents = await captureEvents(rsid);
  await sleep(100);
  await browser(`/api/review-state?session=${rsid}`, { reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${rsid}`, { reviewerId: 'B', reviewerName: 'Bo', comments: [], choices: { pick: 'A2' } });
  // A resolves to A2 with a reason.
  await browser(`/api/review-state?session=${rsid}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' },
    resolutions: { pick: { option: 'A2', reason: 'A2 scales better' } },
  });
  const rsState = await browser(`/api/state?session=${rsid}`);
  check(
    'a resolution is recorded with option + attribution (by/byName) + reason; picks untouched',
    rsState.data.review.resolutions.pick &&
      rsState.data.review.resolutions.pick.option === 'A2' &&
      rsState.data.review.resolutions.pick.by === 'A' &&
      rsState.data.review.resolutions.pick.byName === 'Ada' &&
      rsState.data.review.resolutions.pick.reason === 'A2 scales better' &&
      typeof rsState.data.review.resolutions.pick.at === 'string' &&
      rsState.data.review.choices.pick.A === 'A1' && rsState.data.review.choices.pick.B === 'A2',
    JSON.stringify(rsState.data.review)
  );
  // An option not in the block is ignored (validation); unknown choiceId ignored.
  await browser(`/api/review-state?session=${rsid}`, { reviewerId: 'B', comments: [], resolutions: { pick: 'A9', nope: 'A1' } });
  const rsState2 = await browser(`/api/state?session=${rsid}`);
  check(
    'an out-of-options resolve and an unknown choiceId are ignored (prior resolution intact)',
    rsState2.data.review.resolutions.pick.option === 'A2' && rsState2.data.review.resolutions.nope === undefined,
    JSON.stringify(rsState2.data.review.resolutions)
  );
  // A bare-option set (no reason) changes the resolution and blanks the reason.
  await browser(`/api/review-state?session=${rsid}`, { reviewerId: 'B', reviewerName: 'Bo', comments: [], resolutions: { pick: 'A1' } });
  const rsState3 = await browser(`/api/state?session=${rsid}`);
  check(
    'a bare-option resolve changes option + re-attributes + clears reason',
    rsState3.data.review.resolutions.pick.option === 'A1' && rsState3.data.review.resolutions.pick.by === 'B' &&
      (rsState3.data.review.resolutions.pick.reason === '' || rsState3.data.review.resolutions.pick.reason === undefined),
    JSON.stringify(rsState3.data.review.resolutions)
  );
  // Clear returns the choice to unresolved.
  await browser(`/api/review-state?session=${rsid}`, { reviewerId: 'A', comments: [], resolutions: { pick: null } });
  const rsState4 = await browser(`/api/state?session=${rsid}`);
  check(
    'a null resolve clears the resolution (back to unresolved)',
    rsState4.data.review.resolutions.pick === undefined,
    JSON.stringify(rsState4.data.review.resolutions)
  );
  // The review SSE delta carries resolutions.
  let rsDeltas = [];
  for (let i = 0; i < 40; i++) {
    rsDeltas = rsEvents.events.filter((e) => e.event === 'review');
    if (rsDeltas.some((e) => 'resolutions' in JSON.parse(e.data))) break;
    await sleep(25);
  }
  check(
    'the review SSE delta carries resolutions alongside comments + choices',
    rsDeltas.length && rsDeltas.every((e) => 'resolutions' in JSON.parse(e.data)),
    JSON.stringify(rsDeltas.map((e) => e.data))
  );
  rsEvents.close();
  await cli('stop', '--session', rsid);
```

- [ ] **Step 2: Run, expect failure**

Run: `node test/e2e.js 2>&1 | grep -i "issue 008: a reviewer resolves\|resolution is recorded\|FAIL"`
Expected: FAIL — resolutions never recorded.

- [ ] **Step 3: Implement.** Add `applyResolutions` near `mergeChoices`:

```js
// Apply a POST's resolution intent onto the shared per-choice resolutions map,
// in place. Intent per choiceId: null -> clear; { option, reason? } or a bare
// option string -> set/change. An option not among the block's declared options
// (per s.doc.choiceSpecs), or an unknown choiceId, is ignored (validated here).
// Last-writer-wins on the single shared slot; poster attribution is stamped on.
function applyResolutions(resolutions, incoming, specs, poster) {
  if (!incoming || typeof incoming !== 'object') return;
  for (const [choiceId, intent] of Object.entries(incoming)) {
    if (intent === null) { delete resolutions[choiceId]; continue; }
    const spec = specs && specs[choiceId];
    if (!spec) continue; // unknown choice block — ignore
    const option = typeof intent === 'string' ? intent : intent && intent.option;
    if (typeof option !== 'string' || !spec.options.includes(option)) continue; // out of options — ignore
    const reason = intent && typeof intent === 'object' && typeof intent.reason === 'string' ? intent.reason.trim() : '';
    resolutions[choiceId] = { option, by: poster.id, byName: poster.name || '', at: new Date().toISOString(), reason };
  }
}
```

Wire it into `/api/review-state` (after the `choices` merge, line ~868), and add `resolutions` to the broadcast:
```js
      if (body.choices && typeof body.choices === 'object')
        s.review.choices = mergeChoices(s.review.choices, body.choices, posterId);
      // 008: apply the poster's resolve/clear intent to the shared resolutions map.
      if (body.resolutions && typeof body.resolutions === 'object') {
        if (!isReviewerMap(s.review.resolutions)) s.review.resolutions = {};
        applyResolutions(s.review.resolutions, body.resolutions, s.doc.choiceSpecs, {
          id: posterId,
          name: (authorOf(body) || {}).name,
        });
      }
      touch(s);
      broadcast(s, 'review', {
        comments: s.review.comments,
        choices: s.review.choices,
        resolutions: s.review.resolutions,
        author: { id: posterId },
      });
```

- [ ] **Step 4: Run, expect pass**

Run: `node test/e2e.js 2>&1 | grep -i "resolution is recorded\|are ignored\|changes option\|null resolve clears\|delta carries resolutions"`
Expected: five `ok` lines.

- [ ] **Step 5: Commit**

```bash
git add server/server.js test/e2e.js
git commit -m "feat(review-state): accept/validate/record/broadcast attributed choice resolutions"
```

---

### Task 4: `reviewBundle` emits each choice as `{ picks, resolved? }`

**Files:**
- Modify: `server/server.js` (`reviewBundle` ~line 436-459)
- Test: `test/e2e.js` (new bundle-shape test in the full-cycle section; **update** the existing free-text-Other assertion at line ~1571)

**Reuse:** existing `mergeChoices` result (`{ choiceId: { reviewerId: option } }`) becomes each choice's `picks`; read `s.review.resolutions` for the `resolved` sibling.

- [ ] **Step 1: Write the failing test** — a resolved choice carries `resolved` (incl. reason) + `picks`; an unresolved one carries `picks` only. Add after the existing submit test.

```js
  console.log('issue 008: submit bundle carries resolved (+reason) + raw picks; unresolved carries picks only');
  const bn = await cli('start', docA, '--no-open');
  const bnid = bn.id;
  await browser(`/api/review-state?session=${bnid}`, { reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${bnid}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  await browser(`/api/review-state?session=${bnid}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' },
    resolutions: { pick: { option: 'A2', reason: 'perf' } },
  });
  const bnWait = cli('wait', '--session', bnid, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${bnid}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' }, note: 'go' });
  const bnEv = await bnWait;
  check(
    'a resolved choice emits { resolved: {option, by, reason}, picks: {reviewerId: option} }',
    bnEv.type === 'submit' &&
      bnEv.choices.pick.resolved && bnEv.choices.pick.resolved.option === 'A2' &&
      bnEv.choices.pick.resolved.by === 'A' && bnEv.choices.pick.resolved.reason === 'perf' &&
      bnEv.choices.pick.picks.A === 'A1' && bnEv.choices.pick.picks.B === 'A2',
    JSON.stringify(bnEv.choices)
  );
  await cli('stop', '--session', bnid);

  console.log('issue 008: an unresolved choice emits picks only (no resolved key)');
  const un = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${un.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  const unWait = cli('wait', '--session', un.id, '--timeout', '10');
  await sleep(200);
  await browser(`/api/submit?session=${un.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' }, note: 'x' });
  const unEv = await unWait;
  check(
    'an unresolved choice emits { picks } with no resolved key',
    unEv.choices.pick && unEv.choices.pick.picks.A === 'A1' && !('resolved' in unEv.choices.pick),
    JSON.stringify(unEv.choices)
  );
  await cli('stop', '--session', un.id);
```

Then **update** the existing single-reviewer assertion at line ~1571 to the nested shape:
```js
      subEv.choices.pick.picks.anonymous === 'a custom third option' &&
```

- [ ] **Step 2: Run, expect failure**

Run: `node test/e2e.js 2>&1 | grep -i "resolved choice emits\|picks only\|FAIL"`
Expected: FAIL — bundle still emits the bare per-reviewer map.

- [ ] **Step 3: Implement** in `reviewBundle` — wrap the merged choices per id and attach `resolved` from `s.review.resolutions`:

```js
  const merged = mergeChoices(
    s.review.choices,
    body.choices && typeof body.choices === 'object' ? body.choices : {},
    posterId
  );
  // 008: emit each choice as { picks, resolved? }. `resolved` carries the shared
  // decision (option, who set it, optional reason); `picks` is 004's raw split, so
  // the agent sees the agreed value AND the underlying disagreement — no silent loss.
  const resolutions = isReviewerMap(s.review.resolutions) ? s.review.resolutions : {};
  const choices = {};
  for (const [choiceId, picks] of Object.entries(merged)) {
    const entry = { picks };
    const r = resolutions[choiceId];
    if (r && spec_has_option_here(r)) entry.resolved = { option: r.option, by: r.by, byName: r.byName || '', reason: r.reason || '' };
    choices[choiceId] = entry;
  }
  return {
    comments: structuredClone(comments),
    choices: structuredClone(choices),
    // ... note/docVersion/submittedAt unchanged
```

> Executor note: `spec_has_option_here` is shorthand — just guard `r && typeof r.option === 'string'`. A resolution only exists in the map because it already passed option-validation at write time, so no re-validation is needed here; the guard is defensive against a hand-edited persisted file. Also emit a `resolved` entry only for a choice that has `picks` (a resolution with no surviving picks is dropped from the bundle along with its choice — an edge that can't arise through the UI since resolve requires divergence).

- [ ] **Step 4: Run, expect pass**

Run: `node test/e2e.js 2>&1 | grep -i "resolved choice emits\|picks only\|free-text Other"`
Expected: three `ok` lines (incl. the updated free-text-Other test).

- [ ] **Step 5: Commit**

```bash
git add server/server.js test/e2e.js
git commit -m "feat(reviewBundle): emit each choice as {picks, resolved?} carrying the shared decision"
```

---

### Task 5: Persistence — a resolution (with reason) round-trips a restart

**Files:**
- Test only: `test/e2e.js` (persistence section)

**Reuse:** persistence is already automatic — `serialize()` returns `review: s.review` and `doc: s.doc` wholesale (`server/server.js:168-169`), so `resolutions` and `choiceSpecs` persist and restore with no code change. This task is a guard test proving the round-trip.

- [ ] **Step 1: Write the failing-then-passing test** — model it on the existing kill/restore persistence test (the one that checks `restored.data.review.choices.pick.anonymous === 'Two'` around line 871-877). After a resolve, restart the server and assert the resolution survives.

```js
  console.log('issue 008: a resolution (with reason) round-trips a server restart');
  // Using the same persistence scaffolding as the kill-9 restore test above:
  //  - start a persistent server on a fresh state dir
  //  - two reviewers diverge on `pick`, one resolves to A2 with a reason
  //  - stop/kill the server, start a new one on the same state dir
  await p(`/api/review-state?session=${pid}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  await p(`/api/review-state?session=${pid}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  await p(`/api/review-state?session=${pid}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' },
    resolutions: { pick: { option: 'A2', reason: 'A2 handles the edge case' } },
  });
  // ... restart the server on the same state dir (reuse the existing restart helper) ...
  const restored008 = await p(`/api/state?session=${pid}`);
  check(
    'a resolution + reason + attribution survives a restart',
    restored008.data.review.resolutions.pick &&
      restored008.data.review.resolutions.pick.option === 'A2' &&
      restored008.data.review.resolutions.pick.by === 'A' &&
      restored008.data.review.resolutions.pick.reason === 'A2 handles the edge case',
    JSON.stringify(restored008.data.review.resolutions)
  );
```

> Executor note: wire this into the existing persistence test block that already boots a persistent server, seeds a session, and restarts it (search for the `kill -9 restore` test). Reuse its `pid`/server-restart helpers verbatim; do not stand up a parallel harness. If the block's `pick` choice differs from `A1`/`A2`, align the picks/option to that block's declared options.

- [ ] **Step 2: Run, expect pass** (no production change needed — serialize already covers it)

Run: `node test/e2e.js 2>&1 | grep -i "round-trips a server restart\|survives a restart"`
Expected: `ok`. If it FAILS, the bug is in Task 2's restore normalization — fix there, not here.

- [ ] **Step 3: Commit**

```bash
git add test/e2e.js
git commit -m "test(persistence): choice resolution + reason round-trips a restart"
```

---

### Task 6: Lifecycle — a pick change after a resolution leaves it intact

**Files:**
- Test only: `test/e2e.js` (multi-reviewer section)

**Reuse:** proves the orthogonality already implemented in Tasks 2-3 (`mergeChoices` and `applyResolutions` touch different maps). Guard test — no production change expected.

- [ ] **Step 1: Write the test** — resolve, then a reviewer changes their own pick; the resolution must persist (only an explicit clear re-opens it).

```js
  console.log('issue 008: changing a pick after a resolution leaves the resolution intact');
  const lc = await cli('start', docA, '--no-open');
  await browser(`/api/review-state?session=${lc.id}`, { reviewerId: 'A', comments: [], choices: { pick: 'A1' } });
  await browser(`/api/review-state?session=${lc.id}`, { reviewerId: 'B', comments: [], choices: { pick: 'A2' } });
  await browser(`/api/review-state?session=${lc.id}`, {
    reviewerId: 'A', reviewerName: 'Ada', comments: [], choices: { pick: 'A1' }, resolutions: { pick: { option: 'A2' } },
  });
  // B now changes its own pick — the resolution must NOT be disturbed.
  await browser(`/api/review-state?session=${lc.id}`, { reviewerId: 'B', comments: [], choices: { pick: 'A1' } });
  const lcState = await browser(`/api/state?session=${lc.id}`);
  check(
    'a reviewer changing its own pick does not clear an existing resolution',
    lcState.data.review.resolutions.pick && lcState.data.review.resolutions.pick.option === 'A2' &&
      lcState.data.review.choices.pick.B === 'A1',
    JSON.stringify(lcState.data.review)
  );
  await cli('stop', '--session', lc.id);
```

- [ ] **Step 2: Run, expect pass**

Run: `node test/e2e.js 2>&1 | grep -i "does not clear an existing resolution"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e.js
git commit -m "test(review): pick change after a resolution leaves it intact"
```

---

### Task 7: Client — resolve control on a divergent choice block

**Files:**
- Modify: `public/app.js` (`fetchState` ~line 307; `bindChoices` / `renderPicks` ~line 584-626; `syncReview` ~line 1064; state shape ~line 124-128)
- Test: manual browser verification (no DOM test rig; server-level behavior is covered by Tasks 3-6). Follow the develop `verify` step.

**Reuse:** `authorColor(by)` (004 attribution color), `authorLabel` (name/short-id), the existing `renderPicks` divergence branch (`counts.size > 1`), `syncReview`'s POST, and the SSE `review` handler that already calls `fetchState` (`public/app.js:526-530`) — peer resolutions arrive live for free.

- [ ] **Step 1: State + fetch.** In the `state` object (line ~124-128) add `resolutions: {}`. In `fetchState` (line ~307) add:
```js
  state.choices = (s.review && s.review.choices) || {};
  state.resolutions = (s.review && s.review.resolutions) || {};
```

- [ ] **Step 2: Render the control.** In `bindChoices`, add a resolution element built alongside `picksEl`, and a `renderResolution()` invoked wherever `renderPicks()` is (initial build + inside `sync`). It appears ONLY when the block is divergent — reuse the same `counts.size > 1` condition `renderPicks` computes (compute divergence once and share it, or recompute the per-option counts in `renderResolution`). Behavior:
  - **Divergent + unresolved:** show a "Resolve to:" label, one button per `block`'s preset option (from the `.choice-option` inputs' `value`, excluding the empty "Other" box), and an optional reason `<input type="text">`. Clicking an option posts the resolution (option + trimmed reason) via `syncReview` and optimistically writes `state.resolutions[id]`.
  - **Resolved:** show `Resolved to <option> — by <name>` with the name colored `authorColor(resolution.by)` (via `--author-color` / inline `color`, matching how comment/presence attribution is colored) and the `reason` below it if non-empty, plus a **Change** control (re-opens the option list + reason input) and a **Clear** control (posts `{ [id]: null }`).
  - **Not divergent (single reviewer or all agree):** render nothing — the block is byte-for-byte 004.

Untrusted strings (`byName`, `reason`, `option`) go through `textContent` only — never `innerHTML` (match the comment/presence rule at `public/app.js:784`).

- [ ] **Step 3: Sync the resolve action.** Extend `syncReview` (line ~1064) to carry this tab's pending resolution intent. Simplest faithful approach: give `syncReview(resolutions)` an optional argument; resolve/clear clicks call `syncReview({ [id]: intent })` (intent = `{ option, reason }` or `null`), while ordinary pick/comment syncs call `syncReview()` with none. Include `resolutions` in the POST body only when provided:
```js
async function syncReview(resolutions) {
  const body = {
    reviewerId: reviewer.id,
    reviewerName: reviewer.name,
    comments: state.comments,
    choices: myChoices(),
  };
  if (resolutions) body.resolutions = resolutions;
  await fetch(api('/api/review-state'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}
```
The SSE `review` handler already ignores our own echo (`d.author.id === reviewer.id`) and re-`fetchState`s for peers, so a peer's resolve/clear renders live within a second (criterion 1/2) with no new listener.

- [ ] **Step 4: Style (optional, minimal).** Add CSS in `public/style.css` for `.choice-resolve` / `.choice-resolved` consistent with the existing `.choice-picks` / `.choice-disagree` treatment. Keep it muted, matching 004.

- [ ] **Step 5: Manual verification** (develop `verify` step). Launch the app with a two-reviewer divergent session and confirm, per the spec's acceptance criteria:
  1. Two tabs (distinct reviewer ids) diverge on `pick` → both show the "Resolve to:" control; one resolves with a reason → both tabs show `Resolved to A2 — by Ada` + reason, name colored by reviewer.
  2. Change on one tab reflects on the other; Clear returns both to the unresolved split + "reviewers disagree" hint.
  3. A single-reviewer session (or both agreeing) shows no resolve control at all.

Run: `node server/server.js` (or the project's start command) + open two browser tabs with different reviewer identities. Record what was observed.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/style.css
git commit -m "feat(client): resolve-to control with attribution + reason on divergent choice blocks"
```

---

## Self-review

- **Spec coverage:** resolution model + attribution (Tasks 3, 7) · agent receives resolved + raw picks (Task 4) · persists-until-changed/cleared lifecycle (Tasks 3, 6) · optional reason (Tasks 3, 4, 7) · parallel map, choices/mergeChoices untouched (Task 2) · server validation of option / unknown choiceId (Tasks 1, 3) · SSE broadcast (Task 3) · persistence incl. reason (Task 5) · UI resolve-only-on-divergence + live sync (Task 7). Every spec acceptance criterion (1)-(6) maps to a task.
- **Type consistency:** `resolutions[choiceId] = { option, by, byName, at, reason }` used identically across Tasks 2/3/4/5/7. Bundle entry `{ picks, resolved? }`, `resolved = { option, by, byName, reason }`. `parseChoiceSpecs` → `{ id: { options, multi, other } }` used in Tasks 1/2/3.
- **Verification commands:** each code task has explicit `node test/e2e.js | grep` steps with expected pass/fail; Task 7 is manual-verify (documented, no DOM rig).
- **Commit cadence:** every task ends with a commit.
- **Note:** the one 004 test touched is the free-text-Other bundle assertion (Task 4, line ~1571) — the bundle `choices` shape deliberately changes to `{picks, resolved?}` per the spec; `s.review.choices` stored state and `mergeChoices` are untouched, so the stored-state assertion at line ~826 stays valid.
