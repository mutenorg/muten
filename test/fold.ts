// Folding (engine/compile/fold.ts): what a page can know before it runs is written as the value. A part called with
// fixed arguments leaves expressions over literals; they compile to plain values, with no effect watching them, and a
// `when` that can never show is not compiled at all. What can change stays reactive.
import { parse } from '#engine/lang/parse.js';
import { compose } from '#engine/ir/compose.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compile } from '#engine/compile/compile.js';
import { foldDoc } from '#engine/compile/fold.js';

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };

const lib = parse(`part Frame(height: text = "", url: text = "", label: text = "", tone: text = "info") {
  Stack class("frame", "tone-{$tone}", tall when $height != "") data(crop: $height != "") aria(label: $label) style(h: "{$height}") {
    when $url != "" { Span "{$url}" class("frame-url") }
    when $url == "" { Span "sin dirección" class("frame-empty") }
    Text "Marco {$label}"
  }
}`);
const parts = {};
for (const [name, def] of Object.entries(lib.parts)) parts[name] = def;
const pageOf = (source) => { const ir = parse(source); return toDoc({ ...ir, tree: compose(ir.tree, parts).tree }); };

const fixed = compile(pageOf('screen s\nPage { Frame(label: "Casa Lino") }'), {});
ok('a constant data() is set once, not watched', fixed.includes('"data-crop", String(false)') && !/effect\([^\n]*data-crop/.test(fixed), fixed.match(/[^\n]*data-crop[^\n]*/)?.[0]);
ok('a constant interpolated text is a plain text', fixed.includes('textContent = "Marco Casa Lino"') && !/__bind\([^\n]*Marco/.test(fixed), fixed.match(/[^\n]*Marco[^\n]*/)?.[0]);
ok('a constant style() is set once', !/effect\([^\n]*setProperty/.test(fixed), fixed.match(/[^\n]*setProperty[^\n]*/)?.[0]);
ok('a class() over constants is a static class; a false toggle is gone', fixed.includes('tone-info') && !fixed.includes('"tall"'), fixed.match(/[^\n]*frame[^\n]*/)?.[0]);
ok('a `when` that can never show is not compiled', !fixed.includes('frame-url'));
ok('a `when` that always shows is its children, with no __when', fixed.includes('sin dirección') && !fixed.includes('__when('), fixed.match(/[^\n]*__when[^\n]*/)?.[0]);

// the page has nothing reactive left: it is static HTML, no runtime
const html = compile(pageOf('screen s\nPage { Frame(label: "Casa Lino", url: "storio.ink/casa") }'), {});
ok('a page whose every value is known compiles to static HTML', html.includes('innerHTML') && html.includes('storio.ink/casa') && !html.includes('effect('), html.slice(0, 300));

// what can change stays reactive
const live = compile(pageOf('screen s\nstate { name = "" : text }\naction rename(v: text) mutates name { name.set(v) }\nPage { Frame(label: name)  SearchField bind(name) }'), {});
ok('a state the page writes stays watched', /__bind\([^\n]*Marco/.test(live) || live.includes('"Marco " + String(name.get()'), live.match(/[^\n]*Marco[^\n]*/)?.[0]);

// a frozen state (nothing writes it) and a const are known values
const frozen = compile(pageOf('screen s\nconst SHOP = "Lino"\nstate { kind = "barber" : text }\nPage { Text "{kind} · {SHOP}"  when kind == "barber" { Text "corte" } }'), {});
ok('a frozen state and a const fold into the text', frozen.includes('barber · Lino') && !frozen.includes('__when('), frozen.slice(0, 400));

// `and` / `or` with one known side, as JS reads them
const logic = compile(pageOf('screen s\nstate { open = false : bool }\naction flip mutates open { open.toggle() }\nPage { when open and "" != "" { Text "nunca" }  when "a" == "a" and open { Text "a veces" }  Button "x" -> flip }'), {});
ok('`x and false` never shows', !logic.includes('nunca'));
ok('`true and x` is x, still watched', logic.includes('a veces') && logic.includes('__when('));

// a row's name is never a known value, even when a const has the same name
const rows = compile(pageOf('screen s\nentity T { title text }\nstate { items = [ { title: "uno" } ] : list<T>  title = "fijo" : text }\nPage { each items as t { Text "{t.title}" }  Text "{title}" }'), {});
ok('row fields are untouched; a frozen page state still folds', rows.includes('fijo') && /t\.get\(\)/.test(rows), rows.slice(0, 500));

// the input doc is not changed
const doc = pageOf('screen s\nPage { Frame(label: "x") }');
const before = JSON.stringify(doc);
foldDoc(doc);
ok('foldDoc leaves its input as it was', JSON.stringify(doc) === before);

// dev keeps every node (HMR addresses them by id)
const dev = compile(pageOf('screen s\nPage { Frame(label: "x") }'), {}, '', {}, {}, { dev: true });
ok('dev compiles every branch, folded or not', dev.includes('frame-url'));

console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
