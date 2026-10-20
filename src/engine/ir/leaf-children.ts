// leaf-children: a primitive the manifest declares childless (Span, Text, Title, Image, Icon, the inputs…) DROPS the
// children it is given - they never render, and until now nothing said so. `Span "" { Icon "…" }` draws an empty
// span. This names it, at the node, with the way out (a Stack holds children; the text goes in a Span beside them).

import { diag } from '#engine/shared/diagnostics.js';
import { PRIMITIVES } from '#engine/lang/manifest.js';
import { Nt, UseKind } from '#engine/shared/vocab.js';
import type { Doc, Diagnostic } from '#engine/shared/types.js';

export function leafChildren(doc: Doc): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const node of Object.values(doc.nodes || {})) {
    const spec = PRIMITIVES[node.type];
    if (!spec || spec.children !== false || !node.children.length) continue;
    // a component from npm holds what it is given: a Web Component's slot, a React component's children
    if (node.type === Nt.Custom && (doc.imports || []).some((def) => def.kind && def.names.includes((node.props?.component || '').split('.')[0]))) continue;
    const where = node.ownerPart ? ` (in part ${node.ownerPart})` : '';
    out.push(diag('leaf-children', `${node.type} cannot hold children - they are dropped and never render${where}. Put them in a Stack (it holds children), with the text in a Span beside them.`, { loc: node.loc ?? null }));
  }
  return out;
}

/** Inside a React component, an `each` is a map of React children: what a row holds must be React too (a component
 *  from its library, a plain `Text`, a nested `each` / `when`). Any other muten node is built ONCE and mounted where it
 *  sits, so in a row it would show in one row only: said here, at the node. */
export function reactListNodes(doc: Doc): Diagnostic[] {
  const out: Diagnostic[] = [];
  const nodes = doc.nodes || {};
  const isReact = (id: string): boolean => { const node = nodes[id]; return node?.type === Nt.Custom && (doc.imports || []).some((def) => def.kind === UseKind.React && def.names.includes((node.props?.component || '').split('.')[0])); };
  const walk = (id: string, inReact: boolean, inRow: boolean): void => {
    const node = nodes[id];
    if (!node) return;
    const react = isReact(id);
    const plainText = node.type === Nt.Text && !node.props?.class?.length;
    if (inRow && !react && !plainText && node.type !== Nt.Each && node.type !== Nt.When) {
      out.push(diag('react-list-node', `${node.type} sits in a row of a list inside a React component: a muten node there is built once and would show in one row only. Use the library's own components and a plain \`Text\` in the row, or move the \`each\` outside the React component.`, { loc: node.loc ?? null }));
      return;
    }
    for (const kid of node.children) walk(kid, inReact || react, inRow || (inReact && node.type === Nt.Each));
  };
  const held = new Set(Object.values(nodes).flatMap((node) => node.children));
  for (const id of Object.keys(nodes)) if (!held.has(id)) walk(id, false, false);   // from each root
  return out;
}
