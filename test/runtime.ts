// Runtime: effect disposal (scope) + `contains` helper (__has). Disposal is the fix for the
// router bug where an unmounted page's effects kept firing on shared store signals and crashed.
import { signal, effect, scope, untrack, __has, __rowKey } from '../dist/runtime.js';

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

// A LIST ROW WITHOUT AN ID KEEPS ITS PLACE BY ITS CONTENT. A list computed again hands `each` new objects with the
// same content; keyed by the object itself, every row was destroyed and rebuilt (the app blinked on every change).
{
  const twins = () => new Map();
  const first = [{ day: 'mon', open: true }, { day: 'tue', open: false }];
  const again = [{ day: 'mon', open: true }, { day: 'tue', open: false }];   // same content, new objects
  const k1 = first.map((r) => __rowKey(r, twins())), k2 = again.map((r) => __rowKey(r, twins()));
  ok('row without id: same content, same key', k1[0] === k2[0] && k1[1] === k2[1]);
  ok('row without id: different content, different key', __rowKey({ day: 'mon', open: false }, twins()) !== k1[0]);
  const t = twins(); const a = __rowKey({ x: 1 }, t), b = __rowKey({ x: 1 }, t);
  ok('twin rows get distinct keys', a !== b);
  ok('row with id: the id', __rowKey({ id: 'r7', x: 1 }, twins()) === 'r7');
  ok('primitive row: itself', __rowKey('lunes', twins()) === 'lunes' && __rowKey(3, twins()) === 3);
  const loop = { n: 1 }; loop.self = loop;
  ok('a row that cannot be serialized falls back to itself', __rowKey(loop, twins()) === loop);
}
process.exit(f ? 1 : 0);
