'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A fingerprint of the server's own code — the .js files under server/ that are
// loaded into the running process. It changes whenever server logic changes, so
// the CLI can detect that a running server predates a code edit and restart it.
//
// Deliberately excludes public/ assets: those are read from disk on every
// request (see sendFile), so editing them never requires a restart.
function codeVersion() {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f).update('\0').update(fs.readFileSync(path.join(dir, f)));
  }
  return h.digest('hex').slice(0, 12);
}

module.exports = { codeVersion };
