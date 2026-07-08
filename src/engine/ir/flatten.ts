// flatten: nested authoring tree -> canonical flat Doc, addressable by id.
// Assigns each node a deterministic pre-order id (n1, n2, ...). From here on the engine
// works by id only: the flat Doc is the single shape that is validated, mutated, and compiled.
// Consumed by compose.ts (composeDoc) and directly by the runner and CLI.

import { Ek, Nt } from '#engine/shared/vocab.js';
import type { IR, IRNode, FlatNode, Doc, Entity, FieldType, Value } from '#engine/shared/types.js';

// `each [ {…} {…} ] as x` — hoist the inline literal into a synthesized page state (`__eachN = [ … ] : list`) and
// rewrite the each to iterate it by name. inferLiteralListShapes (below) then infers the element shape, so the rest
// of the pipeline (validate/refs/compile) only ever sees a normal named-list `each`. Static content lists become
// one-liners; a MUTATED list still needs a real named state (you can't reference an anonymous inline list to push to it).
function hoistInlineEachLists(ir: IR): IR {
  if (!ir.tree) return ir;
  const state = { ...(ir.state || {}) };
  const used = new Set(Object.keys(state));
  let n = 0, made = 0;
  const fresh = (): string => { let name; do { name = '_inline' + (++n); } while (used.has(name)); used.add(name); return name; }; // valid state name (single `_`, NOT the reserved `__`), collision-free
  const walk = (node: IRNode): void => {
    const list = node.props?.list;
    if (node.type === Nt.Each && list && typeof list === 'object' && 'kind' in list && list.kind === Ek.Arr) {
      const name = fresh();
      state[name] = { type: 'list', initial: list.items };
      node.props = { ...node.props, list: { kind: Ek.Ref, name } };
      made++;
    }
    (node.children || []).forEach(walk);
  };
  walk(ir.tree);
  return made ? { ...ir, state } : ir;
}

// A list state initialized from a NON-EMPTY literal already carries its own shape, so muten infers the element type
// from the literal instead of forcing a separate `entity` + `list<Entity>` (ceremony with no analyzable payoff — the
// oracle can read `{ title, desc }` straight off the literal). `features = [ { title, desc } ] : list` becomes
// `list<__features>` with a synthesized entity, so `each features as f` still checks `f.title`. Data stays in `state`
// (analyzable, AI-locatable); only the redundant declaration goes away.
const scalarFieldType = (v: Value): FieldType => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text');
function inferLiteralListShapes(ir: IR): IR {
  if (!ir.state) return ir;
  let entities: { [name: string]: Entity } = ir.entities || {};
  const state = { ...ir.state };
  let changed = false;
  for (const [name, def] of Object.entries(ir.state)) {
    if (def.type !== 'list' || !Array.isArray(def.initial) || def.initial.length === 0) continue;
    const items: Value[] = def.initial;
    if (items.every((it) => it != null && typeof it === 'object' && !Array.isArray(it))) {         // list of records -> synth entity
      const fields: Entity = {};
      for (const it of items) for (const key of Object.keys(it as { [k: string]: Value })) if (key !== 'id' && !(key in fields)) fields[key] = scalarFieldType((it as { [k: string]: Value })[key]);
      entities = { ...entities, ['__' + name]: fields };
      state[name] = { ...def, type: `list<__${name}>` };
      changed = true;
    } else if (items.every((it) => it == null || typeof it !== 'object')) {                        // list of scalars -> list<text|number|bool>
      state[name] = { ...def, type: `list<${scalarFieldType(items.find((x) => x != null) as Value)}>` };
      changed = true;
    }
  }
  return changed ? { ...ir, entities, state } : ir;
}

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
  ir = hoistInlineEachLists(ir);     // `each [ … ] as x` → a synthesized state, iterated by name
  ir = inferLiteralListShapes(ir);   // literal-initialized lists get their element shape inferred (no `entity` needed)
  // a .store slice has state + actions but no node tree: produce an empty node map.
  const { rootId, nodes } = ir.tree ? flatten(ir.tree) : { rootId: undefined, nodes: {} };
  return { screen: ir.screen, entities: ir.entities, state: ir.state, actions: ir.actions, gets: ir.gets || {}, effects: ir.effects || [], consts: ir.consts || {}, constraints: ir.constraints || {}, params: ir.params, meta: ir.meta, imports: ir.imports, rootId, nodes };
}
