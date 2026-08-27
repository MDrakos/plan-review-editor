'use strict';

// The ```prototype fence: agent-authored markup rendered into a sandboxed,
// click-to-comment iframe, with its targetable elements' ids mirrored outside
// the frame as anchor stubs. server/markdown.js dispatches to renderPrototype;
// server/anchor.js's idAnchors carries comments forward on those stubs exactly
// as it does for flow.js's <g> anchors.

const { escapeHtml } = require('./escapehtml');

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
      const raw = kv[2].trim();
      const n = Number(raw);
      if (raw && Number.isFinite(n)) height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n));
    }
  }
  const markup = lines.slice(i).join('\n');
  if (!id || !ID_RE.test(id) || !markup.trim()) return null;
  return { id, height, markup };
}

const blank = (s) => s.replace(/[^\n]/g, ' ');

// Blank out the body of every <tagName>...</tagName> in `markup`, keeping the
// open/close tags and every other character's position the same.
function blankTagBody(markup, tagName) {
  // The open tag's own attributes are quote-aware for the same reason `tagEnd`
  // is: a `>` inside one is not the end of the tag.
  const re = new RegExp(
    `(<${tagName}\\b(?:"[^"]*"|'[^']*'|[^>])*>)([\\s\\S]*?)(</${tagName}>)`,
    'gi'
  );
  return markup.replace(re, (m, open, body, close) => open + blank(body) + close);
}

// Blank out the interior of protected regions — HTML comments and the raw-text
// element bodies below — while keeping every other character's position the
// same, so a later tag scan can never mistake text inside them (a JS string
// literal, a code sample, a CSS comment, a placeholder label) for a real
// attribute on a real tag.
// lazydev: this is a regex mask, not an HTML parser — a masked element whose
// own opening tag is malformed enough to confuse `[^>]*` can still slip past
// it. Upgrading past that means a real tokenizer here instead of regexes.
function maskProtected(markup) {
  let out = markup.replace(/<!--[\s\S]*?-->/g, blank);
  for (const tag of ['pre', 'script', 'style', 'textarea', 'title']) out = blankTagBody(out, tag);
  return out;
}

// Find the `>` that closes the tag starting at `start` (its `<`), tracking
// quoted attribute values so a `>` inside one (e.g. title="a > b") doesn't end
// the tag early. A quote only opens a value when it follows `=`, so an
// apostrophe in an unquoted value stays ordinary text. Returns -1 for a tag
// whose quote never closes.
function tagEnd(text, start) {
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && /=\s*$/.test(text.slice(start, i))) {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

// Call fn(tagText, index) for every real tag in `markup` — scanned over a
// masked copy (so nothing inside a comment/<pre>/<script>/<style> body is
// mistaken for a real tag) but handed the original text at the same offset,
// in document order. Shared by scanStubs and rewriteMarkup so they can never
// disagree on what counts as a tag.
// Returns false when a tag's quote never closes: the tail is then unscanned, so
// callers must discard the whole fence rather than emit half-rewritten markup
// in which a forged data-anchor-id would survive.
function forEachTag(markup, fn) {
  const masked = maskProtected(markup);
  const openRe = /<[a-zA-Z]/g;
  let m;
  while ((m = openRe.exec(masked))) {
    const end = tagEnd(masked, m.index);
    if (end === -1) return false;
    fn(markup.slice(m.index, end + 1), m.index);
    openRe.lastIndex = end + 1;
  }
  return true;
}

// Scan `markup` for every real tag carrying data-proto-id="x" and build the
// stub list: one entry per distinct id, first tag wins, and within one tag
// its first data-proto-id attribute wins if it carries more than one. A
// missing data-proto-label defaults the label to the id.
function scanStubs(markup, fenceId) {
  const seen = new Set();
  const stubs = [];
  forEachTag(markup, (tag) => {
    const idMatch = tag.match(/\bdata-proto-id="([^"]*)"/);
    if (!idMatch || !idMatch[1] || seen.has(idMatch[1])) return;
    seen.add(idMatch[1]);
    const label = tag.match(/\bdata-proto-label="([^"]*)"/);
    stubs.push({ id: idMatch[1], label: label ? label[1] : idMatch[1], anchorId: `${fenceId}:el:${idMatch[1]}` });
  });
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
  if (!/(?<![\w-])tabindex\s*=/i.test(out)) out = out.replace(/^<([a-zA-Z][^\s>]*)/, '<$1 tabindex="0"');
  const anchorId = escapeHtml(`${fenceId}:el:${idMatch[1]}`);
  return out.replace(/\/?>$/, (close) => ` data-anchor-id="${anchorId}"${close}`);
}

// Apply rewriteTag to every real tag in `markup`, leaving comment/<pre>/
// <script>/<style> bodies untouched.
// Null when the scan could not finish — see forEachTag.
function rewriteMarkup(markup, fenceId) {
  let out = '';
  let last = 0;
  const ok = forEachTag(markup, (tag, index) => {
    out += markup.slice(last, index) + rewriteTag(tag, fenceId);
    last = index + tag.length;
  });
  return ok ? out + markup.slice(last) : null;
}

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

// Click, or Enter/Space on the nearest [data-anchor-id], reports {anchorId,
// rect} to the parent; a 'proto-commented' message back marks that element as
// carrying a thread. '*' is the only possible postMessage target origin in
// both directions, since the sandboxed frame's own origin is opaque.
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
  const asCode = () => `<pre><code class="language-prototype">${escapeHtml(body)}</code></pre>`;
  const parsed = parseHeader(body);
  if (!parsed || (usedIds && usedIds.has(parsed.id))) return asCode();
  const { id, height, markup } = parsed;
  // Markup the tag scanner cannot finish is shown as code rather than rendered:
  // a half-rewritten frame would carry through any data-anchor-id it never
  // reached, letting the markup point a comment at an element it does not own.
  const rewritten = rewriteMarkup(markup, id);
  if (rewritten === null) return asCode();
  if (usedIds) usedIds.add(parsed.id);
  const stubs = scanStubs(markup, id);
  const inner = CSP_META + BASE_STYLE + `<script>${SHIM}</script>` + rewritten;
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

  // an empty height: value must not be coerced by Number('') === 0 into the
  // minimum — it falls back to the default like any other non-numeric value
  assert.strictEqual(parseHeader('id: signup\nheight:\n<div>hi</div>').height, 400, 'blank height falls back to the default, not 0/MIN_HEIGHT');
  assert.strictEqual(parseHeader('id: signup\nheight:   \n<div>hi</div>').height, 400, 'whitespace-only height falls back to the default too');

  // malformed: no id, blank markup, two id: lines, an id with invalid characters
  assert.strictEqual(parseHeader('<div>hi</div>'), null, 'no id: line');
  assert.strictEqual(parseHeader('id: signup\n   \n'), null, 'blank markup');
  assert.strictEqual(parseHeader('id: a\nid: b\n<div>hi</div>'), null, 'two id: lines');
  assert.strictEqual(parseHeader('id: my signup\n<div>hi</div>'), null, 'id with a space');

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

  // an unrelated attribute merely ending in "-tabindex" must not be mistaken
  // for a real tabindex attribute
  assert.ok(
    /tabindex="0"/.test(rewriteMarkup('<div data-proto-id="x" data-tabindex="a">hi</div>', 'signup')),
    'a data-tabindex attribute must not block tabindex="0" injection'
  );

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

  // a data-proto-id occurrence inside a <style> body is never rewritten either
  const styleMarkup = '<style>/* <b data-proto-id="ghost4">not real</b> */</style>';
  assert.strictEqual(
    (rewriteMarkup(styleMarkup, 'signup').match(/data-anchor-id=/g) || []).length,
    0,
    'nothing inside a <style> body is treated as a real attribute'
  );

  // <textarea> and <title> are raw-text elements too: a data-proto-id-shaped
  // substring inside either is markup-as-text the reader typed, not a real tag
  const textareaMarkup = '<textarea>note: <div data-proto-id="ghost5">x</div></textarea>';
  assert.strictEqual(
    (rewriteMarkup(textareaMarkup, 'signup').match(/data-anchor-id=/g) || []).length,
    0,
    'nothing inside a <textarea> body is treated as a real attribute'
  );
  const titleMarkup = '<title>a <span data-proto-id="ghost6">page</span></title>';
  assert.strictEqual(
    (rewriteMarkup(titleMarkup, 'signup').match(/data-anchor-id=/g) || []).length,
    0,
    'nothing inside a <title> body is treated as a real attribute'
  );

  // a masked element's own opening tag can carry a `>` in a quoted attribute
  // too; ending its open tag there swallows the rest of the markup and drops
  // every real target after it
  for (const m of [
    '<pre title="a>b">x</pre>',
    '<pre title="</pre>">x</pre>',
    '<style media="a>b">.c{}</style>',
    '<script data-x="a>b">var v = 1;</script>',
    '<textarea placeholder="a>b">z</textarea>',
  ]) {
    assert.ok(
      /data-anchor-id="signup:el:real"/.test(
        rewriteMarkup(`${m}<div data-proto-id="real">y</div>`, 'signup')
      ),
      `a target after ${m} is still rewritten`
    );
  }

  // a `>` inside a quoted attribute value is ordinary authored content (a label
  // reading "greater than"), not a tag boundary — the scanner must not stop
  // there, whether the targeted attribute comes before or after it
  // a quote only opens an attribute value when it follows `=`; an apostrophe in
  // an unquoted value is ordinary text and must not desync the scan
  const apos = renderPrototype(
    'id: t\n<div title=it\'s>trigger</div><button data-proto-id="save">S</button>'
  );
  assert.ok(apos.includes('t:el:save'), 'an apostrophe in an unquoted value does not abort the scan');
  const aposForged = rewriteMarkup(
    '<div title=it\'s>t</div><button data-anchor-id="signup:el:save" data-proto-id="ok">F</button>',
    'signup'
  );
  assert.ok(
    !aposForged.includes('data-anchor-id="signup:el:save"'),
    'a forged data-anchor-id after an apostrophe is still stripped'
  );

  // a tag the scanner genuinely cannot finish makes the whole fence fall back to
  // a code block: emitting half-scanned markup would ship unstripped anchors
  const unscannable = renderPrototype(
    'id: t\n<button data-anchor-id=@t:el:forged@ data-proto-id="ok">F</button><div title=@never closed>'.replace(
      /@/g,
      '"'
    )
  );
  assert.ok(unscannable.startsWith('<pre><code'), 'an unscannable fence falls back to a code block');
  assert.ok(!/data-anchor-id="t:el:forged"/.test(unscannable), 'no live forged anchor is emitted');

  const gtAfterTarget = renderPrototype('id: t\n<div data-proto-id="x" title="a > b">hi</div>');
  assert.ok(gtAfterTarget.includes('data-anchor-id=&quot;t:el:x&quot;'), 'the anchor still lands on the element');
  assert.ok(!/ b&quot;&gt;/.test(gtAfterTarget), 'the rest of the quoted attribute must not leak out as its own text');
  const gtBeforeTarget = renderPrototype('id: t\n<div title="a > b" data-proto-id="save">hi</div>');
  assert.ok(
    gtBeforeTarget.includes('data-anchor-id=&quot;t:el:save&quot;'),
    'a quoted > before the target attribute must not drop the target silently'
  );

  // an unterminated quote must never hang or run away scanning the rest of the
  // document — it just means that one tag has no discoverable end
  const before = Date.now();
  const unterminated = renderPrototype(
    'id: t\n<div data-proto-id="x" title="unterminated>hi</div><button data-proto-id="save">Save</button>'
  );
  assert.ok(Date.now() - before < 2000, 'an unterminated quote must not hang the scanner');
  assert.ok(typeof unterminated === 'string');

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

  // the shim must not carry dead code clearing a .selected class nothing in
  // this feature ever adds
  assert.ok(!/querySelectorAll\('\.selected'\)/.test(SHIM), 'the shim has no handling for a class nothing sets');

  // two prototype fences sharing an id: the second falls back to a plain
  // code block, exactly like a missing id: does
  const usedIds = new Set();
  const first = renderPrototype('id: signup\n<button data-proto-id="save">Save</button>', usedIds);
  const second = renderPrototype('id: signup\n<button data-proto-id="cancel">Cancel</button>', usedIds);
  assert.ok(first.includes('sandbox="allow-scripts"'));
  assert.ok(second.startsWith('<pre><code class="language-prototype">'), 'a reused id falls back to a code block');

  // malformed fence falls back to a plain code block, like choice/flow
  assert.ok(renderPrototype('no id here').startsWith('<pre><code class="language-prototype">'));

  console.log('prototype.js self-check ok');
}
