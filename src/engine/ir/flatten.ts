// flatten: nested authoring tree -> canonical flat Doc, addressable by id.
// Assigns each node a deterministic pre-order id (n1, n2, ...). From here on the engine
// works by id only: the flat Doc is the single shape that is validated, mutated, and compiled.
// Consumed by compose.ts (composeDoc) and directly by the Vite plugin and CLI.

import type { IR, IRNode, FlatNode, Doc } from '#engine/shared/types.js';

// recursively number the tree into an { id -> node } map; only toDoc calls this.
function flatten(tree: IRNode): { rootId: string; nodes: { [id: string]: FlatNode } } {
  const nodes: { [id: string]: FlatNode } = {};
  let counter = 0;

  const visit = (node: IRNode): string => {
    const id = 'n' + (++counter);
    const entry: FlatNode = { id, type: node.type, props: node.props || {}, children: [] };
    if (node.loc) entry.loc = node.loc;   // source position (needed for inline diagnostics)
    if (node.fromPart) entry.fromPart = node.fromPart;   // dev: source part for the DevTools tree
    if (node.partArgs) entry.partArgs = node.partArgs;   // dev: the part-call args -> DevTools "props"
    if (node.args) entry.args = node.args; // unresolved part instance: lets the editor lint before compose
    nodes[id] = entry;                    // parent inserted before children so the map reads top-down
    entry.children = (node.children || []).map(visit);
    return id;
  };

  const rootId = visit(tree);
  return { rootId, nodes };
}

// The canonical flat Doc: the one shape that is validated, mutated, and compiled.
// Non-tree fields (screen/entities/state/actions) are already flat; only the node tree is flattened.
export function toDoc(ir: IR): Doc {
  // a .store slice has state + actions but no node tree: produce an empty node map.
  const { rootId, nodes } = ir.tree ? flatten(ir.tree) : { rootId: undefined, nodes: {} };
  return { screen: ir.screen, entities: ir.entities, state: ir.state, actions: ir.actions, gets: ir.gets || {}, effects: ir.effects || [], consts: ir.consts || {}, constraints: ir.constraints || {}, params: ir.params, meta: ir.meta, imports: ir.imports, rootId, nodes };
}
