'use strict';

// Shared by the markdown renderer and the flow-diagram renderer. It lives in its
// own file rather than in markdown.js so flow.js can use it without the two
// requiring each other.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { escapeHtml };
