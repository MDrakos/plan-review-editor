# Agent protocol

Everything runs against a single localhost server (default
`http://127.0.0.1:4780`, override with `PLANREVIEW_PORT`). The
`planreview` CLI wraps these endpoints; agents normally never call them
directly.

## The event loop

The agent presents a document, then blocks on `wait`. Every reviewer action
that needs the agent's attention arrives as one JSON event:

```
planreview start plan.md          # boot server + browser, present the plan
loop:
  event=$(planreview wait)        # blocks until the reviewer acts
  case $event.type in
    chat)    reply with `planreview say "…"`, then wait again
    submit)  rework plan.md using the bundle, `planreview present plan.md`,
             then wait again
    end)     `planreview stop`, return to normal terminal operation
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
- Rework the document, then `planreview present <file>` — the browser
  reloads it in place and a fresh review round begins.

### `end`

The reviewer ended the session. Run `planreview stop`, then continue in the
terminal as usual.

```json
{ "type": "end" }
```

### `timeout`

Only returned when waiting with `planreview wait --timeout <seconds>` (or
`GET /agent/wait?timeout=<ms>`): nothing happened within the window. Not a
reviewer action — just call `wait` again. This lets agents whose shells
impose a per-command time limit poll in a loop instead of blocking forever.

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

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| GET | `/api/state` | browser | full session state (doc, review, chat, status) |
| GET | `/events` | browser | SSE stream: `doc`, `chat`, `status` |
| POST | `/api/review-state` | browser | persist in-progress comments/choices |
| POST | `/api/chat` | browser | reviewer chat message (queued for the agent) |
| POST | `/api/submit` | browser | submit the review bundle (queued for the agent) |
| POST | `/api/end` | browser | end the session (queued for the agent) |
| POST | `/agent/reset` | CLI | start a fresh session: drop queued events, chat, and review state (`planreview start` calls this before presenting) |
| POST | `/agent/present` | CLI | render a markdown file as the current document |
| GET | `/agent/wait` | CLI | long-poll for the next reviewer event (`?timeout=<ms>` optional) |
| POST | `/agent/say` | CLI | agent chat message to the reviewer |
| POST | `/agent/stop` | CLI | shut the server down |

The server binds to `127.0.0.1` only and holds all state in memory — a
session lives and dies with the server process.
