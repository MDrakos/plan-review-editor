#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { render } = require('./markdown');

const PORT = Number(process.env.PLANREVIEW_PORT || 4780);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const state = {
  status: 'idle', // idle | reviewing
  doc: { path: null, title: '', html: '', version: 0 },
};

function titleFrom(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function loadDoc(docPath) {
  const markdown = fs.readFileSync(docPath, 'utf8');
  state.doc.path = docPath;
  state.doc.title = titleFrom(markdown) || path.basename(docPath);
  state.doc.html = render(markdown);
  state.doc.version += 1;
  state.status = 'reviewing';
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, name, type) {
  fs.readFile(path.join(PUBLIC_DIR, name), (err, data) => {
    if (err) return sendJson(res, 500, { error: `missing asset: ${name}` });
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && STATIC[pathname]) {
    return sendFile(res, STATIC[pathname][0], STATIC[pathname][1]);
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, {
      status: state.status,
      doc: { title: state.doc.title, html: state.doc.html, version: state.doc.version },
    });
  }

  sendJson(res, 404, { error: 'not found' });
});

const docArg = process.argv[2];
if (docArg) loadDoc(path.resolve(docArg));

server.listen(PORT, HOST, () => {
  console.log(`plan-review-editor listening on http://${HOST}:${PORT}`);
});
