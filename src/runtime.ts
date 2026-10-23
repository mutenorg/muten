// runtime.ts: fine-grained signals runtime, the only Muten code that ships to the browser.
// Shared by every compiled .muten module. The runner serves it as the `virtual:muten/runtime`
// module (imported per-use, tree-shaken); the standalone HTML format inlines an equivalent. No dependencies.

import type { PageModule, RouteDef, LayoutDefs, PageInstance, NodeRegistry } from '#engine/shared/types.js';
// the way out of a block (`__leave`): its own module, re-exported for the compiled pages
import { __leave } from './runtime-leave.js';
import { __rowKey } from './runtime-key.js';
import { __drag, __drop } from './dnd.js';
export { __leave, __rowKey, __drag, __drop };
import { __device } from './runtime-device.js';
import { __urlRead, __urlSet } from './runtime-url.js';
import { __watchImages } from './runtime-media.js';
import { __t, __lang, __langUse, __langInit, __langList } from './runtime-lang.js';
export { __device, __urlRead, __urlSet, __watchImages, __t, __lang, __langUse, __langInit, __langList };

// The HMR handle lives on the mounted page element (`el.__muten`); the dev client reaches it + the runtime via window.
declare global {
  interface Element { __muten?: PageInstance; }
  interface Window { __muten_page?: PageInstance; __muten_screen?: string; __muten_rt?: { [k: string]: unknown }; }
}

// The reactive core (signals, derived values, effects, scopes) lives in runtime-signals.ts.
import { signal, computed, effect, untrack, root, scope, onCleanup } from './runtime-signals.js';
export { signal, computed, effect, untrack, root, scope, onCleanup };

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
  for (const k of ka) if (Reflect.get(a, k) !== Reflect.get(b, k)) return false;
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
  const cf = enc.color || (radial ? enc.x : ''), six: { [k: string]: number } = Object.create(null); let sn = 0;
  const scls = (base: string, r: { [field: string]: unknown }): string => { if (!cf) return base; const k = String(r[cf]); return `${base} mu-chart-s${Object.prototype.hasOwnProperty.call(six, k) ? six[k] : (six[k] = sn++)}`; };
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

// Pointer-based drag & drop lives in ./dnd.ts (one engine for the DSL's draggable/droptarget and @muten/core/dnd).

// A reactive text or attribute: written when its value really changed, never just because the effect ran again (a row
// patched elsewhere comes back as a new object and re-runs all its bindings). One call per binding in the output.
export function __bind(element: Element, property: string, read: () => unknown): void {
  let was: unknown;
  effect(() => { const now = read(); if (now !== was) { was = now; Reflect.set(element, property, now); } });
}

// A static subtree as HTML: parsed into a template the first time, cloned every time after (the compiler sends every
// subtree with nothing reactive inside this way, instead of one createElement per node).
const templates = new Map<string, Element>();
export function __clone(html: string): Element {
  let template = templates.get(html);
  if (!template) {
    const holder = document.createElement('template');
    holder.innerHTML = html;
    const first = holder.content.firstElementChild;
    if (!first) throw new Error('muten: an empty static template');
    template = first; templates.set(html, template);
  }
  const copy = template.cloneNode(true);
  if (!(copy instanceof Element)) throw new Error('muten: a static template cloned to a non-element');
  // a link is born active on its own path (genNode marks each one it builds; the router marks them on navigation)
  if (typeof location !== 'undefined') {
    for (const link of [copy, ...copy.querySelectorAll('a.mu-link')]) {
      if (link.matches('a.mu-link') && link.getAttribute('href') === location.pathname) { link.classList.add('is-active'); link.setAttribute('aria-current', 'page'); }
    }
  }
  return copy;
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
// A route `in` a layout mounts inside that layout's `slot`. The layout is mounted once and KEPT while the user moves
// between its routes: only the page is swapped, so the chrome (a sidebar, a tab bar) is never rebuilt on navigation.
export function route(outlet: Element, routes: { [path: string]: RouteDef }, layouts: LayoutDefs = {}): void {
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
  let layoutName: string | null = null;     // the layout currently mounted in the outlet (null = the page sits there directly)
  let layoutOutlet: Element | null = null;  // that layout's `slot`, where its routes' pages mount
  let disposeLayout: (() => void) | null = null;
  // mount the layout a route asks for, reusing the one on screen when it is the same; returns where the page goes
  const pageTarget = (want: string | null, layoutModule: PageModule | null): Element => {
    if (want === layoutName && (layoutOutlet || !want)) return layoutOutlet || outlet;
    if (disposeLayout) disposeLayout();
    disposeLayout = null; layoutOutlet = null; layoutName = null;
    outlet.replaceChildren();
    if (want && layoutModule) {
      const chrome = layoutModule;
      injectCss(chrome.css);
      disposeLayout = scope(() => { layoutOutlet = chrome.mount(outlet); });
      layoutName = want;
    }
    return layoutOutlet || outlet;
  };
  // mark the current nav link: any internal `<a>` whose href equals the path gets `aria-current="page"` + `.is-active`
  // (shell nav + page links). So `class(active when …)` isn't needed for nav highlight, and the a11y state is real.
  // Below a section (a sub-route like /shop/design/colors) the link of the section it is in stays marked: `.is-active`
  // + `aria-current="true"`, only the longest such link (a menu never lights two entries). A link that stands for
  // several pages says so with `data(match: "/a /b")`: on any of them it is marked as the section too.
  const markActive = (): void => {
    const here = location.pathname;
    const links = [...document.querySelectorAll('a[href]')].filter((a) => { const h = a.getAttribute('href') || ''; return h[0] === '/' && h.slice(0, 2) !== '//'; }); // internal absolute paths only
    const covers = (a: Element): boolean => { const h = a.getAttribute('href') || ''; return (h !== '/' && here.startsWith(h.replace(/\/$/, '') + '/')) || (a.getAttribute('data-match') || '').split(/\s+/).includes(here); };
    // per menu (its nav, sidebar or header): a menu that already shows the page itself does not also light the section
    const menuOf = (a: Element): Element | null => a.closest('nav, aside, header, [role="navigation"]');
    const shown = new Set(links.filter((a) => a.getAttribute('href') === here).map(menuOf));
    const best = new Map<Element | null, Element>();
    for (const a of links.filter(covers)) {
      const m = menuOf(a); if (shown.has(m)) continue;
      const was = best.get(m); if (!was || (a.getAttribute('href') || '').length > (was.getAttribute('href') || '').length) best.set(m, a);
    }
    const sections = new Set(best.values());
    links.forEach((a) => {
      const href = a.getAttribute('href') || '';
      const on = href === here, inside = !on && sections.has(a);
      if (on) a.setAttribute('aria-current', 'page'); else if (inside) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
      a.classList.toggle('is-active', on || inside);
    });
  };
  // every in-app entry carries how many steps into the app it is (`history.state.muDepth`): 0 on the page the visitor
  // landed on, +1 per navigation. A back button reads it to know whether «back» stays inside the app; at 0 it goes to
  // the app's default screen instead of doing nothing (a page opened from a link) or leaving the app.
  const depth = (): number => { const state: { muDepth?: number } | null = history.state; return state && typeof state.muDepth === 'number' ? state.muDepth : 0; };
  // The section a link names (`/terms#withdrawal`), once its page is on screen. False when the page has no such id.
  const toSection = (hash: string, smooth: boolean): boolean => {
    let el: HTMLElement | null = null;
    try { el = hash ? document.getElementById(decodeURIComponent(hash)) : null; } catch { el = null; }
    if (!el) return false;
    el.scrollIntoView({ block: 'start', behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
    return true;
  };
  const go = (to: string): void => {
    const cut = to.indexOf('#');
    const here = location.pathname + (location.search || '');
    // Only the section moves on the page already open (same path, same query): the address keeps it and the page
    // scrolls to it, with no re-mount. Re-mounting re-ran every query of the page and then opened it at its top.
    if (cut >= 0 && (to.slice(0, cut) || here) === here) {
      if (to !== here + (location.hash || '')) history.pushState({ muDepth: depth() + 1 }, '', to);
      toSection(to.slice(cut + 1), true);
      return;
    }
    if (to !== location.pathname) { history.pushState({ muDepth: depth() + 1 }, '', to); mounted = null; render(); }
  };
  const render = (): void => {
    const path = location.pathname || keys[0];
    const { def, params } = matchRoute(path);
    if (def.guard && !def.guard()) {          // unauthorized: redirect (replaceState, then re-render)
      const to = def.redirect ?? '/';
      if (location.pathname !== to) { history.replaceState({ muDepth: depth() }, '', to); mounted = null; render(); }
      return;
    }
    if (path === mounted) return;
    mounted = path;
    // load-then-swap: keep the current page on screen until the next one is ready, then replace in ONE frame.
    // (Clearing before the async load left a blank gap that made the whole UI flash/jump on every navigation.)
    const want = def.layout && layouts[def.layout] ? def.layout : null;
    const layoutLoad: Promise<PageModule | null> = want && want !== layoutName ? layouts[want]() : Promise.resolve(null);
    // while it loads, the links to it say so (`data-loading`, and the document is `aria-busy`): a menu can turn the
    // section's icon into a spinner. Only past a beat, so a page already in memory never flickers.
    const busy = setTimeout(() => { if (mounted !== path) return; document.documentElement?.setAttribute('aria-busy', 'true'); document.querySelectorAll('a[href]').forEach((a) => { if (a.getAttribute('href') === path) a.setAttribute('data-loading', ''); }); }, 120);
    const unbusy = (): void => { clearTimeout(busy); document.documentElement?.removeAttribute('aria-busy'); document.querySelectorAll?.('a[data-loading]').forEach((a) => a.removeAttribute('data-loading')); };
    Promise.all([def.load(), layoutLoad]).then(([module, layoutModule]) => {
      if (mounted !== path) return;            // a newer navigation superseded this load — drop the stale result
      unbusy();
      if (disposePage) disposePage();          // stop the previous page's effects to avoid stale-DOM crashes
      disposePage = null;
      const target = pageTarget(want, layoutModule);
      injectCss(module.css);
      if (module.meta) applyMeta(module.meta);
      disposePage = scope(() => {
        target.replaceChildren();
        const pageEl = module.mount(target, params); // atomic swap: no blank frame
        if (typeof window !== 'undefined') { window.__muten_page = pageEl.__muten; window.__muten_screen = module.screen; } // dev HMR target
      });
      // a new page opens at its top at once (even under scroll-behavior: smooth), or at the section its address names
      if (!toSection((location.hash || '').slice(1), false)) scrollTo({ top: 0, left: 0, behavior: 'instant' });
      markActive(); // shell nav + page links reflect the new path (aria-current + .is-active)
      const main = target.querySelector('main'); if (main instanceof HTMLElement) main.focus({ preventScroll: true }); // a11y: move focus to content on nav (the <main> is tabIndex -1)
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
  // Back/forward re-renders only when the PATH changed. A step that only moves the query or the hash (a page keeping
  // its open tab or section in `?s=…`) stays on the same mounted page: re-mounting it would re-run every query of
  // the page for a change the page itself already reflects (it listens to popstate for its own state).
  addEventListener('popstate', () => { if (location.pathname !== mounted) render(); });
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
if (typeof window !== 'undefined' && __MUTEN_DEV__) window.__muten_rt = { patchNode, signal, computed, effect, root, onCleanup, __device, __urlRead, __urlSet, __watchImages, __t, __lang, __langUse, __langInit, __langList, __eq, __rowKey, __order, __leave, __has, __id, __chart, __arc, __drag, __drop, __clone, __bind };
