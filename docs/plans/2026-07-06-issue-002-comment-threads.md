# Plan — Issue 002: comment threads (agent replies to a specific inline comment)

**Source:** `issues/002-comment-threads-with-agent-replies.md` · **Path:** Standard (objective adapter)
**Branch:** `miked/issue-002-comment-threads-let-the-agent-reply-to-a`
**Design decisions:** pre-decided in `.riker/brief.md` (a–d) — not re-brainstormed.

## Acceptance criteria (from the spec)

1. The agent can post a reply targeted at a specific comment id; it renders threaded under that comment, not in the global chat.
2. The reviewer can add follow-up replies to a thread; they arrive in the next submit bundle.
3. Global chat still works for un-anchored discussion.
4. Threads survive a re-present when the comment's quote still anchors; when it no longer anchors the behavior is explicit (not a silent drop).
5. No change to the status state machine.

## Design (locked)

### Data shape
Extend the existing comment (do **not** add a parallel structure — brief (a)):
```
{ id, quote, text, ts, replies?: [{ role: 'agent'|'reviewer', text, ts }], archived?: boolean }
```
`replies` is optional (absent == empty). `archived` is a **server-derived** flag set at re-present time.

### Server-side anchor test (the crux)
`anchorByQuote` (public/app.js:682) is browser/DOM-only; `loadDoc` runs server-side with no DOM.
Mirror it server-side against the freshly rendered HTML:
```
docText(html)  = strip tags, decode &lt; &gt; &quot; &amp; (amp last)  // ≈ browser tree-walker text
quoteAnchors(quote, html) = !!quote && docText(html).indexOf(quote) !== -1
```
This faithfully mirrors what the browser's `anchorByQuote` tree-walker concatenation sees (same HTML string, tags removed, entities decoded). Cross-block quotes that the browser also can't anchor stay un-anchored here too — consistent, and never a silent drop.

### Persistence across rounds — brief (b)
`loadDoc` (server/server.js:161) currently resets `comments: []`. Change to carry prior comments forward, flagging each:
```
const carried = (s.review.comments || []).map(c => ({ ...c, archived: !quoteAnchors(c.quote, html) }));
s.review = { comments: carried, choices: s.review.choices || {} };
```
Anchored comments stay active (`archived:false`); un-anchored ones are carried **archived** (never dropped). Recomputed every round, so a quote that reappears un-archives.

### Agent reply endpoint — brief (d)
`POST /agent/reply {session, commentId, text}` (sibling to `/agent/say`, server/server.js:424):
- 400 on missing `commentId` / empty `text`; 404 when the comment id isn't found.
- Pushes `{role:'agent', text, ts}` onto `comment.replies`, `touch(s)`, `broadcast(s, 'comment-reply', {commentId, reply})`.
- CLI sibling `planreview reply <commentId> <message> --session <id>` so the agent can actually call it.

### review-state merge (FMEA-driven robustness)
`/api/review-state` currently **overwrites** `s.review.comments`. An agent reply appended server-side could be clobbered by a browser sync that raced the `comment-reply` SSE. Replace overwrite with a merge:
- match comments by `id`; union `replies` (dedupe by `role|ts|text`, sort by `ts`);
- preserve the server's `archived` flag for known comments (server-authoritative);
- comments absent from the incoming array are dropped (reviewer deleted them — intended).

### Submit bundle — brief (c)
`reviewBundle` already passes `comments` through verbatim, so **full threads** ride along for free. No change.

### Client (public/app.js)
- `renderComments`: split active vs archived. Active render normally; archived render **collapsed** in a distinct `<details class="archived-comments">` section (satisfies "explicit, not a silent drop"). Count badge reflects active comments.
- `viewCard`: append a thread (`renderThread`) under the body; for active comments while `reviewing`, a small reviewer reply box (input + Reply button) that pushes `{role:'reviewer',...}` and `syncReview()`s (rides along next submit). Reply text rendered via `textContent` (no innerHTML — XSS-safe, per STRIDE).
- SSE `comment-reply` listener: find comment by id, push reply, re-render.
- `fetchState` anchoring loop skips archived comments.
- Global chat (`/agent/say` → `chat`) untouched (criterion 3, criterion 5: no status change).

### CSS (public/style.css)
`.comment-thread`, `.reply`/`.reply.agent`/`.reply.reviewer`, `.reply-form`, `.comment-card.archived`, `.archived-comments` — reuse existing tokens and the chat-bubble idiom.

### Demo (demo/demo.js)
On `submit`, if comments exist, post one `/agent/reply` to the first comment to showcase threaded replies end-to-end.

## Tasks (TDD — failing test first each time)

- **T1 Server anchor + persistence:** `docText`/`quoteAnchors`; `loadDoc` carry-forward with archived flag.
- **T2 Agent reply endpoint:** `POST /agent/reply` + `comment-reply` broadcast.
- **T3 review-state merge:** `mergeComments`/`mergeReplies`; swap overwrite for merge.
- **T4 CLI reply:** `reply` command + usage.
- **T5 Client:** thread render, archived section, reviewer reply box, `comment-reply` listener, active-only anchoring.
- **T6 CSS:** thread + archived styles.
- **T7 Demo:** inline reply on submit.
- **T8 Tests:** new e2e section + update the two existing comment-reset assertions.

## Fixtures (conformance)

| # | Input | Expected |
|---|---|---|
| FX-1 | `quoteAnchors('keep Redis', render('We will keep Redis.'))` | true |
| FX-2 | `quoteAnchors('gone text', render('We will keep Redis.'))` | false |
| FX-3 | `quoteAnchors('a & b', render('x a & b y'))` (entity round-trip) | true |
| FX-4 | present round 2, prior comment quote still in doc | comment survives, `archived` falsy, `replies` intact |
| FX-5 | present round 2, prior comment quote absent | comment present with `archived:true` (not dropped) |
| FX-6 | `POST /agent/reply {commentId:'k', text:'…'}` on existing comment | 200, `comment.replies` gains `{role:'agent'}`; `comment-reply` broadcast `{commentId:'k', reply}` |
| FX-7 | `POST /agent/reply` unknown commentId | 404 `no such comment` |
| FX-8 | `POST /agent/reply` empty text | 400 |
| FX-9 | review-state sync of comment k with stale `replies:[]` after an agent reply | server keeps the agent reply (merge) |
| FX-10 | reviewer reply added via review-state, then submit | submit bundle's comment carries the reviewer reply |
| FX-11 | `planreview reply k "…" --session <id>` | prints `{ok:true, commentId:'k', reply:{role:'agent'}}` |
| FX-12 | global chat still delivers a `chat` event; status machine unchanged | unchanged |

## Verification
- `npm test` green (new coverage + the two updated assertions).
- `node -e` spot-check of `quoteAnchors` against FX-1..FX-3.
- Drive the real app (`/run` skill) to see a threaded reply render.

## G4 catalogs

### Structural Analysis (DSM)
(FMEA/STRIDE appended by the parallel enumeration; DSM authored here — the dispatched DSM agent degraded/returned no catalog, so recorded directly from grounding.)

- **Central coupling hotspot — the comment shape.** `{id,quote,text,ts,replies,archived}` is shared across four sites: server persistence (`loadDoc`/`s.review.comments`), the submit bundle (`reviewBundle` server→agent event), the client render (`viewCard`/`renderThread`), and the CLI (`reply` targets a `commentId`). A field change ripples to all four. → contract test: the submit bundle round-trips `replies` and `archived` verbatim (FX-10); the shape is never re-declared, only extended.
- **The one feedback cycle:** `/agent/reply` → `broadcast('comment-reply')` → client `comment-reply` listener appends → (reviewer edits) → `syncReview` → `/api/review-state` **merge** → server `s.review.comments`. The merge (union replies, dedupe) is what makes this cycle convergent instead of lossy. → test FX-9 (stale sync must not drop the agent reply).
- **Ordering dependency:** `loadDoc` computes `archived` server-side at present time; the client reads it later via `fetchState`. The client never computes `archived` — single source of truth (server). No cross-writer race on the flag because review-state merge preserves the server value.
- **Isolation seam:** `comment-reply` broadcasts only to `s.sse` for that one session (`broadcast(s, …)`), and `/agent/reply` resolves `commentId` only within that session's `s.review.comments` (after the session guard at server/server.js:312) — same isolation guarantee the existing routes have. → test: a reply on session A never reaches session B (mirror of the existing isolation tests).
- **Anchor mirror seam (client↔server divergence risk):** `quoteAnchors` (server) must approximate `anchorByQuote` (client) closely enough that survival decisions match what the reviewer sees. Both operate on the same rendered HTML string; the risk is entity/whitespace drift. → tests FX-1..FX-3 pin the server mirror; divergence only ever mis-files a comment as archived (shown collapsed), never a silent drop. **Extracted to `server/anchor.js`** so it is unit-testable (server.js self-launches on require and can't be imported in-process).

### Failure Modes (FMEA) — integrated
17 modes enumerated; must-fix High: FM-1 review-state overwrite clobbers an agent reply (→ merge, FX-9); FM-3 `/agent/reply` throws on a comment with no `replies` array (→ init-on-push, tested by the first-reply case); FM-4 status machine must stay unchanged (→ modeled on `/agent/say`, not `/api/submit`; test: reply enqueues no agent event, `wait` times out); FM-5 entity decode order (`&amp;` last) or the mirror diverges (→ FX-3 + double-escape test). Hardening: FM-6 empty quote → never anchors; FM-7 unknown id → 404 no phantom; FM-8 reply to an archived comment is stored + stays archived; FM-11 **unbounded archived growth — DECISION: accept + document** (capping would risk the silent drop criterion 4 forbids; localhost single-user tool with idle-shutdown); FM-12 cross-session 404 + no broadcast leak; FM-14 client `comment-reply` listener guards `if (!c) return`; FM-15 reply with zero tabs still persists; FM-16 XSS → `textContent`; FM-17 quote inside a `data-changed` wrapper still anchors.

### Threat Model (STRIDE) — integrated
TM-1 XSS (reply text → `textContent`, never `innerHTML`) — top mitigation; TM-2 SSE frame integrity via `JSON.stringify` (newlines can't split the frame) — regression-locked; TM-3 session-scoped `commentId` lookup + `broadcast(s,…)` (no cross-session reach) — locked with a 404 test; TM-4 validation (400 empty/missing, 404 unknown). **Not-applicable for localhost single-user (no over-engineering):** TM-7 no auth, TM-8 role-forging moot, TM-9 no audit log. TM-5 unbounded growth = same decision as FM-11 (accept + document).
