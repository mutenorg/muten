// Part composition: replaces each part instance with its tree, substituting $params
// with the args. Parts DISAPPEAR at build-time → the IR stays flat, all primitives,
// and the AI can still mutate it (spec §8: composition, not JS).
//
// Resolves nested parts (a part may instantiate another). Substitution is EXPLICIT per
// value shape (prop / expression / interpolation / arg) — honestly typed, no generic any.

import { Ek } from '#engine/shared/vocab.js';
import type { IRNode, NodeProps, StringPropValue, Expr, Interp, ArgMap, ArgValue, PartDef } from '#engine/shared/types.js';

type Parts = { [name: string]: PartDef };

export function compose(tree: IRNode | null, parts: Parts): { tree: IRNode | null; used: string[] } {
  const used = new Set<string>();                      // which parts were instantiated (to hoist their data)
  const out = tree ? composeNode(tree, parts, used) : tree;
  return { tree: out, used: [...used] };
}

function composeNode(node: IRNode, parts: Parts, used: Set<string>): IRNode {
  const part = parts[node.type];
  if (part) {                                          // it's a part instance
    used.add(node.type);
    const inlined = substitute(part.tree, node.args || {});
    return composeNode(inlined, parts, used);          // resolve nested parts
  }
  const out: IRNode = { type: node.type };
  if (node.loc) out.loc = node.loc;   // the page's own nodes keep their position
  if (node.args) out.args = node.args; // UNRESOLVED part instance (typo) → validate flags it unknown-part
  if (node.props) out.props = node.props;
  if (node.children) out.children = node.children.map((c) => composeNode(c, parts, used));
  return out;
}

// replaces { $param: "x" } with args.x across the part's whole subtree
function substitute(node: IRNode, args: ArgMap): IRNode {
  const out: IRNode = { type: node.type };
  if (node.props) out.props = subProps(node.props, args);
  if (node.args) out.args = subArgs(node.args, args);    // args of nested parts
  if (node.children) out.children = node.children.map((c) => substitute(c, args));
  return out;
}

// node props: substitute only the ones that can carry a $param (text, expr, ref, args).
function subProps(props: NodeProps, args: ArgMap): NodeProps {
  const out: NodeProps = { ...props }; // passthrough for level/style/class/where/columns/component/data/as
  if (props.value !== undefined) out.value = subStringProp(props.value, args);
  if (props.label !== undefined) out.label = subStringProp(props.label, args);
  if (props.src !== undefined) out.src = subStringProp(props.src, args);
  if (props.alt !== undefined) out.alt = subStringProp(props.alt, args);
  if (props.placeholder !== undefined) out.placeholder = subStringProp(props.placeholder, args);
  if (props.submitLabel !== undefined) out.submitLabel = subStringProp(props.submitLabel, args);
  if (props.cond !== undefined) out.cond = subExpr(props.cond, args);
  if (props.list !== undefined) out.list = subExpr(props.list, args);
  if (props.arg !== undefined) out.arg = subExpr(props.arg, args);
  if (props.action !== undefined) out.action = refText(props.action, args); // action/submit names: $onSave
  if (props.submit !== undefined) out.submit = refText(props.submit, args);
  if (props.bind !== undefined) out.bind = refText(props.bind, args);
  if (props.to !== undefined) out.to = typeof props.to === 'string' ? props.to : subInterp(props.to, args);
  if (props.inputs !== undefined) out.inputs = subArgs(props.inputs, args);
  if (props.on !== undefined) out.on = subArgs(props.on, args);
  return out;
}

// a positional string prop: plain text passes through; { $param } → the arg; interpolation recurses.
function subStringProp(v: StringPropValue, args: ArgMap): StringPropValue {
  if (typeof v === 'string') return v;
  if ('$param' in v) { const a = args[v.$param]; return typeof a === 'number' ? String(a) : a; } // {$param} → arg
  return subInterp(v, args);                                                                      // interpolation
}

// expression: substitute $param refs inside; structure (kind) is preserved.
function subExpr(e: Expr, args: ArgMap): Expr {
  if (e.kind === Ek.Ref) return { kind: Ek.Ref, name: refText(e.name, args) }; // $char.image → c.image
  if (e.kind === Ek.Bin) return { ...e, left: subExpr(e.left, args), right: subExpr(e.right, args) };
  if (e.kind === Ek.Un) return { ...e, operand: subExpr(e.operand, args) };
  if (e.kind === Ek.Tern) return { ...e, cond: subExpr(e.cond, args), then: subExpr(e.then, args), else: subExpr(e.else, args) };
  return e; // literal: nothing to substitute
}

// interpolation: its text chunks are literal; only the embedded expressions can hold $params.
function subInterp(i: Interp, args: ArgMap): Interp {
  return { kind: Ek.Interp, parts: i.parts.map((p) => typeof p === 'string' ? p : subExpr(p, args)) };
}

// args of a part instance / Custom inputs|on.
function subArgs(m: ArgMap, args: ArgMap): ArgMap {
  const out: ArgMap = {};
  for (const [k, v] of Object.entries(m)) out[k] = subArgValue(v, args);
  return out;
}

function subArgValue(v: ArgValue, args: ArgMap): ArgValue {
  if (typeof v === 'string') return v.startsWith('$') ? refText(v, args) : v;
  if (typeof v === 'number') return v;
  return args[v.$param]; // nested $param → the arg
}

// "$char.image" + {char:"c"} -> "c.image";  "$onSave" -> "addFav".  Non-$ strings pass through.
function refText(name: string, args: ArgMap): string {
  if (!name.startsWith('$')) return name;
  const head = name.slice(1).split('.')[0];
  const rest = name.slice(1 + head.length);
  const a = args[head];
  return (typeof a === 'string' ? a : head) + rest;
}
