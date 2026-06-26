// refs: the SINGLE semantic resolver. validate (the oracle) and compile (the emitter) both consult
// these, so "what exists" and "what type is behind a list" can never drift between lint and runtime.
// Before this, the same resolution lived TWICE (validate's refListType / compile's listElemType) and a
// gap in one but not the other = the classic "lint passes, runtime ReferenceErrors" (the two-layer bug).
import type { Expr, Entity, StateDef } from '#engine/shared/types.js';
import { Ek } from '#engine/shared/vocab.js';

/** The per-document facts both sides hold (from a Doc or a CompileCtx — same underlying data). */
export interface RefFacts {
  state: { [name: string]: StateDef };
  gets: { [name: string]: Expr };
  entities: { [name: string]: Entity };
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
  if (e.kind === Ek.Agg && (e.op === 'sort' || e.op === 'sortDesc')) return headType(e.list.split('.')[0], f, seen); // a sorted copy: same element type
  return '';
}

/** The ELEMENT entity behind a list head ('' when not a list-of-entity). */
export function elementType(head: string, f: RefFacts, seen: Set<string> = new Set()): string {
  const t = headType(head, f, seen);
  return t.startsWith('list<') ? t.slice(5, -1) : '';
}

/** Bare-referenceable fields of a list's element, for an item-implicit `where`/`by` scope:
 *  `list<Task>` -> { id, ...Task fields }; a non-entity element (list<uuid>) -> just `id`. */
export function elementFields(elementTypeName: string, f: RefFacts): Set<string> {
  const entity = f.entities[elementTypeName];
  return new Set(['id', ...(entity ? Object.keys(entity) : [])]);
}
