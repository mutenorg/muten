// framework-island: a compiled Vue, Svelte (5) or Solid component from npm, mounted as an island, the way a React one is:
//   use vue VueDatePicker from "@vuepic/vue-datepicker"      VueDatePicker(modelValue: day) on("update:modelValue": pick)
//   use svelte Chart from "svelte-chart-lib"                 Chart(data: sales)
//   use solid Sortable from "solid-sortablejs"               Sortable(items: rows) on(change: reorder)
// Its props are live (a muten state it reads changes → the component sees the new value through its own framework's
// reactivity, not by being mounted again), `on(x: act)` is its `onX` prop (Vue's emits listen the same way), and it is
// unmounted with the page. In a page module the framework and the library load when the island nears the screen
// (runtime-island.ts), so a page that never shows it never downloads them. It holds no muten children: a component
// that takes slots is a `Custom` widget written by hand. Svelte and Solid libraries that ship only source (`.svelte`,
// the `solid` export condition) need their compiler and are not read here; their compiled builds are.
import { Fmt, UseKind } from '#engine/shared/vocab.js';
import type { Emitter, ImportDef, NodeProps } from '#engine/shared/types.js';
import { argJs } from '#engine/compile/react-tree.js';
import { wakeArgs } from '#engine/compile/wake.js';

interface FrameworkAdapter {
  /** The framework's own modules: the variable each lands in, and where it comes from. */
  modules: Array<[string, string]>;
  /** The mount, given the component, the host element, the props as a live JS object expression and their keys. */
  mount(component: string, host: string, props: string, keys: string[]): string;
}

// props a framework reads through getters over one live value: what Svelte's and Solid's reactivity can follow
const getters = (keys: string[], read: string): string => `{ ${keys.map((key) => `get ${JSON.stringify(key)}() { return ${read}[${JSON.stringify(key)}]; }`).join(', ')} }`;

const ADAPTERS: ReadonlyMap<UseKind, FrameworkAdapter> = new Map<UseKind, FrameworkAdapter>([
  [UseKind.Vue, {
    modules: [['__fw_vue', 'vue']],
    mount: (component, host, props) => `const __v = __fw_mod(__fw_vue); const __state = __v.shallowRef(null); effect(() => { __state.value = ${props}; });
      const __app = __v.createApp({ render: () => __v.h(${component}, __state.value) }); __app.mount(${host}); onCleanup(() => __app.unmount());`,
  }],
  [UseKind.Svelte, {
    modules: [['__fw_svelte', 'svelte'], ['__fw_svelte_reactivity', 'svelte/reactivity']],
    // createSubscriber is Svelte's own bridge for a value that changes outside it: a getter that subscribes is a prop
    // Svelte re-reads when muten pokes it
    mount: (component, host, props, keys) => `const __s = __fw_mod(__fw_svelte); let __now = null, __poke = null;
      const __subscribe = __fw_mod(__fw_svelte_reactivity).createSubscriber((update) => { __poke = update; return () => { __poke = null; }; });
      effect(() => { __now = ${props}; if (__poke) __poke(); });
      const __app = __s.mount(${component}, { target: ${host}, props: ${getters(keys, '(__subscribe(), __now)')} }); onCleanup(() => __s.unmount(__app));`,
  }],
  [UseKind.Solid, {
    modules: [['__fw_solid', 'solid-js'], ['__fw_solid_web', 'solid-js/web']],
    mount: (component, host, props, keys) => `const __so = __fw_mod(__fw_solid), __web = __fw_mod(__fw_solid_web); const [__get, __set] = __so.createSignal(null, { equals: false });
      effect(() => { const __next = ${props}; __set(() => __next); });
      const __dispose = __web.render(() => __web.createComponent(${component}, ${getters(keys, '__get()')}), ${host}); onCleanup(__dispose);`,
  }],
]);

/** The kinds of `use` this file mounts. */
export const FRAMEWORK_KINDS: ReadonlySet<string> = new Set(ADAPTERS.keys());

const libraryVar = (def: ImportDef): string => `__fw_lib_${def.names[0]}`;

/** What a page with framework islands gets once: each framework's modules and each library, as variables the island
 *  code reads, loaded by `__fw_load()`. In a page module that is a dynamic import (the island's wake calls it); in the
 *  other outputs they are imported up front (or left in scope by use-bundle.ts) and `__fw_load` has nothing to wait for. */
export function frameworkLoader(imports: ImportDef[], format: string | undefined): string {
  const libraries = imports.filter((def) => FRAMEWORK_KINDS.has(def.kind || '') && !def.script);
  if (!libraries.length) return '';
  const modules = new Map<string, string>();
  for (const def of libraries) for (const [name, from] of ADAPTERS.get(def.kind || UseKind.React)?.modules || []) modules.set(name, from);
  for (const def of libraries) modules.set(libraryVar(def), def.from);
  const unwrap = 'const __fw_mod = (m) => (m && m.default && Object.keys(m).length === 1 ? m.default : m);';
  if (format !== Fmt.Module) return [...[...modules].map(([name, from]) => `import * as ${name} from ${JSON.stringify(from)};`), unwrap, 'const __fw_load = () => Promise.resolve();'].join('\n');
  const names = [...modules.keys()];
  return `let ${names.join(', ')}, __fw_ready = null;\n${unwrap}
const __fw_load = () => __fw_ready || (__fw_ready = Promise.all([${[...modules.values()].map((from) => `import(${JSON.stringify(from)})`).join(', ')}]).then((__m) => { ${names.map((name, index) => `${name} = __m[${index}];`).join(' ')} }));`;
}

/** The names use-bundle.ts leaves in scope for a framework island: the same variables frameworkLoader imports. */
export function frameworkExports(def: ImportDef): Array<[string, string]> {
  return [...(ADAPTERS.get(def.kind || UseKind.React)?.modules || []), [libraryVar(def), def.from]];
}

// `change` → onChange, `value-change` → onValueChange, `update:modelValue` → onUpdate:modelValue (Vue's v-model event)
const handlerName = (event: string): string => {
  const [head, ...rest] = event.split(':');
  const camel = head.replace(/-(.)/g, (_, next: string) => next.toUpperCase());
  return 'on' + camel.charAt(0).toUpperCase() + camel.slice(1) + rest.map((part) => ':' + part).join('');
};

// Svelte 5 callback props are as often `onpick` (the way `onclick` is spelled) as `onPick`: a Svelte island gets both
function propsJs(em: Emitter, p: NodeProps, lowerToo: boolean): { code: string; keys: string[] } {
  const entries: Array<[string, string]> = Object.entries(p.inputs || {}).map(([prop, value]): [string, string] => [prop, argJs(em, value)]);
  for (const [event, action] of Object.entries(p.on || {})) {
    const handler = `(...__a) => ${em.logic.actionRef(typeof action === 'string' ? action : '')}(...__a)`;
    const name = handlerName(event);
    entries.push([name, handler]);
    if (lowerToo && name.toLowerCase() !== name) entries.push([name.toLowerCase(), handler]);
  }
  const classes = (p.class || []).filter((c): c is string => typeof c === 'string');
  if (classes.length) entries.push(['class', JSON.stringify(classes.join(' '))]);
  return { code: `({ ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(', ')} })`, keys: entries.map(([key]) => key) };
}

/** A Vue, Svelte or Solid component: its island. */
export function frameworkIsland(em: Emitter, id: string, def: ImportDef, parentVar: string): void {
  const adapter = ADAPTERS.get(def.kind || UseKind.React);
  if (!adapter) return;
  em.declEl(id, 'div', em.classFor('custom', {}));
  em.push(`el_${id}.style.display = 'contents';`);   // like a React island: the component sits in its parent's layout
  em.appendEl(id, parentVar);
  const name = em.nodes[id].props?.component || '';
  const component = `(${libraryVar(def)}[${JSON.stringify(name)}] ?? __fw_mod(${libraryVar(def)})[${JSON.stringify(name)}] ?? __fw_mod(${libraryVar(def)}).default ?? __fw_mod(${libraryVar(def)}))`;
  const { code, keys } = propsJs(em, em.nodes[id].props || {}, def.kind === UseKind.Svelte);
  const mount = adapter.mount(component, `el_${id}`, code, keys);
  // it wakes when its place nears the screen (a page module), or at once: either way after __fw_load, in a scope of its
  // own let go with the page; a page left before it woke never loads it
  const wake = `() => __fw_load().then(() => { if (!__gone) __off = root(() => { ${mount} }).dispose; })`;
  em.push(em.opts.format === Fmt.Module
    ? `{ let __off = null, __gone = false; const __give = __island(el_${id}, ${wake}${wakeArgs(em.nodes[id].props || {})}); onCleanup(() => { __gone = true; __give(); if (__off) __off(); }); }`
    : `{ let __off = null, __gone = false; (${wake})(); onCleanup(() => { __gone = true; if (__off) __off(); }); }`);
}
