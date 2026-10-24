// Interactivity: reactive `class(name when cond)` → a classList.toggle effect; `on(event: action)` on any
// element → addEventListener. Static classes stay in the className; conditionals are toggled at runtime.
import { readFileSync } from 'node:fs';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compile, compileModule } from '#engine/compile/compile.js';
import { validate } from '#engine/ir/validate.js';
import { BUILTINS_JS } from '#engine/compile/emit.js';
// the plumbing of `when` and `each` lives in the runtime now; some checks read it there
const blocksSource = readFileSync(new URL('../src/runtime-blocks.ts', import.meta.url), 'utf8');

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
ok('static link → plain href', staticJs.includes('.href = "/about"') || staticJs.includes('__clone("<a class=\\"mu-link\\" href=\\"/about\\">Home</a>")'), staticJs.match(/__clone\([^)]*\)/)?.[0]); // built, or cloned from a template

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
ok('each-index: the list asks the runtime for an index per row', ixJs.includes('index: true'));
ok('each-index: buildItem takes the index signal', /function buildItem_\w+\(__p, \w+, \w+\)/.test(ixJs));
ok('each-index: reindexed by position each pass (runtime-blocks.ts)', blocksSource.includes('next[i].idx?.set(i)'));
ok('each-index: `i` read reactively (i.get())', ixJs.includes('i.get()'));
// `where` reads the index var: the row's place in the list BEFORE the filter, as a plain number (a window of rows,
// `where i >= from and i < to`). The filter's arrow must declare it: the oracle accepted it and the page threw
// «i is not defined» at runtime.
const ixWhereJs = compileModule(toDoc(parse(`screen s
entity T { name text }
state { xs = query xs : list<T>  from = 1 : number  to = 3 : number }
sources { xs: { url: "/x" } }
Page { each xs as it, i where i >= from and i < to { Text "{i}. {it.name}" } }`)));
ok('each-index in where: the filter arrow declares the index', ixWhereJs.includes('.filter((it, i) =>'));
const whereLine = ixWhereJs.split('\n').find((l) => l.includes('.filter((it, i) =>')) || '';
ok('each-index in where: read as a plain number there (not i.get())', /i >= /.test(whereLine) && !whereLine.includes('i.get()'));
// and it really filters by position: run the compiled filter on a list
const arrow = whereLine.match(/\.filter\(\((it, i)\) => (.*?)\)(\.slice|;)/);
ok('each-index in where: the compiled filter keeps rows 1 and 2 of four', !!arrow && (() => { try { const src = arrow[2].replace(/\bfrom\.get\(\)|\bfrom\b(?!\s*:)/g, '1').replace(/\bto\.get\(\)|\bto\b(?!\s*:)/g, '3'); const f = new Function('it', 'i', `return (${src});`); return ['a', 'b', 'c', 'd'].filter((it, i) => f(it, i)).join('') === 'bc'; } catch { return false; } })());
// Image loads lazily unless `eager`; both decode off the main thread. A static page is one HTML string, a reactive one
// builds the <img> in JS: both carry the same attributes.
const imgStatic = compileModule(toDoc(parse(`screen s
Page { Image "/a.png" alt "a"  Image "/cover.png" alt "" eager }`)));
ok('Image (static page): lazy and async by default', imgStatic.includes('alt=\\"a\\" loading=\\"lazy\\" decoding=\\"async\\"'));
ok('Image eager (static page): at once, high priority', imgStatic.includes('loading=\\"eager\\" fetchpriority=\\"high\\"'));
const imgLive = compileModule(toDoc(parse(`screen s
state { pic = "/a.png" : text  cover = "/c.png" : text }
action swap mutates pic, cover { pic.set("/b.png")  cover.set("/d.png") }
Page { Image "{pic}" alt "a"  Image "{cover}" alt "" eager  Button "x" -> swap }`)));
ok('Image (reactive page): lazy and async by default', imgLive.includes(".loading = 'lazy'; ") && imgLive.includes(".decoding = 'async';"));
ok('Image eager (reactive page): at once, high priority', imgLive.includes(".loading = 'eager'; ") && imgLive.includes(".fetchPriority = 'high';"));
ok('eager on a non-Image is flagged by the oracle', validate(toDoc(parse(`screen s
Page { Text "x" eager }`)), {}).diagnostics.some((d) => d.code === 'eager-target'));
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
action raise mutates hi { hi.set(hi + 10) }
Page { Range bind(vol) min(0) max(hi) step(5)  Number bind(vol)  Button "+" -> raise }`)));
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

// group("faq") — sibling Details share a native name, so the browser keeps one open; both paths must carry it.
const faqJs = compileModule(toDoc(parse('screen s\nstate { open = false : bool }\nPage { Details "A" group("faq") open { Text "{open}" }  Details "B" group("faq") { Text "b" } }')));
ok('group() emits el.name on the reactive path', faqJs.includes('.name = "faq"'), faqJs.slice(0, 240));
const faqHtml = compile(toDoc(parse('screen s\nPage { Details "A" group("faq") open { Text "a" } }')));
ok('group() survives the static HTML path', faqHtml.includes('name="faq"'), faqHtml.slice(0, 240));

// A `when` owns everything between its two markers, not a snapshot of the nodes it had when built: a nested
// `when`/`each` at its root inserts nodes LATER (rows that load, a branch that turns on), and a snapshot left
// those on screen after the outer block turned off. Same for an `each` row whose root holds a nested block.
const nestJs = compileModule(toDoc(parse(`screen s
entity T { id text  label text }
state { open = true : bool  more = false : bool  items = query items : list<T> }
sources { items: { url: "/x" } }
Page {
  when open {
    Text "head"
    when more { Text "late" }
    each items as it { Text "{it.label}" when more { Text "row-late" } }
  }
}`)));
// a `when` is one runtime call now (runtime-blocks.ts); the marker range and the way out live there, once
ok('when compiles to one __when call per block', (nestJs.match(/__when\(/g) || []).length === 3 && /import \{[^}]*__when[^}]*\} from 'virtual:muten\/runtime'/.test(nestJs));
ok('when hides by clearing its marker range', blocksSource.includes('__leave(start, anchor)') && blocksSource.includes("createComment('when')"));
ok('when no longer removes a build-time snapshot', !/for \(const __n of shown_\w+\.value\) __n\.remove\(\)/.test(nestJs));
ok('a hidden block leaves through __leave, from the runtime', blocksSource.includes("import { __leave } from './runtime-leave.js'"));
ok('each row reads its nodes live between row markers', blocksSource.includes("createComment('row')") && blocksSource.includes('get nodes()') && nestJs.includes('__each('));

// `disabled when` on a Link: an <a> has no `disabled`, so it must leave the Tab order, say aria-disabled and
// refuse the click — a card that is a call to action only while there is something to do.
const linkJs = compileModule(toDoc(parse('screen s\nstate { calm = true : bool }\nPage { Link "" -> "/close" disabled when calm { Text "Cerrar el día" } }')));
ok('disabled Link: out of the Tab order while the condition holds', linkJs.includes('.tabIndex = __off ? -1 : 0'));
ok('disabled Link: announced as aria-disabled', linkJs.includes(".setAttribute('aria-disabled', 'true')"));
ok('disabled Link: a click does not navigate', linkJs.includes("getAttribute('aria-disabled') === 'true') { e.preventDefault(); e.stopImmediatePropagation(); }"));

// A GET MAY READ ONE DECLARED BELOW IT. Each get is a `const` in the module, so emitting them in file order made
// `get b = a + 1` above `get a = n * 2` throw «Cannot access before initialization» on mount (a blank page that
// passed check). The compiler emits them in dependency order instead.
{
  const orderJs = compileModule(toDoc(parse('screen s\nstate { n = 2 : number }\nget c = b + a\nget b = a + 1\nget a = n * 2\nPage { Text "{c}" }')));
  const at = (name) => orderJs.indexOf(`const ${name} = computed(`);
  ok('gets emitted after the gets they read (a, then b, then c)', at('a') > -1 && at('a') < at('b') && at('b') < at('c'), [at('a'), at('b'), at('c')].join(','));
  const cyc = validate(toDoc(parse('screen s\nget a = b + 1\nget b = a + 1\nPage { Text "{a}" }'))).diagnostics.find((d) => d.code === 'get-cycle');
  ok('a cycle among gets is an error that names the chain', !!cyc && /a → b → a|b → a → b/.test(cyc.message), cyc?.message);
  const self = validate(toDoc(parse('screen s\nget a = a + 1\nPage { Text "{a}" }'))).diagnostics.some((d) => d.code === 'get-cycle');
  ok('a get that reads itself is a cycle', self);
  const viaWhere = validate(toDoc(parse('screen s\nentity T { owner text }\nstate { ts = [] : list<T> }\nget mine = ts where owner == me\nget me = mine.count\nPage { Text "{me}" }'))).diagnostics.some((d) => d.code === 'get-cycle');
  ok('a cycle through a where clause is caught too', viaWhere);
}

// A DATE WITHOUT A TIME IS THAT DAY WHERE THE USER IS. `new Date("2026-06-21")` is midnight UTC, the evening of the
// 20th in America: every date function showed the day before. They read a bare date as local midnight now.
{
  process.env.TZ = 'America/Bogota';
  const fns = new Function(`${BUILTINS_JS}\nreturn { date, dayKey, addDays, isToday, weekday };`)();
  ok('date("2026-06-21") is the 21st in Bogotá', /21/.test(fns.date('2026-06-21')), fns.date('2026-06-21'));
  ok('dayKey of a bare date is that date', fns.dayKey('2026-06-21') === '2026-06-21', fns.dayKey('2026-06-21'));
  ok('addDays on a bare date gives a bare date', fns.addDays('2026-06-21', 1) === '2026-06-22', fns.addDays('2026-06-21', 1));
  ok('a date with a time is read as before', fns.dayKey('2026-06-21T03:00:00Z') === '2026-06-20', fns.dayKey('2026-06-21T03:00:00Z'));
  ok('weekday of a bare date is that day', fns.weekday('2026-06-21') === new Date(2026, 5, 21).toLocaleDateString(undefined, { weekday: 'long' }), fns.weekday('2026-06-21'));
}

// AN ABSENT FIELD COMPARED WITH A LITERAL IS THAT LITERAL'S ZERO. `when d.mood == 0` was false for a row that did
// not bring `mood` (undefined === 0), so its spot rendered empty with nothing in the console.
{
  const zeroJs = compileModule(toDoc(parse('screen s\nentity Day { name text  mood number }\nstate { days = [ { name: "lun" } ] : list<Day> }\nPage { each days as d { when d.mood == 0 { Span "zero" } when d.name != "" { Span "named" } } }')));
  ok('== 0 reads an absent number as 0', /\?\? 0\) === 0\)/.test(zeroJs), zeroJs.match(/when|=== 0[^;]*/)?.[0]);
  ok('!= "" reads an absent text as ""', /\?\? ""\) !== ""\)/.test(zeroJs));
  const plain = compileModule(toDoc(parse('screen s\nstate { a = 1 : number  b = 2 : number }\naction up mutates a, b { a.set(a + 1)  b.set(b + 2) }\nPage { when a == b { Text "x" }  Button "+" -> up }')));
  ok('two references compare as before', plain.includes('=== b.get())') && !plain.includes('??'));
}

// A KEBAB-CASE CLASS NEEDS NO QUOTES: `class(is-us when mine)` stopped at the `-` with «expected ident».
{
  const kebab = compileModule(toDoc(parse('screen s\nstate { mine = true : bool }\nPage class(is-us when mine, card-2xl) { Text "x" }')));
  ok('class(is-us when x) toggles "is-us"', kebab.includes('.classList.toggle("is-us", __on)'), kebab.match(/classList\.toggle\([^)]*\)/)?.[0]);
  ok('a bare kebab class stays one class', kebab.includes('card-2xl'));
}

// (These pages write the states they show, through an action: a state nothing writes folds to its value, fold.ts.)
// A REACTIVE TEXT WRITES THE DOM ONLY WHEN IT CHANGED. A row patched elsewhere comes back as a new object and re-runs
// every binding of the row; rewriting an unchanged text replaced its text node (two mutations per field per change).
{
  const js = compileModule(toDoc(parse('screen s\nstate { n = 1 : number }\naction up mutates n { n.set(n + 1) }\nPage { Text "n = {n}"  Button "+" -> up }')));
  ok('reactive text binds through __bind (it keeps the last value and skips an unchanged write)', /__bind\(el_\w+, "textContent", \(\) => /.test(js), js.match(/[^\n]*textContent[^\n]*/)?.[0]);
}

// an interpolated class or style() with an absent value writes nothing for it, never the word "null"/"undefined"
{
  const js = compileModule(toDoc(parse('screen s\nstate { st = "" : text  w = 0 : number }\naction go mutates st, w { st.set("on")  w.set(50) }\nPage { Stack class("status-{st}") style(w: "{w}%") { Text "x" }  Button "go" -> go }')));
  ok('class("status-{x}") reads an absent x as ""', js.includes("const __c = \"status-\" + String(st.get() ?? '')"), js.match(/const __c = [^;]*/)?.[0]);
  ok('style() reads an absent value as ""', js.includes("String(w.get() ?? '')"), js.match(/setProperty\("--w"[^\n]*/)?.[0]);
}

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
