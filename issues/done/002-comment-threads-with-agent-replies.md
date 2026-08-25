# Enhancement: comment threads — let the agent reply to a specific inline comment

**Type:** enhancement (feature)
**Status:** done — merged 2026-07-07 in PR #4
**Area:** `server/server.js` (review model, agent API), `public/app.js` (comment cards, SSE)

## Problem

Inline comments are one-directional today. A reviewer selects text and leaves a
comment (`{id, quote, text, ts}` in `s.review.comments`), but the agent has no way
to answer *that comment in place*. The only reply channel is the global chat sidebar
(`/agent/say` → `s.chat`), which is not tied to a comment's quote or location. So when
the agent wants to respond to a specific note ("keeping Redis because the limiter is
process-local"), the reviewer has to eyeball which chat line answers which comment.

There's also no back-and-forth: a comment is a leaf, not a thread.

## Current behavior (grounding)

- Comments are created browser-side and mirrored to the server via
  `/api/review-state` (`server/server.js:360-366`); their shape is `{id, quote, text, ts}`
  (`public/app.js:42`, rendered by `renderComments`/`viewCard`, `public/app.js:403,427`).
- `loadDoc` resets `s.review.comments` to `[]` every round (`server/server.js:161`) —
  comments are per-cycle, they do not currently survive a re-present.
- Agent replies go to the shared chat via `POST /agent/say` (`server/server.js:424`),
  broadcast as a `chat` SSE event (`public/app.js:227`). Nothing associates a chat
  message with a comment id.
- The submit bundle carries `comments` as a flat array (`reviewBundle`,
  `server/server.js:168-176`); the agent sees them in the `submit` event.

## Proposed enhancement

1. Give each comment an optional `replies: [{role: 'agent'|'reviewer', text, ts}]`
   thread. Extend the comment shape rather than adding a parallel structure.
2. Add an agent endpoint to attach a reply to a specific comment id, e.g.
   `POST /agent/reply {session, commentId, text}` (sibling to `/agent/say`), which
   pushes onto that comment's `replies` and broadcasts a new `comment-reply` SSE event
   carrying `{commentId, reply}`.
3. Client renders `replies` threaded under the comment card (`viewCard`), and lets the
   reviewer add follow-up replies (which ride along in the next submit bundle).
4. Keep the global chat exactly as-is for discussion not tied to any comment.

## Design decisions to settle before implementing

- **Thread persistence across rounds.** Comments reset each round today
  (`server/server.js:161`). Threads only make sense if a comment can outlive one
  cycle. Proposal: a comment (and its thread) survives a re-present as long as its
  `quote` still anchors in the new document (`anchorByQuote`, `public/app.js:124`);
  otherwise it's archived/collapsed. Needs a decision on the archive UX.
- **Reply identity in the bundle.** Decide whether the submit bundle sends full threads
  or only the reviewer's new replies since the last submit.

## Acceptance criteria

- The agent can post a reply targeted at a specific comment id; it renders threaded
  under that comment, not in the global chat.
- The reviewer can add follow-up replies to a thread; they arrive in the next submit
  bundle.
- Global chat still works for un-anchored discussion.
- Threads survive a re-present when the comment's quote still anchors; the behavior
  when it no longer anchors is explicit (not a silent drop).
- No change to the status state machine.

## Code pointers

- `server/server.js:42` — `review.comments` shape in `createSession`.
- `server/server.js:161` — `loadDoc` resets comments each round (the persistence decision).
- `server/server.js:168-176` — `reviewBundle`; how comments reach the agent.
- `server/server.js:424-433` — `/agent/say` (the pattern a `/agent/reply` follows).
- `public/app.js:403-451` — `renderComments` / `viewCard` (where threads render).
- `public/app.js:122-125,227` — comment hydration + `chat` SSE listener.
