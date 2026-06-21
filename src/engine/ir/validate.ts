// validate — structured diagnostics over the flat Doc (the validation stage of the pipeline).
//
// Because it knows the WHOLE vocabulary (types, tokens, state, ops, parts) and the scope of each
// `each` item, every error is specific and proposes the closest candidate ("did you mean …?"). The
// same Doc that compiles is the one validated, so the editor and the build never disagree. Consumed
// by the live linter, the CLI's `muten lint`, and the Vite plugin.

import { resolveToken, SUGGESTED, defaultTheme, isKnownTokenShape } from '#engine/style/tokens.js';
import { diag, closest } from '#engine/shared/diagnostics.js';
import { PRIMITIVE_NAMES, ACTION_OPS, PRIMITIVES } from '#engine/lang/manifest.js';
import { Nt, Ek, StOp } from '#engine/shared/vocab.js';
import type { Doc, FlatNode, ValidateCtx, ValidateResult, Diagnostic, Expr, Stmt, StringPropValue } from '#engine/shared/types.js';

const KNOWN_TYPES = new Set<string>(PRIMITIVE_NAMES); // from the manifest (single source)
const REF_PROPS: Array<'bind' | 'data'> = ['bind', 'data']; // props whose value is @state
const KNOWN_OPS = new Set<string>(ACTION_OPS);
const SCALARS = ['text', 'number', 'bool', 'uuid', 'email', 'string'];

// collect the variable names referenced by an expression AST
function collectRefs(e: Expr, acc: string[] = []): string[] {
  if (e.kind === Ek.Ref) acc.push(e.name);
  else if (e.kind === Ek.Un) collectRefs(e.operand, acc);
  else if (e.kind === Ek.Bin) { collectRefs(e.left, acc); collectRefs(e.right, acc); }
  else if (e.kind === Ek.Tern) { collectRefs(e.cond, acc); collectRefs(e.then, acc); collectRefs(e.else, acc); }
  return acc;
}

// ctx.parts = known part names in the project (to suggest and validate instances)
export function validate(doc: Doc, ctx: ValidateCtx = {}): ValidateResult {
  const D: Diagnostic[] = [];

  const stateKeys = new Set(Object.keys(doc.state || {}));
  const storeDomains = new Set(ctx.stores || []); // app-global store slices (cart.total, cart.add)
  const constNames = new Set(Object.keys(doc.consts || {})); // compile-time constants
  const nodes = doc.nodes || {};

  // ── state types: a `list` must declare its element (the north star — always know what's inside) ──
  const entityNames = Object.keys(doc.entities || {});
  for (const [name, def] of Object.entries(doc.state || {})) {
    const t = def.type;
    if (t === 'list') {
      D.push(diag('untyped-list', `state "${name}" is an untyped "list" — declare the element type, e.g. list<uuid> or list<User>`, { loc: def.loc, suggestion: 'list<uuid>' }));
    } else if (t.startsWith('list<')) {
      const elem = t.slice(5, -1);
      if (!SCALARS.includes(elem) && !entityNames.includes(elem)) {
        D.push(diag('unknown-type', `list element "${elem}" is not a known entity or scalar type`, { loc: def.loc, suggestion: closest(elem, [...entityNames, ...SCALARS]) }));
      }
    }
  }

  const checkRef = (value: string | undefined, node: FlatNode): void => {
    if (typeof value === 'string' && value.startsWith('@')) {
      const name = value.slice(1).split('.')[0];
      if (!stateKeys.has(name)) {
        const near = closest(name, [...stateKeys]);
        D.push(diag('unknown-ref', `"@${name}" is not a declared state`, { loc: node.loc, suggestion: near ? '@' + near : null }));
      }
    }
  };

  // validate the variables an expression uses against (item scope ∪ state)
  const checkExpr = (expr: Expr, node: FlatNode, scope: Set<string>): void => {
    for (const ref of collectRefs(expr)) {
      const head = ref.split('.')[0];
      if (scope.has(head) || stateKeys.has(head) || storeDomains.has(head) || constNames.has(head)) continue;
      const near = closest(head, [...stateKeys, ...scope]);
      D.push(diag('unknown-ref', `"${head}" is not a known state or item variable here`, { loc: node.loc, suggestion: near }));
    }
  };

  // ── the node tree: known type · required props · valid style tokens · resolvable expression refs ──
  const seen = new Set<string>();
  const walk = (id: string, scope: Set<string>): void => {
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
      const prim = PRIMITIVES[n.type];
      const spec = prim ? prim.props : {};
      for (const [pname, hint] of Object.entries(spec)) {
        if (!hint.endsWith('?') && !(pname in (n.props || {}))) {
          D.push(diag('missing-prop', `${n.type} is missing the required "${pname}"`, { loc: n.loc }));
        }
      }
    }

    const props = n.props || {};
    for (const rp of REF_PROPS) if (rp in props) checkRef(props[rp], n);
    if (Array.isArray(props.style)) {
      const theme = ctx.theme || defaultTheme;
      const hasValues = Object.keys(theme.space || {}).length > 0; // a real project theme is present
      for (const t of props.style) {
        if (!isKnownTokenShape(t)) {
          // STRICT vocabulary: the family/atom must be one Muten accepts (engine = source of truth)
          D.push(diag('unknown-token', `"${t}" is not an accepted style token`, { loc: n.loc, suggestion: closest(t, SUGGESTED) }));
        } else if (hasValues && resolveToken(t, theme) === null) {
          // family is valid but the scale step isn't defined in THIS project's theme
          D.push(diag('unknown-token', `"${t}": that step isn't in your theme scale`, { loc: n.loc, suggestion: closest(t, SUGGESTED) }));
        }
      }
    }
    // expression references (when condition, each list, reactive Text/Image interpolation)
    if (n.type === Nt.When && props.cond) checkExpr(props.cond, n, scope);
    if (n.type === Nt.Each && props.list) checkExpr(props.list, n, scope);
    const interps: StringPropValue[] = [];
    if ((n.type === Nt.Text || n.type === Nt.Title || n.type === Nt.Span) && props.value) interps.push(props.value);
    if (n.type === Nt.Image) { if (props.src) interps.push(props.src); if (props.alt) interps.push(props.alt); }
    for (const ip of interps) {
      if (typeof ip === 'object' && 'kind' in ip && ip.kind === Ek.Interp) {
        for (const part of ip.parts) if (typeof part !== 'string') checkExpr(part, n, scope);
      }
    }

    // children inherit the scope; an `each` adds its item variable
    const childScope = (n.type === Nt.Each && props.as) ? new Set([...scope, props.as]) : scope;
    for (const c of n.children || []) walk(c, childScope);
  };
  if (doc.rootId) walk(doc.rootId, new Set());
  else if (ctx.kind !== 'store') D.push(diag('no-root', 'the doc is missing a rootId'));

  // ── .store gets: each `get` expression resolves against the slice's own state ──
  if (ctx.kind === 'store') {
    for (const [name, expr] of Object.entries(doc.gets || {})) {
      for (const ref of collectRefs(expr)) {
        const head = ref.split('.')[0];
        if (!stateKeys.has(head)) D.push(diag('unknown-ref', `get "${name}": "${head}" is not a state of this store`, { suggestion: closest(head, [...stateKeys]) }));
      }
    }
  }

  // ── actions: a body may only mutate what `mutates` declares, with known ops ──
  for (const [name, a] of Object.entries(doc.actions || {})) {
    const declared = new Set(a.mutates || []);
    const checkStmt = (st: Stmt): void => {
      if (st.op === StOp.If) { for (const s of (st.then || [])) checkStmt(s); for (const s of (st.else || [])) checkStmt(s); return; } // recurse into branches
      if (!KNOWN_OPS.has(st.op)) {
        D.push(diag('unknown-op', `action "${name}" uses unknown op "${st.op}"`, { suggestion: closest(st.op, [...KNOWN_OPS]) }));
      }
      if (st.target && !declared.has(st.target)) {
        D.push(diag('undeclared-mutation', `action "${name}" mutates "${st.target}" but only declares mutates(${[...declared].join(', ') || '∅'})`, { suggestion: closest(st.target, [...declared]) }));
      }
    };
    for (const st of a.body || []) checkStmt(st);
  }

  return { ok: D.length === 0, diagnostics: D };
}
