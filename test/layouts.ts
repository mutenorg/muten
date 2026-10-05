// Layouts: `layout pro { … slot … }` + `"/x" -> page in pro`. The chrome a group of routes shares is mounted ONCE and
// kept while navigating between them (only the page inside its `slot` swaps); a route outside it drops it. Also: a
// part carries its own `use` imports, so a layout (or page) that inlines it needs no matching import of its own.
import { parse } from '#engine/lang/parse.js';
import { print as printIR } from '#engine/ir/print.js';
import { compose, composeDoc } from '#engine/ir/compose.js';
import { mergeImports } from '#engine/ir/imports.js';
import { layoutDiagnostics } from '#engine/project/layouts.js';
import { compileModule } from '#engine/compile/compile.js';
import { layoutDoc, layoutLoaders } from '../dist/layout-modules.js';
import { route } from '../dist/runtime.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

// ── parse + print ──
const app = parse(`
layout pro {
  Nav "Menu" { Link "Citas" -> "/a" }
  slot
}
routes {
  "/a"   -> alpha in pro guard auth.ok else "/login"
  "/b"   -> beta in pro
  "/pub" -> pub
  "/login" -> login
}`);
ok('layout parsed with its children', app.layouts?.pro?.type === 'Layout' && app.layouts.pro.children.length === 2, JSON.stringify(app.layouts));
ok('`in pro` sets the route layout', app.routes[0].layout === 'pro' && app.routes[1].layout === 'pro' && !app.routes[2].layout);
ok('`in` coexists with guard', app.routes[0].guard === "auth.ok" && app.routes[0].redirect === '/login');
const printed = printIR(app);
ok('print round-trips `in` and the layout block', printed.includes('-> alpha in pro guard') && printed.includes('layout pro {'), printed);
ok('printed text parses back the same layout', parse(printed).routes[1].layout === 'pro');

// ── diagnostics ──
const codes = (src) => layoutDiagnostics(parse(src)).map((d) => d.code + ':' + d.severity);
ok('unknown layout is an error', codes(`routes { "/a" -> a in pr }`).includes('unknown-layout:error'));
ok('unknown layout suggests the close one', layoutDiagnostics(parse(`layout pro { slot }\nroutes { "/a" -> a in pr }`)).find((d) => d.code === 'unknown-layout')?.suggestion === 'pro');
ok('a layout with no slot is an error', codes(`layout pro { Nav "x" { } }\nroutes { "/a" -> a in pro }`).includes('layout-slot:error'));
ok('a layout with two slots is an error', codes(`layout pro { slot  slot }\nroutes { "/a" -> a in pro }`).includes('layout-slot:error'));
ok('an unused layout is a warning, not an error', codes(`layout pro { slot }\nroutes { "/a" -> a }`).join() === 'unused-layout:warning');
ok('a correct app has no layout diagnostics', codes(`layout pro { slot }\nroutes { "/a" -> a in pro }`).length === 0);

// ── compose keeps the layout outlet; parts bring their imports ──
const parts = { Menu: { params: [], tree: { type: 'Nav', props: {}, children: [{ type: 'Span', props: { text: 'x' } }] }, imports: [{ names: ['t'], from: '~/lib/i18n.ts' }] } };
const layoutTree = { type: 'Layout', props: {}, children: [{ type: 'Menu', props: {} }, { type: 'slot', props: {} }] };
ok('a page compose drops a top-level slot', compose(layoutTree, parts).tree.children.every((c) => c.type !== 'slot'));
ok('a layout compose keeps its slot', compose(layoutTree, parts, true).tree.children.some((c) => c.type === 'slot'));
const { doc } = composeDoc({ screen: 'layout-pro', tree: layoutTree, imports: [] }, parts, true);
ok('a used part carries its import into the doc', JSON.stringify(doc.imports) === JSON.stringify([{ names: ['t'], from: '~/lib/i18n.ts' }]), JSON.stringify(doc.imports));
ok('the page own import wins, no duplicate name', JSON.stringify(mergeImports([{ names: ['t'], from: '~/a.ts' }], [{ names: ['t', 'u'], from: '~/b.ts' }])) === JSON.stringify([{ names: ['t'], from: '~/a.ts' }, { names: ['u'], from: '~/b.ts' }]));

// ── the runner's layout module ──
const built = layoutDoc({ screen: 'app', layouts: { pro: layoutTree }, imports: [] }, parts, 'pro');
const js = built && compileModule(built.doc, {}, built.css, {}, {}, {});
ok('a layout compiles to a module that returns its outlet', !!js && js.includes('__outlet') && /return __outlet/.test(js), js ? js.slice(-300) : 'null');
ok('an unknown layout yields nothing', layoutDoc({ screen: 'app', layouts: {} }, parts, 'nope') === null);
ok('boot loaders name every layout', layoutLoaders({ layouts: { pro: layoutTree, admin: layoutTree } }).includes('"admin": () => import("virtual:muten/layout/admin")'));

// ── a link created after navigation is born marked active (a menu opened later) ──
const linkJs = compileModule(composeDoc(parse(`state { open = false : bool }\naction show mutates open { open.set(true) }\nPage { Button "Menú" -> show  when open { Link "A" -> "/a" } }`), {}).doc, {}, '', {}, {}, {});
ok('a Link marks itself active when created on its own path', /getAttribute\('href'\) === location\.pathname\) \{ el_\w+\.classList\.add\('is-active'\)/.test(linkJs), linkJs.slice(0, 400));

// ── the router keeps the layout across its routes (a minimal DOM) ──
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...n) { this.children = [...n]; }
  querySelector() { return null; }
  setAttribute() {}
}
const listeners = {};
globalThis.Element = El; globalThis.HTMLElement = El;
globalThis.document = { createElement: (t) => new El(t), head: new El('head'), querySelectorAll: () => [], title: '' };
globalThis.location = { pathname: '/a' };
globalThis.history = { pushState: (_s, _t, to) => { location.pathname = to; }, replaceState: (_s, _t, to) => { location.pathname = to; } };
globalThis.addEventListener = (type, fn) => { listeners[type] = fn; };
globalThis.scrollTo = () => {};

const pageOf = (name) => ({ css: '', mount(root) { const e = new El('page:' + name); root.appendChild(e); return e; } });
let layoutMounts = 0, layoutLoads = 0;
const proLayout = { css: '', mount(root) { layoutMounts++; const wrap = new El('layout'); const slot = new El('outlet'); wrap.appendChild(new El('menu')); wrap.appendChild(slot); root.appendChild(wrap); return slot; } };
const outlet = new El('root-outlet');
const tick = () => new Promise((r) => setTimeout(r, 0));
const go = async (to) => { location.pathname = to; listeners.popstate(); await tick(); await tick(); };

route(outlet, {
  '/a': { load: async () => pageOf('a'), layout: 'pro' },
  '/b': { load: async () => pageOf('b'), layout: 'pro' },
  '/pub': { load: async () => pageOf('pub') },
}, { pro: async () => { layoutLoads++; return proLayout; } });
await tick(); await tick();
const chrome = outlet.children[0];
ok('first route mounts its layout, page inside the slot', chrome?.tag === 'layout' && chrome.children[1].children[0]?.tag === 'page:a', JSON.stringify(outlet.children.map((c) => c.tag)));
await go('/b');
ok('same layout: NOT remounted on navigation', layoutMounts === 1 && outlet.children[0] === chrome, `mounts=${layoutMounts}`);
ok('only the page swapped inside the slot', chrome.children[1].children.length === 1 && chrome.children[1].children[0].tag === 'page:b');
await go('/pub');
ok('a route outside the layout drops it', outlet.children.length === 1 && outlet.children[0].tag === 'page:pub', JSON.stringify(outlet.children.map((c) => c.tag)));
await go('/a');
ok('coming back mounts the layout again', layoutMounts === 2 && outlet.children[0].tag === 'layout' && layoutLoads === 2, `mounts=${layoutMounts} loads=${layoutLoads}`);

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
