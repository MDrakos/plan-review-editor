'use strict';

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

module.exports = { docText, quoteAnchors };
