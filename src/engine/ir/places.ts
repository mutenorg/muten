// places: where a finding inside a part really is. Parts are inlined, so a node of a part has no line in the page; it
// carries its place instead (a line in the part's file, and the call that reached it: Loc.in). validate reads every
// node at that place; `check` resolves it to the part's file or to the call (project/place.ts); every other reader
// (the editor, the build, the dev server) gets the call in its own file, the only line it can show.

import type { Diagnostic, FlatNode, Loc } from '#engine/shared/types.js';

/** The nodes as validate reads them: an inlined node at its place in the part (its own `loc` is the call, or none). */
export function located(nodes: { [id: string]: FlatNode }): { [id: string]: FlatNode } {
  const out: { [id: string]: FlatNode } = {};
  for (const [id, node] of Object.entries(nodes)) out[id] = node.place ? { ...node, loc: node.place } : node;
  return out;
}

/** The line in the file being read that leads to `loc`: itself, or the call (outermost first) that reached the part. */
export function onPage(loc: Loc | null): Loc | null {
  let at = loc;
  while (at?.in) at = at.in.call;
  return at;
}

/** A finding as a reader of one file sees it: at that file's own line. */
export function onPageDiagnostic(found: Diagnostic): Diagnostic {
  return found.loc?.in ? { ...found, loc: onPage(found.loc) } : found;
}
