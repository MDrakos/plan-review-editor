# Feature: link external references inline in plan documents

**Type:** feature (authoring convention + test coverage)
**Status:** done (PR #28)
**Area:** `integration/claude/plan-review/SKILL.md` (authoring step), `server/markdown.js` (renderer, already supports)

## Problem

Plans routinely name external resources: Jira issue keys (`ENG-1234`), Confluence
pages, design docs, PRs, other URLs. Today an author often drops these as bare
text (`ENG-1234`) or a naked URL, so the reviewer can't click through to the
source from the rendered plan. References should be live links, inline on the key
or doc title itself.

## Decision (Captain)

The agent authoring the plan already resolves real URLs through its Jira /
Confluence connectors, so the editor does **not** guess a base URL or auto-detect
bare keys. Instead:

- The author resolves each external reference to its real URL and writes it as an
  inline markdown link, e.g. `[ENG-1234](https://.../browse/ENG-1234)`,
  `[Rollout Plan](https://.../wiki/...)`.
- The link goes **on the key / doc title itself**, not appended as a bare URL.

This makes it primarily an authoring convention. The renderer already renders
`[text](url)` inline (`server/markdown.js:21-24`, opens in a new tab), so no
renderer change is needed.

## Scope

- Add the convention to the plan-review skill's "Write the document" step so every
  plan authored through it links external references inline.
- Close the missing render-test gap: there is currently **no** e2e assertion that
  an inline `[text](url)` link renders as an `<a>`. Add one (a Jira key and a
  Confluence doc link) so the behavior the convention relies on stays guarded.

## Non-goals

- No `PLANREVIEW_JIRA_BASE_URL` / base-URL config (Captain: connectors resolve URLs).
- No auto-linking of bare keys or bare URLs in the renderer. If an author leaves a
  reference bare, it stays plain text; the convention is the fix, not detection.

## Acceptance criteria

- The plan-review SKILL.md instructs the author to resolve external references
  (Jira keys, Confluence/doc titles, PRs, other URLs) and write them as inline
  markdown links on the key/title, not as bare text or trailing URLs.
- `test/e2e.js` asserts that `[ENG-1234](url)` and a Confluence doc link each
  render as an inline `<a href … target="_blank" rel="noopener">` with the key /
  title as the link text.
- `npm test` passes.

## Code pointers

- `integration/claude/plan-review/SKILL.md` — "1. Write the document" (add the
  convention next to the choice-fence guidance). Note: this file is hardlinked to
  the installed skill, so editing it updates the running skill too.
- `server/markdown.js:16-26` — `inline()` link rendering (already correct).
- `test/e2e.js:~1867` — markdown render assertions live here.
