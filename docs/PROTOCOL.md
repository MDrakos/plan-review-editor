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
{ "type": "chat", "text": "can we ship without Redis?", "ts": 1783032851932 }
```

### `submit`

The reviewer finished a pass and submitted the bundled review. The browser
shows a "reworking" overlay until you `present` again.

```json
{
  "type": "submit",
  "comments": [
    { "id": "c1a2b3", "quote": "the exact text the reviewer selected",
      "text": "the reviewer's comment about it", "ts": 1783032851932 }
  ],
  "choices": { "storage": "In-process now, Redis behind the feature flag later" },
  "note": "overall note typed next to the submit button",
  "docVersion": 1,
  "submittedAt": "2026-07-02T22:54:12.907Z"
}
```

- `comments[].quote` is the selected passage — locate it in your markdown
  source to understand what the comment anchors to.
- `choices` maps each `id` from a ` ```choice ` fence to the selected option
  (an array when the block sets `multi: true`).
- Rework the document, then `planreview present <file> --session <id>` — the
  browser reloads it in place and a fresh review round begins. Every re-present
  after the first automatically highlights the blocks that changed since the
  previous version (the reviewer can dismiss the highlight); no action needed.
- While reworking, `planreview progress "<step>" --session <id>` appends a step
  to a live checklist shown in the reviewer's "reworking" overlay (SSE
  `progress` event). Steps reset each round and clear when you `present`.

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
  "choices": { "storage": "In-process" },
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
rendering as plain code. The reviewer's answer arrives in `submit.choices` (and
`approve.choices`).

By default each block also renders a free-text **"Other"** answer (a radio or
checkbox plus a text field). If the reviewer types there, `choices[id]` holds
their typed string — indistinguishable in shape from a preset answer, so no
special handling is needed. Add `other: false` to omit it and require one of the
listed options.

**Answers persist across cycles.** A re-present keeps the reviewer's prior
`choices` (only comments reset each round). So if you keep a choice block in the
reworked doc, the reviewer isn't re-asked — their previous pick shows collapsed,
with a "Change" option — and `submit`/`approve` still report the current value
for every answered `id`.

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
| GET | `/api/state?session=` | browser | full session state (doc — incl. `doc.versions` — review, chat, progress, status, clients) |
| GET | `/api/diff?session=` | browser | annotated diff between two retained versions (`&from=`/`&to=` optional); 400s outside the retention ring |
| GET | `/events?session=` | browser | SSE stream: `doc`, `chat`, `progress`, `status` |
| POST | `/api/review-state?session=` | browser | persist in-progress comments/choices |
| POST | `/api/chat?session=` | browser | reviewer chat message (queued for the agent) |
| POST | `/api/submit?session=` | browser | submit a review round (→ `working`; queued as `submit`) |
| POST | `/api/approve?session=` | browser | approve & finish (→ `done`; queued as `approve`) |
| POST | `/api/end?session=` | browser | end the session (queued as `end`) |
| POST | `/agent/present?session=` | CLI | render a markdown file as the session's document |
| GET | `/agent/wait?session=` | CLI | long-poll for the next reviewer event (`&timeout=<ms>` optional) |
| POST | `/agent/say?session=` | CLI | agent chat message to the reviewer |
| POST | `/agent/progress?session=` | CLI | append a rework step to the working overlay |
| POST | `/agent/stop?session=` | CLI | end and drop just this session |

The server binds to `127.0.0.1` only and holds all state in memory — a
session lives and dies with the server process (or an explicit `stop`).
