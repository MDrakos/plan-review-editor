# Agent protocol — code review

The code side of this tool: a **git diff** in the browser, reviewed
GitHub-style (inline or side-by-side, line comments, suggested changes) before
the code is pushed. It runs on the same server, the same sessions, and the same
event loop as the plan side — see [`PROTOCOL.md`](PROTOCOL.md) for the parts
that are identical, and read this for what differs.

Driven by `bin/codereview.js`. Endpoints live on the shared server
(`http://127.0.0.1:4780`, override with `PLANREVIEW_PORT`).

## What differs from a plan review

| | plan | code |
|---|---|---|
| the document | a markdown file you write | the repo, as `git diff` sees it |
| page | `/s/<id>` | `/r/<id>` |
| `start` | `planreview start plan.md` | `codereview start` (+ optional spec flags) |
| `present` | takes the file again | **takes no file** — it re-reads the diff |
| anchor | a quoted passage | `file` + `side` + `line` (+ `endLine`) + quoted line text |
| extras | choice blocks | suggested changes, per-file "viewed", context expansion |

Everything else — `wait`, `say`, `reply`, `progress`, `stop`, `list`,
`restart`, `update`, the `chat`/`submit`/`approve`/`interrupt`/`end` events,
disk persistence, multiple reviewers, the idle shutdown — behaves exactly as
documented in `PROTOCOL.md`.

## The spec: what is under review

A session stores the git **spec** it was started with, and every `present`
re-resolves it. Four shapes:

```sh
codereview start                    # merge-base(HEAD, origin/main) → working tree  (default)
codereview start --base upstream/v2 # merge-base(HEAD, that ref)    → working tree
codereview start --range a..b       # two commits; no working-tree side
codereview start --staged           # HEAD → the index
```

The default is deliberately the **whole branch plus uncommitted work**: it is
what the PR this review precedes will show. Untracked files ride along as
all-addition files (worktree modes only). `--cwd <dir>` picks the repo — needed
whenever the agent's working directory is not the repo, because the shared
server's own cwd is wherever it was spawned. `--context <n>` changes the
unified-diff context (default 3).

`present` reuses the stored spec. Pass a spec flag to `present` only to *change*
what is under review (e.g. you committed and want a new base) — it replaces the
stored one.

## The diff model

`GET /api/state?session=<id>` returns `kind: "diff"` and a `diff` object
instead of `doc.html`:

```json
{
  "kind": "diff",
  "diff": {
    "label": "origin/main...working tree",
    "branch": "miked/feature", "head": "a1b2c3d",
    "mode": "worktree", "from": "<sha>", "to": "working tree",
    "additions": 412, "deletions": 38,
    "files": [
      {
        "path": "src/auth.ts", "oldPath": "src/auth.ts",
        "status": "modified",            // added | deleted | modified | renamed
        "binary": false, "untracked": false,
        "additions": 18, "deletions": 4,
        "newTotal": 340,                 // new-side line count; null = unknown
        "round": "changed",              // "new" | "changed" | absent (see below)
        "freshCount": 2,
        "hunks": [
          {
            "oldStart": 40, "oldCount": 6, "newStart": 40, "newCount": 8,
            "heading": "function verify(req)",
            "lines": [
              { "type": "ctx", "oldNo": 40, "newNo": 40, "text": "  const req = …" },
              { "type": "del", "oldNo": 41, "newNo": null, "text": "  const t = old(req)" },
              { "type": "add", "oldNo": null, "newNo": 41, "text": "  const t = verify(req)", "fresh": true }
            ]
          }
        ]
      }
    ]
  }
}
```

The server ships data, not HTML: the browser needs the model to switch between
inline and side-by-side, expand context, and hang comments off individual lines.

`round` / `fresh` mark what moved since the previous round, so a re-review goes
straight to the fixes: `round: "new"` means the file was absent last round,
`round: "changed"` means its new side differs, and `fresh: true` marks an added
line whose text was not there last round. A first round has none of these, and
neither does a session restored from disk (the previous round's model is
memory-only).

### `GET /api/expand?session=&file=&from=&to=`

New-side lines `[from..to]` of one file, for opening up context around a hunk.
Restricted to files the current diff contains (a path outside it is a 404), and
clamped to the file's length. Returns `{ file, lines: [{type:"ctx",newNo,text}], total }`.

## Comments

A code comment carries its anchor:

```json
{
  "id": "c1a2b3",
  "file": "src/auth.ts",
  "side": "new",                       // "new" = code as it stands, "old" = a removed line
  "line": 42, "endLine": 44,           // endLine only for a range
  "quote": "  const token = verify(req)",   // the exact line text (\n-joined for a range)
  "text": "this throws on a missing header",
  "suggestion": "  const token = verify(req) ?? null",   // present only for a suggested change
  "author": { "id": "…", "name": "Ada" },
  "replies": [ { "role": "agent", "text": "…", "ts": 0 } ],
  "archived": false
}
```

**`suggestion` is literal.** It is the reviewer's replacement text for exactly
the lines the comment covers. Apply it as written; if it is wrong, reply saying
why rather than silently editing around it.

### Re-anchoring across rounds

Every `present` re-anchors each comment against the fresh diff
(`server/diffanchor.js`):

- **`side: "new"`** — the quoted line text is searched for in the same file, and
  the occurrence nearest the old line number wins. The comment's `line`/`endLine`
  move to it. A rename carries the comment to the new path.
- **`side: "old"`** — survives while that same removal, with that same text, is
  still part of the diff.
- **Not found** → `archived: true`, shown collapsed under "No longer in the
  diff" rather than pointed at unrelated code. Applying a suggestion archives
  the comment that carried it, which is the correct outcome: that line is gone.

Matching is exact, never trimmed or fuzzy — re-indented code may no longer mean
the same thing, and a wrong anchor is worse than an honest archive.

## The loop, end to end

```sh
resp=$(codereview start)                 # -> {"id":"a1b2c3", …}; opens the tab
id=a1b2c3
loop:
  event=$(codereview wait --session $id) # blocks, no time limit
  case $event.type in
    chat)      codereview say "…" --session $id ; wait again
    submit)    codereview progress "…" --session $id       # one line per comment
               apply the comments and any `suggestion` verbatim
               codereview reply <commentId> "…" --session $id   # where an answer, not a change, is wanted
               codereview present --session $id            # NO file argument
               wait again
    approve)   codereview stop --session $id ; push / open the PR
    interrupt) drop the in-flight work; do NOT present; wait again
    end)       codereview stop --session $id ; ASK before pushing
  esac
```

An `end` is not an approval. This tool never touches a git remote — the gate is
that the agent is blocked in `wait` until the reviewer decides.

## HTTP surface (code-specific)

| method | path | who | what |
|---|---|---|---|
| POST | `/agent/start` with `{kind:"diff",spec}` | agent | create a diff session; returns `{id,url:"/r/<id>",files,additions,deletions,label}` |
| POST | `/agent/present?session=` with `{}` or `{spec}` | agent | re-read the diff (next round) |
| GET | `/api/state?session=` | browser | `kind:"diff"` + the model above |
| GET | `/api/expand?session=&file=&from=&to=` | browser | context lines for one file |
| GET | `/r/<id>` | browser | the code-review UI |

Every other route (`/api/review-state`, `/api/submit`, `/api/approve`,
`/api/interrupt`, `/api/chat`, `/api/end`, `/events`, `/agent/wait`,
`/agent/say`, `/agent/reply`, `/agent/progress`, `/agent/stop`) is shared with
the plan side, unchanged — see `PROTOCOL.md`.
