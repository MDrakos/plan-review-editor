---
name: plan-review
description: >
  Use automatically whenever you are about to present the user with a plan,
  a set of options/choices to pick from, or any long text output (roughly 30+
  lines) meant for their review or decision — render it in the browser
  plan-review editor instead of printing it to the terminal, then run the
  review event loop until the user ends the session. Triggers include:
  finishing a plan, proposing approaches, "here are your options", design
  docs, migration plans, or any wall of text the user must read and react to.
---

# Plan Review — browser review loop

Do not print plans, option lists, or long review documents to the terminal.
Present them in the plan-review editor and drive the loop below until the
user ends the session.

**Skip this skill when:** the session is non-interactive (no human is
watching), the harness forces its own plan-approval UI (e.g. ExitPlanMode in
plan mode), or the user explicitly asks for terminal output.

## Setup

The CLI (no install, zero dependencies):

```sh
PR="node /Users/miked/work/plan-review-editor/bin/planreview.js"
```

## 1. Write the document

Write the full content to a markdown file (e.g. in your scratchpad; keep
reusing the **same file path** for the whole session). Start with a `#`
title. Embed every decision the user must make as a choice fence instead of
prose like "option 1 / option 2":

````markdown
```choice
id: short-unique-id
prompt: The question the user must answer?
multi: false
options:
  - First option — short rationale
  - Second option — short rationale
```
````

## 2. Present it

```sh
$PR start plan.md        # boots the server and opens the browser
```

Tell the user (one line) that the plan is open in their browser, then start
waiting. If a session is already running, use `$PR present plan.md` instead.

## 3. The event loop

Repeatedly run:

```sh
$PR wait --timeout 90
```

The 90s poll window stays under default shell time limits. If the shell
kills the command anyway, nothing is lost — events queue on the server —
so just run `wait` again. Each call prints one JSON event. Handle it and
loop:

- `{"type":"timeout"}` — nothing happened yet. Run `wait` again. Do not end
  your turn; the user is still reviewing.
- `{"type":"chat","text":…}` — the user said something in the sidebar. It
  may be unrelated to the document; answer it (do real work if needed) with
  `$PR say "<answer>"`, then `wait` again.
- `{"type":"submit",…}` — the bundled review. `comments[]` each carry the
  exact selected passage in `quote` plus the user's `text` about it;
  `choices` maps each choice-fence `id` to the selected option; `note` is an
  overall remark. Rework the markdown file addressing **every** comment and
  honoring every choice, then `$PR present plan.md` (the browser reloads it
  in place) and `wait` again.
- `{"type":"end"}` — the user is done. Run `$PR stop`, give a brief terminal
  summary of the final document and decisions, and continue normally.

Full protocol reference: `/Users/miked/work/plan-review-editor/docs/PROTOCOL.md`.
