// imports: the `use` lines a composed page (or layout) ends up with. A part that calls `t(…)` carries its own
// `use t from …`, so it works inside any page, not only the ones that happen to import the same thing themselves.

import type { ImportDef } from '#engine/shared/types.js';

/** `base` plus every name in `extra` that `base` does not already import, each import whole (its kind, tag, script).
 *  A name is imported once: the page's own `use` wins, and two parts naming the same function share one import. */
export function mergeImports(base: ImportDef[], extra: ImportDef[]): ImportDef[] {
  // each import kept whole, only the names already taken left out: rebuilt as `{ names, from }`, a part's
  // `use react Badge` lost its `react` (and an element its tag, a script its `script`), so the page compiled the
  // island as a plain function and mounted an empty box
  const taken = new Set(base.flatMap((im) => im.names));
  const added: ImportDef[] = [];
  for (const im of extra) {
    const names = im.names.filter((name) => !taken.has(name));
    for (const name of names) taken.add(name);
    if (names.length) added.push({ ...im, names });
  }
  return [...base, ...added];
}
