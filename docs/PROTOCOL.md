# Agent protocol

Everything runs against a single localhost server (default
`http://127.0.0.1:4780`, override with `PLANREVIEW_PORT`). That one server
hosts **many isolated sessions** — one per plan under review — so several
agents can drive reviews at the same time. The `planreview` CLI wraps these
endpoints; agents normally never call them directly.

## Sessions

`planreview start` creates a session, returns its short **`id`**, and opens
`/s/<id>` in the browser. Every other command must carry that id
(`--session <id>` on the CLI, `?session=<id>` on the HTTP API). Sessions share
nothing — document, review, chat, event queue, and browser tabs are all
per-session — so one agent's `start` can neither touch nor see another's.

A missing or unknown session id is an error (HTTP 404); there is no implicit
"current" session. The shared server exits on its own once no sessions remain,
and a fresh `start` respawns it.

`start` (and `present`) seed the reviewer's display name so the browser doesn't
prompt for it on a fresh tab. The name is resolved from `--reviewer-name <name>`,
then `$PLANREVIEW_REVIEWER_NAME`, then `git config user.name`, and injected into
`/s/<id>` for the browser to adopt. A name the reviewer has already saved in that
browser still wins, and if none resolve the browser prompts once as before.

`/health` reports the server's code fingerprint. `start` compares it to the
on-disk code and, if the running server is stale (started before a code edit)
**and idle**, restarts it so changes take effect — but it will not restart a
server with live sessions (that would drop other agents' reviews); use
`planreview restart --force` to override.

## The event loop

The agent presents a document, then blocks on `wait`. Every reviewer action
that needs the agent's attention arrives as one JSON event:

```
resp=$(planreview start plan.md)         # -> {"id":"a1b2c3", …}; opens browser
id=a1b2c3                                 # capture the session id from resp
loop:
  event=$(planreview wait --session $id) # blocks (no time limit) until the reviewer acts
  case $event.type in
    chat)    reply with `planreview say "…" --session $id`, then wait again
    submit)  rework plan.md using the bundle,
             `planreview present plan.md --session $id`, then wait again
    approve) apply any feedback in the bundle, `planreview stop --session $id`,
             then proceed with the work — do NOT present again
    end)     `planreview stop --session $id`, return to normal operation
  esac
```

## Events (returned by `planreview wait`)

### `chat`

The reviewer sent a sidebar message. It may be about the document or about
anything else — answer it with `planreview say` and keep waiting. Chat does
not interrupt the review; the reviewer keeps commenting while you respond.

```json
{ "type": "chat", "text": "can we ship without Redis?", "ts": 1783032851932,
  "author": { "id": "5f3c…", "name": "Ada" } }
```

`author` (`{ id, name? }`) names the reviewer who sent it when more than one is
on the plan; it's absent for a pre-identity client. See **Multiple reviewers**.

### `submit`

The reviewer finished a pass and submitted the bundled review. The browser
shows a "reworking" overlay until you `present` again.

```json
{
  "type": "submit",
  "comments": [
    { "id": "c1a2b3", "quote": "the exact text the reviewer selected",
      "text": "the reviewer's comment about it", "ts": 1783032851932,
      "author": { "id": "5f3c…", "name": "Ada" } }
  ],
  "choices": {
    "storage": {
      "picks": { "5f3c…": "In-process", "9b1d…": "Redis" },
      "resolved": { "option": "In-process", "by": "5f3c…", "byName": "Ada", "reason": "no external dep for localhost" }
    }
  },
  "note": "overall note typed next to the submit button",
  "docVersion": 1,
  "submittedAt": "2026-07-02T22:54:12.907Z"
}
```

- `comments[].quote` is the selected passage — locate it in your markdown
  source to understand what the comment anchors to.
- `comments[].author` (`{ id, name? }`) attributes the comment to a reviewer —
  see **Multiple reviewers** below. It is absent only for a pre-identity client
  (treated as `anonymous`). One bundle consolidates **every** reviewer's
  comments, each attributed; a submit never drops a peer's input.
- Each comment can carry a `replies` thread — `[{ role: "agent" | "reviewer",
  text, ts, author? }]` — so a comment is a conversation, not a leaf. A reviewer
  reply carries its own `author`; agent replies keep `role: "agent"`. Any
  reviewer may reply to any comment (replies are append-only across reviewers).
  To answer a *specific* comment in place (rather than in the global chat), run
  `planreview reply <commentId> "<answer>" --session <id>`; it threads under
  that comment and the reviewers' follow-ups ride back in the next bundle's
  `comments[].replies`. See **Replying to a comment** below.
- `choices` maps each `id` from a ` ```choice ` fence to `{ picks, resolved? }`.
  `picks` is a **per-reviewer** map of `{ reviewerId: selected option }` (the
  option is an array when the block sets `multi: true`) — when reviewers pick
  differently, every pick is present, so the conflict is surfaced, never
  overwritten. `resolved` is present only when a reviewer explicitly resolved a
  divergent choice: `{ option, by, byName, reason }` (the shared decision, who set
  it, and an optional reason). You get the agreed value **and** the raw split. See
  **Choice-conflict resolution** and **Multiple reviewers**.
- Rework the document, then `planreview present <file> --session <id>` — the
  browser reloads it in place and a fresh review round begins. Every re-present
  after the first automatically highlights the blocks that changed since the
  previous version (the reviewer can dismiss the highlight); no action needed.
- While reworking, `planreview progress "<step>" --session <id>` appends a step
  to a live checklist shown in the reviewer's "reworking" overlay (SSE
  `progress` event). Steps reset each round and clear when you `present`.
- The overlay also shows a live elapsed timer and, past a threshold with no
  sign of life, a "may be stuck" hint — driven by two server-tracked
  timestamps on `/api/state` and every `status` SSE event: `workingSince`
  (when the current round began; `null` outside `working`) and
  `lastAgentActivity` (bumped on `wait`, `progress`, and `present`). Both
  survive a browser refresh; neither affects the status state machine.

#### Replying to a comment

`planreview reply <commentId> "<message>" --session <id>` posts an agent reply
threaded under one specific comment — the inline counterpart to `say` (which is
the global, un-anchored chat). The `<commentId>` comes from the bundle's
`comments[].id`. The reply renders under that comment in the reviewer's panel
(SSE `comment-reply`), not in the chat sidebar.

```
planreview reply c1a2b3 "Keeping Redis — the limiter is process-local." --session $id
# -> { "ok": true, "commentId": "c1a2b3", "reply": { "role": "agent", "text": "…", "ts": … } }
```

Unknown `commentId` → 404; empty message → 400. A reply does **not** start a
review round or change status — it's a message, like `say`. Comments (and their
threads) persist across `present` rounds as long as the quote still anchors —
see **Comment & thread persistence** below.

### `approve`

The reviewer chose **Approve & finish** — they're satisfied and done. The
payload is the same bundle shape as `submit` (`comments`/`choices`/`note`, any
of which may be empty). Apply any feedback it carries, run `planreview stop`,
then proceed with the work. Do **not** `present` again — the reviewer's page is
already in a terminal "Review approved" state and no further round is coming.
Unlike `submit`, this never leaves the page spinning: the session goes straight
to `done`, independent of what the agent does next.

```json
{
  "type": "approve",
  "comments": [],
  "choices": { "storage": { "picks": { "5f3c…": "In-process" } } },
  "note": "ship it",
  "docVersion": 3,
  "submittedAt": "2026-07-03T18:12:00.000Z"
}
```

### `end`

The reviewer ended the session without an explicit approval. Run
`planreview stop --session <id>`, then continue in the terminal as usual.

```json
{ "type": "end" }
```

### `timeout`

`planreview wait` polls indefinitely by default — the reviewer has no time
limit — so it normally only returns on a real event. Pass `--timeout <seconds>`
to make it return `{ "type": "timeout" }` after that long instead; agents whose
shell caps command duration use this to return cleanly and re-run `wait` in a
loop. It's not a reviewer action — just call `wait` again. (Internally the CLI
long-polls `GET /agent/wait?session=<id>&timeout=<ms>` in short windows and
loops past the server's own `timeout` replies.)

```json
{ "type": "timeout" }
```

## Choice blocks

Embed decisions in the plan with a `choice` fence:

````markdown
```choice
id: storage
prompt: Where should limiter state live?
multi: false
options:
  - Redis
  - In-process
```
````

`id` and at least one option are required; a malformed block falls back to
rendering as plain code. The reviewers' answers arrive in `submit.choices` (and
`approve.choices`) as `{ id: { picks, resolved? } }`. `picks` is a per-reviewer
map `{ reviewerId: option }` — every reviewer's pick for each block, so a
divergence is visible rather than silently overwritten (the UI shows a per-option
who-picked badge and a muted "reviewers disagree" hint) once more than one
reviewer has answered. With a single reviewer, `picks` has one entry, but the UI
suppresses the badge — it would only echo that reviewer's own answer back to
them — and shows it again once a second reviewer weighs in.

By default each block also renders a free-text **"Other"** answer (a radio or
checkbox plus a text field). If a reviewer types there, their entry in
`choices[id].picks` holds the typed string — indistinguishable in shape from a
preset answer, so no special handling is needed. Add `other: false` to omit it
and require one of the listed options.

**Answers persist across cycles.** A re-present keeps every reviewer's prior
`choices` (and any `resolutions`). So if you keep a choice block in the reworked
doc, a reviewer isn't re-asked — their own previous pick shows collapsed, with a
"Change" option — and `submit`/`approve` still report the current per-reviewer
value for every answered `id`.

## Choice-conflict resolution

When reviewers diverge on a choice, any of them can **resolve** it to a single
shared option (with an optional free-text `reason`). This is an explicit,
attributed decision — no voting, no locking. The resolve control appears only on a
divergent block, so single-reviewer and all-agree blocks are unchanged.

- A resolved choice carries `resolved: { option, by, byName, reason }` in the
  bundle **alongside** the raw `picks` — you see the agreed value *and* the
  underlying split, with nothing lost. An unresolved choice carries `picks` only
  (no `resolved` key).
- A resolution **persists until explicitly changed or cleared** — it is
  independent of the raw picks, so a reviewer changing their own pick never
  silently undoes it. Re-opening the choice is a deliberate **clear** (which
  returns the block to the unresolved split).
- Set/change/clear go through `POST /api/review-state` in a `resolutions` field:
  `{ choiceId: { option, reason? } }` (or a bare `{ choiceId: option }`) to
  set/change, `{ choiceId: null }` to clear. The server validates `option`
  against the block's declared options (an out-of-options value or unknown
  `choiceId` is ignored), stamps `{ option, by, byName, at, reason }`
  (last-writer-wins on the single shared slot), and broadcasts a `review` delta so
  every tab re-syncs live. Resolutions round-trip a server restart.

## Comment & thread persistence

Comments (with their reply threads) also survive a re-present, so a conversation
can outlive one round. When you `present` a reworked document, each prior comment
is re-checked against the new text:

- **Still anchors** (its `quote` still appears in the reworked document) → the
  comment stays active with its thread intact.
- **No longer anchors** (you rewrote or removed that passage) → the comment is
  flagged `archived: true` and shown collapsed in a distinct "unanchored"
  section in the reviewer's panel. It is **never silently dropped** — the thread
  is preserved, and you can still `reply` to it.

The comment shape is therefore
`{ id, quote, text, ts, author?, replies?, archived? }`; `submit`/`approve`
bundles carry the full threads (archived comments included).

## Multiple reviewers

Several people can open the same `/s/<id>` in different browsers and review
together; a single-reviewer session behaves exactly as before.

- **Identity.** Each browser mints an ephemeral `reviewerId` (kept in
  `localStorage`, so a refresh keeps it) plus an optional editable display name,
  and attaches them to every mutating request. No accounts, no server roster.
  A request without a `reviewerId` (an old client, a raw `curl`) is attributed
  to the synthetic id `anonymous` — nothing breaks.
- **Attribution.** Comments, reviewer chat messages, and reviewer replies carry
  an `author: { id, name? }`. The UI color-codes each reviewer.
- **Comment ownership.** A reviewer's save is authoritative **only over its own
  author's comments** (create / edit / delete) — peers' comments are preserved
  untouched, so no one can clobber another's. Replies are the exception: any
  reviewer may reply to any comment, and replies are append-only (never removed
  by a peer's sync). The archived flag stays server-authoritative.
- **Choices** are per-reviewer (`picks: { reviewerId: option }`), so a conflict is
  surfaced, not overwritten; a divergent choice can be **resolved** to one shared,
  attributed decision (see **Choice-conflict resolution**).
- **Live sync.** A `POST /api/review-state` broadcasts a `review` SSE event so
  other open tabs re-sync and render peers' comments, picks, and resolutions live;
  a tab ignores the echo of its own change.
- **Submit consolidates.** Any reviewer can submit; the one bundle carries every
  reviewer's attributed comments plus each choice's full per-reviewer `picks` (and
  any `resolved` decision), with no loss. The status state machine is unchanged —
  the agent still reworks once.

## Version history and diffs

Every `present` (and the initial `start`) bumps the document version and records
that version's **markdown source** in a per-session ring. The ring is bounded:
only the **last 10 versions** are retained (override with
`PLANREVIEW_VERSION_HISTORY`); older versions age out and can no longer be
diffed. Only the source is kept — diffs are re-rendered on demand, so memory
stays capped no matter how many rework rounds run.

The reviewer's browser can compare any two retained versions via
`GET /api/diff?session=<id>&from=<v>&to=<v>`. Both bounds are optional: `to`
defaults to the current version and `from` to the version just before it. The
response is an annotated single-document render with block-level markers —
`data-diff="add"`, `data-diff="remove"` (the deletions the per-round highlight
never showed), and `data-diff="change"` (a same-kind block modified in place,
carrying both old and new). A version outside the ring (aged out, unknown, or
malformed) returns `400` with the list of versions still comparable:

```json
{ "from": 1, "to": 3, "html": "…", "versions": [1, 2, 3], "current": 3 }
```

The retained version numbers are also surfaced on `/api/state` as
`doc.versions`, so the browser can populate its version picker. This is entirely
separate from the dismissible per-round changed-block highlight (`present` still
marks blocks changed since the previous version); the two never interfere.

## HTTP reference

Session-scoped endpoints take `?session=<id>` and 404 without a valid one.

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| GET | `/` | browser | index page listing all open sessions |
| GET | `/s/<id>` | browser | the review UI for one session |
| GET | `/app.js`, `/style.css` | browser | shared static assets |
| GET | `/health` | CLI | liveness, open-session count, and code `version` (no session needed) |
| POST | `/admin/shutdown` | CLI | shut the whole server down (used to restart a server running stale code) |
| GET | `/api/sessions` | both | list open sessions (`planreview list`) |
| POST | `/agent/start` | CLI | create a session and present a document; returns its `id` |
| GET | `/api/state?session=` | browser | full session state (doc — incl. `doc.versions` — review, chat, progress, status, `workingSince`, `lastAgentActivity`, clients) |
| GET | `/api/diff?session=` | browser | annotated diff between two retained versions (`&from=`/`&to=` optional); 400s outside the retention ring |
| GET | `/events?session=` | browser | SSE stream: `doc`, `chat`, `comment-reply`, `review`, `progress`, `status` |
| POST | `/api/review-state?session=` | browser | persist in-progress comments/choices/resolutions (carries `reviewerId`; broadcasts a `review` delta) |
| POST | `/api/chat?session=` | browser | reviewer chat message (queued for the agent) |
| POST | `/api/submit?session=` | browser | submit a review round (→ `working`; queued as `submit`) |
| POST | `/api/approve?session=` | browser | approve & finish (→ `done`; queued as `approve`) |
| POST | `/api/end?session=` | browser | end the session (queued as `end`) |
| POST | `/agent/present?session=` | CLI | render a markdown file as the session's document |
| GET | `/agent/wait?session=` | CLI | long-poll for the next reviewer event (`&timeout=<ms>` optional) |
| POST | `/agent/say?session=` | CLI | agent chat message to the reviewer |
| POST | `/agent/reply?session=` | CLI | agent reply threaded under a specific comment (`comment-reply` SSE) |
| POST | `/agent/progress?session=` | CLI | append a rework step to the working overlay |
| POST | `/agent/stop?session=` | CLI | end and drop just this session |

The server binds to `127.0.0.1` only and holds all state in memory — a
session lives and dies with the server process (or an explicit `stop`).
