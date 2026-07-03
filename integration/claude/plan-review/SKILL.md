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

Drive the session with the `planreview` command (zero dependencies — it is a
PATH symlink to this repo's `bin/planreview.js`). If `planreview` is not on the
PATH, fall back to `node /Users/miked/work/plan-review-editor/bin/planreview.js`.

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

Every choice block also offers a free-text **"Other"** answer by default, so the
user is never boxed into your options — their custom text arrives in
`choices[id]` just like a preset would. Add `other: false` to a block to force a
pick from the listed options only.

## 2. Present it — and capture the session id

```sh
planreview start plan.md
# -> {"ok":true,"id":"a1b2c3","url":"http://127.0.0.1:4780/s/a1b2c3", …}
```

`start` opens the plan in its own browser tab and prints a **session `id`**.
Each session is fully isolated, so several agents can run reviews at once
without clobbering each other — but that only works if you **pass this id to
every later command** for this review (`--session <id>`). Grab the `id` now and
reuse it throughout. (Do NOT call `start` again for the same review — that mints
a *new* session; use `present` to send revisions into the existing one.)

Tell the user (one line) that the plan is open in their browser, then start
waiting.

## 3. The event loop

With your session id in hand, block for the reviewer's next action:

```sh
planreview wait --session a1b2c3
```

This **polls indefinitely** — the reviewer has no time limit, so a long
document can take as long as they need. Keep waiting; **never** end your turn
or assume they're done just because time has passed. Each call prints one JSON
event when something happens. Handle it and wait again:

- If your shell caps how long a command may run and kills `wait`, nothing is
  lost — events queue on the server — so just run it again. To avoid the kill,
  add `--timeout <seconds>` (a bit under your shell's limit); it then returns
  `{"type":"timeout"}` at that point and you simply re-run `wait`.
- After ~5 minutes a one-line "still waiting" note prints to stderr. It's
  informational (the reviewer isn't shown it and isn't rushed) — keep waiting.
- `{"type":"timeout"}` — only appears if you passed `--timeout`; nothing
  happened in that window. Run `wait` again. Do not end your turn.
- `{"type":"chat","text":…}` — the user said something in the sidebar. It
  may be unrelated to the document; answer it (do real work if needed) with
  `planreview say "<answer>" --session a1b2c3`, then `wait` again.
- `{"type":"submit",…}` — the bundled review (another round wanted).
  `comments[]` each carry the exact selected passage in `quote` plus the
  user's `text` about it; `choices` maps each choice-fence `id` to the selected
  option; `note` is an overall remark. Rework the markdown file addressing
  **every** comment and honoring every choice, then
  `planreview present plan.md --session a1b2c3` (the browser reloads it in
  place) and `wait` again. **Always follow a submit with either `present` (to
  continue) or `stop` (if you're truly done) — until you do, the reviewer's
  page shows a "reworking" spinner. Never leave it hanging.** For a multi-step
  rework, call `planreview progress "<step>" --session a1b2c3` as you go (e.g.
  "Applying comment 2 of 5", "Reworking the storage section") — the reviewer
  sees these live in place of a bare spinner, and they clear on `present`.
- `{"type":"approve",…}` — the user approved and is **done reviewing**. Same
  bundle shape as `submit` (`comments`/`choices`/`note`), which may be empty.
  Apply any feedback it carries, then run `planreview stop --session a1b2c3`
  and proceed with the work. Do **not** `present` again — the reviewer will not
  review further, and their page already shows "Review approved".
- `{"type":"end"}` — the user ended the session without an explicit approval.
  Run `planreview stop --session a1b2c3`, give a brief terminal summary, and
  continue normally.

`planreview list` shows every open session if you lose track of an id.

Full protocol reference: `/Users/miked/work/plan-review-editor/docs/PROTOCOL.md`.
