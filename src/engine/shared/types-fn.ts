// types-fn: code a page runs of its own: a `fn` block (TypeScript written in the file), an `every` (a beat) and a
// `settle` (once a value stops changing).

import type { Expr, Loc, Stmt } from '#engine/shared/types.js';

/** `fn finalPrice(p: Product, rate?: number): number { … }`: its parameters' names, how many must be passed, the function
 *  as written (TypeScript) and, once the loader has stripped its types, as JavaScript. */
export interface TsFn {
  params: string[];
  required: number;
  source: string;
  js?: string;
  loc?: Loc;
}

/** `every 1m { now.set(now()) }`: statements run on a beat while the tab is visible, once more when it comes back. */
export interface Timer {
  ms: number;
  body: Stmt[];
  loc?: Loc;
}

/** `settle q 350ms { search(q) }`: statements run once `watched` has not changed for `ms` (a search as you type). */
export interface Settle {
  watched: Expr;
  ms: number;
  body: Stmt[];
  loc?: Loc;
}
