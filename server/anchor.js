'use strict';

const { escapeHtml } = require('./escapehtml');

// The server-side mirror of the browser's `anchorByQuote` (public/app.js).
//
// A comment is anchored to a run of text the reviewer selected in the rendered
// document. When the agent re-presents a reworked plan, the server must decide
// — with no DOM — whether each prior comment's quote still exists in the new
// document, so its thread can be carried forward (anchored) or archived
// (un-anchored) rather than silently dropped.
//
// The browser decides by walking the rendered DOM's text nodes and testing
// `text.indexOf(quote)`. We reproduce that here from the same rendered HTML
// string: strip the tags and decode the entities the renderer emits, leaving
// the same concatenated text the browser's tree-walker would see.

// Decode only the four entities `escapeHtml` (server/markdown.js) produces, and
// decode `&amp;` LAST — otherwise a double-escaped source (`&amp;lt;` on disk →
// `&amp;amp;lt;` in HTML) would over-decode and diverge from the browser, which
// yields `&lt;` for that text node.
function docText(html) {
  return String(html)
    .replace(/<[^>]*>/g, '') // strip tags — leaves inter-block "\n" joins, as the DOM tree-walker keeps them
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// True when `quote` still occurs in the rendered document `html`. An empty quote
// never anchors (guard) — matching the reviewer never being able to select one.
function quoteAnchors(quote, html) {
  if (!quote) return false;
  return docText(html).indexOf(quote) !== -1;
}

// True when the flow-diagram anchor `id` is still rendered in `html`. A comment
// on a node or an edge anchors on its id, not on text, so this is a match
// against the attribute the browser will see rather than against the doc text.
// The closing quote is part of the needle so `…:node:store` never matches
// `…:node:store2`.
function idAnchors(id, html) {
  if (!id) return false;
  return String(html).indexOf(`data-anchor-id="${escapeHtml(id)}"`) !== -1;
}

module.exports = { docText, quoteAnchors, idAnchors };

if (require.main === module) {
  const assert = require('assert');
  const html = '<g data-anchor-id="rl:node:store"></g><g data-anchor-id="rl:edge:a-&gt;b"></g>';
  assert.strictEqual(idAnchors('rl:node:store', html), true);
  assert.strictEqual(idAnchors('rl:edge:a->b', html), true, 'the id must be escaped before matching');
  assert.strictEqual(idAnchors('rl:node:store2', html), false);
  assert.strictEqual(idAnchors('rl:node:stor', html), false, 'a prefix must not match');
  assert.strictEqual(idAnchors('', html), false);
  assert.strictEqual(quoteAnchors('hello', '<p>say hello now</p>'), true);
  assert.strictEqual(quoteAnchors('hello', '<p>nope</p>'), false);
  assert.strictEqual(docText('<p>a &amp;lt; b</p>'), 'a &lt; b');
  console.log('anchor.js self-check ok');
}
