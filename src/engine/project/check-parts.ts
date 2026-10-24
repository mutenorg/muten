// check-parts: every part of the app is checked on its own, called or not. A part was only ever checked through the
// pages that call it: one nobody calls yet (a new one, one a page stopped using) kept its mistakes until the day a page
// called it, and then they showed up there. Here each part is called once, every parameter passed as a name of its own
// declared type (an `action` parameter as an action), and validated like a page: what is wrong in the part's own lines
// lands in its file (project/place.ts), in the part's own words rather than one calling page's.
//
// Only what is true whoever calls it. A part reads its caller's names (a page's `kind`, the `pathFor` the page imports),
// and a link to "/x" is a self-link only on page /x: alone, those would be accusations, so they are left to the pages.

import { Kw } from '#engine/shared/vocab.js';
import { composeDoc } from '#engine/ir/compose.js';
import { UNKNOWN_PARAM, UNKNOWN_ARG } from '#engine/ir/part-params.js';
import type { ActionDef, ArgMap, Doc, IR, PartDef, StateDef } from '#engine/shared/types.js';

type Parts = { [name: string]: PartDef };

/** The findings a part answers for alone: an element, a part, an icon, a class or a route that does not exist, a store's
 *  member, a translation key, a missing prop, an element with no name a screen reader can say. */
export const CALLER_FREE: ReadonlySet<string> = new Set([
  'unknown-type', 'unknown-part', 'unknown-field-type', 'icon-name', 'unknown-class', 'unknown-route', 'unknown-member',
  't-unknown-key', 'theme-ref', 'missing-prop', 'checkbox-prop', 'leaf-children', 'field-unnamed', 'control-unnamed',
  UNKNOWN_PARAM, UNKNOWN_ARG, 'text-not-translated',
]);
// Not a Custom with nothing to mount (custom-check.ts): a part may mount a component its CALLER brings with `use react`
// (the landing's HeldAccordion), so that holds per page, and the pages check it.

/** The findings that belong to the page a part is on, never the part: a link to the page itself, the page's count of h1s. */
export const PAGE_BOUND: ReadonlySet<string> = new Set(['self-link', 'heading-many-h1', 'unknown-anchor']);

/** A page made of one call to `name`, with each parameter a declared name: a state of its type, or an action. */
export function partAlone(name: string, part: PartDef, parts: Parts): Doc {
  const args: ArgMap = {};
  const state: { [name: string]: StateDef } = {};
  const actions: { [name: string]: ActionDef } = {};
  for (const param of part.params) {
    args[param.name] = param.name;
    if (param.type === Kw.Action) actions[param.name] = { mutates: [], input: '', body: [] };
    else state[param.name] = { type: param.type };
  }
  const page: IR = { screen: name, entities: { ...part.entities }, state, actions, tree: { type: name, args } };
  // the part's own entities last: composing merges those of every part it uses, and another file's `entity Circle` with
  // other fields (Seats' three) would otherwise decide what this part's `item: Circle` holds
  const { doc } = composeDoc(page, parts);
  return { ...doc, entities: { ...doc.entities, ...part.entities } };
}
