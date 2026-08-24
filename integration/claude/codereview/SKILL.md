---
name: codereview
invocation: promoted
description: >
  Use before pushing code you wrote or edited — a branch, a commit, or
  uncommitted work — whenever a human is watching. Put the diff in front of
  them in the browser code-review editor (GitHub-style: inline or
  side-by-side, line comments, suggested changes), then run the review event
  loop until they approve or end the session. Triggers include: finishing an
  implementation, "before you push", "review this diff", about to run
  `git push` / `gh pr create` on work you just wrote, or any moment the user
  should see the code before GitHub does. Not Claude Code's built-in
  `code-review` command, which scans a diff for bugs without a human in the
  loop — this one puts it in front of a person and blocks on their verdict.
triggers:
  - codereview
  - review my diff
  - review this before pushing
  - review the branch before I push
  - put the diff in the browser
  - let me review the code first
  - can I see the diff
version: 1
---

# codereview — browser review loop before the push

Do not push code you wrote (or open a PR for it) in an interactive session
without offering the diff for review first. Put it in the code-review editor
and drive the loop below until the reviewer approves or ends the session.

**Skip this skill when:** the run is unattended (a riker crew, a cron job, a
headless agent — nobody is watching a browser), the user explicitly says to
push without review, or the change is not code (docs-only tweaks, a plan — that
is [[plan-review]]).

## Setup

Drive the session with the `codereview` command (zero dependencies — a PATH
symlink to this repo's `bin/codereview.js`). If it is not on the PATH, fall back
to `node /Users/miked/work/plan-review-editor/bin/codereview.js`.

Run it **from the repo under review** (or pass `--cwd <dir>`): the diff is
resolved relative to the working directory, not the server's.

## 1. Put the diff under review

```sh
codereview start
# -> {"ok":true,"id":"a1b2c3","url":"http://127.0.0.1:4780/r/a1b2c3",
#     "files":7,"additions":412,"deletions":38, …}
```

By default this reviews **everything this branch adds**: every commit since it
left `origin/main` (by merge-base) plus uncommitted and untracked work — the
same content the eventual PR will show. Narrow it when that is not what you
mean:

- `--base <ref>` — measure from a different upstream
- `--range a..b` — two commits only, no working tree
- `--staged` — exactly what `git commit` would record

`start` opens a browser tab and prints a **session `id`**. Sessions are
isolated, so several agents can review at once — but only if you **pass that id
to every later command** (`--session <id>`). Never call `start` twice for the
same review; use `present` for later rounds.

Tell the user in one line that the diff is open, then start waiting.

## 2. The event loop

```sh
codereview wait --session a1b2c3
```

This **polls indefinitely** — the reviewer has no time limit, and reading a real
diff takes as long as it takes. Never end your turn because time has passed.
Each call prints one JSON event; handle it and wait again:

- If your shell kills `wait`, nothing is lost (events queue) — run it again, or
  pass `--timeout <seconds>` under your shell's limit and re-run on
  `{"type":"timeout"}`.
- `{"type":"chat","text":…}` — a sidebar message, possibly unrelated to the
  code. Answer with `codereview say "<answer>" --session a1b2c3`, then wait
  again.
- `{"type":"submit",…}` — **changes requested.** Address it and re-present:
  - Each `comments[]` entry carries `file`, `side` (`new` = the code as it
    stands, `old` = a line you removed), `line` (and `endLine` for a range),
    `quote` — the exact text of the line(s) — plus the reviewer's `text`.
  - `suggestion`, when present, is the reviewer's literal replacement for those
    lines. **Apply it verbatim** unless it is wrong, and say so in a reply if it
    is. Do not paraphrase it.
  - `note` is the overall remark.
  - Report progress while you work:
    `codereview progress "<step>" --session a1b2c3` — one line per comment you
    take on. The reviewer sees these live instead of a bare spinner.
  - Reply where a comment needs an answer rather than a change:
    `codereview reply <commentId> "<answer>" --session a1b2c3`. That is the
    right move for "why did you do it this way?" — it threads under the
    comment.
  - Then `codereview present --session a1b2c3`. **No file argument** — the repo
    is the document, so this re-reads the diff. The browser reloads it in place
    and marks which files and lines changed this round, and every comment
    thread re-anchors to the line its code moved to.
  - **Always follow a submit with `present` or `stop`.** Until you do, the
    reviewer's page shows a "working" overlay. Never leave it hanging.
- `{"type":"approve",…}` — **approved.** Same bundle shape, possibly empty.
  Apply anything it carries, run `codereview stop --session a1b2c3`, and only
  then push / open the PR. Do not `present` again.
- `{"type":"interrupt"}` — the reviewer aborted the round you were working on.
  Drop the in-flight work, do not `present`, just wait again. (A `409` from
  your own `present`/`progress` means the same thing.)
- `{"type":"end"}` — ended without a verdict. Run
  `codereview stop --session a1b2c3` and **ask before pushing** — an ended
  session is not an approval.

`codereview list` shows every open session if you lose an id.

## 3. Rules that outrank convenience

- **Approval gates the push, not the tool.** This tool never touches a remote.
  Push only after an `approve` event, or after the user says so in chat.
- **A comment you disagree with gets a reply, not silence.** Push back with
  reasoning ([[receiving-code-review]]); do not quietly skip it.
- **Do not re-`start` mid-review.** That abandons the reviewer's open tab and
  every thread in it.

Full protocol reference:
`/Users/miked/work/plan-review-editor/docs/CODEREVIEW.md`.
