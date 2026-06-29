// Surgical HMR: edit a node's text → ONLY that node re-renders, all page state survives (no full reload).
// Mounts a real compiled module against the real runtime + a tiny DOM, then applies a compiled patch builder by id.
import { signal, effect, root, onCleanup, computed, __has, __eq, __order, __id, patchNode } from '../dist/runtime.js';
import { parse } from '../dist/engine/lang/parse.js';
import { composeDoc } from '../dist/engine/ir/compose.js';
import { compileModule, compileNodePatch } from '../dist/engine/compile/compile.js';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

let f = 0;
const ok = (l: string, c: boolean): void => { console.log((c ? '✓' : '✗') + ' ' + l); if (!c) f++; };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// minimal DOM — parent/sibling links + replaceWith/firstChild (what patchNode needs). A class so the runtime's
// `fresh instanceof Element` guard (correct in a browser) is satisfied here too.
const detach = (n): void => { const p = n.parentNode; if (p) { const i = p.children.indexOf(n); if (i >= 0) p.children.splice(i, 1); n.parentNode = null; } };
class Element {
  tag; children = []; handlers = {}; className = ''; textContent = ''; value = ''; type = ''; placeholder = ''; parentNode = null;
  constructor(tag: string) { this.tag = tag; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { detach(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(n, ref) { detach(n); n.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, n); else this.children.push(n); return n; }
  removeChild(c) { detach(c); return c; }
  remove() { detach(this); }
  replaceChildren(...ns) { for (const c of this.children.slice()) detach(c); for (const n of ns) this.appendChild(n); }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); detach(n); n.parentNode = p; p.children.splice(i, 1, n); this.parentNode = null; }
  addEventListener(t, fn) { this.handlers[t] = fn; }
  setAttribute(k, v) { this[k] = v; }
}
globalThis.Element = Element as unknown as typeof globalThis.Element;
const makeEl = (tag: string) => new Element(tag);
const app = makeEl('div');
globalThis.document = { getElementById: () => app, createElement: (t) => makeEl(t), createComment: (t) => ({ tag: '#c', text: t, parentNode: null }) } as unknown as Document;

const RT = pathToFileURL(join(process.cwd(), 'dist', 'runtime.js')).href;
const rt = { signal, computed, effect, root, onCleanup, __eq, __order, __has, __id };
const findNode = (doc, needle: string): string => Object.keys(doc.nodes).find((id) => doc.nodes[id].type === 'Span' && JSON.stringify(doc.nodes[id].props || {}).includes(needle))!;

const V1 = 'screen home\nstate { count = 0 : number }\naction inc mutates count { count.set(count + 1) }\nPage {\n  Span "Clicked {count}"\n  Button -> inc { Span "more" }\n}';
const V2 = V1.replace('Clicked {count}', 'Tapped {count}');           // edit: just the Span's text
const V3 = V1.replace('Page {', 'Page class("box") {');               // edit: a container's class (children must survive)

// mount V1 with the real runtime
const docV1 = composeDoc(parse(V1), {}).doc;
const js = compileModule(docV1, {}, '', {}, {}, { dev: true }).replace(/'virtual:muten\/runtime'/g, `'${RT}'`);
const mod = await import('data:text/javascript,' + encodeURIComponent(js));
const el = mod.mount(app);
const inst = el.__muten;
const spanId = findNode(docV1, 'Clicked');
const pageId = Object.keys(docV1.nodes).find((id) => docV1.nodes[id].type === 'Page')!;

await tick();
ok('renders v1', inst.nodes[spanId].el.textContent === 'Clicked 0');
inst.ctx.inc(); inst.ctx.inc(); inst.ctx.inc();                        // user interaction: count -> 3
await tick();
ok('reactive before patch', inst.nodes[spanId].el.textContent === 'Clicked 3');

// PATCH 1 — text edit on the Span
const b1 = eval('(' + compileNodePatch(composeDoc(parse(V2), {}).doc, spanId) + ')');
const p1 = patchNode(inst, spanId, (ctx, parent, nodes) => b1(ctx, nodes, parent, rt));
await tick();
ok('text patch applied', p1 === true);
ok('node shows the NEW template', inst.nodes[spanId].el.textContent === 'Tapped 3');
ok('state survived (count still 3)', inst.ctx.count.get() === 3);
inst.ctx.inc(); await tick();
ok('patched node still reacts to the SAME signal', inst.nodes[spanId].el.textContent === 'Tapped 4');

// PATCH 2 — class edit on the container; its live children must be preserved (same DOM objects), not rebuilt
const childBefore = inst.nodes[spanId].el;
const b2 = eval('(' + compileNodePatch(composeDoc(parse(V3), {}).doc, pageId) + ')');
const p2 = patchNode(inst, pageId, (ctx, parent, nodes) => b2(ctx, nodes, parent, rt));
await tick();
ok('container patch applied', p2 === true);
ok('container shows the new class', inst.nodes[pageId].el.className.includes('box'));
ok('child PRESERVED (same DOM node, not rebuilt)', inst.nodes[spanId].el === childBefore);
ok('child still shows live state', inst.nodes[spanId].el.textContent === 'Tapped 4');

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
