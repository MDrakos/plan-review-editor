'use strict';

// Turn a git working state into the structured diff model the review UI renders.
//
// The plan side of this tool renders markdown to HTML server-side; the code side
// deliberately does NOT render HTML. The reviewer can flip between inline and
// side-by-side, expand hidden context, and comment on any line — all of which
// need the diff as DATA (files → hunks → lines with both sides' numbers), so the
// server ships a model and public/review.js draws it.
//
// Everything here is derived from `git` itself: no diff algorithm of our own, no
// dependency. `git diff` already handles renames, binary files, CRLF, and
// submodules better than a hand-rolled LCS would.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// A file with more new-side lines than this doesn't get its total measured, so
// the "expand to end of file" affordance is hidden for it. Bounds the work on a
// generated-file diff; the hunks themselves are unaffected.
const MAX_MEASURE_FILES = 100;

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr && String(err.stderr).trim()) || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function gitLines(cwd, args, opts) {
  const out = git(cwd, args, opts);
  if (out === null) return null;
  return out.split('\n').filter((l) => l !== '');
}

// The empty tree, so a repo with no commits still diffs (every file reads as new).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------- what are we reviewing ----------
//
// A spec is what the agent asked for; resolving it yields the concrete git
// arguments plus the labels the UI shows. Three shapes:
//   { }                  -> merge-base(HEAD, upstream) .. working tree  (the default)
//   { base: 'ref' }      -> merge-base(HEAD, ref) .. working tree
//   { range: 'a..b' }    -> a .. b (committed only; no working-tree side)
//   { staged: true }     -> index .. HEAD (what `git commit` would record)
//
// The default is the whole branch — every commit since it left main PLUS
// uncommitted work — because that is what a reviewer would see on the PR this
// review exists to precede.

function upstreamRef(cwd) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true })) return ref;
  }
  return null;
}

function resolveSpec(spec = {}) {
  const cwd = path.resolve(spec.cwd || process.cwd());
  const root = (git(cwd, ['rev-parse', '--show-toplevel']) || '').trim();
  if (!root) throw new Error(`not a git repository: ${cwd}`);

  if (spec.range) {
    // Normalize a..b / a...b / "a b" into two endpoints, so the label and the
    // `git show` we use for context expansion agree on the new side's ref.
    const m = String(spec.range).match(/^(.*?)(\.\.\.?|\s+)(.*)$/);
    if (!m) throw new Error(`--range needs two revisions (a..b), got: ${spec.range}`);
    const from = m[1].trim() || 'HEAD';
    const to = m[3].trim() || 'HEAD';
    return { root, mode: 'range', from, to, newRef: to, label: `${from}..${to}`, diffArgs: [from, to] };
  }

  if (spec.staged) {
    return {
      root,
      mode: 'staged',
      from: 'HEAD',
      to: 'index',
      newRef: null, // the index, read with `git show :path`
      label: 'staged changes',
      diffArgs: ['--cached', 'HEAD'],
    };
  }

  const target = spec.base || upstreamRef(root) || null;
  let from;
  if (!target) {
    from = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })
      ? 'HEAD'
      : EMPTY_TREE;
  } else {
    const mb = git(root, ['merge-base', 'HEAD', target], { allowFail: true });
    from = (mb || '').trim() || target;
  }
  return {
    root,
    mode: 'worktree',
    from,
    to: 'working tree',
    newRef: null, // the working tree, read from disk
    label: `${spec.base || upstreamRef(root) || 'HEAD'}...working tree`,
    diffArgs: [from],
  };
}

// ---------- unified diff -> model ----------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Parse `git diff` output into files. One pass, no lookahead beyond the current
// line: git's own output order (header → mode/rename lines → ---/+++ → hunks)
// makes that sufficient.
function parseUnified(text) {
  const files = [];
  let f = null;
  let hunk = null;
  const lines = String(text).split('\n');

  const startFile = (header) => {
    // `diff --git a/<old> b/<new>`. Paths with spaces make this ambiguous in
    // general; the ---/+++ lines below correct it whenever they appear.
    const m = header.match(/^diff --git a\/(.*) b\/(.*)$/);
    f = {
      path: m ? m[2] : '(unknown)',
      oldPath: m ? m[1] : '(unknown)',
      status: 'modified',
      binary: false,
      additions: 0,
      deletions: 0,
      newTotal: null, // filled in by measure(); null = unknown, hide expand-to-EOF
      hunks: [],
    };
    files.push(f);
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      startFile(line);
      continue;
    }
    if (!f) continue;
    if (line.startsWith('new file mode')) {
      f.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      f.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      f.oldPath = line.slice('rename from '.length);
      f.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      f.path = line.slice('rename to '.length);
      f.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      f.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') f.oldPath = p.replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') f.path = p.replace(/^b\//, '');
      continue;
    }
    const h = line.match(HUNK_RE);
    if (h) {
      hunk = {
        oldStart: Number(h[1]),
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newCount: h[4] === undefined ? 1 : Number(h[4]),
        heading: (h[5] || '').trim(),
        lines: [],
      };
      f.hunks.push(hunk);
      // git emits @@ -0,0 for a file that only gains lines; the first real line
      // is 1, so track the cursors from max(start, 1).
      hunk._old = Math.max(hunk.oldStart, 1);
      hunk._new = Math.max(hunk.newStart, 1);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — annotate the line it follows.
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const kind = line[0];
    const text = line.slice(1);
    if (kind === '+') {
      hunk.lines.push({ type: 'add', oldNo: null, newNo: hunk._new++, text });
      f.additions += 1;
    } else if (kind === '-') {
      hunk.lines.push({ type: 'del', oldNo: hunk._old++, newNo: null, text });
      f.deletions += 1;
    } else if (kind === ' ' || line === '') {
      // A context line is " text"; a context line that is itself empty arrives
      // as a bare "" once the trailing newline is split off.
      hunk.lines.push({ type: 'ctx', oldNo: hunk._old++, newNo: hunk._new++, text });
    }
  }
  for (const file of files) for (const hk of file.hunks) {
    delete hk._old;
    delete hk._new;
  }
  return files;
}

// An untracked file has no git diff at all, so synthesize the one git would emit
// if it were added: one hunk, every line an addition. Skipped for `--range` and
// `--staged`, where "untracked" isn't part of what's being reviewed.
function untrackedFiles(root) {
  const names = gitLines(root, ['ls-files', '--others', '--exclude-standard'], { allowFail: true }) || [];
  const out = [];
  for (const name of names) {
    const abs = path.join(root, name);
    let raw;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      raw = fs.readFileSync(abs);
    } catch {
      continue; // vanished between ls-files and here
    }
    const binary = raw.includes(0);
    const file = {
      path: name,
      oldPath: name,
      status: 'added',
      binary,
      additions: 0,
      deletions: 0,
      newTotal: null,
      untracked: true,
      hunks: [],
    };
    if (!binary) {
      const text = raw.toString('utf8');
      const lines = text.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      file.additions = lines.length;
      file.newTotal = lines.length;
      file.hunks = [
        {
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: lines.length,
          heading: '',
          lines: lines.map((text, i) => ({ type: 'add', oldNo: null, newNo: i + 1, text })),
        },
      ];
    }
    out.push(file);
  }
  return out;
}

// Read the NEW side of a file as text, wherever it lives for this spec: the
// working tree (default), the index (--staged), or a commit (--range). Returns
// null when it isn't readable as text there (deleted, binary, gone).
function readNewSide(resolved, file) {
  if (file.status === 'deleted') return null;
  if (resolved.mode === 'worktree') {
    try {
      return fs.readFileSync(path.join(resolved.root, file.path), 'utf8');
    } catch {
      return null;
    }
  }
  const ref = resolved.mode === 'staged' ? `:${file.path}` : `${resolved.newRef}:${file.path}`;
  return git(resolved.root, ['show', ref], { allowFail: true });
}

function countLines(text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// Fill in newTotal so the UI knows whether there is anything left to expand
// below the last hunk. Only for files that can actually be expanded — bounded,
// because this is one `git show` (or one file read) each.
// lazydev: capped at MAX_MEASURE_FILES; the only loss is the expand-to-EOF
// control on a huge diff's tail files. Batch with `git cat-file --batch` if that
// ever matters.
function measure(resolved, files) {
  let measured = 0;
  for (const f of files) {
    if (f.binary || f.newTotal !== null || f.status === 'deleted') continue;
    if (measured >= MAX_MEASURE_FILES) return;
    const text = readNewSide(resolved, f);
    if (text === null) continue;
    f.newTotal = countLines(text);
    measured += 1;
  }
}

// The whole model for one review round.
function collectDiff(spec = {}) {
  const resolved = resolveSpec(spec);
  const args = [
    '--no-pager',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '-M', // detect renames — a moved file shouldn't read as delete + add
    `--unified=${Number(spec.context) > 0 ? Number(spec.context) : 3}`,
    ...resolved.diffArgs,
  ];
  const files = parseUnified(git(resolved.root, args));
  if (resolved.mode === 'worktree' && spec.untracked !== false) files.push(...untrackedFiles(resolved.root));
  files.sort((a, b) => a.path.localeCompare(b.path));
  measure(resolved, files);
  return {
    spec: { ...spec, cwd: resolved.root },
    root: resolved.root,
    mode: resolved.mode,
    from: resolved.from,
    to: resolved.to,
    label: resolved.label,
    branch: (git(resolved.root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || '').trim(),
    head: (git(resolved.root, ['rev-parse', '--short', 'HEAD'], { allowFail: true }) || '').trim(),
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

// Context expansion: hand back new-side lines [from..to] (1-based, inclusive) of
// one file, so the reviewer can open up the code around a hunk. The reviewer can
// only ask for lines that exist; a request past EOF is clamped, not an error.
// `oldOffset` lets the client label the old side without a second request: for a
// context line, oldNo = newNo + oldOffset (the client computes the offset from
// the hunk it is expanding away from).
function expandContext(spec, file, from, to) {
  const resolved = resolveSpec(spec);
  const text = readNewSide(resolved, { path: file, status: 'modified' });
  if (text === null) return { lines: [], total: null };
  const all = String(text).split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const start = Math.max(1, Math.floor(from) || 1);
  const end = Math.min(all.length, Math.floor(to) || all.length);
  const lines = [];
  for (let n = start; n <= end; n++) lines.push({ type: 'ctx', newNo: n, text: all[n - 1] });
  return { lines, total: all.length };
}

// New-side lines of one file as an array, for callers that already resolved the
// spec (comment re-anchoring reads several files per round and must not re-run
// `git merge-base` for each one). Returns null when there is no readable text
// side — deleted, binary, or gone.
function newSideLines(resolved, filePath) {
  const text = readNewSide(resolved, { path: filePath, status: 'modified' });
  if (text === null) return null;
  const all = String(text).split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  return all;
}

module.exports = { collectDiff, expandContext, parseUnified, resolveSpec, newSideLines, countLines };

// ---------- self-check ----------
//
// `node server/gitdiff.js` builds a throwaway repo, makes the four changes that
// matter (modify, add, delete, untracked), and asserts the model. Cheap, and it
// fails loudly if git's output shape or the parser drifts.
if (require.main === module) {
  const assert = require('assert');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-'));
  const run = (...args) => execFileSync('git', args, { cwd: tmp, stdio: 'ignore' });
  const write = (name, body) => fs.writeFileSync(path.join(tmp, name), body);

  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 'T');
  write('keep.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n');
  write('gone.txt', 'bye\n');
  run('add', '-A');
  run('commit', '-qm', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();

  write('keep.txt', 'a\nb\nCHANGED\nd\ne\nf\ng\nh\n');
  write('new.txt', 'fresh\nlines\n');
  fs.unlinkSync(path.join(tmp, 'gone.txt'));
  write('untracked.txt', 'not added\n');
  run('add', 'keep.txt', 'new.txt');
  run('rm', '-q', '--cached', 'gone.txt');

  const model = collectDiff({ cwd: tmp, base });
  const byPath = Object.fromEntries(model.files.map((f) => [f.path, f]));

  assert.deepStrictEqual(Object.keys(byPath).sort(), ['gone.txt', 'keep.txt', 'new.txt', 'untracked.txt']);
  assert.strictEqual(byPath['keep.txt'].status, 'modified');
  assert.strictEqual(byPath['keep.txt'].additions, 1);
  assert.strictEqual(byPath['keep.txt'].deletions, 1);
  assert.strictEqual(byPath['keep.txt'].newTotal, 8);
  assert.strictEqual(byPath['new.txt'].status, 'added');
  assert.strictEqual(byPath['gone.txt'].status, 'deleted');
  assert.strictEqual(byPath['untracked.txt'].untracked, true);
  assert.strictEqual(byPath['untracked.txt'].additions, 1);

  // Line numbers must line up on both sides, or every comment anchors wrong.
  const changed = byPath['keep.txt'].hunks[0].lines.find((l) => l.type === 'add');
  assert.strictEqual(changed.text, 'CHANGED');
  assert.strictEqual(changed.newNo, 3);
  const removed = byPath['keep.txt'].hunks[0].lines.find((l) => l.type === 'del');
  assert.strictEqual(removed.oldNo, 3);
  const ctx = byPath['keep.txt'].hunks[0].lines.find((l) => l.type === 'ctx');
  assert.strictEqual(ctx.oldNo, ctx.newNo); // no drift before the first change

  // Expansion reads the new side and clamps past EOF.
  const exp = expandContext({ cwd: tmp, base }, 'keep.txt', 1, 99);
  assert.strictEqual(exp.total, 8);
  assert.strictEqual(exp.lines.length, 8);
  assert.strictEqual(exp.lines[2].text, 'CHANGED');

  // Staged mode sees the index, not the working tree.
  write('keep.txt', 'a\nb\nCHANGED\nd\ne\nf\ng\nWORKTREE-ONLY\n');
  const staged = collectDiff({ cwd: tmp, staged: true });
  const stagedKeep = staged.files.find((f) => f.path === 'keep.txt');
  assert.ok(!stagedKeep.hunks.some((h) => h.lines.some((l) => l.text === 'WORKTREE-ONLY')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('gitdiff self-check: ok');
}
