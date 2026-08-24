# 015 — a reviewer-side "re-read the diff" control

## What happens now

The diff is re-read only when the agent calls `codereview present`, which is
gated to an active working round. So if the agent commits again *after*
presenting, the reviewer's tab keeps showing the previous round until the
reviewer submits and the agent presents once more.

This only bites a `--range a..b` session, where the diff is committed-only: the
default spec includes the working tree, so an edit is already one `present`
away. It showed up the first time the tool reviewed itself — the fix under
discussion was committed straight after the round it belonged to, and the
reviewer had no way to pull it in.

## What would fix it

A control in the files bar — "re-read the diff" — hitting a new
`POST /api/refresh?session=`: same `loadDiff` the agent's `present` runs, but
allowed while `reviewing` and *not* ending a working round. Round markers stay
meaningful (the previous model is still the baseline), and the agent's own
`present` is untouched.

Open question: whether a refresh should re-anchor comments (it uses the same
`reanchor` path, so it would) or leave threads pinned until the agent
acknowledges them. Re-anchoring is the consistent answer.
