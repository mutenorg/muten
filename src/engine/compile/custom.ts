// custom: the code of a `Custom` node. Three kinds of thing mount there:
//   · a host-written widget (`src/components/Name.js`, or one from npm with `use widget`): mount(el, inputs, on),
//     re-called with the inputs when it returns an updater and an input it reads changes;
//   · a Web Component (`use element Name "tag" from "pkg"`): the tag, its props set as PROPERTIES (what Lit/Shoelace
//     read), written when they change, its events to actions with the event's detail (or the element's value);
//   · a React component (`use react Name from "pkg"`): an island holding its own tree, composed as the library's docs
//     show it (react-tree.ts); `on(select: x)` is its `onSelect` prop;
//   · a compiled Vue, Svelte or Solid component (`use vue Name from "pkg"`…): an island of one (framework-island.ts).
import { Nt, UseKind } from '#engine/shared/vocab.js';
import type { ArgValue, Emitter, FlatNode, ImportDef, NodeEmitter, NodeProps } from '#engine/shared/types.js';
import { argJs, reactIsland } from '#engine/compile/react-tree.js';
import { FRAMEWORK_KINDS, frameworkIsland } from '#engine/compile/framework-island.js';
import { wakeArgs } from '#engine/compile/wake.js';

const actionJs = (em: Emitter, action: ArgValue): string => em.logic.actionRef(typeof action === 'string' ? action : '');
const foreignOf = (em: Emitter, name: string | undefined): ImportDef | undefined => (name ? (em.doc.imports || []).find((def) => def.kind && def.names.includes(name.split('.')[0])) : undefined);

function webComponent(em: Emitter, id: string, tag: string, p: NodeProps, parentVar: string, hasChildren: boolean): void {
  em.declEl(id, tag, em.classFor('custom', p));
  for (const [prop, value] of Object.entries(p.inputs || {})) em.push(`__bind(el_${id}, ${JSON.stringify(prop)}, () => ${argJs(em, value)});`);
  for (const [event, action] of Object.entries(p.on || {})) em.push(`el_${id}.addEventListener(${JSON.stringify(event)}, (e) => ${actionJs(em, action)}(e.detail !== undefined && e.detail !== null ? e.detail : e.target && e.target.value));`);
  if (hasChildren) em.genChildren(id, `el_${id}`);   // slotted children
  em.appendEl(id, parentVar);
}

function custom(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const name = p.component || '';
  const foreign = foreignOf(em, name);
  if (foreign?.kind === UseKind.Element) { webComponent(em, id, foreign.tag || 'div', p, parentVar, !!n.children?.length); return; }
  if (foreign?.kind === UseKind.React) { reactIsland(em, id, foreign, parentVar); return; }   // with the tree it holds (react-tree.ts)
  if (foreign?.kind && FRAMEWORK_KINDS.has(foreign.kind)) { frameworkIsland(em, id, foreign, parentVar); return; }   // Vue, Svelte, Solid
  em.declEl(id, 'div', em.classFor('custom', p));
  em.appendEl(id, parentVar);
  const inputs = Object.entries(p.inputs || {}).map(([key, value]) => `${JSON.stringify(key)}: ${argJs(em, value)}`).join(', ');
  const handlers = Object.entries(p.on || {}).map(([event, action]) => `${JSON.stringify(event)}: (...__a) => ${actionJs(em, action)}(...__a)`).join(', ');
  // a mount that returns an updater is re-called whenever an input it reads changes; one that returns nothing stays
  // a mount-time snapshot (backward compatible)
  const mount = `if (typeof __custom_${name} === 'function') { const __u${id} = __custom_${name}(el_${id}, { ${inputs} }, { ${handlers} }); if (typeof __u${id} === 'function') effect(() => __u${id}({ ${inputs} })); }`;
  // `lazy`: mounted as its place nears the screen, like a React island (runtime-island.ts), so what its mount imports
  // (fruta, a QR library, a map) is downloaded then; leaving the page before that never mounts nor downloads it
  // `wake idle | load | media "(…)"` holds it back the same way, until its moment (wake.ts)
  if (p.lazy || p.wake) em.push(`{ let __off = null, __gone = false; const __give = __island(el_${id}, () => { if (!__gone) __off = root(() => { ${mount} }).dispose; return Promise.resolve(); }${wakeArgs(p)}); onCleanup(() => { __gone = true; __give(); if (__off) __off(); }); }`);
  else em.push(mount);
}

/** How a Custom node becomes DOM code. */
export const CUSTOM_NODES: ReadonlyMap<string, NodeEmitter> = new Map<string, NodeEmitter>([[Nt.Custom, custom]]);
