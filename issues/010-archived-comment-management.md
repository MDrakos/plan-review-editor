# Enhancement: archived-comment management (bound the carried-forward threads)

**Type:** enhancement (polish)
**Status:** open, groomed 2026-07-07, lowest priority
**Area:** `server/server.js` (`loadDoc` carry-forward), `public/app.js` (archived section UI)
**Builds on:** 002 (comment threads that survive a re-present or archive)

## Problem

002 carries comments and their reply threads forward across rounds: a comment survives while its quote still anchors, otherwise it is flagged `archived` and shown collapsed, never dropped. The 002 plan explicitly accepted that archived comments accumulate **unbounded** across many rounds (`server/server.js:336-337`), reasoning that capping could risk the "never silently drop" criterion, and that this is a localhost single-user tool with idle-shutdown. That trade-off is fine for short sessions but leaves long ones with a growing pile of dead threads and no way to clear them.

## Current behavior (grounding)

- `loadDoc` maps each carried comment to `{...c, archived: !quoteAnchors(c.quote, html)}` and never removes any (`server/server.js` around :330-334).
- The client renders archived comments collapsed in a distinct section (002).

## Proposed enhancement

Give the reviewer control instead of an automatic cap (which is what 002 correctly avoided):

1. A manual "clear archived" / "dismiss this thread" affordance in the archived section, so the reviewer chooses what to drop.
2. Optionally a collapse-all / count badge so a long archived list stays out of the way without being lost.
3. No automatic silent removal; the "never silently drop" invariant from 002 stays intact.

## Acceptance criteria

- The reviewer can explicitly clear archived comments (individually and/or all at once); nothing is removed without an explicit action.
- Active (anchored) comments and their threads are untouched.
- A session with no archived comments looks exactly as it does today.

## Code pointers

- `server/server.js:330-337` — the carry-forward map and the accepted-unbounded note.
- `public/app.js` — the archived-comment section rendering from 002.
