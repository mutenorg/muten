// Components from npm, used like parts: `use element|widget|react`. Parsed into a Custom node (inputs, events, live
// updates); compiled per kind; validated like any reference. The browser behaviour is covered end to end in the
// repro bench (a Web Component, a widget and a React island, in `bundle` and `build`).
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compileModule } from '#engine/compile/compile.js';
import { validate } from '#engine/ir/validate.js';
import { foreignImport } from '#engine/compile/foreign.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const SRC = `screen s
use element Rating "sl-rating" from "@shoelace-style/shoelace/dist/components/rating/rating.js"
use widget Map from "leaflet-widget"
use react Picker from "react-day-picker"
use fmt from "date-fns"
state { stars = 3 : number  day = "" : text }
action rate(n: number) mutates stars { stars.set(n) }
action pick(d: text) mutates day { day.set(d) }
Page {
  Rating(value: stars, max: 5) on(sl-change: rate) class("big") { Span "slotted" }
  Map(center: day) on(move: pick)
  Picker(selected: day) on(select: pick)
}`;
const ir = parse(SRC);
ok('use element keeps its tag and kind', ir.imports.some((i) => i.kind === 'element' && i.tag === 'sl-rating' && i.names[0] === 'Rating'));
ok('use widget / use react keep their kind', ir.imports.some((i) => i.kind === 'widget' && i.names[0] === 'Map') && ir.imports.some((i) => i.kind === 'react' && i.names[0] === 'Picker'));
ok('a plain use still imports functions', ir.imports.some((i) => !i.kind && i.names[0] === 'fmt'));
const rating = ir.tree.children[0];
ok('a call becomes a Custom node with its props, kebab events and class', rating.type === 'Custom' && rating.props.component === 'Rating' && rating.props.inputs.value === 'stars' && rating.props.on['sl-change'] === 'rate' && rating.props.class?.includes('big'), JSON.stringify(rating.props));
ok('slotted children ride along', rating.children?.[0]?.type === 'Span');

const js = compileModule(toDoc(ir));
ok('the element registers by importing its module', js.includes('import "@shoelace-style/shoelace/dist/components/rating/rating.js";'));
ok('the element is its own tag, props bound as properties', js.includes("document.createElement('sl-rating')") && /__bind\(el_\w+, "value", \(\) => stars\.get\(\)\);/.test(js), js.match(/[^\n]*sl-rating[^\n]*/)?.[0]);
ok('its event reaches the action with the detail', /addEventListener\("sl-change", \(e\) => rate\(e\.detail !== undefined/.test(js));
ok('a widget imports its mount', js.includes('import { mount as __custom_Map } from "leaflet-widget";'));
ok('a React island: named or default export, rendered in an effect, on(select) is onSelect', js.includes('import * as __react_ns_Picker from') && js.includes('function __react_pick(ns, head, rest)') && /__root\.render\(__react_h\(__react_pick\(__react_ns_Picker, "Picker", \[\]\), \{ "selected": day\.get\(\), "onSelect": /.test(js) && js.includes("import { createRoot as __react_root } from 'react-dom/client';"), js.match(/__root\.render\([^\n]*/)?.[0]);
ok('the island unmounts with the page', js.includes('onCleanup(() => __root.unmount())'));
ok('foreignImport: the app\'s own file by name', foreignImport({ names: ['a', 'b'], from: '~/lib/x.ts' }) === 'import { a, b } from "~/lib/x.ts";');
ok('foreignImport: a package by name, or on its default export', foreignImport({ names: ['a', 'b'], from: 'x' }) === 'import * as __pkg_0 from "x";\nconst a = __pkg_0.a ?? __pkg_0.default?.a;\nconst b = __pkg_0.b ?? __pkg_0.default?.b;', foreignImport({ names: ['a', 'b'], from: 'x' }));

const typo = validate(toDoc(parse('screen s\nuse element Rating "x-r" from "x"\nstate { stars = 1 : number }\nPage { Rating(value: starz) }'))).diagnostics;
ok('a prop that reads an unknown state is an error', typo.some((d) => d.code === 'unknown-ref' && /starz/.test(d.message)), JSON.stringify(typo.map((d) => d.code)));
let threw = ''; try { parse('screen s\nuse element Rating "x-r" from "x"\nPage { Rating(value: 1) aria(label: "x") }'); } catch (e) { threw = e.message; }
ok('only props, on() and class() attach to a component from npm', /cannot be attached to `Rating`/.test(threw), threw);

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
