# Multiple reviewers on one plan — approved design (2026-07-07)

Built on merged main (001 liveness, 002 comment threads, 003 version-diff, 005 persistence).

PROBLEM: A session already accepts multiple browser tabs (s.sse Set; broadcast fans out), but review state is singular/unattributed. mergeComments(s.review.comments, body.comments) lets the browser own the WHOLE comment set, so reviewer B's save drops A's comments B lacks. s.review.choices is one shared {choiceId: option} map (last-writer-wins). Chat/replies carry only role:'reviewer'|'agent'. Submit bundles the one shared s.review.

LOCKED DECISIONS (approved):
1. Identity — ephemeral per-tab id + optional display name. Client generates reviewerId (crypto.randomUUID) on first load, kept in localStorage (survives refresh); optional editable reviewerName. No accounts, no server roster. Rides as author:{id,name} on mutations.
2. Choices — per-reviewer, surface conflict. choices becomes {choiceId: {reviewerId: option}}. Each reviewer sees their own pick; divergence renders a split hint (e.g. "2 · Redis / 1 · In-process"). Submit carries the full map.
3. Submit — one consolidated bundle. Any reviewer can submit; the bundle contains all reviewers' attributed comments + the per-reviewer choice map + notes; the agent reworks once. STATUS STATE MACHINE UNCHANGED.

ARCHITECTURE & DATA MODEL:
- Client identity (public/app.js): on load reviewerId = localStorage 'pr.reviewerId' || crypto.randomUUID() (persist back); reviewerName optional, editable via a small "you are <name> (edit)" affordance. Both attach to every mutating request.
- Comment shape: add author:{id,name} to each comment (existing {id,quote,text,ts,replies,archived}). Reviewer replies gain author; agent replies keep role:'agent'.
- Chat: reviewer messages gain author; role stays 'reviewer'|'agent' for rendering.
- Choices: s.review.choices {choiceId: option} -> {choiceId: {reviewerId: option}}.
- Server merge — CORE CHANGE (mergeComments): a browser's /api/review-state POST is authoritative ONLY over its own author's comments (create/edit/delete/reorder where author.id === posterId). Other reviewers' comments are preserved untouched (union across authors). Agent replies + server archived flag stay server-authoritative (unchanged). Posts include the poster's reviewerId so the server knows whose set to reconcile.
- Live sync: /api/review-state (today silent) broadcasts a 'review' SSE delta (merged comments + choices) so other tabs render peers' comments and choice picks live. Reuse broadcast(s.sse, …). A tab ignores its own echo by author.id.

DATA FLOW:
- A comments: POST /api/review-state {reviewerId:A, comments:[A's], choices:{…A's picks…}} -> server unions A's comments, records A's choice picks -> broadcast('review', …) -> B's tab renders A's comment + any choice split live.
- Submit (any reviewer): POST /api/submit -> reviewBundle consolidates all comments (attributed) + {choiceId:{reviewerId:option}} + notes -> one submit agent event -> agent reworks once. reviewing -> working, unchanged.

ATTRIBUTION UI:
- Comment card: author badge, color derived from reviewerId.
- Chat line: reviewer name.
- Choice block: per-option who-picked badges; a muted "reviewers disagree" hint when picks diverge. No lock.

ERROR HANDLING & EDGE CASES:
- Absent reviewerId (old client / curl): fall back to a synthetic 'anonymous' author — nothing breaks.
- Single-reviewer = today. One reviewer -> union is just their comments; choice map has one entry -> renders with no conflict UI. ACCEPTANCE: single-reviewer session behaves exactly as it does now.
- Deletion scoped to author: a reviewer can only delete/edit their own comments (server enforces author.id); can't clobber another's.
- Persistence (005): author fields + per-reviewer choices are plain serializable data -> persist/restore automatically via existing persist(s). Client identity is localStorage, reconstructed on reconnect.
- Archived flag stays server-authoritative, per comment, regardless of author.

TESTING:
- Two-reviewer union: A + B (distinct ids) POST comments -> both present + attributed; neither clobbers the other.
- Choice conflict: A picks Redis, B picks In-process -> choices map holds both; submit bundle carries both; UI shows the split.
- Live sync: A's comment broadcasts; B's SSE receives a 'review' delta.
- Submit consolidation: bundle has all reviewers' comments + per-reviewer choices, no loss.
- Single-reviewer regression: identical to today.
- Use the now-overridable test port (from 002) with a UNIQUE port to avoid the shared-4799 collision with other test runs.

OUT OF SCOPE (YAGNI): auth/accounts; presence/typing/cursors; per-reviewer submit bundles; co-editing a single comment's text (comments are whole units).
