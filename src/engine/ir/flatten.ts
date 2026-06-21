// Flatten — the nested authoring tree → the canonical FLAT Doc, addressable by id.
//
// You author nested (locality, no symbol table); flatten assigns each node a deterministic
// pre-order id (n1, n2, …). From here on the engine works on the flat Doc BY ID — it is the only
// thing validated, mutated and compiled. (Ids are positional today; a path-based scheme later would
// keep them stable across reorderings.)

import type { IR, IRNode, FlatNode, Doc } from '#engine/shared/types.js';

// recursively number the tree into a { id → node } map; only toDoc calls this.
function flatten(tree: IRNode): { rootId: string; nodes: { [id: string]: FlatNode } } {
  const nodes: { [id: string]: FlatNode } = {};
  let counter = 0;

  const visit = (node: IRNode): string => {
    const id = 'n' + (++counter);
    const entry: FlatNode = { id, type: node.type, props: node.props || {}, children: [] };
    if (node.loc) entry.loc = node.loc;   // source position in the .muten file (for inline diagnostics)
    if (node.args) entry.args = node.args; // an unresolved part instance (so the editor can lint before compose)
    nodes[id] = entry;                    // insert the parent BEFORE its children, so the map reads top-down
    entry.children = (node.children || []).map(visit);
    return id;
  };

  const rootId = visit(tree);
  return { rootId, nodes };
}

// The canonical flat Doc — the one shape that's validated, mutated and compiled. The non-tree parts
// (screen/entities/state/actions) are already flat; only the node tree needs flattening.
export function toDoc(ir: IR): Doc {
  // a .store slice has state + actions but no node tree → an empty node map.
  const { rootId, nodes } = ir.tree ? flatten(ir.tree) : { rootId: undefined, nodes: {} };
  return { screen: ir.screen, entities: ir.entities, state: ir.state, actions: ir.actions, consts: ir.consts || {}, constraints: ir.constraints || {}, rootId, nodes };
}
