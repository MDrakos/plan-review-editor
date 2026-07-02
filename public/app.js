'use strict';

const docEl = document.getElementById('doc');
const docTitleEl = document.getElementById('doc-title');
const statusPill = document.getElementById('status-pill');

const STATUS_LABEL = {
  idle: 'waiting for a plan',
  reviewing: 'reviewing',
};

function setStatus(status) {
  statusPill.dataset.status = status;
  statusPill.textContent = STATUS_LABEL[status] || status;
}

function renderDoc(doc) {
  docTitleEl.textContent = doc.title || '';
  document.title = doc.title ? `${doc.title} — Plan Review` : 'Plan Review';
  docEl.innerHTML =
    doc.html || '<p class="empty">Waiting for the agent to present a plan…</p>';
}

async function fetchState() {
  const res = await fetch('/api/state');
  const s = await res.json();
  renderDoc(s.doc);
  setStatus(s.status);
}

fetchState();
