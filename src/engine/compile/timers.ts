// timers: `every 1m { … }` and `settle q 350ms { … }` as code. On the beat while the tab is visible, once more when it comes back (a phone left in a
// pocket wakes up on the right minute), never reading what it runs as a dependency; the page leaving stops it.

import type { Expr, Stmt } from '#engine/shared/types.js';
import type { Settle, Timer } from '#engine/shared/types-fn.js';

/** The code of every `every` of a page, given how a statement compiles. */
export function timerCode(timers: Timer[], lines: (st: Stmt) => string[]): string {
  return timers.map((timer) => {
    const body = timer.body.map((st) => lines(st).map((line) => '      ' + line).join('\n')).join('\n');
    return `if (typeof window !== 'undefined') { const __beat = () => untrack(() => {\n${body}\n    }); const __each = setInterval(() => { if (document.visibilityState !== 'hidden') __beat(); }, ${timer.ms}); const __back = () => { if (document.visibilityState === 'visible') __beat(); }; document.addEventListener('visibilitychange', __back); onCleanup(() => { clearInterval(__each); document.removeEventListener('visibilitychange', __back); }); }`;
  }).join('\n  ');
}

/** The code of every `settle`: its statements once the watched value has not changed for its time. A value already
 *  there when the page opens (a restored draft) settles too; an empty one does not (nothing was typed). */
export function settleCode(settles: Settle[], lines: (st: Stmt) => string[], expr: (watched: Expr) => string): string {
  return settles.map((settle) => {
    const body = settle.body.map((st) => lines(st).map((line) => '      ' + line).join('\n')).join('\n');
    return `{ let __wait = null, __first = true; effect(() => { const __now = ${expr(settle.watched)}; if (__first) { __first = false; if (__now === '' || __now == null) return; } if (__wait) clearTimeout(__wait); __wait = setTimeout(() => { __wait = null; untrack(() => {\n${body}\n    }); }, ${settle.ms}); }); onCleanup(() => { if (__wait) clearTimeout(__wait); }); }`;
  }).join('\n  ');
}
