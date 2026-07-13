'use strict';

// ---------- working-overlay liveness (pure) ----------
//
// Small, DOM-free helpers behind the "is the agent still alive?" cue in the
// working overlay. Kept in their own file for two reasons: they load as a plain
// <script> in the browser (attaching to window.Liveness, consumed by app.js) and
// they're require()-able in node so the timer/threshold logic is unit-tested
// without a DOM — the same split server/markdown.js uses.

// How long the overlay waits with no sign of life before showing the advisory.
// One tunable knob; purely a display threshold, it never touches the status
// state machine. Relaxed to 90s: a healthy rework often runs a while between
// reported steps, and the old 40s window tripped the "stuck" line on perfectly
// normal silent work. Longer window plus softer wording (see stalenessHint)
// keeps the cue for genuinely stalled agents without crying wolf.
const STALE_THRESHOLD_MS = 90000;

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
// while fresh so the caller can simply hide the line. Advisory only: soft,
// non-alarming wording. A healthy silent rework can still trip it, so the copy
// reassures ("still working") rather than warning ("may be stuck").
function stalenessHint(msSinceSignal, thresholdMs = STALE_THRESHOLD_MS) {
  if (!(msSinceSignal >= thresholdMs)) return null;
  const seconds = Math.floor(msSinceSignal / 1000);
  return `Still working; no update from the agent in ${seconds} s.`;
}

const Liveness = { STALE_THRESHOLD_MS, formatElapsed, stalenessHint };

if (typeof module !== 'undefined' && module.exports) module.exports = Liveness;
if (typeof window !== 'undefined') window.Liveness = Liveness;
