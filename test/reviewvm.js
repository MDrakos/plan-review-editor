'use strict';

// A zero-dependency mini-DOM plus a VM loader for public/review.js, so the
// code-review UI is testable in-process the way test/e2e.js already tests the
// plan UI (buildLivenessVm).
//
// Why a second harness rather than lifting buildLivenessVm out of test/e2e.js:
// that shim's elements are hollow — `append` is a no-op, `querySelector` hands
// back a fresh orphan every call, and nothing is ever a child of anything. That
// is enough for app.js, which only reads and writes a handful of known nodes by
// id, and nowhere near enough for review.js, which BUILDS the diff table and
// then finds its way around it with `td.ln.anchor[data-file=…]` and
// `closest('tr')`. Making the liveness shim real enough for that means changing
// the shim under 4000 lines of passing plan tests. So: a real (tiny) tree here,
// e2e.js untouched. If a third page ever needs a DOM, move THIS one.
//
// Scope is deliberately the selectors review.js actually uses — simple compound
// selectors only (`tag`, `.class`, `#id`, `[attr="value"]`, and combinations).
// No combinators, no pseudo-classes: there are none in review.js, and an
// unsupported selector is better as a loud wrong answer than a quiet one.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- nodes ----------

class TextNode {
  constructor(text) {
    this.nodeValue = String(text);
    this.parentNode = null;
  }
  get textContent() {
    return this.nodeValue;
  }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.className = '';
    this.id = '';
    this._listeners = {};
  }

  // ----- classes -----
  get _classes() {
    return this.className.split(/\s+/).filter(Boolean);
  }
  get classList() {
    const self = this;
    return {
      add(...names) {
        const set = new Set(self._classes);
        for (const n of names) set.add(n);
        self.className = [...set].join(' ');
      },
      remove(...names) {
        self.className = self._classes.filter((c) => !names.includes(c)).join(' ');
      },
      contains: (n) => self._classes.includes(n),
      toggle(n, force) {
        const on = force === undefined ? !self._classes.includes(n) : Boolean(force);
        if (on) this.add(n);
        else this.remove(n);
        return on;
      },
    };
  }

  // ----- text -----
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.append(String(v));
  }
  // review.js only reaches for innerHTML behind a highlight.js guard, and hljs
  // is absent here, so this exists to be assignable, not to parse.
  set innerHTML(v) {
    this.textContent = v;
  }
  get innerHTML() {
    return this.textContent;
  }

  // ----- tree -----
  _adopt(n) {
    const node = typeof n === 'string' ? new TextNode(n) : n;
    if (node.parentNode) node.remove();
    node.parentNode = this;
    return node;
  }
  append(...nodes) {
    for (const n of nodes) this.childNodes.push(this._adopt(n));
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  replaceChildren(...nodes) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  insertBefore(node, ref) {
    const adopted = this._adopt(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) this.childNodes.push(adopted);
    else this.childNodes.splice(i, 0, adopted);
    return adopted;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i !== -1) {
      this.childNodes.splice(i, 1);
      n.parentNode = null;
    }
    return n;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }

  // ----- attributes -----
  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
    else if (name === 'class') this.className = String(value);
    else if (name === 'id') this.id = String(value);
    else this.attributes[name] = String(value);
  }
  getAttribute(name) {
    if (name.startsWith('data-')) {
      const v = this.dataset[dataKey(name)];
      return v === undefined ? null : String(v);
    }
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    const v = this.attributes[name];
    return v === undefined ? null : v;
  }

  // ----- queries -----
  matches(selector) {
    return matchesParsed(this, parseSelector(selector));
  }
  closest(selector) {
    const sel = parseSelector(selector);
    for (let n = this; n; n = n.parentNode) if (n instanceof Element && matchesParsed(n, sel)) return n;
    return null;
  }
  querySelectorAll(selector) {
    const sel = parseSelector(selector);
    const out = [];
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (!(child instanceof Element)) continue;
        if (matchesParsed(child, sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  // ----- events -----
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type] || [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }
  // test-only: run this element's own handlers for `type` (no bubbling — the
  // handlers review.js attaches to elements are all direct).
  dispatch(type, extra) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of [...(this._listeners[type] || [])]) fn(ev);
    return ev;
  }

  // ----- no-ops the page calls for real browser behaviour -----
  focus() {}
  blur() {}
  scrollIntoView() {}
  setSelectionRange() {}
  requestSubmit() {
    this.dispatch('submit');
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }
}

const dataKey = (attr) => attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// `tag`, `.class`, `#id`, `[attr]`, `[attr="v"]` — in any combination, one
// compound only. Cached: renderAll runs these on every row.
const selCache = new Map();
function parseSelector(selector) {
  if (selCache.has(selector)) return selCache.get(selector);
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|\.([\w-]+)|#([\w-]+)|([a-zA-Z][\w-]*)/g;
  let m;
  let matchedAny = false;
  while ((m = re.exec(selector))) {
    matchedAny = true;
    if (m[1]) out.attrs.push([m[1], m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : null]);
    else if (m[5]) out.classes.push(m[5]);
    else if (m[6]) out.id = m[6];
    else if (m[7]) out.tag = m[7].toLowerCase();
  }
  if (!matchedAny || /[\s>+~:]/.test(selector.trim()))
    throw new Error(`reviewvm mini-DOM: unsupported selector ${JSON.stringify(selector)}`);
  selCache.set(selector, out);
  return out;
}

function matchesParsed(el, sel) {
  if (sel.tag && el.tagName !== sel.tag.toUpperCase()) return false;
  if (sel.id && el.id !== sel.id) return false;
  for (const c of sel.classes) if (!el._classes.includes(c)) return false;
  for (const [name, value] of sel.attrs) {
    const actual = el.getAttribute(name);
    if (actual === null) return false;
    if (value !== null && actual !== value) return false;
  }
  return true;
}

// ---------- the document ----------

function createDocument() {
  // Everything getElementById hands out lives under one root, so a
  // document-level querySelectorAll can see the whole page the way a browser's
  // does. review.html's static chrome (.view-btn, .split-item) is not modelled:
  // those selectors legitimately come back empty here.
  const root = new Element('body');
  const byId = new Map();
  const listeners = {};
  const document = {
    documentElement: Object.assign(new Element('html'), {
      style: { setProperty() {}, removeProperty() {} },
    }),
    title: '',
    getElementById(id) {
      if (!byId.has(id)) {
        const el = new Element('div');
        el.id = id;
        root.append(el);
        byId.set(id, el);
      }
      return byId.get(id);
    },
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    // test-only: fire a document-level handler with `target` as the event target.
    dispatch(type, target, extra) {
      const ev = { type, target, preventDefault() {}, stopPropagation() {}, ...extra };
      for (const fn of [...(listeners[type] || [])]) fn(ev);
      return ev;
    },
    _root: root,
  };
  return document;
}

// ---------- the VM ----------

// `respond(url, init)` answers every fetch: return a response-ish object, or a
// promise of one, which is how the out-of-order test holds a read open.
function buildReviewVm({ respond, storage, session = 'abc' }) {
  const document = createDocument();
  const fetches = [];
  let es = null;
  let tid = 1;
  const timers = new Map();

  const okJson = (v) => ({ ok: true, status: 200, json: () => Promise.resolve(v) });

  const ctx = vm.createContext({
    window: {},
    document,
    location: { pathname: `/r/${session}` },
    EventSource: function (url) {
      es = {
        _url: url,
        _h: {},
        addEventListener(type, fn) {
          this._h[type] = fn;
        },
      };
      return es;
    },
    fetch: (url, init) => {
      fetches.push(url);
      return Promise.resolve(respond(url, init)).then((r) => (r && r.json ? r : okJson(r)));
    },
    setInterval: (fn, ms) => {
      const id = tid++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn) => {
      const id = tid++;
      timers.set(id, { fn, ms: 0 });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    crypto: { randomUUID: () => `shim-uuid-${tid++}` },
    localStorage: (() => {
      const m = storage || new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
    Date,
    Map,
    Set,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Boolean,
    Error,
    console,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
  });

  const load = (file) =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), ctx, { filename: file });

  const flush = async () => {
    for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
  };

  return {
    ctx,
    document,
    load,
    flush,
    fetches,
    el: (id) => document.getElementById(id),
    fire: (type, data) => es && es._h[type] && es._h[type]({ data: JSON.stringify(data) }),
    get es() {
      return es;
    },
  };
}

// Boot the real page: liveness.js then review.js, as review.html loads them.
async function bootReview(opts) {
  const h = buildReviewVm(opts);
  h.load('liveness.js');
  h.load('review.js'); // calls boot() on load
  await h.flush();
  return h;
}

module.exports = { Element, TextNode, createDocument, buildReviewVm, bootReview, parseSelector };

// Self-check for the selector engine itself — the one piece of real logic in
// here, and the piece every assertion below it depends on being right.
if (require.main === module) {
  const assert = require('assert');
  const doc = createDocument();
  const tr = doc.createElement('tr');
  const td = doc.createElement('td');
  td.className = 'ln new';
  td.classList.add('anchor');
  td.dataset.file = 'a/b.js';
  td.dataset.side = 'new';
  td.dataset.line = '12';
  tr.append(td);
  doc.getElementById('files').append(tr);

  assert.strictEqual(doc.querySelectorAll('td.ln.anchor').length, 1);
  assert.strictEqual(doc.querySelector('td.ln.anchor[data-file="a/b.js"][data-side="new"][data-line="12"]'), td);
  assert.strictEqual(doc.querySelector('td.ln.anchor[data-line="13"]'), null);
  assert.strictEqual(td.closest('tr'), tr);
  assert.strictEqual(doc.querySelectorAll('tr.composer-row').length, 0);
  tr.classList.add('composer-row');
  assert.strictEqual(doc.querySelectorAll('tr.composer-row').length, 1);
  tr.classList.remove('composer-row');
  assert.strictEqual(doc.querySelectorAll('tr.composer-row').length, 0);

  const p = doc.createElement('p');
  p.textContent = 'hello';
  const s = doc.createElement('span');
  s.textContent = ' world';
  p.append(s);
  assert.strictEqual(p.textContent, 'hello world');

  const host = doc.createElement('div');
  const a = doc.createElement('i');
  const b = doc.createElement('i');
  host.append(a, b);
  assert.strictEqual(a.nextSibling, b);
  host.insertBefore(doc.createElement('em'), b);
  assert.strictEqual(host.children.map((x) => x.tagName).join(','), 'I,EM,I');
  a.remove();
  assert.strictEqual(host.children.length, 2);
  host.replaceChildren(doc.createElement('u'));
  assert.strictEqual(host.children.length, 1);

  assert.throws(() => parseSelector('div p'), /unsupported selector/);
  console.log('ok  reviewvm mini-DOM self-check');
}
