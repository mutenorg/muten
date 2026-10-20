// `use a, b from "./lib.ts"` — named JS functions muten may CALL in expressions. The seam to the JS
// ecosystem: one bounded shape (named only), typed-checked at the border by the oracle.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { compileModule } from '#engine/compile/compile.js';
import { print } from '#engine/ir/print.js';

let f = 0;
const ok = (l: string, c: boolean, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '  ← ' + e)); if (!c) f++; };

const SRC = `screen s
use fmt, big from "./lib/util.ts"
state { n = 0 : number  d = "" : text }
Page {
  when big(n) { Text "yes" }
  Text "{fmt(d)}"
}`;

const ir = parse(SRC);
ok('use parsed', ir.imports?.[0]?.names.join(',') === 'fmt,big' && ir.imports?.[0]?.from === './lib/util.ts',
  JSON.stringify(ir.imports));

const js = compileModule(toDoc(ir));
ok('emits the ESM import', js.includes('import { fmt, big } from "./lib/util.ts"'));
ok('emits the call', js.includes('big(') && js.includes('fmt('));

// oracle: an undeclared function is caught at the border
const bad = validate(toDoc(parse(`screen s\nuse fmt from "./x.ts"\nPage { Text "{ghost(d)}" }`)));
ok('undeclared fn caught', bad.diagnostics.some((d) => d.code === 'unknown-function'),
  JSON.stringify(bad.diagnostics));

// oracle: a declared function passes (no unknown-function)
const good = validate(toDoc(parse(`screen s\nuse fmt from "./x.ts"\nstate { d = "" : text }\nPage { Text "{fmt(d)}" }`)));
ok('declared fn passes', good.diagnostics.every((d) => d.code !== 'unknown-function'),
  JSON.stringify(good.diagnostics));

// printer round-trips the use declaration + the call
const rt = parse(print(ir));
const withoutLoc = (imports) => JSON.stringify((imports || []).map(({ loc, ...def }) => def));   // where it is written moves; what it says must not
ok('printer round-trips', withoutLoc(rt.imports) === withoutLoc(ir.imports));

// use a function as a STATEMENT in an action (a side effect), not just an expression
const fxIr = parse(`screen s
use persist, scrollBottom from "./fx.ts"
state { n = 0 : number }
action go mutates n { n.set(1)  persist(n)  scrollBottom() }
Page { Button "go" -> go }`);
ok('use fn in action: validates clean', validate(toDoc(fxIr)).diagnostics.every((d) => d.code !== 'unknown-function'));
ok('use fn in action: emits the call', compileModule(toDoc(fxIr)).includes('persist(n.get())'));
const fxBad = validate(toDoc(parse(`screen s\nstate { n = 0 : number }\naction go mutates n { ghost()  n.set(1) }\nPage { Text "x" }`)));
ok('use fn in action: undeclared caught', fxBad.diagnostics.some((d) => d.code === 'unknown-function'));
ok('use fn in action: prints the call', /persist\(n\)/.test(print(fxIr)) && /scrollBottom\(\)/.test(print(fxIr)));

// in an ASYNC action a `use` call is awaited, but never inside a per-item callback: `patch where … with` and
// `count where` compile to a synchronous `.map`/`.filter`, where an `await` does not even parse (Storio, 20-10-2026:
// `.map((__it) => … (await nowIso()) …)` broke four pages)
const asyncIr = parse(`screen s
use nowIso, keyOf from "./fx.ts"
entity Row { name text  at text }
state { rows = [] : list<Row>  n = 0 : number  picked = "" : text }
action save mutates rows, n {
  post "/x" body { a: 1 }
  rows.patch where name == keyOf(picked) with { at: nowIso() }
  n.set(rows.count where at == nowIso())
}
Page { Button "go" -> save }`);
const asyncJs = compileModule(toDoc(asyncIr));
const callbacks = [...asyncJs.matchAll(/\((__it)\) => [^;]*/g)].map((m) => m[0]);
ok('async action: per-item callbacks were emitted', callbacks.length > 0, asyncJs.slice(0, 400));
ok('async action: no await inside a per-item callback', callbacks.every((body) => !body.includes('await')), callbacks.join('\n'));

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
