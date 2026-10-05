// imports: the `use` lines a composed page (or layout) ends up with. A part that calls `t(…)` carries its own
// `use t from …`, so it works inside any page, not only the ones that happen to import the same thing themselves.

import type { ImportDef } from '#engine/shared/types.js';

/** `base` plus every name in `extra` that `base` does not already import, grouped by source. A name is imported
 *  once: the page's own `use` wins, and two parts naming the same function share one import. */
export function mergeImports(base: ImportDef[], extra: ImportDef[]): ImportDef[] {
  const taken = new Set(base.flatMap((im) => im.names));
  const bySource = new Map<string, string[]>();
  for (const im of extra) {
    for (const name of im.names) {
      if (taken.has(name)) continue;
      taken.add(name);
      bySource.set(im.from, [...(bySource.get(im.from) ?? []), name]);
    }
  }
  return [...base, ...[...bySource].map(([from, names]) => ({ names, from }))];
}
