// Part composition: replaces each part instance with its tree, substituting $params
// with the args. Parts DISAPPEAR at build-time → the IR stays flat, all primitives,
// and the AI can still mutate it (spec §8: composition, not JS).
//
// Resolves nested parts (a part may instantiate another).

export function compose(tree, parts) {
  const used = new Set();                               // which parts were instantiated (to hoist their data)
  const out = tree ? composeNode(tree, parts, used) : tree;
  return { tree: out, used: [...used] };
}

function composeNode(node, parts, used) {
  if (parts[node.type]) {                               // it's a part instance
    used.add(node.type);
    const inlined = substitute(parts[node.type].tree, node.args || {});
    return composeNode(inlined, parts, used);           // resolve nested parts
  }
  const out = { type: node.type };
  if (node.loc) out.loc = node.loc;   // the page's own nodes keep their position
  if (node.args) out.args = node.args; // UNRESOLVED part instance (typo) → validate flags it unknown-part
  if (node.props) out.props = node.props;
  if (node.children) out.children = node.children.map((c) => composeNode(c, parts, used));
  return out;
}

// replaces { $param: "x" } with args.x across the part's whole subtree
function substitute(node, args) {
  const out = { type: node.type };
  if (node.props) out.props = subObj(node.props, args);
  if (node.args) out.args = subObj(node.args, args);    // args of nested parts
  if (node.children) out.children = node.children.map((c) => substitute(c, args));
  return out;
}

function subObj(obj, args) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) o[k] = subVal(v, args);
  return o;
}

function subVal(v, args) {
  if (v == null) return v;
  if (typeof v === 'string') return v.startsWith('$') ? refText(v, args) : v;  // action/submit name: $onSave
  if (Array.isArray(v)) return v.map((x) => subVal(x, args));
  if (typeof v !== 'object') return v;
  if ('$param' in v) return args[v.$param];                                     // whole value: Text $title
  if (v.kind === 'ref') return { kind: 'ref', name: refText(v.name, args) };    // $char.image -> c.image
  if (v.kind === 'interp') return { kind: 'interp', parts: v.parts.map((p) => subVal(p, args)) };
  if (v.kind === 'bin') return { ...v, left: subVal(v.left, args), right: subVal(v.right, args) };
  if (v.kind === 'un') return { ...v, operand: subVal(v.operand, args) };
  return subObj(v, args);                                                        // generic object (e.g. source {url,at})
}

// "$char.image" + {char:"c"} -> "c.image";  "$onSave" -> "addFav".  Non-$ strings pass through.
function refText(name, args) {
  if (!name.startsWith('$')) return name;
  const head = name.slice(1).split('.')[0];
  const rest = name.slice(1 + head.length);
  return (args[head] === undefined ? head : args[head]) + rest;
}
