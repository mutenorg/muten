// Flat-IR (doc) validator — emits STRUCTURED DIAGNOSTICS.
//
// Since it knows the whole vocabulary (types, tokens, state, ops, parts) AND the
// scope of `each` items, every error is specific and proposes the closest candidate
// ("did you mean ...?"). Editor/AI consumable. Runs on the same doc that gets compiled.

import { TOKENS } from './theme.js';
import { diag, closest } from './diagnostics.js';
import { PRIMITIVE_NAMES, ACTION_OPS, PRIMITIVES } from './manifest.js';

const KNOWN_TYPES = new Set(PRIMITIVE_NAMES); // from the manifest (single source)
const REF_PROPS = ['bind', 'data']; // props whose value is @state
const KNOWN_OPS = new Set(ACTION_OPS);

// collect the variable names referenced by an expression AST
function collectRefs(e, acc = []) {
  if (!e || typeof e !== 'object') return acc;
  if (e.kind === 'ref') acc.push(e.name);
  else if (e.kind === 'un') collectRefs(e.operand, acc);
  else if (e.kind === 'bin') { collectRefs(e.left, acc); collectRefs(e.right, acc); }
  return acc;
}

// ctx.parts = known part names in the project (to suggest and validate instances)
export function validate(doc, ctx = {}) {
  const D = [];
  if (!doc || typeof doc !== 'object') {
    return { ok: false, diagnostics: [diag('bad-doc', 'doc must be an object')] };
  }

  const stateKeys = new Set(Object.keys(doc.state || {}));
  const nodes = doc.nodes || {};

  // state types: a `list` must declare its element type (north star: know what's inside)
  const SCALARS = ['text', 'number', 'bool', 'uuid', 'email', 'string'];
  const entityNames = Object.keys(doc.entities || {});
  for (const [name, def] of Object.entries(doc.state || {})) {
    const t = def.type;
    if (t === 'list') {
      D.push(diag('untyped-list', `state "${name}" is an untyped "list" — declare the element type, e.g. list<uuid> or list<User>`, { loc: def.loc, suggestion: 'list<uuid>' }));
    } else if (typeof t === 'string' && t.startsWith('list<')) {
      const elem = t.slice(5, -1);
      if (!SCALARS.includes(elem) && !entityNames.includes(elem)) {
        D.push(diag('unknown-type', `list element "${elem}" is not a known entity or scalar type`, { loc: def.loc, suggestion: closest(elem, [...entityNames, ...SCALARS]) }));
      }
    }
  }

  const checkRef = (value, node) => {
    if (typeof value === 'string' && value.startsWith('@')) {
      const name = value.slice(1).split('.')[0];
      if (!stateKeys.has(name)) {
        const near = closest(name, [...stateKeys]);
        D.push(diag('unknown-ref', `"@${name}" is not a declared state`, { loc: node.loc, suggestion: near ? '@' + near : null }));
      }
    }
  };

  // validate the variables an expression uses against (item scope ∪ state)
  const checkExpr = (expr, node, scope) => {
    for (const ref of collectRefs(expr)) {
      const head = ref.split('.')[0];
      if (scope.has(head) || stateKeys.has(head)) continue;
      const near = closest(head, [...stateKeys, ...scope]);
      D.push(diag('unknown-ref', `"${head}" is not a known state or item variable here`, { loc: node.loc, suggestion: near }));
    }
  };

  const seen = new Set();
  const walk = (id, scope) => {
    const n = nodes[id];
    if (!n) { D.push(diag('missing-node', `node ${id} does not exist`)); return; }
    if (seen.has(id)) { D.push(diag('dup-node', `${id} is referenced twice`, { loc: n.loc })); return; }
    seen.add(id);

    if (!KNOWN_TYPES.has(n.type)) {
      if (n.args) {
        D.push(diag('unknown-part', `"${n.type}" is not a known part`, { loc: n.loc, suggestion: closest(n.type, ctx.parts || []) }));
      } else {
        D.push(diag('unknown-type', `"${n.type}" is not a known primitive`, { loc: n.loc, suggestion: closest(n.type, [...KNOWN_TYPES]) }));
      }
    } else {
      // required props from the manifest (the ones NOT ending in "?")
      const spec = (PRIMITIVES[n.type] || {}).props || {};
      for (const [pname, hint] of Object.entries(spec)) {
        if (!String(hint).endsWith('?') && !(pname in (n.props || {}))) {
          D.push(diag('missing-prop', `${n.type} is missing the required "${pname}"`, { loc: n.loc }));
        }
      }
    }

    const props = n.props || {};
    for (const rp of REF_PROPS) if (rp in props) checkRef(props[rp], n);
    if (Array.isArray(props.style)) {
      for (const t of props.style) {
        if (!(t in TOKENS)) D.push(diag('unknown-token', `"${t}" is not a style token`, { loc: n.loc, suggestion: closest(t, Object.keys(TOKENS)) }));
      }
    }
    // expression references (when condition, each list, reactive Text/Image interpolation)
    if (n.type === 'When' && props.cond) checkExpr(props.cond, n, scope);
    if (n.type === 'Each' && props.list) checkExpr(props.list, n, scope);
    const interp = n.type === 'Text' ? props.value : (n.type === 'Image' ? props.src : null);
    if (interp && interp.kind === 'interp') {
      for (const part of interp.parts) if (part && part.kind) checkExpr(part, n, scope);
    }

    // children inherit the scope; an `each` adds its item variable
    const childScope = (n.type === 'Each' && props.as) ? new Set([...scope, props.as]) : scope;
    for (const c of n.children || []) walk(c, childScope);
  };
  if (doc.rootId) walk(doc.rootId, new Set());
  else D.push(diag('no-root', 'the doc is missing a rootId'));

  // Actions: the body may only mutate what's declared in `mutates`, with known ops.
  for (const [name, a] of Object.entries(doc.actions || {})) {
    const declared = new Set(a.mutates || []);
    for (const st of a.body || []) {
      if (!KNOWN_OPS.has(st.op)) {
        D.push(diag('unknown-op', `action "${name}" uses unknown op "${st.op}"`, { suggestion: closest(st.op, [...KNOWN_OPS]) }));
      }
      if (st.target && !declared.has(st.target)) {
        D.push(diag('undeclared-mutation', `action "${name}" mutates "${st.target}" but only declares mutates(${[...declared].join(', ') || '∅'})`, { suggestion: closest(st.target, [...declared]) }));
      }
    }
  }

  return { ok: D.length === 0, diagnostics: D };
}
