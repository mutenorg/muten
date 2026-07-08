// runtime.ts: fine-grained signals runtime, the only Muten code that ships to the browser.
// Shared by every compiled .muten module. The runner serves it as the `virtual:muten/runtime`
// module (imported per-use, tree-shaken); the standalone HTML format inlines an equivalent. No dependencies.

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

// Native chart: draw bar/line/area/point marks + a y-axis into an <svg> from `rows`, reading the `x`/`y`
// field encodings. Full redraw per data change — charts are small, so keyed reconciliation isn't worth it.
// Aesthetic defaults (no config needed): rounded bars, SMOOTH cubic curves (cardinal spline, not jagged
// polylines), a real accent→transparent gradient area (inline `style` so it beats the CSS fill), round-number
// axis ticks formatted compactly (3k / 1.2M), and a donut center-total.
export function __chart(svg: Element, rows: ReadonlyArray<{ [field: string]: unknown }>, enc: { x: string; y: string; kind?: string; color?: string }, legend?: Element | null): void {
  const data = Array.isArray(rows) ? rows : [];
  const NS = 'http://www.w3.org/2000/svg';
  // NOTHING hardcoded: all layout reads CSS custom properties (with fallbacks), so the theme / a class configures
  // viewBox, padding, tick count, bar gap and donut thickness — no code change. (Colors already come from CSS.)
  const cs = getComputedStyle(svg);
  const num = (name: string, def: number): number => { const v = parseFloat(cs.getPropertyValue(name)); return isFinite(v) ? v : def; };
  // render at the REAL pixel size (viewBox = client box) so axis text stays crisp at any width and nothing clips —
  // fall back to the CSS vars only before layout (a ResizeObserver redraws once the element has a measured size).
  const W = svg.clientWidth || num('--chart-w', 320), H = svg.clientHeight || num('--chart-h', 200);
  const pL = num('--chart-pad-left', 34), pR = num('--chart-pad-right', 12), pT = num('--chart-pad-top', 12), pB = num('--chart-pad-bottom', 24);
  const iw = W - pL - pR, ih = H - pT - pB, TICKS = Math.max(1, Math.round(num('--chart-ticks', 4))), BARGAP = num('--chart-bar-gap', 0.42), DONUT = num('--chart-donut-inner', 0.62);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const mk = (t: string, a: { [k: string]: string | number }, tx?: string): Element => {
    const e = document.createElementNS(NS, t);
    for (const k in a) e.setAttribute(k, String(a[k]));
    if (tx != null) e.textContent = tx;
    return e;
  };
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!data.length) return;
  // compact axis number: 3000 -> 3k, 1250000 -> 1.2M (references never show "9000").
  const fmtN = (v: number): string => { const a = Math.abs(v), r = (x: number): string => { const s = x.toFixed(1); return s.slice(-2) === '.0' ? s.slice(0, -2) : s; }; return a >= 1e9 ? r(v / 1e9) + 'B' : a >= 1e6 ? r(v / 1e6) + 'M' : a >= 1e3 ? r(v / 1e3) + 'k' : String(Math.round(v)); };
  const kind = enc.kind || 'bar', radial = kind === 'pie' || kind === 'donut';
  const cf = enc.color || (radial ? enc.x : ''), six: { [k: string]: number } = {}; let sn = 0;
  const scls = (base: string, r: { [field: string]: unknown }): string => { if (!cf) return base; const k = String(r[cf]); return `${base} mu-chart-s${(k in six) ? six[k] : (six[k] = sn++)}`; };
  const doLegend = (): void => {
    if (!legend) return;
    while (legend.firstChild) legend.removeChild(legend.firstChild);
    if (cf) for (const k in six) { const li = document.createElement('li'); li.className = 'mu-chart-legend-item'; const sw = document.createElement('span'); sw.className = `mu-chart-swatch mu-chart-s${six[k]}`; const tx = document.createElement('span'); tx.className = 'mu-chart-legend-label'; tx.textContent = k; li.appendChild(sw); li.appendChild(tx); legend.appendChild(li); }
  };
  if (radial) { // pie / donut — slices summing to 360°, colored by the x label (arc path inlined so __chart is self-contained)
    const arc = (X: number, Y: number, R: number, a0: number, a1: number, RI: number): string => {
      const rad = (d: number): number => (d - 90) * Math.PI / 180, s = rad(a0), e = rad(a1), lg = (a1 - a0) > 180 ? 1 : 0;
      const x0 = X + R * Math.cos(s), y0 = Y + R * Math.sin(s), x1 = X + R * Math.cos(e), y1 = Y + R * Math.sin(e);
      if (RI <= 0) return `M${X},${Y} L${x0},${y0} A${R},${R} 0 ${lg} 1 ${x1},${y1} Z`;
      const xi0 = X + RI * Math.cos(e), yi0 = Y + RI * Math.sin(e), xi1 = X + RI * Math.cos(s), yi1 = Y + RI * Math.sin(s);
      return `M${x0},${y0} A${R},${R} 0 ${lg} 1 ${x1},${y1} L${xi0},${yi0} A${RI},${RI} 0 ${lg} 0 ${xi1},${yi1} Z`;
    };
    const total = data.reduce((a, r) => a + (Number(r[enc.y]) || 0), 0) || 1;
    const RAD = Math.min(iw, ih) / 2 - 2, RI = kind === 'donut' ? RAD * DONUT : 0, ccx = pL + iw / 2, ccy = pT + ih / 2;
    let a = 0;
    for (const r of data) { const v = Number(r[enc.y]) || 0, a1 = a + v / total * 360; svg.appendChild(mk('path', { d: arc(ccx, ccy, RAD, a, a1, RI), class: scls('mu-chart-slice', r) })); a = a1; }
    if (kind === 'donut') svg.appendChild(mk('text', { x: ccx, y: ccy, class: 'mu-chart-total', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, fmtN(total))); // center total
    doLegend(); return;
  }
  // round-number axis: pick a "nice" step (1/2/2.5/5 ×10^k), so ticks land on 3k/6k/9k, never 2250.
  const rawMax = Math.max(0, ...data.map((r) => Number(r[enc.y]) || 0));
  let step = 1, mx = 1;
  if (rawMax > 0) { const rough = rawMax / TICKS, mag = Math.pow(10, Math.floor(Math.log10(rough))), norm = rough / mag; step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag; mx = Math.ceil(rawMax / step) * step; }
  const sy = (v: number): number => pT + ih - (v / mx) * ih;
  for (let v = 0; v <= mx + step / 1e6; v += step) { const y = sy(v); svg.appendChild(mk('line', { x1: pL, y1: y, x2: W - pR, y2: y, class: 'mu-chart-grid' })); svg.appendChild(mk('text', { x: pL - 7, y: y + 3, class: 'mu-chart-tick', 'text-anchor': 'end' }, fmtN(v))); }
  const n = data.length, bw = iw / n;
  if (kind === 'scatter') {
    const xs = data.map((r) => Number(r[enc.x]) || 0), xmax = Math.max(1, ...xs), xmin = Math.min(0, ...xs), xr = (xmax - xmin) || 1;
    data.forEach((r) => svg.appendChild(mk('circle', { cx: pL + ((Number(r[enc.x]) || 0) - xmin) / xr * iw, cy: sy(Number(r[enc.y]) || 0), r: 4, class: scls('mu-chart-dot', r) })));
  } else if (kind === 'line' || kind === 'area' || kind === 'point') {
    const pts = data.map((r, i): [number, number] => [pL + bw * (i + 0.5), sy(Number(r[enc.y]) || 0)]);
    // cardinal spline → smooth cubic path (each segment's control points aim along the neighbours), so the line
    // curves gently like the reference dashboards instead of a jagged polyline.
    const smooth = (ps: Array<[number, number]>, k: number): string => {
      if (ps.length < 2) return ps.length ? `M${ps[0][0]},${ps[0][1]}` : '';
      let d = `M${ps[0][0]},${ps[0][1]}`;
      for (let i = 0; i < ps.length - 1; i++) {
        const p0 = ps[i - 1] || ps[i], p1 = ps[i], p2 = ps[i + 1], p3 = ps[i + 2] || p2;
        d += ` C${p1[0] + (p2[0] - p0[0]) * k},${p1[1] + (p2[1] - p0[1]) * k} ${p2[0] - (p3[0] - p1[0]) * k},${p2[1] - (p3[1] - p1[1]) * k} ${p2[0]},${p2[1]}`;
      }
      return d;
    };
    const line = smooth(pts, 0.18);
    if (kind === 'area') { // gradient fill (accent → transparent) via inline style so the CSS `.mu-chart-area` fill never clobbers it
      const gid = 'mcg' + Math.floor(Math.random() * 1e9);
      const df = mk('defs', {}), lg = mk('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      lg.appendChild(mk('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': 0.28 }));
      lg.appendChild(mk('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': 0 }));
      df.appendChild(lg); svg.appendChild(df);
      const fill = mk('path', { d: `${line} L${pts[n - 1][0]},${pT + ih} L${pts[0][0]},${pT + ih} Z`, class: 'mu-chart-area' });
      fill.setAttribute('style', `fill:url(#${gid});fill-opacity:1`);
      svg.appendChild(fill);
    }
    if (kind !== 'point') svg.appendChild(mk('path', { d: line, class: 'mu-chart-line', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    if (kind !== 'area') data.forEach((r, i) => svg.appendChild(mk('circle', { cx: pts[i][0], cy: pts[i][1], r: 3, class: scls('mu-chart-dot', r) })));
  } else {
    data.forEach((r, i) => { const y = sy(Number(r[enc.y]) || 0), w = bw * (1 - BARGAP), h = (pT + ih) - y, rx = Math.min(w / 2, h / 2, 6); svg.appendChild(mk('rect', { x: pL + bw * i + bw * BARGAP / 2, y, width: w, height: Math.max(h, 0.01), rx, class: scls('mu-chart-bar', r) })); });
  }
  if (kind !== 'scatter') data.forEach((r, i) => svg.appendChild(mk('text', { x: pL + bw * (i + 0.5), y: H - pB + 15, class: 'mu-chart-xlabel', 'text-anchor': 'middle' }, r[enc.x] == null ? '' : String(r[enc.x]))));
  doLegend();
}

// SVG arc/sector path — pie slice (inner 0) or donut segment (inner > 0). Angles in DEGREES, 0 = top, clockwise.
export function __arc(cx: number, cy: number, r: number, a0: number, a1: number, ri?: number): string {
  const X = Number(cx), Y = Number(cy), R = Number(r), RI = Number(ri) || 0;
  const rad = (deg: number): number => (Number(deg) - 90) * Math.PI / 180;
  const s = rad(a0), e = rad(a1);
  const large = Math.abs(Number(a1) - Number(a0)) > 180 ? 1 : 0;
  const x0 = X + R * Math.cos(s), y0 = Y + R * Math.sin(s), x1 = X + R * Math.cos(e), y1 = Y + R * Math.sin(e);
  if (RI <= 0) return `M${X},${Y} L${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} Z`;
  const xi0 = X + RI * Math.cos(e), yi0 = Y + RI * Math.sin(e), xi1 = X + RI * Math.cos(s), yi1 = Y + RI * Math.sin(s);
  return `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${xi0},${yi0} A${RI},${RI} 0 ${large} 0 ${xi1},${yi1} Z`;
}

// ── Pointer-based drag & drop (dnd-kit-inspired, NOT flaky HTML5 DnD) ──────────────────────────────────
// A floating overlay clone follows the pointer; collision = the INNERMOST registered zone under the pointer,
// so NESTED drop zones never double-fire (the outer never steals an inner drop). Pointer events → touch works;
// transforms → no layout thrash / no re-render. All visuals are CSS: .mu-dnd-overlay / .mu-dnd-ghost / .mu-dnd-over.
interface DndZone { group: string; onDrop: (id: string) => void; }
const __dndZones = new Map<Element, DndZone>();
let __dndActive: { id: string; overlay: HTMLElement; src: HTMLElement; dx: number; dy: number; over: Element | null } | null = null;

function __dndMove(e: PointerEvent): void {
  const d = __dndActive; if (!d) return;
  d.overlay.style.transform = `translate(${e.clientX - d.dx}px, ${e.clientY - d.dy}px)`;
  d.overlay.style.visibility = 'hidden';                                   // don't let the overlay eat the hit-test
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  d.overlay.style.visibility = 'visible';
  let zone: Element | null = null;
  for (const el of stack) { if (__dndZones.has(el)) { zone = el; break; } } // top-of-stack first → innermost zone wins
  if (zone !== d.over) { if (d.over) d.over.classList.remove('mu-dnd-over'); if (zone) zone.classList.add('mu-dnd-over'); d.over = zone; }
}
function __dndEnd(): void {
  window.removeEventListener('pointermove', __dndMove);
  window.removeEventListener('pointerup', __dndEnd);
  const d = __dndActive; __dndActive = null; if (!d) return;
  d.overlay.remove(); d.src.classList.remove('mu-dnd-ghost');
  if (d.over) { d.over.classList.remove('mu-dnd-over'); const z = __dndZones.get(d.over); if (z) z.onDrop(d.id); }
}
// register a drag source. Config from CSS custom props (nothing hardcoded): `--mu-dnd-z` (overlay stacking) and
// `--mu-dnd-activation` (px the pointer must move before a drag starts — so a plain click never drags; the dnd-kit
// "activation constraint"). getId is read live, at grab time.
export function __drag(el: HTMLElement, getId: () => string): void {
  el.style.touchAction = 'none'; el.classList.add('mu-dnd-item');
  el.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || __dndActive) return;
    const cs = getComputedStyle(el);
    const threshold = parseFloat(cs.getPropertyValue('--mu-dnd-activation')) || 0;
    const z = cs.getPropertyValue('--mu-dnd-z').trim() || '99999';
    const sx = e.clientX, sy = e.clientY;
    const begin = (ev: PointerEvent): void => {
      const clone = el.cloneNode(true); if (!(clone instanceof HTMLElement)) return;
      const r = el.getBoundingClientRect();
      clone.classList.add('mu-dnd-overlay');
      clone.style.cssText += `;position:fixed;left:0;top:0;width:${r.width}px;height:${r.height}px;margin:0;pointer-events:none;z-index:${z};`;
      document.body.appendChild(clone);
      el.classList.add('mu-dnd-ghost');
      __dndActive = { id: getId(), overlay: clone, src: el, dx: sx - r.left, dy: sy - r.top, over: null };
      __dndMove(ev);
      window.addEventListener('pointermove', __dndMove);
      window.addEventListener('pointerup', __dndEnd);
    };
    if (threshold <= 0) { e.preventDefault(); begin(e); return; }
    const pre = (ev: PointerEvent): void => {                               // activation constraint: click-safe
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < threshold) return;
      window.removeEventListener('pointermove', pre); window.removeEventListener('pointerup', cancel);
      ev.preventDefault(); begin(ev);
    };
    const cancel = (): void => { window.removeEventListener('pointermove', pre); window.removeEventListener('pointerup', cancel); };
    window.addEventListener('pointermove', pre); window.addEventListener('pointerup', cancel);
  });
}
// register a drop zone; on drop the innermost zone under the pointer fires onDrop(draggedId).
export function __drop(el: Element, group: string, onDrop: (id: string) => void): void { __dndZones.set(el, { group, onDrop }); }

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
  // mark the current nav link: any internal `<a>` whose href equals the path gets `aria-current="page"` + `.is-active`
  // (shell nav + page links). So `class(active when …)` isn't needed for nav highlight, and the a11y state is real.
  const markActive = (): void => {
    const here = location.pathname;
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (href[0] !== '/' || href.slice(0, 2) === '//') return; // internal absolute paths only
      const on = href === here;
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      a.classList.toggle('is-active', on);
    });
  };
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
      markActive(); // shell nav + page links reflect the new path (aria-current + .is-active)
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

// dev HMR/DevTools: the injected client evals a compiled patch builder and reaches the runtime fns via window.
// PROD never reads __muten_rt, so this registry is gated to dev — otherwise naming __chart/__arc/__drag/__drop here
// keeps them reachable and defeats the per-page tree-shaking (a counter would ship the whole chart+DnD runtime).
// `__MUTEN_DEV__` is replaced by the bundler (`define`): dev → true (registry kept), prod → false → this whole
// branch is dead-code-eliminated, and any helper no page imports drops out.
declare const __MUTEN_DEV__: boolean;
// `typeof window` FIRST so an unbundled consumer (a Node import of runtime.js, where __MUTEN_DEV__ is undefined)
// short-circuits before touching it — no ReferenceError. In a browser bundle the `define` folds `… && false` → DCE.
if (typeof window !== 'undefined' && __MUTEN_DEV__) window.__muten_rt = { patchNode, signal, computed, effect, root, onCleanup, __eq, __order, __has, __id, __chart, __arc, __drag, __drop };
