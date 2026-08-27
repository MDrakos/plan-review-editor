# Inline Prototypes Implementation Plan

> **For agent executors:** Use [[subagent-driven-development]] (recommended) or [[executing-plans]] to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent embed a live, sandboxed screen prototype in a plan (a `prototype` fence) that the reviewer can click, element by element, to leave the same kind of comment a flow diagram box already gets — carried forward across rework rounds and bundled on submit, with zero changes to the server's comment/carry-forward/submit machinery.

**Architecture:** One new server module (`server/prototype.js`) renders the fence into a sandboxed `<iframe srcdoc>` plus a set of hidden `<span data-anchor-id>` stubs sitting *outside* the frame in the normal HTML flow. Those stubs are what `idAnchors` (`server/anchor.js`), `flowEl`/`flowLabel`/`markFlowAnchors` (`public/app.js`) and `saveComment` already operate on for flow diagrams — a prototype element is just another anchor kind (`el`, alongside `node`/`edge`), so none of that carry-forward/panel/bundle code changes. The only new client-side work is a tiny click-reporting shim injected into the frame, a `postMessage` bridge in `app.js`, and CSS for the frame's container.

**Tech stack:** Node.js (zero-dependency server modules, same pattern as `server/flow.js`), vanilla browser JS (`public/app.js`), plain CSS.

## Global Constraints

- Node >=18 (per `package.json` `engines`).
- No new runtime dependencies — every new module is zero-dependency, matching `server/flow.js` and `server/anchor.js`.
- `escapeHtml` lives in `server/escapehtml.js`; import it from there, never redefine it.
- The prototype `<iframe>` is `sandbox="allow-scripts"` and **must never** carry `allow-same-origin` — that is the entire security property this feature relies on. Every task touching `server/prototype.js` or its tests must preserve this.
- A malformed `prototype` fence (missing `id:`, or blank markup) falls back to `<pre><code class="language-prototype">…</code></pre>`, exactly as `choice` and `flow` do on malformed input. Nothing throws.
- `height:` is optional, defaults to `400`, and is clamped to `80`–`2000`.
- A prototype element's anchor id is `<fenceId>:el:<x>`, mirroring flow's `<fenceId>:node:<id>` / `<fenceId>:edge:<key>`.
- `server/server.js` and `server/anchor.js` get **zero** changes — the existing `idAnchors`/`quoteAnchors` branch and comment carry-forward are already generic over any `anchors` array.
- New/renamed npm-visible commands: `server/prototype.js` joins `npm run selfcheck` alongside `flow.js` and `anchor.js`.
- The prototype iframe's `srcdoc` always opens with a fixed CSP meta tag (`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`) — the very first thing in the inner document, before the base stylesheet, the markup, and the shim. Inline CSS and inline script keep working; every URL-loaded subresource and all network egress (`fetch`, `sendBeacon`, a remote `<img>`, a web font) is blocked.
- The server is the only thing allowed to mint `data-anchor-id`. Any `data-anchor-id` already present in the agent's raw markup is stripped before the server's own is added, and `openProtoComposer` only honors a reported `anchorId` that is prefixed with the sending block's own `<fenceId>:el:` — the frame is the one thing in this feature that isn't trusted.
- A `prototype` fence's `id:` must be unique within its document. A repeat falls back to a plain code block, exactly like a missing `id:` does. This uniqueness check is scoped to prototype fence ids only — a `flow` fence may share an `id:` with a `prototype` fence, since flow's `node`/`edge` namespacing already keeps their anchor ids distinct from a prototype's `el` namespace.
- Every element the server rewrites with `data-anchor-id` also gets `tabindex="0"` (unless it already declares a `tabindex`), and the shim reports Enter/Space the same way it reports a click — the same keyboard parity `server/flow.js` already gives its `<g>` elements.

---

## File map

| File | Change |
|---|---|
| `server/prototype.js` | **New.** Parses the fence, renders the sandboxed frame + hidden stubs, exports `renderPrototype`. |
| `server/markdown.js` | One dispatch line in `renderFence`. |
| `public/app.js` | `bindProtos()`, a `message` listener, `openProtoComposer()`, a small addition to `markFlowAnchors()` and `dismissComposer()`. |
| `public/style.css` | `.proto-block`, `.proto-frame`, `.proto-anchors`. |
| `package.json` | `server/prototype.js` added to the `selfcheck` script. |
| `test/e2e.js` | The 6 scenarios from the spec's Testing section. |
| `docs/PROTOCOL.md`, `integration/claude/plan-review/SKILL.md`, `README.md` | Document the `prototype` fence, mirroring how `flow` is documented. |

---

### Task 1: `server/prototype.js` — parse, render, self-check

**Files:**
- Create: `server/prototype.js`
- Modify: `package.json:17` (the `selfcheck` script)

**Reuse:** `escapeHtml` from `server/escapehtml.js` (existing, zero-dep). Structural precedent: `server/flow.js` (header/body split, `require.main` self-check, malformed→code-block fallback pattern also used by `renderChoice` in `server/markdown.js:93-98`). `searched, none — NEW` for everything else: no existing module parses a `key: value` fence header or scans HTML attributes.

**Interfaces:**
- Consumes: none — first task.
- Produces: `renderPrototype(body: string, usedIds?: Set<string>): string` — Task 2 (`server/markdown.js` dispatch) calls this directly, threading through the per-document `Set` of prototype fence ids already seen so a repeated `id:` falls back to a code block. Internal helpers `parseHeader`, `scanStubs`, `rewriteMarkup` are exported too, for the self-check, but no later task depends on them directly.

- [ ] **Step 1: Write the header-parsing assertions (RED)**

Create `server/prototype.js` with just enough to run and fail meaningfully:

```javascript
'use strict';

// The ```prototype fence: an inline sandboxed iframe carrying agent-authored
// markup, click-to-comment via a shim that reports clicks (and Enter/Space)
// up as anchor ids mirrored outside the frame as stubs. server/markdown.js
// dispatches to renderPrototype; server/anchor.js's idAnchors carries
// comments forward on the stub ids exactly as it does for flow.js's <g>
// anchors.
//
// The frame is sandbox="allow-scripts" and deliberately NOT allow-same-origin:
// that keeps its origin opaque, so agent-authored script inside it can never
// reach the reviewer page, no matter what it does. A frame-level CSP closes
// the one channel the sandbox attribute doesn't: it blocks every URL-loaded
// subresource and all network egress, leaving only inline CSS/script, which
// the sandbox already grants.

const { escapeHtml } = require('./escapehtml');

module.exports = {};

if (require.main === module) {
  const assert = require('assert');
  console.log('prototype.js self-check ok');
}
```

Run it once to confirm the harness itself is fine, then add the real assertions in place of the empty self-check body:

```javascript
if (require.main === module) {
  const assert = require('assert');

  // header parsing: id required, height defaults to 400
  const p1 = parseHeader('id: signup\n<div>hi</div>');
  assert.strictEqual(p1.id, 'signup');
  assert.strictEqual(p1.height, 400);
  assert.strictEqual(p1.markup, '<div>hi</div>');

  // height is clamped to 80–2000
  assert.strictEqual(parseHeader('id: signup\nheight: 5000\n<div>hi</div>').height, 2000);
  assert.strictEqual(parseHeader('id: signup\nheight: 10\n<div>hi</div>').height, 80);

  // a non-numeric height falls back to the default rather than erroring
  assert.strictEqual(parseHeader('id: signup\nheight: nope\n<div>hi</div>').height, 400);

  // malformed: no id, blank markup, two id: lines, an id with invalid characters
  assert.strictEqual(parseHeader('<div>hi</div>'), null, 'no id: line');
  assert.strictEqual(parseHeader('id: signup\n   \n'), null, 'blank markup');
  assert.strictEqual(parseHeader('id: a\nid: b\n<div>hi</div>'), null, 'two id: lines');
  assert.strictEqual(parseHeader('id: my signup\n<div>hi</div>'), null, 'id with a space');

  console.log('prototype.js self-check ok');
}
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node server/prototype.js`
Expected: `ReferenceError: parseHeader is not defined` (or similar) — `parseHeader` does not exist yet.

- [ ] **Step 3: Implement `parseHeader`**

Add above the `module.exports = {}` line (replace that line too):

```javascript
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2000;
const DEFAULT_HEIGHT = 400;
const ID_RE = /^[A-Za-z0-9_-]+$/;

// Split a fence body into its header ("key: value" lines) and markup
// (everything from the first non-header line down, verbatim). Returns
// { id, height, markup }, or null when `id:` is missing/invalid/duplicated or
// the markup is blank — the caller falls back to a plain code block, exactly
// as a malformed `choice`/`flow` fence does.
function parseHeader(body) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  let id = '';
  let height = DEFAULT_HEIGHT;
  let i = 0;
  for (; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w+):\s*(.*)$/);
    if (!kv) break;
    if (kv[1] === 'id') {
      if (id) return null; // two id: lines
      id = kv[2].trim();
    } else if (kv[1] === 'height') {
      const n = Number(kv[2].trim());
      if (Number.isFinite(n)) height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n));
    }
  }
  const markup = lines.slice(i).join('\n');
  if (!id || !ID_RE.test(id) || !markup.trim()) return null;
  return { id, height, markup };
}

module.exports = { parseHeader };
```

- [ ] **Step 4: Run to confirm the header assertions pass**

Run: `node server/prototype.js`
Expected: `prototype.js self-check ok`

- [ ] **Step 5: Add the stub-scanning and markup-rewrite assertions (RED)**

Insert into the self-check block, right after the header-parsing assertions (before `console.log('prototype.js self-check ok')`):

```javascript
  // stub scanning: id namespacing, first-wins on a duplicate data-proto-id,
  // a bare data-proto-id defaults its label to the id itself, and a
  // data-proto-id sitting inside a comment/<pre>/<script> is not a real tag
  // so it is never picked up
  const stubs = scanStubs(
    '<button data-proto-id="save" data-proto-label="Save button">Save</button>' +
      '<span data-proto-id="save">dup</span><i data-proto-id="cancel">x</i>' +
      '<!-- <b data-proto-id="ghost">not real</b> -->' +
      '<pre>&lt;b data-proto-id="ghost2"&gt;not real&lt;/b&gt;</pre>' +
      '<script>var s = "data-proto-id=\\"ghost3\\"";</script>',
    'signup'
  );
  assert.deepStrictEqual(stubs, [
    { id: 'save', label: 'Save button', anchorId: 'signup:el:save' },
    { id: 'cancel', label: 'cancel', anchorId: 'signup:el:cancel' },
  ]);

  // an element carrying two data-proto-id attributes: the first wins, and
  // scanStubs/rewriteMarkup must agree on which one that is
  const dupAttrStubs = scanStubs('<button data-proto-id="a" data-proto-id="b">x</button>', 'signup');
  assert.deepStrictEqual(dupAttrStubs, [{ id: 'a', label: 'a', anchorId: 'signup:el:a' }]);

  // markup rewrite: every occurrence of a given data-proto-id gets a matching
  // data-anchor-id, so a click on either duplicate reports the same anchor
  const rewritten = rewriteMarkup(
    '<button data-proto-id="save">Save</button><span data-proto-id="save">dup</span>',
    'signup'
  );
  assert.strictEqual(
    (rewritten.match(/data-anchor-id="signup:el:save"/g) || []).length,
    2,
    'both elements sharing a data-proto-id get the anchor attribute'
  );

  // rewriteMarkup obeys the same first-wins rule as scanStubs on a
  // duplicate-attribute element
  assert.ok(
    rewriteMarkup('<button data-proto-id="a" data-proto-id="b">x</button>', 'signup').includes(
      'data-anchor-id="signup:el:a"'
    ),
    'rewriteMarkup must agree with scanStubs on which duplicate attribute wins'
  );

  // the server is the only thing allowed to mint data-anchor-id: a literal
  // one already in the markup is stripped before the generated one is added
  const forged = rewriteMarkup(
    '<button data-anchor-id="other:el:x" data-proto-id="save">Save</button>',
    'signup'
  );
  assert.ok(!/data-anchor-id="other:el:x"/.test(forged), 'a pre-existing data-anchor-id is stripped');
  assert.strictEqual((forged.match(/data-anchor-id=/g) || []).length, 1, 'exactly one data-anchor-id remains');
  const forgedSingleQuoted = rewriteMarkup(
    "<button data-anchor-id='other:el:x' data-proto-id=\"save\">Save</button>",
    'signup'
  );
  assert.ok(!/data-anchor-id='other:el:x'/.test(forgedSingleQuoted), 'a single-quoted forgery is stripped too');
  // the strip is unconditional: an element with no data-proto-id is never
  // given an anchor id, so a forged one there must not survive either
  const forgedBare = rewriteMarkup(
    '<div data-anchor-id="signup:el:save">x</div><span data-anchor-id=signup:el:save>y</span>',
    'signup'
  );
  assert.ok(!/data-anchor-id/.test(forgedBare), 'a forgery on a tag with no data-proto-id is stripped, quoted or not');

  // every rewritten element gets a keyboard path: tabindex="0" unless it
  // already declares one, in which case its own value is left alone
  assert.ok(/<button[^>]*\btabindex="0"/.test(rewriteMarkup('<button data-proto-id="x">x</button>', 'signup')));
  const ownTabindex = rewriteMarkup('<button tabindex="-1" data-proto-id="x">x</button>', 'signup');
  assert.ok(/tabindex="-1"/.test(ownTabindex), "the element's own tabindex is left alone, not overwritten");
  assert.ok(!/tabindex="0"/.test(ownTabindex), 'no second tabindex is added on top of an existing one');

  // a data-proto-id occurrence inside a comment, <pre>, or <script> body is
  // never rewritten — only a real tag's own attribute is
  const protectedMarkup =
    '<!-- <b data-proto-id="ghost">not real</b> -->' +
    '<pre>&lt;b data-proto-id="ghost2"&gt;not real&lt;/b&gt;</pre>' +
    '<script>var s = "data-proto-id=\\"ghost3\\"";</script>';
  assert.strictEqual(
    (rewriteMarkup(protectedMarkup, 'signup').match(/data-anchor-id=/g) || []).length,
    0,
    'nothing inside a comment, <pre>, or <script> body is treated as a real attribute'
  );
```

- [ ] **Step 6: Run to confirm it fails**

Run: `node server/prototype.js`
Expected: `ReferenceError: scanStubs is not defined`

- [ ] **Step 7: Implement `scanStubs` and `rewriteMarkup`**

Add below `parseHeader`, above `module.exports`:

```javascript
// Blank out the interior of protected regions — HTML comments, <pre> blocks,
// and <script> bodies — while keeping every other character's position the
// same, so a later tag scan can never mistake text inside them (a JS string
// literal, a code sample) for a real attribute on a real tag.
// lazydev: this is a regex mask, not an HTML parser — a <pre> or <script>
// whose own opening tag is malformed enough to confuse `[^>]*` can still slip
// past it. The markup is agent-authored and well-formed by construction; a
// real parser is a bigger tool than this fence needs.
function maskProtected(markup) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return markup
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<pre\b[^>]*>)([\s\S]*?)(<\/pre>)/gi, (m, open, body, close) => open + blank(body) + close)
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) => open + blank(body) + close);
}

// Scan `markup` for every real tag (an attribute scan over masked markup, not
// an HTML parse) carrying data-proto-id="x" and build the stub list: one
// entry per distinct id, first tag wins, and within one tag its first
// data-proto-id attribute wins if it carries more than one. A missing
// data-proto-label defaults the label to the id.
function scanStubs(markup, fenceId) {
  const masked = maskProtected(markup);
  const tagRe = /<[a-zA-Z][^>]*>/g;
  const seen = new Set();
  const stubs = [];
  let m;
  while ((m = tagRe.exec(masked))) {
    const idMatch = m[0].match(/\bdata-proto-id="([^"]*)"/);
    if (!idMatch || !idMatch[1] || seen.has(idMatch[1])) continue;
    seen.add(idMatch[1]);
    const label = m[0].match(/\bdata-proto-label="([^"]*)"/);
    stubs.push({ id: idMatch[1], label: label ? label[1] : idMatch[1], anchorId: `${fenceId}:el:${idMatch[1]}` });
  }
  return stubs;
}

// Rewrite one already-matched opening tag: drop any data-anchor-id already on
// it (the server is the only thing allowed to mint that attribute — an
// agent-authored one could forge a click onto a different element), add
// tabindex="0" when the tag doesn't already declare one, and append a fresh
// data-anchor-id beside its first data-proto-id attribute.
function rewriteTag(tag, fenceId) {
  // Strip first and unconditionally: a tag with no data-proto-id can still
  // carry a forged data-anchor-id, and it would otherwise survive untouched.
  let out = tag.replace(/\s+data-anchor-id=(?:"[^"]*"|'[^']*'|[^\s>]*)/g, '');
  const idMatch = tag.match(/\bdata-proto-id="([^"]*)"/);
  if (!idMatch || !idMatch[1]) return out;
  if (!/\btabindex\s*=/.test(out)) out = out.replace(/^<([a-zA-Z][^\s>]*)/, '<$1 tabindex="0"');
  const anchorId = escapeHtml(`${fenceId}:el:${idMatch[1]}`);
  return out.replace(/\/?>$/, (close) => ` data-anchor-id="${anchorId}"${close}`);
}

// Apply rewriteTag to every real tag in `markup` (scanned on masked markup,
// applied to the original at the same offsets — masking never changes
// length), leaving comment/<pre>/<script> bodies untouched.
function rewriteMarkup(markup, fenceId) {
  const masked = maskProtected(markup);
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = tagRe.exec(masked))) {
    out += markup.slice(last, m.index) + rewriteTag(markup.slice(m.index, m.index + m[0].length), fenceId);
    last = m.index + m[0].length;
  }
  return out + markup.slice(last);
}

module.exports = { parseHeader, scanStubs, rewriteMarkup };
```

- [ ] **Step 8: Run to confirm the stub/rewrite assertions pass**

Run: `node server/prototype.js`
Expected: `prototype.js self-check ok`

- [ ] **Step 9: Add the full-render assertions (RED)**

Insert into the self-check block, after the stub/rewrite assertions:

```javascript
  // full render: CSP meta first, sandbox attrs, no allow-same-origin, the
  // declared height on the CSS var, a hidden-free stub per data-proto-id, and
  // the raw markup only inside the escaped srcdoc — never verbatim in the
  // outer HTML
  const html = renderPrototype('id: signup\nheight: 320\n<button data-proto-id="save">Save</button>');
  assert.ok(html.includes('sandbox="allow-scripts"'));
  assert.ok(!/allow-same-origin/.test(html));
  assert.ok(html.includes('--proto-h:320px'));
  assert.ok(html.includes('data-anchor-id="signup:el:save"'));
  assert.ok(
    html.includes('class="proto-anchors"') && !/proto-anchors"\s+hidden/.test(html),
    'the stub container carries no hidden attribute — the CSS hides it instead, so focusComment can still scroll to it'
  );
  assert.ok(
    !html.includes('<button data-proto-id="save">Save</button>'),
    'the raw markup must never appear unescaped outside the srcdoc attribute'
  );

  // the CSP meta tag is the very first thing in the inner document — before
  // the base stylesheet, the markup, and the shim
  const decoded = html
    .match(/srcdoc="([^"]*)"/)[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  assert.ok(decoded.startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(decoded.includes("default-src 'none'"));

  // the shim's own <script> sits before the agent's markup, so a raw
  // </script> inside the agent's own inline script can never orphan it
  const shimIdx = decoded.indexOf('<script>');
  const markupIdx = decoded.indexOf('data-anchor-id="signup:el:save"');
  assert.ok(shimIdx !== -1 && shimIdx < markupIdx, 'the shim script is injected before the markup');
  assert.ok(decoded.includes("addEventListener('keydown'"), 'the shim also listens for keydown, not just click');

  // two prototype fences sharing an id: the second falls back to a plain
  // code block, exactly like a missing id: does
  const usedIds = new Set();
  const first = renderPrototype('id: signup\n<button data-proto-id="save">Save</button>', usedIds);
  const second = renderPrototype('id: signup\n<button data-proto-id="cancel">Cancel</button>', usedIds);
  assert.ok(first.includes('sandbox="allow-scripts"'));
  assert.ok(second.startsWith('<pre><code class="language-prototype">'), 'a reused id falls back to a code block');

  // malformed fence falls back to a plain code block, like choice/flow
  assert.ok(renderPrototype('no id here').startsWith('<pre><code class="language-prototype">'));
```

- [ ] **Step 10: Run to confirm it fails**

Run: `node server/prototype.js`
Expected: `ReferenceError: renderPrototype is not defined`

- [ ] **Step 11: Implement `renderPrototype`**

Add below `rewriteMarkup`, above `module.exports`:

```javascript
// The frame's own CSP: no URL-loaded subresource and no network egress of any
// kind (fetch, sendBeacon, a remote <img>, a web font) — only inline CSS and
// inline script, which the sandbox already grants, keep working.
const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:">';

// A minimal reset — the prototype is a screen the agent designed, not part of
// the reviewer's chrome, so it always gets a plain light surface regardless
// of the reviewer's theme.
const BASE_STYLE =
  '<style>*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;color:#1a1a1a;background:#fff}</style>';

// Click, or Enter/Space on the nearest [data-anchor-id] → report it to the
// parent. Two inbound messages: 'proto-commented' marks an element as
// carrying a thread, 'proto-clear' drops the selection highlight. '*' is the
// only possible target origin in both directions, because sandbox="allow-scripts"
// without allow-same-origin gives this frame an opaque (null) origin.
const SHIM = `(function(){
function report(el){
  var r = el.getBoundingClientRect();
  parent.postMessage({ kind: 'proto-click', anchorId: el.dataset.anchorId, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }, '*');
}
document.addEventListener('click', function(e){
  var el = e.target.closest('[data-anchor-id]');
  if (el) report(el);
});
document.addEventListener('keydown', function(e){
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var el = e.target.closest('[data-anchor-id]');
  if (!el) return;
  e.preventDefault();
  report(el);
});
window.addEventListener('message', function(e){
  var d = e.data || {};
  if (d.kind === 'proto-commented') {
    var el = document.querySelector('[data-anchor-id="' + CSS.escape(d.anchorId) + '"]');
    if (el) el.classList.add('commented');
  } else if (d.kind === 'proto-clear') {
    var sel = document.querySelectorAll('.selected');
    for (var i = 0; i < sel.length; i++) sel[i].classList.remove('selected');
  }
});
})();`;

// Render one ```prototype fence body to a sandboxed iframe plus its anchor
// stubs, or fall back to a plain code block when the fence is malformed (no
// id:, blank markup, or an id: already used elsewhere in this document) —
// exactly as renderChoice/renderFlow do. `usedIds`, when passed, is the
// per-document set of prototype fence ids already rendered; the caller
// (renderBlocks) owns its lifetime.
function renderPrototype(body, usedIds) {
  const parsed = parseHeader(body);
  if (!parsed || (usedIds && usedIds.has(parsed.id))) {
    return `<pre><code class="language-prototype">${escapeHtml(body)}</code></pre>`;
  }
  if (usedIds) usedIds.add(parsed.id);
  const { id, height, markup } = parsed;
  const stubs = scanStubs(markup, id);
  const inner = CSP_META + BASE_STYLE + `<script>${SHIM}</script>` + rewriteMarkup(markup, id);
  const stubHtml = stubs
    .map((s) => `<span data-anchor-id="${escapeHtml(s.anchorId)}" data-label="${escapeHtml(s.label)}"></span>`)
    .join('');
  return (
    `<div class="proto-block" data-proto-id="${escapeHtml(id)}" style="--proto-h:${height}px">` +
    `<iframe class="proto-frame" sandbox="allow-scripts" srcdoc="${escapeHtml(inner)}"></iframe>` +
    `<div class="proto-anchors">${stubHtml}</div>` +
    `</div>`
  );
}

module.exports = { parseHeader, scanStubs, rewriteMarkup, renderPrototype };
```

- [ ] **Step 12: Run to confirm the full self-check passes**

Run: `node server/prototype.js`
Expected: `prototype.js self-check ok`

- [ ] **Step 13: Wire `server/prototype.js` into `npm run selfcheck`**

In `package.json`, change line 17 from:

```json
    "selfcheck": "node server/gitdiff.js && node server/diffanchor.js && node server/flow.js && node server/anchor.js && node test/reviewvm.js"
```

to:

```json
    "selfcheck": "node server/gitdiff.js && node server/diffanchor.js && node server/flow.js && node server/anchor.js && node server/prototype.js && node test/reviewvm.js"
```

- [ ] **Step 14: Run the full selfcheck to confirm it's wired correctly**

Run: `npm run selfcheck`
Expected: every self-check prints its own `… ok` line, including `prototype.js self-check ok`, and the command exits 0.

- [ ] **Step 15: Commit**

```bash
git add server/prototype.js package.json
git commit -m "feat: add server/prototype.js to render the prototype fence"
```

---

### Task 2: `server/markdown.js` dispatch + full e2e suite

**Files:**
- Modify: `server/markdown.js:9` (import), `server/markdown.js:23-27` (`renderFence` dispatch), `server/markdown.js:178-197` (`renderBlocks`, to own the per-document `Set` of prototype fence ids)
- Modify: `test/e2e.js` (new section, inserted after the existing "issue 016: flow diagrams" section, which currently ends at the `await cli('stop', '--session', fl.id);` on the line right before the `// Two regressions…` comment, and — including that section's CSS/app.js regression checks — spans through the block ending at the `panBranch` check just before `console.log('issue 008: …')`; insert the new section immediately before that `console.log('issue 008: …')` line)

**Reuse:** `render`, `idAnchors` (already imported in `test/e2e.js:29-31`); `cli`, `browser`, `check`, `sleep`, `dir`, `path`, `fs` (all already in scope in `test/e2e.js`, used identically by the existing flow-diagram test block). `searched, none — NEW` for the dispatch line itself: it is the one-line pattern `choice`/`flow` already establish.

**Interfaces:**
- Consumes: `renderPrototype(body, usedIds)` from Task 1 (`server/prototype.js`).
- Produces: nothing new — `render()` (from `server/markdown.js`, already exported) now also handles `prototype` fences, for any later task/test to call. `renderBlocks` creates a fresh `protoIds` `Set` on every call and passes it through `renderFence` to `renderPrototype`; since `renderDiff` calls `renderBlocks` once and `renderVersionDiff` calls it twice (once per markdown string), each render gets its own `Set` for free — a diff render never inherits or leaks prototype-id state from the other side of the diff.

- [ ] **Step 1: Write the e2e test section (RED)**

In `test/e2e.js`, insert this new block immediately before the line `console.log('issue 008: a re-present carries a choice resolution forward (persists until cleared)');`:

```javascript
  console.log('issue 017: inline prototypes — rendering, id anchoring, carry-forward, and the bundle');
  const PROTO_A =
    '# Screens\n\nBefore the prototype.\n\n```prototype\nid: signup\nheight: 320\n' +
    '<div class="card"><h2 data-proto-id="title">Create your account</h2>' +
    '<input data-proto-id="email" placeholder="Email">' +
    '<button data-proto-id="save" data-proto-label="Save button">Save</button></div>\n```\n';
  // The same prototype with the `save` button (and its stub) taken out.
  const PROTO_B =
    '# Screens\n\nBefore the prototype.\n\n```prototype\nid: signup\nheight: 320\n' +
    '<div class="card"><h2 data-proto-id="title">Create your account</h2>' +
    '<input data-proto-id="email" placeholder="Email"></div>\n```\n';

  const protoHtml = render(PROTO_A);
  check(
    'a ```prototype fence renders a sandboxed frame (allow-scripts, NOT allow-same-origin) with a matching anchor id per data-proto-id, and the raw markup nowhere but inside srcdoc',
    protoHtml.includes('sandbox="allow-scripts"') &&
      !/allow-same-origin/.test(protoHtml) &&
      protoHtml.includes('data-anchor-id="signup:el:save"') &&
      protoHtml.includes('data-anchor-id="signup:el:email"') &&
      !protoHtml.includes('<button data-proto-id="save"'),
    protoHtml.slice(0, 200)
  );
  check(
    'a malformed prototype fence falls back to plain code, exactly as a malformed choice/flow does',
    render('# T\n\n```prototype\nno id here\n```\n').includes('<pre><code class="language-prototype">')
  );
  check(
    'a document with no prototype fence is untouched by the feature',
    !/proto-/.test(render('# T\n\nJust prose, and `code`.\n\n```js\nlet a = 1;\n```\n'))
  );
  check(
    'idAnchors is not fooled by a prefix of a longer prototype anchor id',
    idAnchors('signup:el:save', protoHtml) === true &&
      idAnchors('signup:el:sav', protoHtml) === false
  );
  check(
    "the frame's CSP blocks network egress and every URL-loaded subresource, leaving only inline CSS/script",
    protoHtml.includes('Content-Security-Policy') && protoHtml.includes("default-src 'none'")
  );
  check(
    'every rewritten element gets a keyboard path to the composer, matching flow.js\'s <g> elements (tabindex lives inside the escaped srcdoc, so its own quotes come back as &quot;)',
    protoHtml.includes('tabindex=&quot;0&quot;')
  );
  check(
    'a document reusing an already-used prototype fence id falls back to a code block for the repeat, never a second indistinguishable stub set',
    (() => {
      const dupeHtml = render(
        '```prototype\nid: signup\n<button data-proto-id="save">Save</button>\n```\n' +
          '```prototype\nid: signup\n<button data-proto-id="cancel">Cancel</button>\n```\n'
      );
      const stubCount = (dupeHtml.match(/data-anchor-id="signup:el:save"/g) || []).length;
      return (
        stubCount === 1 &&
        dupeHtml.includes('<pre><code class="language-prototype">') &&
        !dupeHtml.includes('data-anchor-id="signup:el:cancel"')
      );
    })()
  );
  check(
    'a flow fence and a prototype fence may share an id: without colliding — the kind segment (node/edge vs el) already keeps them distinct',
    render(
      '```flow\nid: signup\nsave[Save]\n```\n' +
        '```prototype\nid: signup\n<button data-proto-id="save">Save</button>\n```\n'
    ).includes('data-anchor-id="signup:el:save"')
  );

  const protoDoc = path.join(dir, 'planreview-e2e-proto.md');
  fs.writeFileSync(protoDoc, PROTO_A);
  const pr = await cli('start', protoDoc, '--no-open');
  const prState = await browser(`/api/state?session=${pr.id}`);
  check(
    'the served document carries the rendered prototype frame and its anchor stubs',
    prState.data.doc.html.includes('data-anchor-id="signup:el:save"') &&
      prState.data.doc.html.includes('data-anchor-id="signup:el:title"')
  );

  await browser(`/api/review-state?session=${pr.id}`, {
    reviewerId: 'A',
    comments: [
      { id: 'pn', quote: 'Save button', text: 'move this above the fold', anchors: ['signup:el:save'], author: { id: 'A' } },
      { id: 'pp', quote: 'Before the prototype.', text: 'a prose comment', author: { id: 'A' } },
    ],
    choices: {},
  });

  const prSubmit = cli('wait', '--session', pr.id, '--timeout', '10');
  await sleep(300);
  await browser(`/api/submit?session=${pr.id}`, { comments: [], choices: {}, note: '' });
  const prEv = await prSubmit;
  const prBundled = (prEv.comments || []).find((c) => c.id === 'pn');
  check(
    'the submit bundle carries anchors naming the prototype element the comment is attached to',
    !!prBundled &&
      Array.isArray(prBundled.anchors) &&
      prBundled.anchors[0] === 'signup:el:save' &&
      !('anchors' in (prEv.comments.find((c) => c.id === 'pp') || {})),
    JSON.stringify(prBundled)
  );

  // Re-present the SAME prototype: the element comment must still be active.
  fs.writeFileSync(protoDoc, PROTO_A + '\nA reworked addition.\n');
  await cli('present', protoDoc, '--session', pr.id);
  const prById = (st) => Object.fromEntries(st.data.review.comments.map((c) => [c.id, c]));
  const prKept = prById(await browser(`/api/state?session=${pr.id}`));
  check(
    'a re-present that keeps the element carries its comment forward, unarchived',
    prKept.pn && !prKept.pn.archived,
    JSON.stringify(prKept)
  );

  // Re-present with the Save button (and its stub) removed: the comment archives.
  await browser(`/api/submit?session=${pr.id}`, { comments: [], choices: {}, note: '' });
  fs.writeFileSync(protoDoc, PROTO_B);
  await cli('present', protoDoc, '--session', pr.id);
  const prGone = prById(await browser(`/api/state?session=${pr.id}`));
  check(
    'removing the element archives its comment rather than dropping it',
    prGone.pn && prGone.pn.archived === true && prGone.pn.text === 'move this above the fold',
    JSON.stringify(prGone.pn)
  );
  check(
    'a prose comment in the same document still anchors on its quote',
    prGone.pp && prGone.pp.archived === false
  );
  await cli('stop', '--session', pr.id);

```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm run test:plan`
Expected: FAIL — the first `check` for the `prototype` fence fails, because `renderFence` doesn't dispatch to `renderPrototype` yet (the fence renders as `<pre><code class="language-prototype">`, so `sandbox="allow-scripts"` is absent).

- [ ] **Step 3: Wire the dispatch line and thread the per-document prototype-id `Set`**

In `server/markdown.js`, change line 9 from:

```javascript
const { renderFlow } = require('./flow');
```

to:

```javascript
const { renderFlow } = require('./flow');
const { renderPrototype } = require('./prototype');
```

Then change lines 23-27 from:

```javascript
function renderFence(lang, body) {
  if (lang === 'choice') return renderChoice(body);
  if (lang === 'flow') return renderFlow(body);
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<pre><code${cls}>${escapeHtml(body)}</code></pre>`;
}
```

to:

```javascript
function renderFence(lang, body, protoIds) {
  if (lang === 'choice') return renderChoice(body);
  if (lang === 'flow') return renderFlow(body);
  if (lang === 'prototype') return renderPrototype(body, protoIds);
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<pre><code${cls}>${escapeHtml(body)}</code></pre>`;
}
```

`flow` is deliberately left out of `protoIds` — it stays untouched, and its own `id:` collisions (if any) are its own concern; a `flow` and a `prototype` fence sharing an `id:` is fine because `node`/`edge` and `el` already keep their anchor ids apart.

Then change `renderBlocks` (currently lines 178-197) from:

```javascript
function renderBlocks(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(renderFence(fence[1], body.join('\n')));
      continue;
    }
```

to:

```javascript
function renderBlocks(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const protoIds = new Set(); // this render's prototype fence ids — fresh per call, never shared

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(renderFence(fence[1], body.join('\n'), protoIds));
      continue;
    }
```

`protoIds` lives inside `renderBlocks`, not at module scope, so it can't leak between calls. `renderDiff` calls `renderBlocks` once per render — one `Set`. `renderVersionDiff` calls `renderBlocks(fromMarkdown)` and `renderBlocks(toMarkdown)` as two separate calls, each getting its own fresh `Set` — the old and new side of a version diff never share or leak prototype-id state.

- [ ] **Step 4: Run to confirm it passes**

Run: `npm run test:plan`
Expected: PASS — every `check` prints OK, output ends `all checks passed` (or this suite's equivalent all-green summary).

- [ ] **Step 5: Commit**

```bash
git add server/markdown.js test/e2e.js
git commit -m "feat: dispatch the prototype fence and cover it end to end"
```

---

### Task 3: `public/style.css` — `.proto-block` / `.proto-frame` / `.proto-anchors`

**Files:**
- Modify: `public/style.css` (append at end of file, currently 1648 lines, right after the `.flow-block:hover .flow-hint { opacity: 1; }` rule)
- Modify: `test/e2e.js` (append to the "issue 017" section added in Task 2, right after the `idAnchors` prefix check and before the "served document" check — or anywhere within that section; placed here at the end of the section, right after `await cli('stop', '--session', pr.id);`)

**Reuse:** `--pr-surface`, `--pr-rule` design tokens (`public/style.css:16-20`, already used by `.flow-block`). `searched, none — NEW`: no existing rule sizes an iframe or hides a stub div.

**Interfaces:**
- Consumes: `.proto-block` / `.proto-frame` / `.proto-anchors` class names and the `--proto-h` custom property, all produced by `renderPrototype` in Task 1.
- Produces: nothing later tasks depend on structurally — Task 4's `openProtoComposer` reads geometry off `.proto-frame` via `getBoundingClientRect()`, which works regardless of these rules, but the block is not usable without them.

- [ ] **Step 1: Write the CSS-presence assertion (RED)**

Append to the end of the "issue 017" section in `test/e2e.js` (after `await cli('stop', '--session', pr.id);`):

```javascript
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const protoCssIdx = cssSrc.indexOf('.proto-block');
  const protoCss = protoCssIdx === -1 ? '' : cssSrc.slice(protoCssIdx);
  check(
    '.proto-block/.proto-frame/.proto-anchors exist and paint with design tokens, not literal colours',
    protoCss.includes('.proto-block') &&
      protoCss.includes('.proto-frame') &&
      protoCss.includes('.proto-anchors') &&
      protoCss.includes('height: var(--proto-h)') &&
      !/#[0-9a-fA-F]{3,8}\b/.test(protoCss),
    protoCss.slice(0, 300)
  );
  check(
    'the anchor stubs keep a layout box so focusComment can scroll to the prototype',
    !/\.proto-anchors\s*\{[^}]*display:\s*none/.test(protoCss),
    protoCss.slice(0, 300)
  );
  check(
    'the stub container carries no hidden attribute — public/style.css declares [hidden] { display: none !important }, which would beat the .proto-anchors rule above',
    !/proto-anchors"\s+hidden/.test(protoHtml)
  );
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm run test:plan`
Expected: FAIL — `.proto-block` is not yet in `public/style.css`.

- [ ] **Step 3: Add the CSS**

Append to the end of `public/style.css`:

```css

.proto-block {
  position: relative;
  margin: 18px 0;
  border: 1px solid var(--pr-rule);
  border-radius: 6px;
  overflow: hidden;
  background: var(--pr-surface);
}

.proto-frame {
  display: block;
  width: 100%;
  height: var(--proto-h);
  border: 0;
}

/* The stubs mirror the frame's targetable ids into the outer document so
   idAnchors and flowEl can see them. They are inert and invisible, but they keep
   a zero-size box inside the block rather than `display: none`, so
   focusComment's scrollIntoView lands on the prototype instead of doing
   nothing. */
.proto-anchors {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  overflow: hidden;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm run test:plan`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/style.css test/e2e.js
git commit -m "feat: style the prototype block, frame and hidden anchor stubs"
```

---

### Task 4: `public/app.js` — `bindProtos()`, message bridge, `openProtoComposer()`

**Files:**
- Modify: `public/app.js:278` (`renderDoc`, right after `bindFlows();`)
- Modify: `public/app.js:422` (`showDiff`, right after `bindFlows();`)
- Modify: `public/app.js:1116-1122` (`dismissComposer`)
- Modify: `public/app.js:1822-1831` (`markFlowAnchors`)
- Modify: `public/app.js` (new section, inserted after the flow-diagrams section ends — after the `docEl.addEventListener('keydown', …)` block that currently closes just before `// ---------- boot ----------`)
- Modify: `test/e2e.js` (append to the "issue 017" section, after the CSS check added in Task 3)

**Reuse:** `flowEl(id)`, `flowLabel(ids)`, `flowCommentable()`, `openComposerAt(rect, quote)`, `focusComment(id)`, `pendingRange`/`pendingAnchors`/`pendingQuote` module state, `clearFlowSelection()` (all existing, `public/app.js:130-1864` — see spec's grounding). `searched, none — NEW`: `protoFrames` (a `contentWindow → block` `Map`), `lastProtoBlocks` (a `data-proto-id → block` `Map`, held across renders so an unchanged block's live iframe can be swapped back in), `bindProtos()`, the `message` listener, `openProtoComposer()` are new — nothing in the codebase tracks iframe windows today.

**Interfaces:**
- Consumes: `flowEl`, `flowLabel`, `flowCommentable`, `openComposerAt`, `focusComment`, `clearFlowSelection`, `pendingRange`/`pendingAnchors`/`pendingQuote` — all `Reuse` above, no new names to learn.
- Produces: `bindProtos()` (called from `renderDoc`/`showDiff`, no later task consumes it directly), `openProtoComposer(block, anchorId, rect)` (called only from the new `message` listener in this same task).

- [ ] **Step 1: Write the wiring assertions (RED)**

Append to the end of the "issue 017" section in `test/e2e.js` (after the CSS check from Task 3):

```javascript
  const appSrc2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check(
    'bindProtos() is wired at both renderDoc sites, right alongside bindFlows()',
    (appSrc2.match(/bindFlows\(\);\n\s*bindProtos\(\);/g) || []).length === 2
  );
  const protoListener = (appSrc2.match(
    /window\.addEventListener\('message'[\s\S]*?\n\}\);/
  ) || [''])[0];
  check(
    "the prototype message listener filters on event.source, never event.origin — a sandboxed frame's origin is null and not a value worth trusting",
    /protoFrames\.get\(e\.source\)/.test(protoListener) && !/\.origin\b/.test(protoListener),
    protoListener.slice(0, 300)
  );
  check(
    'dismissComposer() also clears the selection inside every prototype frame',
    /function dismissComposer\(\)\s*\{[^}]*proto-clear/.test(appSrc2)
  );
  check(
    'markFlowAnchors() also notifies a prototype frame when one of its elements gets commented',
    /function markFlowAnchors\([^)]*\)\s*\{[\s\S]*?proto-commented[\s\S]*?\n\}/.test(appSrc2)
  );
  const openProtoComposerSrc = (appSrc2.match(/function openProtoComposer\([^)]*\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  check(
    "openProtoComposer rejects a reported anchorId that isn't prefixed with the sending block's own fence id — a frame can't hijack a click onto a different block's anchor",
    /dataset\.protoId/.test(openProtoComposerSrc) && /startsWith\(prefix\)/.test(openProtoComposerSrc),
    openProtoComposerSrc.slice(0, 400)
  );
  const bindProtosSrc = (appSrc2.match(/function bindProtos\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  check(
    "bindProtos() reuses an existing frame instead of letting an unrelated re-render tear it down, when the incoming block's srcdoc is byte-identical to the one it's replacing",
    /getAttribute\('srcdoc'\)/.test(bindProtosSrc) && /replaceWith/.test(bindProtosSrc),
    bindProtosSrc.slice(0, 400)
  );
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm run test:plan`
Expected: FAIL — none of `bindProtos`, `protoFrames`, `proto-clear`, `proto-commented` exist in `public/app.js` yet.

- [ ] **Step 3: Add `bindProtos()`, the message listener, and `openProtoComposer()`**

In `public/app.js`, insert this new section right after the flow-diagrams section's closing `docEl.addEventListener('keydown', …)` block and right before `// ---------- boot ----------`:

```javascript
// ---------- prototype frames (```prototype) ----------
//
// A prototype fence renders as a sandboxed iframe with the same click-to-comment
// affordance a flow diagram's box gets: the frame's own shim script reports a
// click (or Enter/Space) as { anchorId, rect } via postMessage, and the
// composer opens exactly as it does for a flow node. flowEl/flowLabel/
// flowCommentable are reused as is — the anchor lives on the stub beside the
// frame, not inside it.

const protoFrames = new Map(); // iframe.contentWindow -> the .proto-block that owns it
let lastProtoBlocks = new Map(); // data-proto-id -> the .proto-block from the previous render

// Re-scanned on every render: docEl.innerHTML is fully replaced each time, so
// every .proto-block is a fresh DOM node. When a fresh block's srcdoc is
// byte-identical to the block that carried the same data-proto-id last time,
// swap the fresh node back out for the old one — its iframe is already
// loaded and keeps its running state, instead of reloading (and re-running
// the agent's script) on every unrelated reviewer's comment.
// lazydev: this only recognizes a whole-block match (same id, identical
// srcdoc); it doesn't diff attributes within a block, so it buys nothing when
// only part of a prototype changed.
function bindProtos() {
  protoFrames.clear();
  const nextProtoBlocks = new Map();
  for (const block of docEl.querySelectorAll('.proto-block')) {
    const id = block.dataset.protoId;
    const frame = block.querySelector('.proto-frame');
    const prevBlock = lastProtoBlocks.get(id);
    const prevFrame = prevBlock && prevBlock.querySelector('.proto-frame');
    if (frame && prevFrame && prevFrame.getAttribute('srcdoc') === frame.getAttribute('srcdoc')) {
      block.replaceWith(prevBlock);
      nextProtoBlocks.set(id, prevBlock);
      protoFrames.set(prevFrame.contentWindow, prevBlock);
      continue;
    }
    if (frame) protoFrames.set(frame.contentWindow, block);
    nextProtoBlocks.set(id, block);
  }
  lastProtoBlocks = nextProtoBlocks;
}

// Filtered on event.source (an exact window reference), never event.origin —
// a sandboxed frame with no allow-same-origin has an opaque (null) origin,
// which is not a value worth trusting.
window.addEventListener('message', (e) => {
  const block = protoFrames.get(e.source);
  if (!block) return;
  const data = e.data || {};
  if (data.kind !== 'proto-click') return;
  openProtoComposer(block, data.anchorId, data.rect);
});

// Open the composer for a click reported up from inside `block`'s frame. A
// reported anchorId is only trusted when it names an element inside this same
// block — the block's frame could otherwise forge a click onto a different
// block's anchor and hijack or misattribute its comment thread. Mirrors
// openFlowComposer: an anchor that already carries a thread (data-cids on its
// stub) focuses that thread instead of starting a second one.
function openProtoComposer(block, anchorId, rect) {
  const prefix = `${block.dataset.protoId}:el:`;
  if (typeof anchorId !== 'string' || !anchorId.startsWith(prefix)) return;
  const el = flowEl(anchorId);
  if (!el) return;
  if (el.dataset.cids) {
    focusComment(el.dataset.cids.split(' ')[0]);
    return;
  }
  if (!flowCommentable()) return;
  const frameRect = block.querySelector('.proto-frame').getBoundingClientRect();
  pendingRange = null;
  pendingAnchors = [anchorId];
  pendingQuote = flowLabel(pendingAnchors);
  openComposerAt(
    { left: frameRect.left + rect.left, bottom: frameRect.top + rect.bottom },
    pendingQuote
  );
}
```

- [ ] **Step 4: Add `bindProtos()` at both `renderDoc`/`showDiff` call sites**

In `public/app.js`, change (in `renderDoc`, line 278):

```javascript
  highlightDoc();
  bindFlows();
  state.version = doc.version;
```

to:

```javascript
  highlightDoc();
  bindFlows();
  bindProtos();
  state.version = doc.version;
```

And change (in `showDiff`, line 422):

```javascript
  highlightDoc();
  bindFlows();
  diffLegend.hidden = false;
```

to:

```javascript
  highlightDoc();
  bindFlows();
  bindProtos();
  diffLegend.hidden = false;
```

- [ ] **Step 5: Add the `proto-clear` post in `dismissComposer()`**

In `public/app.js`, change lines 1116-1122 from:

```javascript
function dismissComposer() {
  composerEl.hidden = true;
  pendingRange = null;
  pendingAnchors = null;
  pendingQuote = '';
  clearFlowSelection();
}
```

to:

```javascript
function dismissComposer() {
  composerEl.hidden = true;
  pendingRange = null;
  pendingAnchors = null;
  pendingQuote = '';
  clearFlowSelection();
  for (const win of protoFrames.keys()) win.postMessage({ kind: 'proto-clear' }, '*');
}
```

- [ ] **Step 6: Add the `proto-commented` post in `markFlowAnchors()`**

In `public/app.js`, change lines 1822-1831 from:

```javascript
function markFlowAnchors(anchors, cid) {
  for (const id of anchors) {
    const el = flowEl(id);
    if (!el) continue;
    el.classList.add('commented');
    const cids = (el.dataset.cids || '').split(' ').filter(Boolean);
    if (!cids.includes(cid)) cids.push(cid);
    el.dataset.cids = cids.join(' ');
  }
}
```

to:

```javascript
function markFlowAnchors(anchors, cid) {
  for (const id of anchors) {
    const el = flowEl(id);
    if (!el) continue;
    el.classList.add('commented');
    const cids = (el.dataset.cids || '').split(' ').filter(Boolean);
    if (!cids.includes(cid)) cids.push(cid);
    el.dataset.cids = cids.join(' ');
    const protoBlock = el.closest('.proto-block');
    const frame = protoBlock && protoBlock.querySelector('.proto-frame');
    if (frame) frame.contentWindow.postMessage({ kind: 'proto-commented', anchorId: id }, '*');
  }
}
```

- [ ] **Step 7: Run to confirm it passes**

Run: `npm run test:plan`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS — `test/e2e.js`, `test/codereview.js` and `test/demo.js` all green (the latter two are untouched by this feature and should be unaffected).

- [ ] **Step 9: Run selfcheck once more for good measure**

Run: `npm run selfcheck`
Expected: every module prints its own `… ok` line and the command exits 0.

- [ ] **Step 10: Commit**

```bash
git add public/app.js test/e2e.js
git commit -m "feat: wire prototype frames into click-to-comment"
```

---

### Task 5: Docs — `PROTOCOL.md`, `SKILL.md`, `README.md`

**Files:**
- Modify: `docs/PROTOCOL.md:103-107` (the `comments[].anchors` bullet) and a new `## Prototypes` section inserted after the existing `## Flow diagrams` section (which ends right before `## Choice-conflict resolution`)
- Modify: `integration/claude/plan-review/SKILL.md` (a new paragraph inserted after the "**Draw a flow as a diagram, not as prose.**" paragraph, lines 61-72, and before the "**Link external references inline.**" paragraph)
- Modify: `README.md` (the walkthrough line at ~line 56, a new `### Prototypes` section inserted after the existing `### Flow diagrams` section and before `### Comparing versions`, and one new Roadmap line)

**Reuse:** Prose and structure of the existing `flow` documentation in each file — this task mirrors it, not reinvents it. `searched, none — NEW`: none of this is code; N/A.

**Interfaces:**
- Consumes: the `prototype` fence syntax fixed by Task 1/2 (`id:`, `height:`, `data-proto-id`, `data-proto-label`) and the `<fenceId>:el:<id>` anchor shape.
- Produces: nothing — this is the terminal task.

- [ ] **Step 1: Update the `comments[].anchors` bullet in `docs/PROTOCOL.md`**

Change lines 103-107 from:

```markdown
- `comments[].anchors` is present only when the comment is attached to a flow
  diagram rather than to a passage. It is a non-empty array of
  `<fenceId>:node:<id>` / `<fenceId>:edge:<src>-><dst>` values, each naming a
  statement in the matching ```` ```flow ```` fence, so you can find exactly what
  is being talked about. More than one entry means the reviewer box-selected a
  group and the comment is about all of them together. `quote` then holds the
  members' visible labels, for reading, not for locating. Absent on every prose
  comment, so an existing integration is unaffected.
```

to:

```markdown
- `comments[].anchors` is present only when the comment is attached to a flow
  diagram or a prototype element rather than to a passage. It is a non-empty
  array of `<fenceId>:node:<id>` / `<fenceId>:edge:<src>-><dst>` (flow) or
  `<fenceId>:el:<id>` (prototype) values, each naming a statement in the
  matching ```` ```flow ```` or ```` ```prototype ```` fence, so you can find
  exactly what is being talked about. More than one entry means the reviewer
  box-selected a group and the comment is about all of them together. `quote`
  then holds the members' visible labels, for reading, not for locating.
  Absent on every prose comment, so an existing integration is unaffected.
```

- [ ] **Step 2: Add a `## Prototypes` section to `docs/PROTOCOL.md`**

Insert this new section right after the `## Flow diagrams` section (immediately before `## Choice-conflict resolution`):

```markdown
## Prototypes

Embed a live, clickable screen with a `prototype` fence:

````markdown
```prototype
id: signup
height: 320
<style>.card{font:14px system-ui;padding:16px}</style>
<div class="card">
  <h2 data-proto-id="title">Create your account</h2>
  <input data-proto-id="email" placeholder="Email">
  <button data-proto-id="save" data-proto-label="Save button">Save</button>
</div>
```
````

- `id:` — required, like `flow` and `choice`. It namespaces this prototype's
  anchor ids.
- `height:` — optional, defaults to 400, clamped to 80–2000.
- Everything from the first non-`key: value` line down is the markup, verbatim
  — real HTML, CSS and (sandboxed) script.
- `data-proto-id="x"` marks an element targetable; the server expands it to
  `<fenceId>:el:x`. An element with no `data-proto-id` isn't targetable — the
  escape hatch for layout wrappers.
- `data-proto-label="…"` is the human name shown on the comment card; it
  defaults to the `data-proto-id` value.

The markup renders inside a sandboxed `<iframe>` (`allow-scripts`, deliberately
not `allow-same-origin`, so nothing inside it can reach this page). The
reviewer clicks an element to comment on it, and that comment comes back with
`anchors` (see **`submit`** above) exactly like a flow diagram's.

The frame also carries a fixed Content-Security-Policy that blocks every
URL-loaded subresource and all network egress: an image must be a `data:`
URI, there's no way to load a web font, and no script inside the frame can
reach the network. Inline CSS and inline script are unaffected.

A malformed block (no `id:`, or blank markup) falls back to rendering as plain
code, exactly as a malformed `choice` or `flow` does. So does a repeated
`id:` — the second (and later) fence reusing an already-used prototype id.
```

- [ ] **Step 3: Add a prototype paragraph to `integration/claude/plan-review/SKILL.md`**

Insert this new paragraph right after the "**Draw a flow as a diagram, not as prose.**" paragraph and before the "**Link external references inline.**" paragraph:

```markdown
**Show a screen as a live prototype, not a description.** When the plan
introduces a new UI, embed it as a `prototype` fence instead of describing it
in prose or ASCII. The reviewer clicks an element to comment on it, exactly as
they comment on a flow diagram's boxes:

```prototype
id: signup
height: 320
<div class="card">
  <h2 data-proto-id="title">Create your account</h2>
  <button data-proto-id="save" data-proto-label="Save button">Save</button>
</div>
```

`id:` is required and namespaces the prototype; `height:` is optional (default
400). Mark any element you want commentable with `data-proto-id="x"` — the
server turns it into a stable anchor. Comments on it come back with an
`anchors` list, same as a flow diagram's. The frame's CSP means an image must
be a `data:` URI — no web fonts, no network calls.
```

- [ ] **Step 4: Update the walkthrough line and add a `### Prototypes` section to `README.md`**

Change:

```markdown
3. You select text and leave inline comments, click a box or an arrow in any
   flow diagram to comment on that, answer any choice blocks the plan embeds,
   and can chat with the agent in a sidebar about anything — related to the
   document or not.
```

to:

```markdown
3. You select text and leave inline comments, click a box or an arrow in any
   flow diagram (or an element in a live prototype) to comment on that, answer
   any choice blocks the plan embeds, and can chat with the agent in a sidebar
   about anything — related to the document or not.
```

Then insert this new section right after the existing `### Flow diagrams` section and before `### Comparing versions`:

```markdown
### Prototypes

Plans can embed a live, clickable screen with a `prototype` fence:

````markdown
```prototype
id: signup
height: 320
<div class="card">
  <h2 data-proto-id="title">Create your account</h2>
  <input data-proto-id="email" placeholder="Email">
  <button data-proto-id="save" data-proto-label="Save button">Save</button>
</div>
```
````

The markup renders in a sandboxed frame — real HTML, CSS and (sandboxed)
script — and the reviewer clicks a `data-proto-id`-marked element to comment on
it directly. Comments carry an `anchors` list in the submit bundle naming
exactly which element they're about, and survive a rework round the same way a
flow diagram's do: a comment archives (never disappears) once the element it
named is gone.

The frame carries a fixed CSP: inline CSS and inline script work, but every
URL-loaded subresource and all network egress is blocked — an image needs to
be a `data:` URI, and there's no way to pull in a web font.
```

- [ ] **Step 5: Add a Roadmap line to `README.md`**

Change:

```markdown
- [x] Flow diagrams with commentable boxes and arrows
```

to:

```markdown
- [x] Flow diagrams with commentable boxes and arrows
- [x] Inline prototypes — a live, clickable screen the reviewer can comment on element by element
```

- [ ] **Step 6: Run the full suite one last time**

Run: `npm test`
Expected: PASS — docs changes don't touch any tested code path, so this is a final confirmation nothing else broke.

- [ ] **Step 7: Commit**

```bash
git add docs/PROTOCOL.md integration/claude/plan-review/SKILL.md README.md
git commit -m "docs: document the prototype fence"
```
