// leaf-children: a primitive the manifest declares childless (Span, Text, Title, Image, Icon, the inputs…) DROPS the
// children it is given - they never render, and until now nothing said so. `Span "" { Icon "…" }` draws an empty
// span. This names it, at the node, with the way out (a Stack holds children; the text goes in a Span beside them).

import { diag } from '#engine/shared/diagnostics.js';
import { PRIMITIVES } from '#engine/lang/manifest.js';
import type { Doc, Diagnostic } from '#engine/shared/types.js';

export function leafChildren(doc: Doc): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const node of Object.values(doc.nodes || {})) {
    const spec = PRIMITIVES[node.type];
    if (!spec || spec.children !== false || !node.children.length) continue;
    const where = node.ownerPart ? ` (in part ${node.ownerPart})` : '';
    out.push(diag('leaf-children', `${node.type} cannot hold children - they are dropped and never render${where}. Put them in a Stack (it holds children), with the text in a Span beside them.`, { loc: node.loc ?? null }));
  }
  return out;
}
