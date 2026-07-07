'use strict';

// ---------- working-overlay liveness (pure) ----------
//
// Small, DOM-free helpers behind the "is the agent still alive?" cue in the
// working overlay. Kept in their own file for two reasons: they load as a plain
// <script> in the browser (attaching to window.Liveness, consumed by app.js) and
// they're require()-able in node so the timer/threshold logic is unit-tested
// without a DOM — the same split server/markdown.js uses.

// How long the overlay waits with no sign of life before showing the advisory.
// One tunable knob; the spec calls for ~30–45s. Purely a display threshold — it
// never touches the status state machine.
const STALE_THRESHOLD_MS = 40000;

// Format a millisecond duration as "m:ss" ("0:48", "1:05"). A negative or NaN
// delta (a clock skew, a not-yet-started timer) clamps to "0:00" rather than
// rendering "-1:59" or "NaN:aN".
function formatElapsed(ms) {
  const totalSec = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Decide the advisory line, given how long since the last sign of life (entering
// 'working', or a progress event) and the staleness threshold. Returns null
// while fresh so the caller can simply hide the line. Advisory only — soft
// signal, non-alarming wording; a healthy silent rework can trip it and that's
// acceptable per the spec.
function stalenessHint(msSinceSignal, thresholdMs = STALE_THRESHOLD_MS) {
  if (!(msSinceSignal >= thresholdMs)) return null;
  const seconds = Math.floor(msSinceSignal / 1000);
  return `No updates for ${seconds} s — the agent may be stuck.`;
}

const Liveness = { STALE_THRESHOLD_MS, formatElapsed, stalenessHint };

if (typeof module !== 'undefined' && module.exports) module.exports = Liveness;
if (typeof window !== 'undefined') window.Liveness = Liveness;
