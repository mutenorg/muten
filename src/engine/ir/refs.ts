// refs: the SINGLE semantic resolver. validate (the oracle) and compile (the emitter) both consult
// these, so "what exists" and "what type is behind a list" can never drift between lint and runtime.
// Before this, the same resolution lived TWICE (validate's refListType / compile's listElemType) and a
// gap in one but not the other = the classic "lint passes, runtime ReferenceErrors" (the two-layer bug).
import type { Expr, Entity, StateDef, Stmt, FnDef, ImportDef } from '#engine/shared/types.js';
import { Ek, StOp } from '#engine/shared/vocab.js';
import { callValues } from '#engine/ir/calls.js';

/** The per-document facts both sides hold (from a Doc or a CompileCtx — same underlying data). */
export interface RefFacts {
  state: { [name: string]: StateDef };
  gets: { [name: string]: Expr };
  entities: { [name: string]: Entity };
  calls?: { [fn: string]: string };   // what a function returns: a `use`'s declared type (`rowsOf: list<Row>`)
  fns?: { [name: string]: FnDef };    // this file's `get name(…)`: what it returns is its body's type
  storeEntities?: { [domainDotMember: string]: Entity };  // element entity of a CROSS-STORE list ("orders.items" -> Order), so aggregates over a store list resolve their item fields
}

/** Every name muten can resolve a HEAD to, besides lexical scope. Built identically from a Doc or a
 *  CompileCtx so the "is this a real thing?" question has ONE answer. */
export interface KnownHeads {
  stateKeys: Set<string>;
  gets: Set<string>;
  stores: Set<string>;
  consts: Set<string>;
  routeParams: Set<string>;
  actions: Set<string>;
}

/** Is `head` something muten KNOWS about — a lexical local (the caller's `inScope` covers each-vars,
 *  item fields and action params), or a declared state/get/store/const/route-param/action? The ONE
 *  predicate behind every `unknown-ref`, so the linter and the emitter agree on what exists. */
export function isKnownHead(head: string, inScope: (h: string) => boolean, h: KnownHeads): boolean {
  return inScope(head)
    || h.stateKeys.has(head) || h.gets.has(head) || h.stores.has(head)
    || h.consts.has(head) || h.routeParams.has(head) || h.actions.has(head);
}

/** The declared/derived type tag behind a head: a state's type, or the list type a `get` resolves to
 *  (a `where`-filter / sort over another list/get). '' when unresolvable. Cycle-guarded. */
export function headType(head: string, f: RefFacts, seen: Set<string> = new Set()): string {
  const st = f.state[head]?.type;
  if (st) return st;                                  // state — a query's `.data` is the same list type
  const body = f.gets[head];
  if (body !== undefined && !seen.has(head)) { seen.add(head); return exprListType(body, f, seen); }
  return '';
}

/** The list type an expression produces, when it produces one (Ref / where-filter / sort preserve it).
 *  Exported for the linter's `getListType`; recurses through `headType`. */
export function exprListType(e: Expr | undefined, f: RefFacts, seen: Set<string>): string {
  if (!e) return '';
  if (e.kind === Ek.Ref) return headType(e.name.split('.')[0], f, seen);
  if (e.kind === Ek.Filter) return headType(e.list.split('.')[0], f, seen);                                  // a `where`-filter preserves the element type
  if (e.kind === Ek.Agg && (e.op === 'sort' || e.op === 'sortDesc' || e.op === 'take')) return headType(e.list.split('.')[0], f, seen); // sort/take return a list of the SAME element type
  if (e.kind === Ek.Call) {   // a function's result: a `get name(…)` is its body's type, a `use` the type it declares
    const own = f.fns?.[e.fn];
    if (own && !seen.has(e.fn)) return exprListType(own.body, f, new Set([...seen, e.fn]));
    return f.calls?.[e.fn] ?? '';
  }
  return '';
}

/** The ELEMENT entity behind a list head ('' when not a list-of-entity). */
export function elementType(head: string, f: RefFacts, seen: Set<string> = new Set()): string {
  const t = headType(head, f, seen);
  return t.startsWith('list<') ? t.slice(5, -1) : '';
}

/** The element ENTITY (field -> type) behind a list REFERENCE — page-local (`tasks` -> Task) OR cross-store
 *  (`orders.items` -> the store's Order). undefined if not a list-of-entity. The ONE resolver both the
 *  linter (to bind an aggregate's item fields) and the emitter (to emit `__it.<field>`) use, so a
 *  cross-store aggregate can never lint-pass-then-runtime-break on a field. */
export function listElementEntity(listRef: string, f: RefFacts): Entity | undefined {
  const local = elementType(listRef.split('.')[0], f);
  if (local && f.entities[local]) return f.entities[local];
  return f.storeEntities?.[listRef];
}

/** Item-implicit field names for a list ref (id + the element's fields), page-local or cross-store. */
export function listElementFields(listRef: string, f: RefFacts): Set<string> {
  const ent = listElementEntity(listRef, f);
  return new Set(['id', ...(ent ? Object.keys(ent) : [])]);
}

// the head names an expression READS (the signals an effect would track on running it).
function exprRefs(e: Expr, acc: Set<string>): void {
  switch (e.kind) {
    case Ek.Ref: acc.add(e.name.split('.')[0]); break;
    case Ek.Un: exprRefs(e.operand, acc); break;
    case Ek.Bin: exprRefs(e.left, acc); exprRefs(e.right, acc); break;
    case Ek.Tern: exprRefs(e.cond, acc); exprRefs(e.then, acc); exprRefs(e.else, acc); break;
    case Ek.Call: if (e.fn.includes('.')) acc.add(e.fn.split('.')[0]); for (const a of callValues(e)) exprRefs(a, acc); break;   // `db.from(…)` reads db
    case Ek.Obj: for (const fld of e.fields) exprRefs(fld.value, acc); break;
    case Ek.List: for (const item of e.items) exprRefs(item, acc); break;
    case Ek.Agg: acc.add(e.list.split('.')[0]); break;
    case Ek.Filter: acc.add(e.list.split('.')[0]); break;
  }
}

/** Targets a body updates FROM THEIR OWN VALUE at the TOP LEVEL — `x.set(x + 1)`, `x.push(…x…)`,
 *  `x.toggle(x…)`. In an effect (or a store action an effect calls) these self-trigger forever: an effect
 *  re-runs on every signal it reads, so writing a signal it reads loops (the page hangs, silently). Only
 *  top-level statements are scanned — a write GUARDED by `if {…}` usually converges, so it isn't flagged. */
export function selfUpdateTargets(body: Stmt[]): string[] {
  const out: string[] = [];
  for (const st of body) {
    if (!('target' in st) || !st.target) continue;
    if ((st.op === StOp.Set || st.op === StOp.Push || st.op === StOp.Toggle) && 'arg' in st && st.arg) {
      const reads = new Set<string>();
      exprRefs(st.arg, reads);
      if (reads.has(st.target)) out.push(st.target);
    }
  }
  return out;
}

// ── derived values in dependency order ─────────────────────────────────────────────────────
// Every head an expression reads, item-implicit bodies included (`tasks where owner == me` reads `me`). Inside a
// `where` / `sum by` a bare name that is a field of the row is the row's, not a get (`issues.sum by points` in
// `get points` reads each issue's points, not itself).
function readHeads(e: Expr, acc: Set<string>, f: RefFacts, rowFields: Set<string>): void {
  switch (e.kind) {
    case Ek.Ref: { const head = e.name.split('.')[0]; if (!rowFields.has(head)) acc.add(head); break; }
    case Ek.Un: readHeads(e.operand, acc, f, rowFields); break;
    case Ek.Bin: readHeads(e.left, acc, f, rowFields); readHeads(e.right, acc, f, rowFields); break;
    case Ek.Tern: readHeads(e.cond, acc, f, rowFields); readHeads(e.then, acc, f, rowFields); readHeads(e.else, acc, f, rowFields); break;
    case Ek.Call: for (const arg of callValues(e)) readHeads(arg, acc, f, rowFields); break;
    case Ek.Obj: for (const field of e.fields) readHeads(field.value, acc, f, rowFields); break;
    case Ek.List: for (const item of e.items) readHeads(item, acc, f, rowFields); break;
    case Ek.Agg: acc.add(e.list.split('.')[0]); readHeads(e.body, acc, f, listElementFields(e.list, f)); break;
    case Ek.Filter: acc.add(e.list.split('.')[0]); readHeads(e.cond, acc, f, listElementFields(e.list, f)); break;
  }
}

/** The gets a get reads, among the declared ones. */
function getDeps(f: RefFacts, name: string): string[] {
  const heads = new Set<string>();
  readHeads(f.gets[name], heads, f, new Set());
  return [...heads].filter((head) => head in f.gets);
}

/** The gets in an order where each one comes after every get it reads. A get is a `const` in the emitted module,
 *  so a get read before its line throws «Cannot access before initialization» and blanks the page; the file order
 *  is the author's, the emit order is this. Gets caught in a cycle keep their file order (getCycle reports them). */
export function getOrder(f: RefFacts): string[] {
  const done = new Set<string>(); const visiting = new Set<string>(); const out: string[] = [];
  const visit = (name: string): void => {
    if (done.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const dep of getDeps(f, name)) visit(dep);
    visiting.delete(name); done.add(name); out.push(name);
  };
  for (const name of Object.keys(f.gets)) visit(name);
  return out;
}

/** The first chain of gets that reads itself (`a` reads `b` reads `a`), or [] — a cycle can never settle. */
export function getCycle(f: RefFacts): string[] {
  const done = new Set<string>(); const path: string[] = [];
  const visit = (name: string): string[] => {
    if (done.has(name)) return [];
    if (path.includes(name)) return [...path.slice(path.indexOf(name)), name];
    path.push(name);
    for (const dep of getDeps(f, name)) { const cycle = visit(dep); if (cycle.length) return cycle; }
    path.pop(); done.add(name);
    return [];
  };
  for (const name of Object.keys(f.gets)) { const cycle = visit(name); if (cycle.length) return cycle; }
  return [];
}

/** The dotted names an expression references (`cart.total`, `x`): what validate checks exist, and what a route
 *  guard may read. Item-implicit bodies (`where`/`by`) are checked separately against the row. */
export function collectRefs(e: Expr, acc: string[] = []): string[] {
  switch (e.kind) {
    case Ek.Ref: acc.push(e.name); break;
    case Ek.Un: collectRefs(e.operand, acc); break;
    case Ek.Bin: collectRefs(e.left, acc); collectRefs(e.right, acc); break;
    case Ek.Tern: collectRefs(e.cond, acc); collectRefs(e.then, acc); collectRefs(e.else, acc); break;
    case Ek.Call: for (const a of callValues(e)) collectRefs(a, acc); break; // args' refs; the fn is checked separately
    case Ek.Obj: for (const f of e.fields) collectRefs(f.value, acc); break;
    case Ek.List: for (const item of e.items) collectRefs(item, acc); break;
    case Ek.Agg: acc.push(e.list); break;    // outer list ref; body fields are item-implicit, checked separately
    case Ek.Filter: acc.push(e.list); break; // outer list ref; cond's bare fields are item-implicit, checked separately
  }
  return acc;
}

/** What each `use`'d function says it returns (`use rowsOf: list<Row> from …`), by name. */
export function callReturns(imports: ImportDef[] | undefined): { [fn: string]: string } {
  const out: { [fn: string]: string } = {};
  for (const def of imports || []) Object.assign(out, def.returns || {});
  return out;
}
