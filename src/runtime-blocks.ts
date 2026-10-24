// runtime-blocks: the plumbing every `when` and `each` used to carry in its own compiled code. A page with 40 `when`s
// wrote the same ten lines forty times (two comment markers, a holder, a cleanup, the effect that builds or removes),
// and every `each` its whole keyed reconciliation; Storio's app was 2.4 MB of this. Now each block is one call,
// `__when(parent, () => cond, build)` / `__each(parent, () => rows, buildItem, shape)`, and the lines live here once.
// Same behaviour, line for line: markers appended first, the block owns everything between them (a nested block
// inserts its nodes later, so a snapshot would leave them behind on hide), built in its own root so its effects die
// with it, removed through `__leave` so an exit animation can play; rows matched by key and reordered with the fewest
// moves (the longest increasing subsequence, like Vue/Svelte/Solid).
import { effect, root, onCleanup, signal } from './runtime-signals.js';
import { __leave } from './runtime-leave.js';
import { __rowKey, type Row } from './runtime-key.js';
import type { Signal } from '#engine/shared/types.js';

/** An element with its classes: what every compiled node starts as (one call instead of two statements per node). */
export function __mk(tag: string, className: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

/** Attaches a compiled node to its parent (one short call where every node wrote `parent.appendChild(node)`). */
export function __ap(parent: Node, child: Node): void {
  parent.appendChild(child);
}

/** Shows what `build` makes while `cond()` is true, right where the block sits in `parent`. */
export function __when(parent: Node, cond: () => unknown, build: (into: Node) => void): void {
  const start = document.createComment('when');
  const anchor = document.createComment('/when');
  parent.appendChild(start);
  parent.appendChild(anchor);
  let shown: { value: Node; dispose: () => void } | null = null;
  onCleanup(() => { if (shown) shown.dispose(); });
  effect(() => {
    if (cond()) {
      if (shown) return;
      const made = root(() => { const into = document.createDocumentFragment(); build(into); return into; });
      anchor.parentNode?.insertBefore(made.value, anchor);
      shown = made;
    } else if (shown) {
      shown.dispose();
      __leave(start, anchor);
      shown = null;
    }
  });
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


/** How an `each` is shaped: rows with an index signal (`as item, i`), and rows that are their own <li> (in a List). */
export interface EachShape { index: boolean; li: boolean }
interface RowEntry { sig: Signal<Row>; idx: Signal<number> | null; readonly nodes: ChildNode[]; dispose: () => void; data: Row }

/** A keyed list: one `buildItem` per row of `rows()`, kept, moved or removed as the list changes. */
export function __each(parent: Node, rows: () => Row[], buildItem: (into: Node, item: Signal<Row>, index: Signal<number> | null) => void, shape: EachShape): void {
  const start = document.createComment('each');
  const anchor = document.createComment('/each');
  parent.appendChild(start);
  parent.appendChild(anchor);
  const map = new Map<unknown, RowEntry>();
  onCleanup(() => { for (const entry of map.values()) entry.dispose(); map.clear(); });
  let order: RowEntry[] = [];
  effect(() => {
    const seen = new Set<unknown>();
    const next: RowEntry[] = [];
    const twins = new Map<string, number>();
    for (const row of rows()) {
      const key = __rowKey(row, twins);   // by id, else by content (runtime-key.ts)
      seen.add(key);
      let entry = map.get(key);
      if (entry) { if (!__eq(entry.data, row)) { entry.data = row; entry.sig.set(row); } }
      else { entry = makeRow(row, buildItem, shape); map.set(key, entry); }
      next.push(entry);
    }
    for (const [key, entry] of map) if (!seen.has(key)) { entry.dispose(); for (const node of entry.nodes) node.remove(); map.delete(key); }
    if (shape.index) for (let i = 0; i < next.length; i++) next[i].idx?.set(i);   // reorder/filter reindexes surviving rows
    if (anchor.parentNode) __order(anchor.parentNode, anchor, next, order);
    order = next;
  });
}

// one row: its own <li>, or a fragment bracketed by two markers whose nodes are read LIVE between them (a nested block
// at the row's root adds nodes after the row is built, for the same reason as `when`)
function makeRow(row: Row, buildItem: (into: Node, item: Signal<Row>, index: Signal<number> | null) => void, shape: EachShape): RowEntry {
  const sig = signal(row);
  const idx = shape.index ? signal(0) : null;
  if (shape.li) {
    const made = root(() => { const li = document.createElement('li'); buildItem(li, sig, idx); return li; });
    const nodes: ChildNode[] = [made.value];
    return { sig, idx, nodes, dispose: made.dispose, data: row };
  }
  const made = root(() => {
    const into = document.createDocumentFragment();
    const first = document.createComment('row');
    const last = document.createComment('/row');
    into.appendChild(first);
    buildItem(into, sig, idx);
    into.appendChild(last);
    return [first, last];
  });
  const [first, last] = made.value;
  return {
    sig, idx, dispose: made.dispose, data: row,
    get nodes(): ChildNode[] { const out: ChildNode[] = [first]; let node: ChildNode = first; while (node !== last && node.nextSibling) { node = node.nextSibling; out.push(node); } return out; },
  };
}
