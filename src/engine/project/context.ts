// context.ts: the project's store facts that validate AND compile both need, derived from the parsed
// .store IRs in ONE place. lint, build, and the runner each assembled this by hand and DRIFTED — the dev
// overlay even passed validate a weaker context than `check` (missing storeSelfMut + iconExists), so the IDE
// silently skipped checks the CLI ran. One source, no drift. (This is muten owning one project model, not
// every consumer re-deriving it — the same principle as the unified resolver in ir/refs.ts.)

import { selfUpdateTargets } from '#engine/ir/refs.js';
import { storeListEntities } from '#engine/project/load.js';
import type { IR, StoreSlice } from '#engine/shared/types.js';

export interface StoreContext {
  stores: string[];                                 // domain names
  storeMembers: { [domain: string]: string[] };     // flat union (state+gets+actions) — validate resolves `cart.count`
  storeSelfMut: Set<string>;                         // "domain.action" that self-updates -> effect-loop guard
  storeEntities: ReturnType<typeof storeListEntities>; // element entity per store list -> cross-store aggregates
  storesMeta: { [domain: string]: StoreSlice };      // {state, gets, actions} arrays -> compile emits store imports
}

export function storeContext(storeIRs: { [domain: string]: IR }): StoreContext {
  const stores = Object.keys(storeIRs);
  const storeMembers: { [domain: string]: string[] } = {};
  const storeSelfMut = new Set<string>();
  const storesMeta: { [domain: string]: StoreSlice } = {};
  for (const [domain, ir] of Object.entries(storeIRs)) {
    const state = Object.keys(ir.state || {}), gets = Object.keys(ir.gets || {}), actions = Object.keys(ir.actions || {});
    storeMembers[domain] = [...state, ...gets, ...actions];
    storesMeta[domain] = { state, gets, actions };
    for (const [name, a] of Object.entries(ir.actions || {})) if (selfUpdateTargets(a.body || []).length) storeSelfMut.add(`${domain}.${name}`);
  }
  return { stores, storeMembers, storeSelfMut, storeEntities: storeListEntities(storeIRs), storesMeta };
}
