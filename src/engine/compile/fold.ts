// fold: what a page can know before it runs, written as the value. A part called with fixed arguments arrives here as
// expressions over literals: DeviceFrame(width: "300px") leaves `crop: "" != ""`, `when "" != "" { … }` and
// `style(h: "{""}")`, and each one compiled to an effect that re-checked a value that can never change (Storio's
// landing home: 93 style effects, 600 attribute writes, branches that could never show compiled whole). Folded, a
// constant is a plain value, a `when` that can never show is gone, one that always shows is just its children, and
// the subtrees left with nothing reactive inside become one static clone (compile.ts `cloneable`).
// Known values: the page's consts and its frozen states (frozen.ts: a state nothing writes). Never folded: a route
// param, a name an `each` gives its row or its index (`x`, `i`), nor anything inside a list's own expressions (a `where`, a `sum by`),
// where a bare name is the row's field. Folding follows the JS the compiler would emit, operator by operator.
import { BOp, Ek, Nt, UOp } from '#engine/shared/vocab.js';
import type { ClassCond, ClassInterp, Doc, Expr, ExprPropKey, FlatNode, Interp, NodeProps, Scalar, StringPropValue } from '#engine/shared/types.js';
import { frozenStates } from '#engine/compile/frozen.js';

type Known = Map<string, Scalar>;
type ExprKey = ExprPropKey | 'cond' | 'disabled' | 'checked' | 'arg';
type TextKey = 'value' | 'label' | 'src' | 'alt' | 'placeholder' | 'submitLabel' | 'summary' | 'dropGroup';
type InterpKey = 'to' | 'd' | 'transform';

const EXPR_KEYS: ReadonlyArray<ExprKey> = ['cond', 'disabled', 'checked', 'arg', 'min', 'max', 'step', 'take', 'draggable',
  'x', 'y', 'w', 'h', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'rx', 'start', 'end', 'inner'];
// read only as true or false
const CONDITIONS: ReadonlySet<ExprKey> = new Set<ExprKey>(['cond', 'disabled']);
const TEXT_KEYS: ReadonlyArray<TextKey> = ['value', 'label', 'src', 'alt', 'placeholder', 'submitLabel', 'summary', 'dropGroup'];
const INTERP_KEYS: ReadonlyArray<InterpKey> = ['to', 'd', 'transform'];

const num = (value: Scalar): number | null => (typeof value === 'number' ? value : null);
const both = (a: Scalar, b: Scalar, fn: (x: number, y: number) => number | boolean): Scalar | undefined => {
  const x = num(a), y = num(b);
  return x === null || y === null ? undefined : fn(x, y);
};
const ordered = (a: Scalar, b: Scalar, fn: (order: number) => boolean): Scalar | undefined => {
  if (typeof a === 'number' && typeof b === 'number') return fn(a - b);
  if (typeof a === 'string' && typeof b === 'string') return fn(a < b ? -1 : a > b ? 1 : 0);
  return undefined;
};
// each operator on two known values, as the compiled JS computes it; undefined = not folded (mixed types, `contains`)
const BINARY: { readonly [op in BOp]?: (a: Scalar, b: Scalar) => Scalar | undefined } = {
  [BOp.Eq]: (a, b) => a === b,
  [BOp.Neq]: (a, b) => a !== b,
  [BOp.Lt]: (a, b) => ordered(a, b, (o) => o < 0),
  [BOp.Gt]: (a, b) => ordered(a, b, (o) => o > 0),
  [BOp.Lte]: (a, b) => ordered(a, b, (o) => o <= 0),
  [BOp.Gte]: (a, b) => ordered(a, b, (o) => o >= 0),
  [BOp.And]: (a, b) => (a ? b : a),
  [BOp.Or]: (a, b) => (a ? a : b),
  [BOp.Add]: (a, b) => (typeof a === 'string' || typeof b === 'string') && a !== null && b !== null ? `${a}${b}` : both(a, b, (x, y) => x + y),
  [BOp.Sub]: (a, b) => both(a, b, (x, y) => x - y),
  [BOp.Mul]: (a, b) => both(a, b, (x, y) => x * y),
  [BOp.Div]: (a, b) => both(a, b, (x, y) => x / y),
};

const lit = (value: Scalar): Expr => ({ kind: Ek.Lit, value });
const valueOf = (expr: Expr): Scalar | undefined => (expr.kind === Ek.Lit ? expr.value : undefined);
// what an interpolated part prints: interpConcat's `String(x ?? '')`
const printed = (value: Scalar): string => String(value ?? '');

// ── expressions ──
function foldExpr(expr: Expr, known: Known): Expr {
  switch (expr.kind) {
    case Ek.Ref: { const value = known.get(expr.name); return value === undefined ? expr : lit(value); }
    case Ek.Un: {
      const operand = foldExpr(expr.operand, known);
      const value = valueOf(operand);
      return value !== undefined && expr.op === UOp.Not ? lit(!value) : { ...expr, operand };
    }
    case Ek.Bin: {
      const left = foldExpr(expr.left, known), right = foldExpr(expr.right, known);
      const a = valueOf(left), b = valueOf(right);
      // one known side settles `and` / `or` as JS does: `false and x` is false, `true and x` is x
      if (a !== undefined && b === undefined && (expr.op === BOp.And || expr.op === BOp.Or)) return (expr.op === BOp.And) === Boolean(a) ? right : left;
      const rule = BINARY[expr.op];
      const value = a !== undefined && b !== undefined && rule ? rule(a, b) : undefined;
      return value === undefined ? { ...expr, left, right } : lit(value);
    }
    case Ek.Tern: {
      const cond = foldExpr(expr.cond, known);
      const value = valueOf(cond);
      return value === undefined ? { ...expr, cond, then: foldExpr(expr.then, known), else: foldExpr(expr.else, known) } : foldExpr(value ? expr.then : expr.else, known);
    }
    case Ek.Call: return { ...expr, args: expr.args.map((arg) => foldExpr(arg, known)) };
    case Ek.Obj: return { ...expr, fields: expr.fields.map((field) => ({ key: field.key, value: foldExpr(field.value, known) })) };
    case Ek.List: return { ...expr, items: expr.items.map((item) => foldExpr(item, known)) };
    default: return expr;   // a literal, or a list's own expression (Agg / Filter / Arr), where a bare name is a row field
  }
}

/** An expression read only as true or false (a `when`, a class toggle, `disabled`): `x and false` never holds and
 *  `x or true` always does, whatever x is, though as a value JS would give back x. */
function foldCond(expr: Expr, known: Known): Expr {
  const folded = foldExpr(expr, known);
  if (folded.kind !== Ek.Bin || (folded.op !== BOp.And && folded.op !== BOp.Or)) return folded;
  const sides = [valueOf(folded.left), valueOf(folded.right)].filter((value) => value !== undefined);
  if (folded.op === BOp.And && sides.some((value) => !value)) return lit(false);
  if (folded.op === BOp.Or && sides.some((value) => Boolean(value))) return lit(true);
  return folded;
}

/** An interpolation with its known parts printed in; a plain string when nothing in it is left to read. */
function foldInterp(interp: Interp, known: Known): string | Interp {
  const parts: Array<string | Expr> = [];
  for (const part of interp.parts) {
    const folded = typeof part === 'string' ? part : foldExpr(part, known);
    const value = typeof folded === 'string' ? folded : valueOf(folded);
    const text = typeof folded === 'string' ? folded : value !== undefined ? printed(value) : null;
    const last = parts[parts.length - 1];
    if (text === null) parts.push(folded);
    else if (typeof last === 'string') parts[parts.length - 1] = last + text;
    else parts.push(text);
  }
  return parts.every((part) => typeof part === 'string') ? parts.join('') : { kind: Ek.Interp, parts };
}

function foldText(value: StringPropValue, known: Known): StringPropValue {
  return typeof value === 'object' && 'kind' in value ? foldInterp(value, known) : value;
}

function foldClasses(classes: Array<string | ClassCond | ClassInterp>, known: Known): Array<string | ClassCond | ClassInterp> {
  const out: Array<string | ClassCond | ClassInterp> = [];
  for (const entry of classes) {
    if (typeof entry === 'string') { out.push(entry); continue; }
    if ('interp' in entry) {
      const folded = foldInterp(entry.interp, known);
      if (typeof folded === 'string') out.push(...folded.split(/\s+/).filter(Boolean));
      else out.push({ interp: folded });
      continue;
    }
    const cond = foldCond(entry.cond, known);
    const value = valueOf(cond);
    if (value === undefined) out.push({ name: entry.name, cond });
    else if (value) out.push(entry.name);
  }
  return out;
}

function foldProps(props: NodeProps, known: Known): NodeProps {
  const out: NodeProps = { ...props };
  for (const key of EXPR_KEYS) { const expr = props[key]; if (expr) out[key] = CONDITIONS.has(key) ? foldCond(expr, known) : foldExpr(expr, known); }
  for (const key of TEXT_KEYS) { const text = props[key]; if (text !== undefined) out[key] = foldText(text, known); }
  for (const key of INTERP_KEYS) { const text = props[key]; if (text !== undefined) out[key] = typeof text === 'string' ? text : foldInterp(text, known); }
  if (props.class) out.class = foldClasses(props.class, known);
  if (props.aria) out.aria = Object.fromEntries(Object.entries(props.aria).map(([key, expr]) => [key, foldExpr(expr, known)]));
  if (props.styleVars) out.styleVars = Object.fromEntries(Object.entries(props.styleVars).map(([key, value]) => [key, typeof value === 'string' ? value : foldInterp(value, known)]));
  return out;
}

// ── structure: a `when` that is settled leaves the tree, or leaves its children in its place ──
function settle(nodes: { [id: string]: FlatNode }, id: string): string[] {
  const node = nodes[id];
  const children = node.children.flatMap((child) => settle(nodes, child));
  nodes[id] = { ...node, children };
  if (node.type !== Nt.When || !node.props.cond) return [id];
  const value = valueOf(node.props.cond);
  if (value === undefined) return [id];
  return value ? children : [];
}

/** The names an `each` gives its rows and positions: never a known value, whatever a const or state is called. */
function rowNames(doc: Doc): Set<string> {
  const names = new Set<string>();
  for (const node of Object.values(doc.nodes)) {
    if (node.props.as) names.add(node.props.as);
    if (node.props.index) names.add(node.props.index);
  }
  return names;
}

/** Only the nodes still in the tree: the compiler reads the whole map (is the page static, does it show images). */
function reachable(nodes: { [id: string]: FlatNode }, rootId: string): { [id: string]: FlatNode } {
  const out: { [id: string]: FlatNode } = {};
  const visit = (id: string): void => { out[id] = nodes[id]; nodes[id].children.forEach(visit); };
  visit(rootId);
  return out;
}

/** `doc` with every value it can know before it runs written in. The input is not changed. */
export function foldDoc(doc: Doc): Doc {
  if (!doc.rootId) return doc;
  const known: Known = new Map();
  for (const [name, value] of Object.entries(doc.consts || {})) known.set(name, value);
  for (const [name, value] of frozenStates(doc)) known.set(name, value);
  for (const name of [...rowNames(doc), ...(doc.params || [])]) known.delete(name);   // a route param arrives at run time
  const nodes: { [id: string]: FlatNode } = {};
  for (const [id, node] of Object.entries(doc.nodes)) nodes[id] = { ...node, props: foldProps(node.props, known) };
  // the root is the page's one node and stays, whatever it is; what is under it settles
  const root = nodes[doc.rootId];
  nodes[doc.rootId] = { ...root, children: root.children.flatMap((child) => settle(nodes, child)) };
  return { ...doc, nodes: reachable(nodes, doc.rootId) };
}
