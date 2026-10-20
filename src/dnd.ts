// DRAG AND DROP — pointer-based (dnd-kit-inspired, NOT flaky HTML5 DnD). One engine for both doors: the DSL's
// `draggable(id)` / `droptarget(group) on(drop: …)` (compiled to `__drag` / `__drop`, through the runtime) and the
// public `@muten/core/dnd` (`draggable` / `droppable`) for hand-written code: a `Custom`, an editor, a canvas tool.
//
// Two shapes, one engine. PLAIN: what you drag follows the pointer (a 1:1 floating copy, or the item itself when
// the caller moves it), the INNERMOST zone under the pointer is «over», and on release that zone receives it.
// SORTABLE (a list whose container carries `.mu-sortable`): the dragged row is lifted out and a real PLACEHOLDER
// is slotted where it will land, so the browser's own layout reflows the rest; on release its neighbour gives the
// sort it lands before. The base of dnd-kit is here: activation by distance or by press-and-hold (touch), the
// floating copy or none, an axis lock, edge scrolling on both axes, Esc to cancel, and every step reported with
// where the pointer is, how far it moved, where the item was taken by, and where it is inside the zone it is over.

/** A point on screen (viewport pixels). */
export interface DndPoint { x: number; y: number; }
/** A box on screen (viewport pixels). */
export interface DndRect { left: number; top: number; width: number; height: number; }
/** What a draggable carries besides its id (plain values, so it can be read anywhere). */
export interface DndData { [key: string]: string | number | boolean | null; }
/** One moment of a drag, as every handler receives it. */
export interface DragInfo {
  id: string;
  data: DndData;
  point: DndPoint;        // the pointer now
  start: DndPoint;        // the pointer where the drag began
  delta: DndPoint;        // point − start (0 on a locked axis)
  grab: DndPoint;         // where the item was taken by, from its top-left corner
  rect: DndRect;          // the item's box when it was taken
  over: Element | null;   // the drop zone under the pointer (the innermost one that accepts it)
  local: DndPoint | null; // the pointer inside that zone, from its top-left corner
}
type DragHandler = (info: DragInfo) => void;
export interface DraggableOptions {
  id: string | (() => string);            // read when the drag begins
  data?: DndData | (() => DndData);
  overlay?: boolean;                      // a floating 1:1 copy follows the pointer (default); false: you move the item
  handle?: Element;                       // where it is taken by (default: the item)
  distance?: number;                      // px the pointer moves before it is a drag (a click never drags)
  delay?: number;                         // ms pressed before it is a drag (touch: hold, then drag)
  tolerance?: number;                     // px it may move while that delay runs
  axis?: 'x' | 'y';                       // only along this axis
  zIndex?: number;                        // of the floating copy
  onStart?: DragHandler;
  onMove?: DragHandler;
  onEnd?: DragHandler;                    // released (over a zone or not: see `over`)
  onCancel?: DragHandler;                 // Esc: nothing lands
}
export interface DroppableOptions {
  group?: string;
  accept?: (info: DragInfo) => boolean;   // a zone that says no is passed over (the one under it may take it)
  onEnter?: DragHandler;
  onOver?: DragHandler;                   // every move while it is over this zone
  onLeave?: DragHandler;
  onDrop?: DragHandler;
}

// a zone: its group, the DSL's drop action (id, sort it lands before), and the hand-written handlers
interface DndZone { group: string; onDrop?: (id: string, before?: string) => void; hooks?: DroppableOptions; }
// `ox`/`oy` correct for a transformed ancestor: the overlay is `position:fixed` but lives under the item's parent
// (to keep scoped CSS matching), and a `transform`/`filter`/`will-change` on any ancestor makes `fixed` resolve
// against THAT box, not the viewport — which threw the copy far from the finger on mobile, where such transforms
// are common. The containing-block origin is measured once and subtracted from the viewport pointer coords.
interface DragBase {
  id: string; data: DndData; opts: DraggableOptions; overlay: HTMLElement | null; item: HTMLElement;
  start: DndPoint; grab: DndPoint; rect: DndRect; ox: number; oy: number;
}
interface PlainDrag extends DragBase { mode: 'plain'; over: Element | null; }
interface SortDrag extends DragBase { mode: 'sort'; container: HTMLElement; placeholder: HTMLElement; onDrop: (id: string, before?: string) => void; seen: Set<HTMLElement>; }
type Drag = PlainDrag | SortDrag;

const zones = new Map<Element, DndZone>();
const SORTABLE_MARK = 'mu-sortable';
const EDGE = 64;          // px from a scroll box's edge where a drag scrolls it
const TOLERANCE = 5;      // px a press-and-hold may wander before it gives up
const AXES: ('x' | 'y')[] = ['x', 'y'];
let active: Drag | null = null;
let point: DndPoint = { x: 0, y: 0 };
let tick = 0;

// ── the sheet over the page while a drag lasts: the grab cursor (on <body> it restyled the whole page twice per
// drag), and the wheel still scrolls whatever is under it ──
let shield: HTMLElement | null = null;
function shieldOn(z: number): void {
  const sheet = document.createElement('div');
  sheet.className = 'mu-dnd-shield';
  sheet.style.cssText = `position:fixed;inset:0;z-index:${Math.max(0, z - 1)};cursor:grabbing;background:transparent;`;
  sheet.addEventListener('wheel', (e) => {
    sheet.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    sheet.style.pointerEvents = '';
    if (!under) return;
    const box = scroller(under, e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) ? 'x' : 'y');
    box.scrollBy({ left: e.shiftKey ? e.deltaY : e.deltaX, top: e.shiftKey ? 0 : e.deltaY });
    if (active) moved(active);
  }, { passive: true });
  document.body.appendChild(sheet); shield = sheet;
}
function shieldOff(): void { if (shield) { shield.remove(); shield = null; } }

// nearest ancestor (incl. el) that is a registered drop zone
function zoneOf(el: Element | null): HTMLElement | null {
  for (let n: Element | null = el; n; n = n.parentElement) if (zones.has(n) && n instanceof HTMLElement) return n;
  return null;
}
// the zones inside a sortable container, in DOM order, skipping the hidden source and the placeholder
function zonesIn(d: SortDrag): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const c of Array.from(d.container.children)) if (c instanceof HTMLElement && zones.has(c) && c !== d.item) out.push(c);
  return out;
}
// The drag "family" is a container's `mu-sort-<name>` class: a row only crosses into another sortable of the SAME
// family (items into item lists; groups among groups). A new draggable section just gives its lists a shared
// `mu-sortable mu-sort-<name>` and cross-list drag works.
function family(el: HTMLElement): string {
  for (const c of Array.from(el.classList)) if (c.startsWith('mu-sort-')) return c;
  return '';
}
function sortableAt(x: number, y: number, like: HTMLElement): HTMLElement | null {
  const fam = family(like);
  for (const el of document.elementsFromPoint(x, y))
    for (let n: Element | null = el; n; n = n.parentElement)
      if (n instanceof HTMLElement && n.classList.contains(SORTABLE_MARK) && zones.has(n) && family(n) === fam) return n;
  return null;
}

/** The drag at this moment, as its handlers receive it. */
function infoOf(d: Drag, over: Element | null): DragInfo {
  const r = over?.getBoundingClientRect();
  return { id: d.id, data: d.data, point: { ...point }, start: { ...d.start }, delta: { x: point.x - d.start.x, y: point.y - d.start.y },
    grab: { ...d.grab }, rect: { ...d.rect }, over, local: r ? { x: point.x - r.left, y: point.y - r.top } : null };
}

// SORTABLE: slot the placeholder where the pointer sits, and let native layout reflow the rest — then FLIP the rows
// that moved (measure before/after, invert with a transform, play back to 0) so the reorganisation glides instead of
// snapping. If the pointer is over a DIFFERENT sortable of the same family, the row crosses into it.
function sortTo(d: SortDrag, pointerX: number, pointerY: number): void {
  if (d.overlay) d.overlay.style.visibility = 'hidden';
  const target = sortableAt(pointerX, pointerY, d.container);
  if (d.overlay) d.overlay.style.visibility = 'visible';
  const switching = target !== null && target !== d.container;
  const oldC = d.container;
  if (switching && target) { d.container = target; d.seen.add(target); }
  const newZones = zonesIn(d);
  // A column compares against each row's vertical middle. A flex-row or a wrapping grid reads left-to-right,
  // top-to-bottom: land before the first cell the pointer is ahead of in that order.
  const flow = getComputedStyle(d.container);
  const horizontal = flow.display.includes('grid') || (flow.display.includes('flex') && flow.flexDirection.startsWith('row'));
  let before: Element | null = null;
  for (const z of newZones) {
    const r = z.getBoundingClientRect();
    const hit = horizontal ? (pointerY < r.top || (pointerY <= r.bottom && pointerX < r.left + r.width / 2)) : (pointerY < r.top + r.height / 2);
    if (hit) { before = z; break; }
  }
  // The first trailing child that is NOT a sortable cell (an «Add» tile, a skeleton): landing goes before it.
  let tail: Element | null = null;
  for (const c of Array.from(d.container.children)) {
    if (c === d.item || c === d.placeholder) continue;
    if (c instanceof HTMLElement && zones.has(c)) continue;
    tail = c; break;
  }
  const anchor = before ?? tail;
  const moves = switching || (anchor ? d.placeholder.nextElementSibling !== anchor : d.container.lastElementChild !== d.placeholder);
  if (!moves) return;
  const oldZones = switching ? Array.from(oldC.children).filter((c): c is HTMLElement => c instanceof HTMLElement && zones.has(c) && c !== d.item && c !== d.placeholder) : [];
  const first = new Map<HTMLElement, DndPoint>();
  for (const z of [...oldZones, ...newZones]) { const r = z.getBoundingClientRect(); first.set(z, { x: r.left, y: r.top }); }
  if (anchor) d.container.insertBefore(d.placeholder, anchor);
  else d.container.appendChild(d.placeholder);
  const all = [...oldZones, ...newZones];
  for (const z of all) {
    const f = first.get(z);
    const r = z.getBoundingClientRect();
    const dx = (f ? f.x : 0) - r.left, dy = (f ? f.y : 0) - r.top;
    if (dx || dy) { z.style.transition = 'none'; z.style.transform = `translate(${dx}px, ${dy}px)`; }
  }
  requestAnimationFrame(() => {
    for (const z of all) if (z.style.transform) { z.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)'; z.style.transform = ''; }
  });
}

// ── EDGE SCROLL, both axes. Near an edge of its scroll box a drag scrolls it, faster the closer it gets, so a target
// out of view can be reached (on a phone the finger holds the item and cannot also scroll). The box is the one of the
// zone it is over (a timeline it is carried into), else its own list's. ──
function scroller(el: Element, axis: 'x' | 'y'): HTMLElement {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (!(n instanceof HTMLElement)) continue;
    const cs = getComputedStyle(n);
    const overflow = axis === 'x' ? cs.overflowX : cs.overflowY;
    const more = axis === 'x' ? n.scrollWidth > n.clientWidth : n.scrollHeight > n.clientHeight;
    if ((overflow === 'auto' || overflow === 'scroll') && more) return n;
  }
  const page = document.scrollingElement;
  return page instanceof HTMLElement ? page : document.documentElement;
}
const edgeStep = (at: number, lo: number, hi: number): number => (at < lo + EDGE ? -Math.ceil((lo + EDGE - at) / 4) : at > hi - EDGE ? Math.ceil((at - hi + EDGE) / 4) : 0);
function edge(): void {
  const d = active; if (!d) { tick = 0; return; }
  const from = d.mode === 'sort' ? d.container : d.over ?? d.item;
  let scrolled = false;
  for (const axis of AXES) {
    if (d.opts.axis && d.opts.axis !== axis) continue;
    const box = scroller(from, axis);
    const whole = box === document.scrollingElement || box === document.documentElement;
    const r = box.getBoundingClientRect();
    const step = axis === 'x'
      ? edgeStep(point.x, whole ? 0 : r.left, whole ? window.innerWidth : r.right)
      : edgeStep(point.y, whole ? 0 : r.top, whole ? window.innerHeight : r.bottom);
    if (!step) continue;
    if (axis === 'x') box.scrollLeft += step; else box.scrollTop += step;
    scrolled = true;
  }
  if (scrolled) moved(d);
  tick = requestAnimationFrame(edge);
}

/** The innermost zone under the pointer that takes this drag. */
function zoneAt(d: Drag): Element | null {
  if (d.overlay) d.overlay.style.visibility = 'hidden';                   // the copy must not eat the hit-test
  if (shield) shield.style.pointerEvents = 'none';
  const stack = document.elementsFromPoint(point.x, point.y);
  if (shield) shield.style.pointerEvents = '';
  if (d.overlay) d.overlay.style.visibility = 'visible';
  for (const el of stack) {                                                // top of the stack first: innermost wins
    const z = zones.get(el);
    if (z && (!z.hooks?.accept || z.hooks.accept(infoOf(d, el)))) return el;
  }
  return null;
}
/** After the pointer (or what is under it) moved: the copy, the zone it is over, and everyone told. */
function moved(d: Drag): void {
  if (d.overlay) d.overlay.style.transform = `translate(${point.x - d.grab.x - d.ox}px, ${point.y - d.grab.y - d.oy}px)`;
  if (d.mode === 'sort') { sortTo(d, point.x, point.y); d.opts.onMove?.(infoOf(d, d.container)); return; }
  const zone = zoneAt(d);
  if (zone !== d.over) {
    if (d.over) { d.over.classList.remove('mu-dnd-over'); zones.get(d.over)?.hooks?.onLeave?.(infoOf(d, d.over)); }
    if (zone) { zone.classList.add('mu-dnd-over'); zones.get(zone)?.hooks?.onEnter?.(infoOf(d, zone)); }
    d.over = zone;
  }
  const info = infoOf(d, d.over);
  if (d.over) zones.get(d.over)?.hooks?.onOver?.(info);
  d.opts.onMove?.(info);
}
function onPointerMove(e: PointerEvent): void {
  const d = active; if (!d) return;
  point = { x: d.opts.axis === 'y' ? d.start.x : e.clientX, y: d.opts.axis === 'x' ? d.start.y : e.clientY };
  moved(d);
}
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape' && active) { e.preventDefault(); e.stopPropagation(); finish(false); } }
function onPointerUp(): void { finish(true); }

/** The drag ends: dropped (`land`) or cancelled (Esc). Everything the drag put on the page goes. */
function finish(land: boolean): void {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
  window.removeEventListener('keydown', onKey, true);
  const d = active; active = null; if (!d) return;
  cancelAnimationFrame(tick); tick = 0;
  shieldOff();
  document.documentElement.classList.remove('mu-dnd-on');
  d.overlay?.remove();
  d.item.classList.remove('mu-dnd-ghost', 'mu-dnd-dragging');
  if (d.mode === 'plain') {
    const over = d.over;
    const info = infoOf(d, over);
    if (over) { over.classList.remove('mu-dnd-over'); if (!land) zones.get(over)?.hooks?.onLeave?.(info); }
    if (!land) { d.opts.onCancel?.(info); return; }
    const z = over ? zones.get(over) : undefined;
    if (z?.onDrop) z.onDrop(d.id);
    z?.hooks?.onDrop?.(info);
    d.opts.onEnd?.(info);
    return;
  }
  // sortable: the zone right after the placeholder is what the dropped row lands BEFORE; none → the end.
  let before: string | undefined;
  let n: Element | null = d.placeholder.nextElementSibling;
  while (n && (!zones.has(n) || n === d.item)) n = n.nextElementSibling;
  if (n) before = zones.get(n)?.group;
  else { let max = 0; for (const z of zonesIn(d)) { const v = Number(zones.get(z)?.group); if (Number.isFinite(v) && v > max) max = v; } before = String(max + 1); }
  for (const c of d.seen) for (const z of Array.from(c.children)) if (z instanceof HTMLElement) { z.style.transition = ''; z.style.transform = ''; }
  d.placeholder.remove();
  d.item.style.display = '';
  const info = infoOf(d, d.container);
  if (!land) { d.opts.onCancel?.(info); return; }
  // the drop belongs to the container the row LANDED in (it may have crossed into another list)
  (zones.get(d.container)?.onDrop ?? d.onDrop)(d.id, before);
  zones.get(d.container)?.hooks?.onDrop?.(info);
  d.opts.onEnd?.(info);
}

/** The drag begins: the copy (or the item itself), the shield, and the listeners for the rest of it. */
function begin(el: HTMLElement, opts: DraggableOptions, start: DndPoint, now: PointerEvent, liftZone: boolean): void {
  // the DSL's grip inside a row lifts the ROW (its nearest zone); hand-written code lifts exactly what it asked for
  const zone = liftZone ? zoneOf(el) : zones.has(el) ? el : null;
  const item = zone ?? el;
  const container = item.parentElement;
  const sortable = zone !== null && container instanceof HTMLElement && container.classList.contains(SORTABLE_MARK);
  const b = item.getBoundingClientRect();
  const rect: DndRect = { left: b.left, top: b.top, width: b.width, height: b.height };
  const z = opts.zIndex ?? 99999;
  let overlay: HTMLElement | null = null, ox = 0, oy = 0;
  if (opts.overlay !== false) {
    const clone = item.cloneNode(true);
    if (clone instanceof HTMLElement) {
      clone.classList.add('mu-dnd-overlay'); clone.style.animation = 'none';
      clone.style.cssText += `;position:fixed;left:0;top:0;width:${rect.width}px;height:${rect.height}px;margin:0;pointer-events:none;z-index:${z};animation:none;`;
      (item.parentElement ?? document.body).appendChild(clone);         // same ancestors: scoped CSS still matches
      const o = clone.getBoundingClientRect(); ox = o.left; oy = o.top;
      overlay = clone;
      item.classList.add('mu-dnd-ghost');
    }
  } else item.classList.add('mu-dnd-dragging');
  shieldOn(z);
  document.documentElement.classList.add('mu-dnd-on');                    // a hook for enlarging drop zones
  const id = typeof opts.id === 'function' ? opts.id() : opts.id;
  const data = typeof opts.data === 'function' ? opts.data() : opts.data ?? {};
  // grab point stays exactly under the pointer: the item hangs from where you took it
  const base: DragBase = { id, data, opts, overlay, item, start, grab: { x: start.x - rect.left, y: start.y - rect.top }, rect, ox, oy };
  if (sortable && container instanceof HTMLElement) {
    const placeholder = document.createElement(item.tagName);
    placeholder.className = 'mu-dnd-placeholder';
    placeholder.style.cssText = `box-sizing:border-box;width:${rect.width}px;height:${rect.height}px;flex:0 0 auto;`;
    container.insertBefore(placeholder, item);
    item.style.display = 'none';
    active = { ...base, mode: 'sort', container, placeholder, seen: new Set([container]), onDrop: zones.get(container)?.onDrop ?? zones.get(item)?.onDrop ?? (() => {}) };
  } else active = { ...base, mode: 'plain', over: null };
  point = { x: now.clientX, y: now.clientY };
  opts.onStart?.(infoOf(active, null));
  onPointerMove(now);
  if (!tick) tick = requestAnimationFrame(edge);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKey, true);
}

/**
 * Start a drag from a press you already handle (dnd-kit's «listeners»): call it from your own `pointerdown`, after
 * deciding the press is a drag (a click that selects first, a tool that cuts instead…). The drag begins once the
 * pointer moved `distance` px (or was held `delay` ms within `tolerance` px): until then the press is still a click.
 */
export function startDrag(e: PointerEvent, el: HTMLElement, opts: DraggableOptions): void { press(e, el, opts, false); }
function press(e: PointerEvent, el: HTMLElement, opts: DraggableOptions, liftZone: boolean): void {
  if (e.button !== 0 || active) return;
  const start = { x: e.clientX, y: e.clientY };
  const distance = opts.distance ?? 0, delay = opts.delay ?? 0, tolerance = opts.tolerance ?? TOLERANCE;
  if (distance <= 0 && delay <= 0) { e.preventDefault(); begin(el, opts, start, e, liftZone); return; }
  let timer = 0, last = e;
  const stop = (): void => { clearTimeout(timer); window.removeEventListener('pointermove', pre); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  const pre = (ev: PointerEvent): void => {
    last = ev;
    const far = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
    if (delay > 0) { if (far > tolerance) stop(); return; }              // held too loosely: it was a scroll
    if (far < distance) return;
    stop(); ev.preventDefault(); begin(el, opts, start, ev, liftZone);
  };
  if (delay > 0) timer = window.setTimeout(() => { stop(); begin(el, opts, start, last, liftZone); }, delay);
  window.addEventListener('pointermove', pre); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
}

/** Make `el` draggable (by itself, or by `handle`). Returns a function that stops it. */
export function draggable(el: HTMLElement, opts: DraggableOptions): () => void {
  const handle = opts.handle instanceof HTMLElement ? opts.handle : el;
  handle.style.touchAction = 'none'; handle.classList.add('mu-dnd-item');
  const down = (e: PointerEvent): void => startDrag(e, el, opts);
  handle.addEventListener('pointerdown', down);
  return () => { handle.removeEventListener('pointerdown', down); handle.classList.remove('mu-dnd-item'); };
}

/** Whether a drag is under way (anywhere on the page). */
export const dragging = (): boolean => active !== null;

/** Make `el` a drop zone. Returns a function that stops it. */
export function droppable(el: Element, opts: DroppableOptions = {}): () => void {
  zones.set(el, { group: opts.group ?? '', hooks: opts });
  return () => { zones.delete(el); };
}

// ── the DSL's door (compiled `draggable(id)` / `droptarget(group) on(drop: …)`) ──
// The activation distance and the copy's stacking come from CSS: `--mu-dnd-activation`, `--mu-dnd-z`.
// A FINGER SCROLLS PAST IT AND PICKS IT UP BY HOLDING. With the mouse a drag starts on the first move; on a phone that
// turned every swipe over a draggable row (a horizontal rail, a list) into a drag and every tap into a lifted copy. A
// touch now waits `--mu-dnd-hold` ms (300 by default) held still: until then the page scrolls as usual.
export function __drag(el: HTMLElement, getId: () => string): void {
  el.style.touchAction = 'manipulation'; el.classList.add('mu-dnd-item');
  el.addEventListener('pointerdown', (e: PointerEvent) => {
    const cs = getComputedStyle(el);
    const distance = parseFloat(cs.getPropertyValue('--mu-dnd-activation')) || 0;
    const zIndex = parseInt(cs.getPropertyValue('--mu-dnd-z').trim(), 10) || 99999;
    if (e.pointerType === 'touch') {
      const hold = parseFloat(cs.getPropertyValue('--mu-dnd-hold')) || 300;
      press(e, el, { id: getId, zIndex, delay: hold, tolerance: 8 }, true);
    } else press(e, el, { id: getId, zIndex, distance }, true);
  });
}
// once a drag is under way the finger moves the copy, not the page: the first touchmove after the hold is cancelled
// before the browser can start a pan (which would cancel the pointer and drop the item where it was)
if (typeof window !== 'undefined') window.addEventListener('touchmove', (e) => { if (active) e.preventDefault(); }, { passive: false });
// a zone; on drop it reports the dragged id and (sortable) the sort it lands before
export function __drop(el: Element, group: string, onDrop: (id: string, before?: string) => void): void { zones.set(el, { group, onDrop }); }
