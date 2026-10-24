// react-tree: a React component from npm with what it holds, written the way its docs compose it:
//   LineChart(data: sales) { XAxis(dataKey: "day")  Line(dataKey: "total") }      components inside components
//   Dialog.Root { Dialog.Trigger { Text "Abrir" } … }                              a library's namespaced parts
//   Command.List { each items as it { Command.Item(value: it.name) { Text "{it.name}" } } }   a list, as React children
// The outermost one is an island (its own React root, rendered again when anything it reads changes, unmounted with
// the page). Inside it: a React component is an element, a plain `Text` is its text, `each` / `when` are a map and a
// condition, and any other muten node is built by muten as always and mounted where it sits (a slot), still reactive.
import { Fmt, Nt, UseKind } from '#engine/shared/vocab.js';
import type { ArgValue, Doc, Emitter, ImportDef, NodeProps, Scope, StringPropValue, ThemeKit } from '#engine/shared/types.js';
import { wakeArgs } from '#engine/compile/wake.js';

/** What every page with React gets once: the component a dotted name points at, and the slot a muten node sits in. */
export const REACT_HELPERS = `function __react_pick(ns, head, rest) {
    let found = ns[head] !== undefined ? ns[head] : ns.default && ns.default[head] !== undefined ? ns.default[head] : (rest.length ? ns : ns.default);
    for (const key of rest) found = found == null ? undefined : found[key];
    if (found === undefined && rest.length) { found = ns; for (const key of rest) found = found == null ? undefined : found[key]; }
    return found;
  }
  function __MutenSlot(props) { return __react_h('span', { style: { display: 'contents' }, ref: (host) => { if (host && props.node.parentNode !== host) host.appendChild(props.node); } }); }`;

/** A page module's React, loaded when its first island wakes (runtime-island.ts): React, ReactDOM and every `use react`
 *  library, in one promise kept by the module. Until then the names the island code reads are unset, and nothing reads
 *  them: an island renders only once this has resolved. React and ReactDOM are CommonJS: imported on demand, their
 *  functions sit on the module's `default` (a static import bridged that by itself). */
export function reactLoader(imports: ImportDef[]): string {
  const libraries = imports.filter((def) => def.kind === UseKind.React && !def.script);
  const names = libraries.map((def) => `__react_ns_${def.names[0]}`);
  const loads = ["import('react')", "import('react-dom/client')", ...libraries.map((def) => `import(${JSON.stringify(def.from)})`)];
  return `let __react_h, __react_root${names.map((name) => `, ${name}`).join('')}, __react_ready = null;
const __react_load = () => __react_ready || (__react_ready = Promise.all([${loads.join(', ')}]).then(([__r, __rd${names.map((_, index) => `, __l${index}`).join('')}]) => { __react_h = (__r.createElement ? __r : __r.default).createElement; __react_root = (__rd.createRoot ? __rd : __rd.default).createRoot;${names.map((name, index) => ` ${name} = __l${index};`).join('')} }));`;
}

/** The `use react` line a component name (or its namespace, `Dialog` of `Dialog.Root`) comes from. */
export function reactImport(imports: ImportDef[] | undefined, name: string | undefined): ImportDef | undefined {
  const head = (name || '').split('.')[0];
  return head ? (imports || []).find((def) => def.kind === UseKind.React && def.names.includes(head)) : undefined;
}

// a value crossing into a component: a ref is its live read, a quoted string its text (an interpolated one stays live)
export function argJs(em: Emitter, value: ArgValue, scope: Scope = em.scope): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return em.logic.resolveRef(value.startsWith('@') ? value.slice(1) : value, scope);
  if ('$lit' in value) return value.$interp ? `(${em.interpConcat(value.$interp)})` : JSON.stringify(value.$lit);
  if ('$expr' in value) return em.logic.compileExpr(value.$expr, scope);   // `animate: { opacity: shown ? 1 : 0 }`
  return em.logic.resolveRef(value.$param, scope);
}

function textJs(em: Emitter, value: StringPropValue | undefined, scope: Scope): string {
  if (value === undefined) return '""';
  if (typeof value === 'string') return JSON.stringify(value);
  if ('$param' in value) return em.logic.resolveRef(value.$param, scope);
  return '(' + value.parts.map((part) => (typeof part === 'string' ? JSON.stringify(part) : `String(${em.logic.compileExpr(part, scope)} ?? '')`)).join(' + ') + ')';
}

function propsJs(em: Emitter, p: NodeProps, scope: Scope, key: string): string {
  const classes = (p.class || []).filter((c): c is string => typeof c === 'string');
  return `{ ${[
    ...Object.entries(p.inputs || {}).map(([prop, value]) => `${JSON.stringify(prop)}: ${argJs(em, value, scope)}`),
    ...Object.entries(p.on || {}).map(([event, action]) => `${JSON.stringify('on' + event.charAt(0).toUpperCase() + event.slice(1))}: (...__a) => ${em.logic.actionRef(typeof action === 'string' ? action : '')}(...__a)`),
    ...(classes.length ? [`"className": ${JSON.stringify(classes.join(' '))}`] : []),
    ...(key ? [`"key": ${key}`] : []),
  ].join(', ')} }`;
}

// one node of the tree as a React child expression; `row` is the key of the row it renders in (inside an `each`)
function child(em: Emitter, id: string, scope: Scope, row: string): string {
  const n = em.nodes[id];
  const p = n.props || {};
  const def = n.type === Nt.Custom ? reactImport(em.doc.imports, p.component) : undefined;
  if (def) return element(em, id, def, scope, row);
  if (n.type === Nt.Text && !p.class?.length) return textJs(em, p.value, scope);
  if (n.type === Nt.Each && p.list && p.as) {
    const index = p.index || '__i';
    const inner: Scope = { ...scope, locals: new Set([...scope.locals, p.as, index]) };
    const rowKey = `(${p.as} && ${p.as}.id != null ? ${p.as}.id : ${index})`;
    return `...(${em.logic.compileExpr(p.list, scope)} || []).flatMap((${p.as}, ${index}) => [${n.children.map((kid) => child(em, kid, inner, rowKey)).join(', ')}])`;
  }
  if (n.type === Nt.When && p.cond) return `...((${em.logic.compileExpr(p.cond, scope)}) ? [${n.children.map((kid) => child(em, kid, scope, row)).join(', ')}] : [])`;
  // any other muten node: built once, the muten way, and mounted where it sits
  em.push(`const el_${id}_slot = document.createElement('span'); el_${id}_slot.style.display = 'contents';`);
  em.genNode(id, `el_${id}_slot`);
  return `__react_h(__MutenSlot, { node: el_${id}_slot, key: ${JSON.stringify(id)} })`;
}

function element(em: Emitter, id: string, def: ImportDef, scope: Scope, row: string): string {
  const n = em.nodes[id];
  const [head, ...rest] = (n.props?.component || '').split('.');
  const component = `__react_pick(__react_ns_${def.names[0]}, ${JSON.stringify(head)}, ${JSON.stringify(rest)})`;
  const key = row ? `${row} + ${JSON.stringify(':' + id)}` : '';
  return `__react_h(${[component, propsJs(em, n.props || {}, scope, key), ...n.children.map((kid) => child(em, kid, scope, ''))].join(', ')})`;
}

/** A page with a library theme.muten provides for: the `use` lines its providers call come in too (once). */
export function withThemeImports(doc: Doc, kit: ThemeKit | undefined): Doc {
  const used = new Set((doc.imports || []).filter((def) => def.kind === UseKind.React).map((def) => def.from));
  if (!kit || !kit.providers.some((provider) => used.has(provider.from))) return doc;
  const names = new Set((doc.imports || []).flatMap((def) => def.names));
  const extra = kit.imports.map((def) => ({ ...def, names: def.names.filter((name) => !names.has(name)) })).filter((def) => def.names.length);
  return { ...doc, imports: [...(doc.imports || []), ...extra] };
}

/** The outermost React component: its island, holding the whole tree under it, inside the providers theme.muten gives
 *  its library (made once, when the page opens: they read theme.muten's fixed values). */
export function reactIsland(em: Emitter, id: string, def: ImportDef, parentVar: string): void {
  em.declEl(id, 'div', em.classFor('custom', {}));   // class(…) is the component's className (propsJs), never this box's
  em.push(`el_${id}.style.display = 'contents';`);   // the island's own box is not in the layout: the component sits in its parent's flex or grid
  em.appendEl(id, parentVar);
  let tree = element(em, id, def, em.scope, '');   // builds the slots first: they exist before the first render
  // every library the island holds gets its providers: a MUI card inside a Chakra layout still reads MUI's theme
  const held = new Map<string, ImportDef>();
  const walk = (at: string): void => {
    const n = em.nodes[at];
    const inner = n.type === Nt.Custom ? reactImport(em.doc.imports, n.props?.component) : undefined;
    if (inner && !held.has(inner.from)) held.set(inner.from, inner);
    for (const kid of n.children) walk(kid);
  };
  walk(id);
  const providers = (em.opts.themeKit?.providers || []).filter((provider) => held.has(provider.from));
  for (const [index, provider] of [...providers.entries()].reverse()) {
    const from = held.get(provider.from) || def;
    em.push(`const __provided_${id}_${index} = ${propsJs(em, { inputs: provider.args }, em.scope, '')};`);
    tree = `__react_h(__react_pick(__react_ns_${from.names[0]}, ${JSON.stringify(provider.component)}, []), __provided_${id}_${index}, ${tree})`;
  }
  const render = `const __root = __react_root(el_${id}); effect(() => __root.render(${tree})); onCleanup(() => __root.unmount());`;
  if (!lazyReact(em)) { em.push(`{ ${render} }`); return; }
  // it wakes when its place nears the screen (runtime-island.ts): React and the library load then, and the island renders
  // in a scope of its own, let go with the page; a page left before it woke never loads them
  em.push(`{ let __off = null, __gone = false; const __give = __island(el_${id}, () => __react_load().then(() => { if (!__gone) __off = root(() => { ${render} }).dispose; })${wakeArgs(em.nodes[id].props || {})}); onCleanup(() => { __gone = true; __give(); if (__off) __off(); }); }`);
}

/** Whether this compile's islands wake later (a page module: what `muten dev` and `muten bundle` load). */
export function lazyReact(em: { opts: { format?: string } }): boolean {
  return em.opts.format === Fmt.Module;
}
