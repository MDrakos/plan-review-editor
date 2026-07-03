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

## The event loop

The agent presents a document, then blocks on `wait`. Every reviewer action
that needs the agent's attention arrives as one JSON event:

```
resp=$(planreview start plan.md)         # -> {"id":"a1b2c3", …}; opens browser
id=a1b2c3                                 # capture the session id from resp
loop:
  event=$(planreview wait --session $id) # blocks until the reviewer acts
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
  browser reloads it in place and a fresh review round begins.

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

Only returned when waiting with `planreview wait --session <id> --timeout
<seconds>` (or `GET /agent/wait?session=<id>&timeout=<ms>`): nothing happened
within the window. Not a reviewer action — just call `wait` again. This lets
agents whose shells impose a per-command time limit poll in a loop instead of
blocking forever.

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
rendering as plain code. The reviewer's answer arrives in `submit.choices`.

## HTTP reference

Session-scoped endpoints take `?session=<id>` and 404 without a valid one.

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| GET | `/` | browser | index page listing all open sessions |
| GET | `/s/<id>` | browser | the review UI for one session |
| GET | `/app.js`, `/style.css` | browser | shared static assets |
| GET | `/health` | CLI | liveness + open-session count (no session needed) |
| GET | `/api/sessions` | both | list open sessions (`planreview list`) |
| POST | `/agent/start` | CLI | create a session and present a document; returns its `id` |
| GET | `/api/state?session=` | browser | full session state (doc, review, chat, status, clients) |
| GET | `/events?session=` | browser | SSE stream: `doc`, `chat`, `status` |
| POST | `/api/review-state?session=` | browser | persist in-progress comments/choices |
| POST | `/api/chat?session=` | browser | reviewer chat message (queued for the agent) |
| POST | `/api/submit?session=` | browser | submit a review round (→ `working`; queued as `submit`) |
| POST | `/api/approve?session=` | browser | approve & finish (→ `done`; queued as `approve`) |
| POST | `/api/end?session=` | browser | end the session (queued as `end`) |
| POST | `/agent/present?session=` | CLI | render a markdown file as the session's document |
| GET | `/agent/wait?session=` | CLI | long-poll for the next reviewer event (`&timeout=<ms>` optional) |
| POST | `/agent/say?session=` | CLI | agent chat message to the reviewer |
| POST | `/agent/stop?session=` | CLI | end and drop just this session |

The server binds to `127.0.0.1` only and holds all state in memory — a
session lives and dies with the server process (or an explicit `stop`).
