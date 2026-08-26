'use strict';

// The ```flow fence: a small flow diagram the reviewer can click a box or an
// arrow in to leave a comment. Parsed, laid out and emitted as inline SVG here;
// server/markdown.js dispatches to renderFlow, and the anchor ids emitted on
// each <g> are what server/anchor.js carries comments forward on.
//
// Layered top to bottom, fixed box size, no physics and no layout library —
// a plan's flow is a dozen boxes, not a graph database.

const { escapeHtml } = require('./escapehtml');

const NODE_TOKEN = /^([A-Za-z0-9_-]+)(?:\[([^\]]*)\])?$/;

// Parse a fence body into { id, nodes: [{id,label}], edges: [{src,dst,label,key}] },
// or null when it is malformed: no `id:`, no statements, or any unparseable line.
// A null sends renderFlow to the plain-code fallback, exactly as renderChoice does.
function parseFlow(body) {
  let fenceId = '';
  const labels = new Map(); // id -> label; the first bracketed mention wins
  const order = [];
  const edges = [];
  const pairSeen = new Map();

  const node = (token) => {
    const m = token.trim().match(NODE_TOKEN);
    if (!m) return null;
    const id = m[1];
    // A reserved id would poison the Maps' prototype, as parseChoiceSpecs guards against.
    if (id === '__proto__') return null;
    const label = m[2] != null && m[2].trim() ? m[2].trim() : '';
    if (!labels.has(id)) {
      labels.set(id, label || id);
      order.push(id);
    } else if (label && labels.get(id) === id) {
      labels.set(id, label);
    }
    return id;
  };

  for (const raw of String(body).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const kv = line.match(/^id:\s*([A-Za-z0-9_-]+)$/);
    if (kv) {
      if (fenceId) return null; // two id: lines
      if (kv[1] === '__proto__') return null;
      fenceId = kv[1];
      continue;
    }
    const arrow = line.match(/^(.+?)\s*->\s*(.+)$/);
    if (arrow) {
      let rest = arrow[2];
      let label = '';
      const ci = rest.indexOf(':');
      if (ci !== -1) {
        label = rest.slice(ci + 1).trim();
        rest = rest.slice(0, ci).trim();
      }
      const src = node(arrow[1]);
      const dst = node(rest);
      if (!src || !dst) return null;
      const pair = `${src}->${dst}`;
      const n = (pairSeen.get(pair) || 0) + 1;
      pairSeen.set(pair, n);
      edges.push({ src, dst, label, key: n === 1 ? pair : `${pair}#${n}` });
      continue;
    }
    if (!node(line)) return null; // a bare node declaration, or garbage
  }

  if (!fenceId || !order.length) return null;
  return { id: fenceId, nodes: order.map((id) => ({ id, label: labels.get(id) })), edges };
}

// ---------- layout ----------

const BOX_W = 168;
const BOX_H = 46;
const H_GAP = 32;
const V_GAP = 76;
const PAD = 24;
const CHAR_W = 6.9; // 13px sans, estimated — there are no text metrics server-side

// Wrap a label into at most two lines that fit BOX_W, truncating the second.
function wrapLabel(label) {
  const max = Math.floor((BOX_W - 20) / CHAR_W);
  if (label.length <= max) return [label];
  const lines = [''];
  for (const w of label.split(/\s+/)) {
    const cand = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w;
    if (cand.length <= max) lines[lines.length - 1] = cand;
    else if (lines.length < 2) lines.push(w);
    else break;
  }
  if (lines[1] && lines[1].length > max) lines[1] = lines[1].slice(0, max - 1) + '…';
  return lines.filter(Boolean);
}

// An edge is a BACK edge when its destination first appears before its source.
// The forward edges therefore form a DAG in first-appearance order, so one pass
// in that order computes the longest-path layer for every node — and a cycle
// simply stops raising layers instead of looping forever.
function layout(spec) {
  const idx = new Map(spec.nodes.map((n, i) => [n.id, i]));
  for (const e of spec.edges) e.back = idx.get(e.dst) < idx.get(e.src);

  const layer = new Map(spec.nodes.map((n) => [n.id, 0]));
  for (const n of spec.nodes)
    for (const e of spec.edges)
      if (!e.back && e.dst === n.id)
        layer.set(n.id, Math.max(layer.get(n.id), layer.get(e.src) + 1));

  const rows = [];
  for (const n of spec.nodes) {
    const L = layer.get(n.id);
    (rows[L] || (rows[L] = [])).push(n);
  }
  const rowW = rows.map((r) => r.length * BOX_W + (r.length - 1) * H_GAP);
  const width = Math.max(...rowW) + PAD * 2;
  const height = rows.length * BOX_H + (rows.length - 1) * V_GAP + PAD * 2;

  const pos = new Map();
  rows.forEach((row, L) => {
    let x = (width - rowW[L]) / 2;
    for (const n of row) {
      pos.set(n.id, { x, y: PAD + L * (BOX_H + V_GAP), layer: L });
      x += BOX_W + H_GAP;
    }
  });
  return { pos, layer, width, height };
}

// An edge between adjacent layers drops straight down. Anything else — a back
// edge, or a forward edge spanning more than one layer — would cut through the
// boxes in between, so it bows out past the side of the whole diagram instead.
function edgePath(e, pos, ext) {
  const s = pos.get(e.src);
  const d = pos.get(e.dst);
  if (d.layer - s.layer === 1) {
    const sx = s.x + BOX_W / 2;
    const dx = d.x + BOX_W / 2;
    const sy = s.y + BOX_H;
    const dy = d.y;
    const c = (dy - sy) / 2;
    return {
      d: `M ${sx} ${sy} C ${sx} ${sy + c}, ${dx} ${dy - c}, ${dx} ${dy}`,
      mid: { x: (sx + dx) / 2, y: (sy + dy) / 2 },
      anchor: 'middle',
    };
  }
  const left = (s.x + d.x) / 2 + BOX_W / 2 < (ext.minX + ext.maxX) / 2;
  const bow = left ? ext.minX - 44 : ext.maxX + 44;
  const sx = left ? s.x : s.x + BOX_W;
  const dx = left ? d.x : d.x + BOX_W;
  const sy = s.y + BOX_H / 2;
  const dy = d.y + BOX_H / 2;
  return {
    d: `M ${sx} ${sy} C ${bow} ${sy}, ${bow} ${dy}, ${dx} ${dy}`,
    mid: { x: bow + (left ? 8 : -8), y: (sy + dy) / 2 },
    anchor: left ? 'start' : 'end',
    bowX: bow,
  };
}

const TOOLS =
  '<div class="flow-tools">' +
  '<button type="button" data-mode="select" aria-pressed="false" title="Box-select a group (or hold Shift and drag)" aria-label="Box select">Box</button>' +
  '<button type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>' +
  '<button type="button" data-zoom="reset" title="Reset view" aria-label="Reset view">Fit</button>' +
  '<button type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>' +
  '</div>' +
  '<div class="flow-hint">drag to pan · Box (or shift-drag) to select a group · ⌘/ctrl + scroll to zoom · double-click to fit</div>';

function renderFlow(body) {
  const spec = parseFlow(body);
  if (!spec) return `<pre><code class="language-flow">${escapeHtml(body)}</code></pre>`;
  const { pos, width, height } = layout(spec);
  const arrow = `flow-arrow-${spec.id}`;
  const out = [];

  // Box extents first, then the edge paths, then the viewBox: a bowed edge can
  // reach outside the boxes, and sizing off the boxes alone clips it.
  const ps = [...pos.values()];
  const ext = {
    minX: Math.min(...ps.map((p) => p.x)),
    maxX: Math.max(...ps.map((p) => p.x + BOX_W)),
  };
  const paths = spec.edges.map((e) => edgePath(e, pos, ext));
  const bows = paths.filter((p) => p.bowX != null).map((p) => p.bowX);
  const vx = Math.min(0, ...bows.map((b) => b - 24));
  const vw = Math.max(width, ...bows.map((b) => b + 24)) - vx;

  out.push(`<div class="flow-block" data-flow-id="${escapeHtml(spec.id)}">`);
  out.push(TOOLS);
  out.push(
    `<svg class="flow-svg" viewBox="${vx} 0 ${vw} ${height}" width="${vw}" height="${height}" role="img" aria-label="Flow diagram">`
  );
  out.push(
    `<defs><marker id="${escapeHtml(arrow)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>`
  );
  // Everything drawable lives in one <g> so pan/zoom is a single transform on it.
  // <defs> stays outside: markers are referenced, not drawn in place.
  out.push('<g class="flow-pan">');

  const labelOf = (id) => spec.nodes.find((n) => n.id === id).label;

  spec.edges.forEach((e, ei) => {
    const p = paths[ei];
    const aid = `${spec.id}:edge:${e.key}`;
    const sl = labelOf(e.src);
    const dl = labelOf(e.dst);
    out.push(
      `<g class="flow-edge${e.back ? ' back' : ''}" data-anchor-id="${escapeHtml(aid)}" data-label="${escapeHtml(`${sl} → ${dl}`)}" tabindex="0" role="button" aria-label="arrow, ${escapeHtml(sl)} to ${escapeHtml(dl)}">`
    );
    // Three paths: a fat transparent strip so a thin line is clickable, a halo a
    // commented edge tints (it has no fill to tint), and the line itself.
    out.push(`<path class="flow-hit" d="${p.d}"/>`);
    out.push(`<path class="flow-halo" d="${p.d}"/>`);
    out.push(`<path class="flow-line" d="${p.d}" marker-end="url(#${escapeHtml(arrow)})"/>`);
    if (e.label)
      out.push(
        `<text class="flow-edge-label" x="${p.mid.x}" y="${p.mid.y}" text-anchor="${p.anchor}" dominant-baseline="middle">${escapeHtml(e.label)}</text>`
      );
    out.push('</g>');
  });

  for (const n of spec.nodes) {
    const p = pos.get(n.id);
    const aid = `${spec.id}:node:${n.id}`;
    const lines = wrapLabel(n.label);
    const y0 = p.y + BOX_H / 2 - (lines.length - 1) * 8;
    out.push(
      `<g class="flow-node" data-anchor-id="${escapeHtml(aid)}" data-label="${escapeHtml(n.label)}" tabindex="0" role="button" aria-label="${escapeHtml(n.label)}">`
    );
    out.push(
      `<rect class="flow-box" x="${p.x}" y="${p.y}" width="${BOX_W}" height="${BOX_H}" rx="8"/>`
    );
    lines.forEach((ln, i) => {
      out.push(
        `<text class="flow-node-label" x="${p.x + BOX_W / 2}" y="${y0 + i * 16}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(ln)}</text>`
      );
    });
    out.push('</g>');
  }

  out.push('</g></svg></div>');
  return out.join('');
}

module.exports = { parseFlow, layout, renderFlow };

// ---------- self-check ----------

if (require.main === module) {
  const assert = require('assert');
  const layersOf = (src) => {
    const spec = parseFlow(src);
    return Object.fromEntries(layout(spec).layer);
  };

  // parsing
  const spec = parseFlow('id: rl\na[Incoming] -> b[Token bucket]: 1 token\nb -> c\nlone');
  assert.strictEqual(spec.id, 'rl');
  assert.deepStrictEqual(
    spec.nodes.map((n) => `${n.id}=${n.label}`),
    ['a=Incoming', 'b=Token bucket', 'c=c', 'lone=lone']
  );
  assert.deepStrictEqual(
    spec.edges.map((e) => `${e.key}|${e.label}`),
    ['a->b|1 token', 'b->c|']
  );

  // a label given on a later mention still wins over the bare id
  assert.strictEqual(parseFlow('id: x\na -> b\nb[Later] -> c').nodes[1].label, 'Later');

  // repeated edges between the same pair get #2, #3 by order of appearance
  assert.deepStrictEqual(
    parseFlow('id: x\na -> b\na -> b\na -> b').edges.map((e) => e.key),
    ['a->b', 'a->b#2', 'a->b#3']
  );

  // malformed: no id, no statements, a bad token, two ids, a reserved id
  for (const bad of [
    'a -> b',
    'id: x',
    'id: x\na b c -> d',
    'id: x\nid: y\na -> b',
    'id: x\n__proto__ -> b',
    'id: __proto__\na -> b',
  ])
    assert.strictEqual(parseFlow(bad), null, `expected malformed: ${JSON.stringify(bad)}`);

  // layering: longest path, not shortest
  assert.deepStrictEqual(layersOf('id: x\na -> b\nb -> c\na -> c'), { a: 0, b: 1, c: 2 });
  // a back edge does not raise anything, and a cycle terminates
  assert.deepStrictEqual(layersOf('id: x\na -> b\nb -> c\nc -> a'), { a: 0, b: 1, c: 2 });
  const backSpec = parseFlow('id: x\na -> b\nb -> a');
  layout(backSpec);
  assert.deepStrictEqual(
    backSpec.edges.map((e) => e.back),
    [false, true]
  );

  // rendering: ids on the <g>s, one pan group, escaping, code fallback
  const html = renderFlow('id: rl\na[A & B] -> b[<hi>]: x"y');
  assert.ok(html.includes('data-anchor-id="rl:node:a"'));
  assert.ok(html.includes('data-anchor-id="rl:node:b"'));
  assert.ok(html.includes('data-anchor-id="rl:edge:a-&gt;b"'));
  assert.strictEqual(html.match(/class="flow-pan"/g).length, 1);
  assert.ok(html.includes('A &amp; B') && !html.includes('<hi>'));
  assert.ok(html.includes('x&quot;y'));
  assert.strictEqual(html.indexOf('flow-edge') < html.indexOf('flow-node'), true); // edges under boxes
  assert.ok(renderFlow('nonsense').startsWith('<pre><code class="language-flow">'));

  // a bowed edge must be inside the viewBox, not clipped by a boxes-only size
  const bowed = renderFlow('id: x\na -> b\nb -> c\na -> c');
  const vb = bowed.match(/viewBox="(-?[\d.]+) 0 ([\d.]+) /);
  const bowX = Math.min(...[...bowed.matchAll(/C (-?[\d.]+) /g)].map((m) => +m[1]));
  assert.ok(+vb[1] <= bowX, `viewBox minX ${vb[1]} must reach bow ${bowX}`);

  console.log('flow.js self-check ok');
}
