// Runtime: effect disposal (scope) + `contains` helper (__has). Disposal is the fix for the
// router bug where an unmounted page's effects kept firing on shared store signals and crashed.
import { signal, effect, scope, untrack, __has } from '../dist/runtime.js';

let f = 0;
const ok = (l, c) => { console.log((c ? '✓' : '✗') + ' ' + l); if (!c) f++; };

// __has: list membership OR case-insensitive substring
ok('__has list hit', __has([1, 2, 3], 2) === true);
ok('__has list miss', __has([1, 2, 3], 9) === false);
ok('__has substring', __has('Hello World', 'world') === true);

// scope disposal: a disposed effect stops reacting (no stale-DOM crashes on unmount)
const s = signal(0);
let runs = 0;
const dispose = scope(() => { effect(() => { s.get(); runs++; }); });
ok('scoped effect ran on create', runs === 1);
s.set(1);
await Promise.resolve();   // effects batch into a microtask now (Solid-style)
ok('scoped effect ran on change', runs === 2);
dispose();
s.set(2);
ok('disposed effect does NOT run', runs === 2);

// effects created outside a scope persist (stores/shell must survive page nav)
const s2 = signal(0);
let g = 0;
effect(() => { s2.get(); g++; });
s2.set(1);
await Promise.resolve();
ok('non-scoped effect still reacts', g === 2);

// AN ACTION NEVER SUBSCRIBES THE EFFECT THAT CALLS IT. Compiled actions run through `untrack`: an effect that
// reacts to an error by calling an action that bumps a counter (notice.error: seq.set(seq + 1)) must run once,
// not re-run itself for ever (it froze the store when a booking came back «hour taken»).
const failed = signal(false);
const seq = signal(0);
const bump = () => untrack(() => seq.set(seq.get() + 1));
let shown = 0;
effect(() => { if (failed.get()) { shown++; bump(); } });
failed.set(true);
for (let i = 0; i < 5; i += 1) await Promise.resolve();
ok('an effect calling an action that reads+writes a signal runs once', shown === 1 && seq.get() === 1);
ok('untrack returns what its function returns', untrack(() => 7) === 7);

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
