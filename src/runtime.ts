// runtime.ts: fine-grained signals runtime, the only Muten code that ships to the browser.
// Shared by every compiled .muten module. Vite serves it as `virtual:muten/runtime`;
// the standalone HTML format inlines an equivalent. No dependencies, ~50 lines.

import type { Signal, EffectRun, PageModule, RouteDef, PageInstance, NodeRegistry } from '#engine/shared/types.js';

// The HMR handle lives on the mounted page element (`el.__muten`); the dev client reaches it + the runtime via window.
declare global {
  interface Element { __muten?: PageInstance; }
  interface Window { __muten_page?: PageInstance; __muten_screen?: string; __muten_rt?: { [k: string]: unknown }; }
}

let current: EffectRun | null = null;            // effect currently running, so reads can subscribe it
let owner: Array<EffectRun | (() => void)> | null = null;   // effects + onCleanup teardowns in the current scope, disposed together

// Reactive cell: reading inside an effect subscribes it; writing notifies subscribers.
export function signal<T>(value: T): Signal<T> {
  const subs = new Set<EffectRun>();
  return {
    get() { if (current) { subs.add(current); current.deps.add(subs); } return value; },
    set(next: T) { if (next === value) return; value = next; for (const run of [...subs]) run.sync ? run() : schedule(run); },
  };
}

// Batching (Solid-style): many sets in one tick flush effects once, in a microtask, so a burst
// of updates re-renders each spot a single time. Computed effects are `sync` (run immediately)
// so a `get` read elsewhere in the same tick is never stale.
let pending: Set<EffectRun> | null = null;
function flush(): void { const runs = pending; pending = null; if (runs) for (const run of runs) run(); }
function schedule(run: EffectRun): void { if (!pending) { pending = new Set(); queueMicrotask(flush); } pending.add(run); }

// Runs `fn`, tracking every signal it reads; re-runs whenever any of those signals changes.
export function effect(fn: () => void, sync?: boolean): EffectRun {
  const run: EffectRun = Object.assign(
    () => {
      if (run.disposed) return;
      for (const dep of run.deps) dep.delete(run); // drop previous subscriptions before re-tracking
      run.deps.clear();
      const prev = current; current = run;
      try { fn(); } finally { current = prev; }
    },
    { deps: new Set<Set<EffectRun>>(), disposed: false, sync },
  );
  if (owner) owner.push(run); // belongs to the current scope, disposable on unmount/navigation
  run();
  return run;
}

// Runs `fn`, collecting every effect it creates, and returns a disposer that stops them all.
// The router uses this so an unmounted page's effects stop firing on shared store signals,
// avoiding detached-DOM crashes (anchor.parentNode === null).
function disposeOwned(owned: Array<EffectRun | (() => void)>): void {
  for (const o of owned) {
    if ('deps' in o) { o.disposed = true; for (const dep of o.deps) dep.delete(o); o.deps.clear(); } // effect
    else o(); // onCleanup teardown (keyed list disposing rows, when disposing its block)
  }
}
export function root<T>(fn: () => T): { value: T; dispose: () => void } {
  const prev = owner; const owned: Array<EffectRun | (() => void)> = []; owner = owned;
  let value: T; try { value = fn(); } finally { owner = prev; }
  return { value, dispose: () => disposeOwned(owned) };
}
export function scope(fn: () => void): () => void { return root(fn).dispose; }
export function onCleanup(fn: () => void): void { if (owner) owner.push(fn); }

// SURGICAL HMR: rebuild ONE node by id against the SAME live signals (ctx), keeping its CHILDREN (their DOM,
// effects and state) and every sibling intact — muten's "address + mutate by id" made real at runtime, no VDOM,
// no full reload. `build(ctx, parent, nodes)` builds the node's OWN element + own props/effects (NOT its
// children) and returns that element. We then re-parent the existing children into it and dispose only this
// node's own scope, so a class/text/attr edit never resets a child's signal. Returns false (caller reloads) for
// an unknown/detached node, or when `build` doesn't yield an element (a structural change the diff should catch).
export function patchNode(inst: PageInstance, id: string, build: (ctx: { [k: string]: unknown }, parent: Element, nodes: NodeRegistry) => Element): boolean {
  const node = inst.nodes[id];
  if (!node || !node.el.parentNode) return false;
  let fresh: Element | undefined;
  const dispose = root(() => { fresh = build(inst.ctx, node.parent, inst.nodes); }).dispose; // node's own effects in a fresh scope
  if (!(fresh instanceof Element)) { dispose(); return false; }
  while (node.el.firstChild) fresh.appendChild(node.el.firstChild); // move existing children — their state/effects survive
  node.dispose?.();                                                 // re-patch: stop the prior patch's scope. First patch: the original effects stay on the detached node (cleaned on nav) — ponytail: dev leak bounded by edit count
  node.el.replaceWith(fresh);                                       // swap in place — siblings untouched
  inst.nodes[id] = { el: fresh, dispose, parent: node.parent };
  return true;
}

// `a contains b`: list membership or case-insensitive substring, one operator for both.
export function __has<T>(a: readonly T[] | string | null | undefined, b: T): boolean {
  if (Array.isArray(a)) return a.includes(b);
  return String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
}

// Shallow value equality: keyed reconciliation uses this to skip rows whose data didn't change.
export function __eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  return true;
}

// Keyed-list reconciliation: positions the new order with the minimum DOM moves via the
// longest increasing subsequence (like Vue/Svelte/Solid). A 2-row swap moves 2 nodes, not O(n).
function __lisSet(arr: number[]): Set<number> {
  const p = arr.slice();
  const result: number[] = [0];
  const len = arr.length;
  for (let i = 0; i < len; i++) {
    const a = arr[i];
    if (a === 0) continue; // 0 means a new row, not part of the existing increasing run
    const j = result[result.length - 1];
    if (arr[j] < a) { p[i] = j; result.push(i); continue; }
    let u = 0, v = result.length - 1;
    while (u < v) { const c = (u + v) >> 1; if (arr[result[c]] < a) u = c + 1; else v = c; }
    if (a < arr[result[u]]) { if (u > 0) p[i] = result[u - 1]; result[u] = i; }
  }
  let u = result.length, v = result[u - 1];
  while (u-- > 0) { result[u] = v; v = p[v]; }
  return new Set(result);
}

// Reorder `next` (new row entries) under `parent` with the fewest DOM moves; `prev` is the old order.
export function __order(parent: Node, ref0: Node, next: { nodes: ChildNode[] }[], prev: { nodes: ChildNode[] }[]): void {
  const n = next.length;
  if (!n) return;
  const pi = new Map<{ nodes: ChildNode[] }, number>();
  for (let i = 0; i < prev.length; i++) pi.set(prev[i], i + 1); // 1-based so 0 stays "new"
  const oldIdx = new Array<number>(n);
  let moved = false, max = 0;
  for (let i = 0; i < n; i++) { const o = pi.get(next[i]) || 0; oldIdx[i] = o; if (o !== 0) { if (o < max) moved = true; else max = o; } }
  const ls = moved ? __lisSet(oldIdx) : null; // compute LIS only when rows actually reordered
  let ref: Node = ref0;
  for (let i = n - 1; i >= 0; i--) {
    const e = next[i];
    if (oldIdx[i] === 0 || (ls && !ls.has(i))) { for (const node of e.nodes) parent.insertBefore(node, ref); } // new, or not in the stable subsequence: move
    ref = e.nodes[0] || ref;
  }
}

// Derived/memoized value (a store `get`): recomputes when the signals it reads change.
// Seeded eagerly, then kept current by a sync effect that tracks its dependencies.
export function computed<T>(fn: () => T): Signal<T> {
  const cell = signal(fn());
  effect(() => cell.set(fn()), true); // sync: a `get` read in the same tick is always fresh
  return cell;
}

let seq = 0;
export function __id(): string {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + (++seq);
}

// Injects a page/shell stylesheet once, deduped by content (re-mounting a route doesn't pile up <style>s).
const injected = new Set<string>();
export function injectCss(css: string): void {
  if (!css || injected.has(css)) return;
  injected.add(css);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

// Applies a page's `meta` to <head>: sets the title and upserts each meta tag (og:* -> property, else name).
export function applyMeta(meta: { [key: string]: string }): void {
  if (meta.title) document.title = meta.title;
  for (const name in meta) {
    if (name === 'title' || !meta[name]) continue;
    const attr = name.indexOf('og:') === 0 ? 'property' : 'name';
    let el = document.head.querySelector(`meta[${attr}="${name}"]`);
    if (!el) { el = document.createElement('meta'); el.setAttribute(attr, name); document.head.appendChild(el); }
    el.setAttribute('content', meta[name]);
  }
}

// History router: real-path URLs (/about, /product/42). Intercepts internal <a> clicks, syncs on
// popstate, scrolls to top, applies each page's <head> meta, and falls back to the first route as a
// soft 404. A guard is a () => boolean over a store signal; when it flips the tracking effect re-runs,
// so routes + navbar react to auth automatically. (Deploy: serve index.html for any path.)
export function route(outlet: Element, routes: { [path: string]: RouteDef }): void {
  const keys = Object.keys(routes);
  // pre-split each route key into segments; a ":x" segment matches any value and captures it as x.
  const patterns = keys.map((key) => ({ key, segs: key.replace(/^\//, '').split('/').filter(Boolean) }));
  // match a path to a route, capture its :params; fall back to the first route (soft 404).
  const matchRoute = (path: string): { def: RouteDef; params: { [k: string]: string } } => {
    const parts = path.replace(/^\//, '').split('/').filter(Boolean);
    for (const { key, segs } of patterns) {
      if (segs.length !== parts.length) continue;
      const params: { [k: string]: string } = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (segs[i][0] === ':') params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (segs[i] !== parts[i]) { ok = false; break; }
      }
      if (ok) return { def: routes[key], params };
    }
    return { def: routes['/404'] || routes[keys[0]], params: {} }; // no match: `/404` page if defined, else the first route
  };
  let mounted: string | null = null;        // path currently shown, to avoid re-mounting on every auth tick
  let disposePage: (() => void) | null = null;
  const go = (to: string): void => { if (to !== location.pathname) { history.pushState({}, '', to); mounted = null; render(); } };
  const render = (): void => {
    const path = location.pathname || keys[0];
    const { def, params } = matchRoute(path);
    if (def.guard && !def.guard()) {          // unauthorized: redirect (replaceState, then re-render)
      const to = def.redirect ?? '/';
      if (location.pathname !== to) { history.replaceState({}, '', to); mounted = null; render(); }
      return;
    }
    if (path === mounted) return;
    mounted = path;
    // load-then-swap: keep the current page on screen until the next one is ready, then replace in ONE frame.
    // (Clearing before the async load left a blank gap that made the whole UI flash/jump on every navigation.)
    def.load().then((module: PageModule) => {
      if (mounted !== path) return;            // a newer navigation superseded this load — drop the stale result
      if (disposePage) disposePage();          // stop the previous page's effects to avoid stale-DOM crashes
      injectCss(module.css);
      if (module.meta) applyMeta(module.meta);
      disposePage = scope(() => {
        outlet.replaceChildren();
        const pageEl = module.mount(outlet, params); // atomic swap: no blank frame
        if (typeof window !== 'undefined') { window.__muten_page = pageEl.__muten; window.__muten_screen = module.screen; } // dev HMR target
      });
      scrollTo(0, 0);
      const main = outlet.querySelector('main'); if (main instanceof HTMLElement) main.focus(); // a11y: move focus to content on nav (the <main> is tabIndex -1)
    });
  };
  // intercept internal link clicks for client-side navigation (external/new-tab/downloads pass through)
  addEventListener('click', (e: Event) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const a = t.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href[0] === '#' || a.getAttribute('target') || a.hasAttribute('download') || /^[a-z]+:|^\/\//i.test(href)) return;
    e.preventDefault();
    go(href);
  });
  addEventListener('popstate', () => { mounted = null; render(); });
  // tracking every guard signal ensures logging in/out re-renders the active route automatically.
  effect(() => { for (const key of keys) { const guard = routes[key].guard; if (guard) guard(); } render(); });
}

// dev HMR: the injected client evals a compiled patch builder and needs these runtime fns in scope. Harmless in prod.
if (typeof window !== 'undefined') window.__muten_rt = { patchNode, signal, computed, effect, root, onCleanup, __eq, __order, __has, __id };
