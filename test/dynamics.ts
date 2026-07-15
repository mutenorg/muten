// Interactivity: reactive `class(name when cond)` → a classList.toggle effect; `on(event: action)` on any
// element → addEventListener. Static classes stay in the className; conditionals are toggled at runtime.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compile, compileModule } from '#engine/compile/compile.js';
import { validate } from '#engine/ir/validate.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const js = compileModule(toDoc(parse(`screen s
state { open = false : bool }
action toggle mutates open <- x { open.set(not open) }
Page {
  Stack class(panel, active when open) on(mouseenter: toggle) { Text "menu" }
  Button "x" -> toggle
}`)));
ok('static class stays in className', js.includes('"mu-stack panel"'));
ok('reactive class → classList.toggle effect (condition computed once)', js.includes('const __on = !!(open.get());') && js.includes('.classList.toggle("active", __on)'));
ok('on(event: action) → addEventListener', js.includes('.addEventListener("mouseenter", (e) => toggle())')); // event arg threaded (payload table); a no-arg action ignores it

// two separate class() modifiers MERGE (regression: a second class() used to overwrite, silently dropping the first)
const mergeJs = compileModule(toDoc(parse('screen s\nstate { d = false : bool }\nPage class("chat-app") class(dark when d) { Text "x" }')));
ok('multiple class() merge: static kept', mergeJs.includes('chat-app'));
ok('multiple class() merge: reactive kept', mergeJs.includes('.classList.toggle("dark", __on)'));

// MULTI-TOKEN reactive class: `class("a b c" when cond)` must toggle EACH token separately — classList.toggle
// throws on a token with spaces, so a single toggle("a b c") passes lint but blows up the render at runtime.
const multiJs = compileModule(toDoc(parse('screen s\nstate { on = false : bool }\nPage class("ring-2 ring-primary ring-inset" when on) { Text "x" }')));
ok('multi-token reactive class: per-token toggles', multiJs.includes('.classList.toggle("ring-2", __on)') && multiJs.includes('.classList.toggle("ring-primary", __on)') && multiJs.includes('.classList.toggle("ring-inset", __on)'));
ok('multi-token reactive class: NO multi-token toggle (would throw at runtime)', !multiJs.includes('toggle("ring-2 ring-primary'));

// a conditional class inside `each` resolves against the item local
const eachJs = compileModule(toDoc(parse(`screen s
entity T { label text  done bool }
state { items = query items : list<T> }
sources { items: { url: "/x" } }
Page { each items as it { Text "{it.label}" class(done when it.done) } }`)));
ok('conditional class in each uses the item (reactive row signal)', eachJs.includes('const __on = !!(it.get().done);') && eachJs.includes('.classList.toggle("done", __on)'));

// dynamic navigation: `-> /product/{p.id}` → an interpolated href (reuses the Text interpolation machinery)
const navJs = compileModule(toDoc(parse(`screen s
entity P { id text  title text }
state { items = query items : list<P> }
sources { items: { url: "/x" } }
Page { each items as p { Link "{p.title}" -> "/product/{p.id}" } }`)));
ok('dynamic link → interpolated href', navJs.includes(`"/product/" + String(p.get().id ?? '')`));

// a static path on a dynamic page stays a plain string href (no regression in the JS path)
const staticJs = compileModule(toDoc(parse(`screen s
state { open = false : bool }
action t mutates open <- x { open.set(not open) }
Page { Link "Home" -> "/about"  Button "x" -> t }`)));
ok('static link → plain href', staticJs.includes('.href = "/about"'));

// synthetic on(enter: action) on an input → a keydown listener firing on Enter (no Custom for "Enter to send").
// Enter without Shift submits and preventDefaults the newline; Shift+Enter falls through as a newline.
const enterJs = compileModule(toDoc(parse(`screen s
state { d = "" : text }
action go mutates d { d.reset() }
Page { SearchField bind(d) on(enter: go) "x" }`)));
ok('on(enter:) → keydown + Enter check', enterJs.includes("e.key === 'Enter' && !e.shiftKey") && enterJs.includes('e.preventDefault(); go()'));
ok('SearchField wires on()', enterJs.includes(".addEventListener('keydown'"));

// `each x as item, i` → a second per-row signal (i) holding the row's position, reindexed on reorder/filter
const ixJs = compileModule(toDoc(parse(`screen s
entity T { name text }
state { xs = query xs : list<T> }
sources { xs: { url: "/x" } }
Page { each xs as it, i { Text "{i}. {it.name}" } }`)));
ok('each-index: per-row index signal created', ixJs.includes('const __ix = signal(0);'));
ok('each-index: passed to buildItem + stored on the entry', ixJs.includes(', __ix)') && ixJs.includes('idx: __ix'));
ok('each-index: reindexed by position each pass', ixJs.includes('__next[__i].idx.set(__i)'));
ok('each-index: `i` read reactively (i.get())', ixJs.includes('i.get()'));
// no index var → no index machinery at all (zero overhead)
const noIxJs = compileModule(toDoc(parse(`screen s
entity T { name text }
state { xs = query xs : list<T> }
sources { xs: { url: "/x" } }
Page { each xs as it { Text "{it.name}" } }`)));
ok('no-index each: no idx signal emitted', !noIxJs.includes('idx: __ix') && !noIxJs.includes('.idx.set('));

// `list.at(n)[.field]` — read the element (or a field of it) at an index; the dual of each-index
const atJs = compileModule(toDoc(parse(`screen s
entity Opt { name text }
state { hi = 0 : number  opts = [ { id: "1", name: "A" } ] : list<Opt> }
get matches = opts where name contains "a"
action pick mutates hi { hi.set(hi + 1) }
Page { Text "{matches.at(hi).name}" }`)));
ok('at(n).field → indexed access + safe field read', atJs.includes('.at(hi.get())?.name'));

// Range/Number: native numeric inputs bound to a number state, value coerced with Number()
const rngJs = compileModule(toDoc(parse(`screen s
state { vol = 50 : number  hi = 10 : number }
Page { Range bind(vol) min(0) max(hi) step(5)  Number bind(vol) }`)));
ok('Range → <input type=range>', rngJs.includes('.type = "range"'));
ok('Number → <input type=number>', rngJs.includes('.type = "number"'));
ok('numeric write coerces via Number()', rngJs.includes('vol.set(Number(e.target.value))'));
ok('static min attribute', rngJs.includes('.setAttribute("min", 0)'));
ok('reactive max attribute (state-driven bound)', rngJs.includes(`.setAttribute("max", hi.get())`));

// `Chart @get` — the flagship widget consumes a derived list (store-centric pattern), not just a bare page state
const chartGetDoc = toDoc(parse(`screen s
entity Row { cat text  amount number }
state { rows = [] : list<Row> }
get byCat = rows.sortDesc by amount
Page { Chart @byCat kind(bar) x(cat) y(amount)  DataTable @byCat columns(cat, amount) }`));
const chartGetV = validate(chartGetDoc, { externs: new Set(), apiClients: [], iconExists: () => true, storeEntities: {}, storeSelfMut: new Set() });
ok('Chart/DataTable @get validate clean (no unknown-ref)', chartGetV.ok, JSON.stringify(chartGetV.diagnostics.map((d) => d.code)));
const chartGetJs = compileModule(chartGetDoc);
ok('Chart @get compiles to the computed read', chartGetJs.includes('byCat.get()'));
// negative: a wrong x-field on a @get still errors THROUGH the get (fields resolved)
const chartBadDoc = toDoc(parse(`screen s
entity Row { cat text  amount number }
state { rows = [] : list<Row> }
get byCat = rows.sortDesc by amount
Page { Chart @byCat kind(bar) x(nope) y(amount) }`));
const chartBadV = validate(chartBadDoc, { externs: new Set(), apiClients: [], iconExists: () => true, storeEntities: {}, storeSelfMut: new Set() });
ok('Chart @get still field-checks (x(nope) → chart-field)', !chartBadV.ok && chartBadV.diagnostics.some((d) => d.code === 'chart-field'));

// id("features") — the anchor target must actually REACH the DOM on BOTH paths, or `Link -> "#features"` scrolls
// nowhere. A landing with no state compiles down the zero-JS static path, so that one matters most here.
const anchorJs = compileModule(toDoc(parse('screen s\nstate { open = false : bool }\nPage { Stack id("features") { Text "{open}" }  Link "F" -> "#features" }')));
ok('id() emits el.id on the reactive path', anchorJs.includes('.id = "features"'), anchorJs.slice(0, 240));
const anchorHtml = compile(toDoc(parse('screen s\nPage { Stack id("features") { Text "f" } }')));
ok('id() survives the static HTML path', anchorHtml.includes('id="features"'), anchorHtml.slice(0, 240));

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
