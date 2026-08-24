'use strict';

// Carry a code review's comment threads across rounds, and mark what moved.
//
// The plan side of this tool anchors a comment to a quoted run of text and asks
// "does that quote still appear in the reworked document?" (server/anchor.js).
// A code comment needs more: it lives at `file:line` on a specific side of the
// diff, and between rounds the agent edits the file, so the line number moves
// even when the code the reviewer pointed at is untouched.
//
// So a comment stores BOTH: {file, side, line, quote}. Re-anchoring finds the
// quote again inside the same file and takes the occurrence nearest the old line
// number — which is right for the common case (edits above shift everything
// down) and honest about the rest: when the quote is gone, the thread is
// archived rather than silently pointed at unrelated code.

const { newSideLines } = require('./gitdiff');

// A comment's quote is the exact text of the line(s) it covers, joined by \n for
// a multi-line selection. Splitting it back apart lets a multi-line anchor match
// as a run of consecutive lines.
function quoteLines(quote) {
  return String(quote == null ? '' : quote).split('\n');
}

// Every occurrence of the quoted run in `lines`, as 1-based start line numbers.
// Exact text match — a trimmed/fuzzy match would silently anchor a comment to
// re-indented code that may no longer mean the same thing.
function occurrences(lines, quote) {
  const want = quoteLines(quote);
  if (!want.length || (want.length === 1 && want[0] === '')) return [];
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (lines[i + k] !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i + 1);
  }
  return hits;
}

function nearest(hits, line) {
  let best = hits[0];
  let bestDist = Math.abs(hits[0] - line);
  for (const h of hits.slice(1)) {
    const d = Math.abs(h - line);
    if (d < bestDist) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}

// The old-side (deleted) lines the new model still shows, per file: a comment on
// a removed line survives only while that removal is still part of the diff.
function deletedIndex(model) {
  const byFile = new Map();
  for (const f of model.files || []) {
    const map = new Map();
    for (const h of f.hunks || []) {
      for (const l of h.lines || []) {
        if (l.type === 'del') map.set(l.oldNo, l.text);
      }
    }
    byFile.set(f.path, map);
  }
  return byFile;
}

// A file that was renamed this round: old path -> new path, so a comment left
// before the rename follows the file instead of being archived.
function renameMap(model) {
  const m = new Map();
  for (const f of model.files || []) {
    if (f.status === 'renamed' && f.oldPath && f.oldPath !== f.path) m.set(f.oldPath, f.path);
  }
  return m;
}

// Re-anchor every comment against a freshly collected model. Returns NEW comment
// objects (never mutates the input) with `line`/`endLine`/`file` updated and
// `archived` set true when the code they point at is gone. `resolved` is the
// resolveSpec() result the model was built from, so we can read the new side of
// files that no longer appear in the diff (the agent may have reverted the very
// change a comment was about — the code is then unchanged, not missing).
// `readLines` is the file reader, injected in tests so this stays checkable without a repo.
function reanchor(comments, model, resolved, readLines = newSideLines) {
  const renames = renameMap(model);
  const deleted = deletedIndex(model);
  const cache = new Map(); // path -> new-side lines (or null); one read per file per round
  const linesOf = (p) => {
    if (!cache.has(p)) cache.set(p, readLines(resolved, p));
    return cache.get(p);
  };

  return (comments || []).map((c) => {
    const out = { ...c };
    const file = renames.get(c.file) || c.file;
    out.file = file;

    if (c.side === 'old') {
      // Anchored to a removed line. It survives while the same removal, with the
      // same text, is still in the diff — a re-added line is a different thing
      // and should archive rather than quietly re-point at the new side.
      const map = deleted.get(file);
      const hit = map && map.get(c.line);
      out.archived = !(hit !== undefined && quoteLines(c.quote)[0] === hit);
      return out;
    }

    const lines = linesOf(file);
    if (!lines) {
      out.archived = true; // file deleted, binary, or unreadable this round
      return out;
    }
    const hits = occurrences(lines, c.quote);
    if (!hits.length) {
      out.archived = true;
      return out;
    }
    const start = nearest(hits, c.line || 1);
    const span = typeof c.endLine === 'number' ? c.endLine - c.line : 0;
    out.line = start;
    if (typeof c.endLine === 'number') out.endLine = start + span;
    out.archived = false;
    return out;
  });
}

// Mark what the agent touched since the last round, so the reviewer can go
// straight to the fixes instead of re-reading the whole diff:
//   file.round = 'new'       — this file wasn't in the previous round at all
//   file.round = 'changed'   — its new-side content differs from last round
//   line.fresh = true        — an added line whose text wasn't there last round
//
// lazydev: `fresh` is a set-membership test on line text, not a real diff of the
// two rounds, so a line that merely MOVED counts as fresh and a duplicate line
// (`});`) may not. It is a navigation hint on top of file-level truth, not a
// correctness claim; swap in a line-level LCS if it ever misleads.
function annotateRound(model, prevModel) {
  if (!prevModel) return model;
  const prev = new Map((prevModel.files || []).map((f) => [f.path, f]));
  const newSideText = (f) => {
    const out = [];
    for (const h of f.hunks || []) for (const l of h.lines || []) if (l.type !== 'del') out.push(l.text);
    return out;
  };
  for (const f of model.files || []) {
    const before = prev.get(f.path) || (f.status === 'renamed' ? prev.get(f.oldPath) : null);
    if (!before) {
      f.round = 'new';
      for (const h of f.hunks || []) for (const l of h.lines || []) if (l.type === 'add') l.fresh = true;
      continue;
    }
    const wasAdded = new Set();
    for (const h of before.hunks || []) for (const l of h.lines || []) if (l.type === 'add') wasAdded.add(l.text);
    let fresh = 0;
    for (const h of f.hunks || []) {
      for (const l of h.lines || []) {
        if (l.type !== 'add') continue;
        if (!wasAdded.has(l.text)) {
          l.fresh = true;
          fresh += 1;
        }
      }
    }
    const sameShape =
      f.additions === before.additions &&
      f.deletions === before.deletions &&
      newSideText(f).join('\n') === newSideText(before).join('\n');
    if (!sameShape) f.round = 'changed';
    f.freshCount = fresh;
  }
  return model;
}

module.exports = { reanchor, annotateRound, occurrences };

// ---------- self-check ----------
if (require.main === module) {
  const assert = require('assert');

  // occurrences: exact, multi-line, and absent.
  const src = ['a', 'b', 'c', 'b', 'c'];
  assert.deepStrictEqual(occurrences(src, 'b'), [2, 4]);
  assert.deepStrictEqual(occurrences(src, 'b\nc'), [2, 4]);
  assert.deepStrictEqual(occurrences(src, 'zzz'), []);
  assert.deepStrictEqual(occurrences(src, ''), []);

  // reanchor: a comment follows its line down the file, and archives when gone.
  const resolved = { root: '/tmp', mode: 'stub' };
  const files = { 'x.js': ['pad', 'pad', 'const token = verify(req)', 'tail'] };
  const read = (r, p) => files[p] || null; // injected instead of touching a real repo
  const fresh = {
    reanchor: (c, m, r) => reanchor(c, m, r, read),
    annotateRound,
  };

  const model = { files: [{ path: 'x.js', status: 'modified', hunks: [] }] };
  const [moved] = fresh.reanchor(
    [{ id: 'c1', file: 'x.js', side: 'new', line: 1, quote: 'const token = verify(req)' }],
    model,
    resolved
  );
  assert.strictEqual(moved.line, 3);
  assert.strictEqual(moved.archived, false);

  const [gone] = fresh.reanchor(
    [{ id: 'c2', file: 'x.js', side: 'new', line: 3, quote: 'const token = old(req)' }],
    model,
    resolved
  );
  assert.strictEqual(gone.archived, true);

  // A multi-line comment keeps its span when it moves.
  files['x.js'] = ['pad', 'pad', 'pad', 'one', 'two', 'tail'];
  const [span] = fresh.reanchor(
    [{ id: 'c3', file: 'x.js', side: 'new', line: 1, endLine: 2, quote: 'one\ntwo' }],
    model,
    resolved
  );
  assert.strictEqual(span.line, 4);
  assert.strictEqual(span.endLine, 5);

  // A comment on a removed line survives while that removal is still shown.
  const withDel = {
    files: [
      {
        path: 'x.js',
        status: 'modified',
        hunks: [{ lines: [{ type: 'del', oldNo: 7, newNo: null, text: 'legacy()' }] }],
      },
    ],
  };
  const [onDel] = fresh.reanchor(
    [{ id: 'c4', file: 'x.js', side: 'old', line: 7, quote: 'legacy()' }],
    withDel,
    resolved
  );
  assert.strictEqual(onDel.archived, false);
  const [delGone] = fresh.reanchor(
    [{ id: 'c5', file: 'x.js', side: 'old', line: 7, quote: 'legacy()' }],
    model,
    resolved
  );
  assert.strictEqual(delGone.archived, true);

  // A rename carries the comment to the new path.
  files['y.js'] = ['moved line'];
  const renamed = { files: [{ path: 'y.js', oldPath: 'x.js', status: 'renamed', hunks: [] }] };
  const [followed] = fresh.reanchor(
    [{ id: 'c6', file: 'x.js', side: 'new', line: 1, quote: 'moved line' }],
    renamed,
    resolved
  );
  assert.strictEqual(followed.file, 'y.js');
  assert.strictEqual(followed.archived, false);

  // annotateRound: a new file, a changed file, and an untouched one.
  const prevRound = {
    files: [
      { path: 'a.js', additions: 1, deletions: 0, hunks: [{ lines: [{ type: 'add', text: 'one' }] }] },
      { path: 'b.js', additions: 1, deletions: 0, hunks: [{ lines: [{ type: 'add', text: 'same' }] }] },
    ],
  };
  const thisRound = {
    files: [
      {
        path: 'a.js',
        additions: 2,
        deletions: 0,
        hunks: [{ lines: [{ type: 'add', text: 'one' }, { type: 'add', text: 'two' }] }],
      },
      { path: 'b.js', additions: 1, deletions: 0, hunks: [{ lines: [{ type: 'add', text: 'same' }] }] },
      { path: 'c.js', additions: 1, deletions: 0, hunks: [{ lines: [{ type: 'add', text: 'brand new' }] }] },
    ],
  };
  fresh.annotateRound(thisRound, prevRound);
  const byPath = Object.fromEntries(thisRound.files.map((f) => [f.path, f]));
  assert.strictEqual(byPath['a.js'].round, 'changed');
  assert.strictEqual(byPath['a.js'].freshCount, 1);
  assert.strictEqual(byPath['b.js'].round, undefined);
  assert.strictEqual(byPath['c.js'].round, 'new');

  console.log('diffanchor self-check: ok');
}
