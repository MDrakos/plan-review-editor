# 018 — rename the project and repo

## What happens now

Everything is called `plan-review`: the repo directory, the npm package name,
the `planreview` CLI, the installed skill, the docs. That was accurate when the
tool only reviewed plans. It now also does code review (`codereview start`,
diff sessions, line comments, suggested changes), with whiteboard and inline
prototypes queued behind it (016, 017). The name undersells the tool and reads
as wrong to anyone landing on the repo for the first time.

## What would fix it

Pick a name that covers "put a document, a diff, or a design in the browser and
let a human mark it up", then rename in one pass:

- repo + local checkout directory
- `package.json` name, `bin` entries
- CLI names (`planreview` / `codereview`) — decide whether they stay as
  subcommand-style aliases of one binary or get renamed too
- the installed skills (`plan-review`, `codereview`) and their SKILL.md files
- docs, README, examples
- the global CLAUDE.md references that point at the skill by name

## Notes

Two things make this bigger than a find-and-replace. The installed skill is
hardlinked to `integration/claude/plan-review/SKILL.md`, so the install path
has to be re-pointed, not just edited. And `~/.claude/CLAUDE.md` names both
skills, so a rename that misses it silently stops the skills from being
invoked.

Open question: one binary with two modes, or keep two entry points under a new
umbrella name.
