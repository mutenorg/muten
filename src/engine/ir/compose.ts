// compose: replaces each part instance with its tree, substituting $params with the args.
// Parts disappear at build-time so the IR stays flat and all-primitives, and the AI can
// still mutate it by id. Resolves nested parts. Substitution is explicit per value shape
// (prop / expression / interpolation / arg), honestly typed with no generic any.

import { Ek, Nt } from '#engine/shared/vocab.js';
import { toDoc } from '#engine/ir/flatten.js';
import type { IR, Doc, IRNode, NodeProps, StringPropValue, Expr, Interp, ArgMap, ArgValue, PartDef } from '#engine/shared/types.js';

type Parts = { [name: string]: PartDef };

// a readable form of a part-call arg value, for the DevTools "props" view (bare ref / number / "literal" / $param).
function argToStr(v: ArgValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if ('$lit' in v) return JSON.stringify(v.$lit);
  return '$' + v.$param;
}

export function compose(tree: IRNode | null, parts: Parts): { tree: IRNode | null; used: string[] } {
  const used = new Set<string>();                      // which parts were instantiated (to hoist their data)
  const out = tree ? composeNode(tree, parts, used) : tree;
  return { tree: out, used: [...used] };
}

// The single page-doc builder: inline parts, hoist the used parts' entities/state, then flatten.
// Spreads `ir` so every field (imports/params/meta/...) survives. Both the CLI loader and the editor
// analyzer go through here, so a new IR field can never silently drop in just one path.
export function composeDoc(ir: IR, parts: Parts): { doc: Doc; used: string[] } {
  const { tree, used } = compose(ir.tree, parts);
  const entities = { ...ir.entities };
  const state = { ...ir.state };
  for (const name of used) {
    const p = parts[name];
    if (!p) continue;
    Object.assign(entities, p.entities);
    Object.assign(state, p.state);
  }
  return { doc: toDoc({ ...ir, entities, state, tree }), used };
}

// `slot` carries the call-site children to inject at the part's `slot` marker. They're composed once, in the
// CALLER's chain — so nesting the same wrapper (`Panel { Panel { … } }`) is fine; only a part whose BODY cites
// itself is the unterminating cycle the chain guard catches.
function composeNode(node: IRNode, parts: Parts, used: Set<string>, chain: Set<string> = new Set(), slot: IRNode[] = []): IRNode {
  const part = parts[node.type];
  if (part) {                                          // it's a part instance
    if (chain.has(node.type)) throw new Error(`part "${node.type}" references itself (directly or through another part) — parts inline at build, so a cycle can never terminate. Remove the self-reference.`);
    used.add(node.type);
    const kids = (node.children || []).flatMap((c) => composeChild(c, parts, used, chain, slot)); // the call's children become this part's slot content (forwarding any enclosing slot)
    const inlined = substitute(part.tree, node.args || {}, node.type);   // every inlined node remembers which part file it was written in
    const composed = composeNode(inlined, parts, used, new Set([...chain, node.type]), kids);   // resolve nested parts; the part's `slot` fills with kids
    // The instance root keeps the CALL SITE — the line in the page where this part was written. It is the only line the
    // app owns for that whole subtree (a plugin part's own file lives in node_modules and must never be edited), and
    // without it a click on the part's chrome had nothing nearer than the page root to anchor to.
    if (node.loc) composed.loc = node.loc;
    if (node.endLoc) composed.endLoc = node.endLoc;   // the call-site span, so the editor can splice the whole `Name(args)` instance
    // A `class()` written at the CALL SITE appends to the part root's own classes — the same rule two `class()` calls
    // on a primitive already follow: the second appends, it never overwrites. Nothing else may ride in this way.
    const callClass = node.props?.class;
    if (callClass && callClass.length) composed.props = { ...(composed.props || {}), class: [...(composed.props?.class || []), ...callClass] };
    composed.fromPart = node.type;   // dev: tag the part instance's root so the DevTools tree shows the part name
    if (node.args && Object.keys(node.args).length) composed.partArgs = Object.fromEntries(Object.entries(node.args).map(([k, v]) => [k, argToStr(v)])); // dev: the "props" the part was called with
    return composed;
  }
  const out: IRNode = { type: node.type };
  if (node.loc) out.loc = node.loc;   // page's own nodes keep their source position
  if (node.endLoc) out.endLoc = node.endLoc;   // ...and their span END, paired with loc
  // An inlined node has no position in the PAGE, but it has one in the part it was written in. Carry both facts through
  // this branch too — `substitute` stamps them and `composeNode` runs over the result, so dropping them here loses them.
  if (node.ownerPart) out.ownerPart = node.ownerPart;
  if (node.partLoc) out.partLoc = node.partLoc;
  if (node.fromPart) out.fromPart = node.fromPart;
  if (node.partArgs) out.partArgs = node.partArgs;
  if (node.args) out.args = node.args; // unresolved part instance (typo): validate flags it unknown-part
  if (node.props) out.props = node.props;
  if (node.children) out.children = node.children.flatMap((c) => composeChild(c, parts, used, chain, slot));
  return out;
}

// A child position: a `slot` marker expands to the already-composed slot content; any other node composes to itself.
function composeChild(c: IRNode, parts: Parts, used: Set<string>, chain: Set<string>, slot: IRNode[]): IRNode[] {
  if (c.type === Nt.Slot) return slot;                 // inject the caller's children here (empty array if the call passed none)
  return [composeNode(c, parts, used, chain, slot)];
}

// replaces { $param: "x" } with args.x across the part's whole subtree.
//
// `owner` is the part whose FILE this subtree was written in. `loc` is deliberately NOT copied onto the inlined node: it
// is a line in the PART's file, and a diagnostic here names the PAGE — printing one against the other is how you send a
// reader (or a model) to a line that does not exist. It travels as `partLoc` + `ownerPart` instead, so the element
// picker can open the right file at the right line while the oracle keeps pointing at the page. Nested parts keep their
// own owner: the innermost file that actually holds the source wins.
function substitute(node: IRNode, args: ArgMap, owner: string): IRNode {
  const out: IRNode = { type: node.type };
  out.ownerPart = node.ownerPart || owner;
  const src = node.partLoc || node.loc;
  if (src) out.partLoc = src;
  if (node.fromPart) out.fromPart = node.fromPart;
  if (node.props) out.props = subProps(node.props, args);
  if (node.args) out.args = subArgs(node.args, args);    // args of nested parts
  if (node.children) out.children = node.children.map((c) => substitute(c, args, owner));
  return out;
}

// node props: substitute only props that can carry a $param (text, expr, ref, args).
function subProps(props: NodeProps, args: ArgMap): NodeProps {
  const out: NodeProps = { ...props }; // passthrough for level/style/where/columns/component/data/as
  if (props.class !== undefined) out.class = props.class.map((c) => typeof c === 'string' ? c : 'interp' in c ? { interp: subInterp(c.interp, args) } : { name: c.name, cond: subExpr(c.cond, args) }); // `class(x when $flag)` / `class("p-{$x}")`: sub $param in the cond or the interpolation
  if (props.value !== undefined) out.value = subStringProp(props.value, args);
  if (props.label !== undefined) out.label = subStringProp(props.label, args);
  if (props.src !== undefined) out.src = subStringProp(props.src, args);
  if (props.alt !== undefined) out.alt = subStringProp(props.alt, args);
  if (props.name !== undefined) out.name = subStringProp(props.name, args); // Icon "set:name" — a part can pass the icon (`Icon $icon`), inlined to a static literal so it tree-shakes
  if (props.placeholder !== undefined) out.placeholder = subStringProp(props.placeholder, args);
  if (props.submitLabel !== undefined) out.submitLabel = subStringProp(props.submitLabel, args);
  if (props.cond !== undefined) out.cond = subExpr(props.cond, args);
  if (props.list !== undefined) out.list = subExpr(props.list, args);
  if (props.arg !== undefined) out.arg = subExpr(props.arg, args);
  if (props.argRest !== undefined) out.argRest = props.argRest.map((a) => subExpr(a, args));
  if (props.action !== undefined) out.action = refText(props.action, args); // action/submit names can be $params too
  if (props.submit !== undefined) out.submit = refText(props.submit, args);
  if (props.bind !== undefined) out.bind = refText(props.bind, args);
  if (props.to !== undefined) out.to = typeof props.to === 'string' ? props.to : subInterp(props.to, args);
  if (props.inputs !== undefined) out.inputs = subInputs(props.inputs, args);
  if (props.on !== undefined) out.on = subArgs(props.on, args);
  if (props.styleVars !== undefined) out.styleVars = Object.fromEntries(Object.entries(props.styleVars).map(([k, v]) => [k, typeof v === 'string' ? v : subInterp(v, args)])); // `style(w: "{$pct}")` in a part: sub the param
  if (props.aria !== undefined) out.aria = Object.fromEntries(Object.entries(props.aria).map(([k, e]) => [k, subExpr(e, args)]));                                          // `aria(label: $lbl)` in a part: sub the param
  return out;
}

// a positional string prop: plain text passes through, { $param } resolves to the arg, interpolation recurses.
function subStringProp(v: StringPropValue, args: ArgMap): StringPropValue {
  if (typeof v === 'string') return v;
  if ('$param' in v) { const a = args[v.$param]; return typeof a === 'number' ? String(a) : (typeof a === 'object' && '$lit' in a) ? (a.$interp ?? a.$lit) : a; } // {$param} -> arg (an interpolated literal keeps its Interp)
  return subInterp(v, args);                                                                      // interpolation
}

// expression: substitute $param refs inside; structure (kind) is preserved.
function subExpr(e: Expr, args: ArgMap): Expr {
  if (e.kind === Ek.Ref) {
    if (e.name.startsWith('$')) {                                       // a part param in an expr position
      const a = args[e.name.slice(1).split('.')[0]];
      if (a !== undefined && typeof a === 'object' && '$lit' in a) return { kind: Ek.Lit, value: a.$lit }; // literal stays a literal, not a ref
      if (typeof a === 'number') return { kind: Ek.Lit, value: a };
    }
    return { kind: Ek.Ref, name: refText(e.name, args) };              // $char.image -> c.image
  }
  if (e.kind === Ek.Bin) return { ...e, left: subExpr(e.left, args), right: subExpr(e.right, args) };
  if (e.kind === Ek.Un) return { ...e, operand: subExpr(e.operand, args) };
  if (e.kind === Ek.Tern) return { ...e, cond: subExpr(e.cond, args), then: subExpr(e.then, args), else: subExpr(e.else, args) };
  if (e.kind === Ek.Call) return { ...e, args: e.args.map((a) => subExpr(a, args)) }; // a use'd fn: substitute $params in its args
  if (e.kind === Ek.Obj) return { ...e, fields: e.fields.map((f) => ({ key: f.key, value: subExpr(f.value, args) })) };
  if (e.kind === Ek.Agg) return { ...e, list: refText(e.list, args), body: subExpr(e.body, args) };
  if (e.kind === Ek.Filter) return { ...e, list: refText(e.list, args), cond: subExpr(e.cond, args) }; // `tasks where …` inside a part: sub $params
  return e; // literal: nothing to substitute
}

// interpolation: its text chunks are literal; only the embedded expressions can hold $params.
// A bare `$param` slot whose arg is ITSELF an interpolated literal must be SPLICED in: one outer slot holds a
// single `string | Expr`, so it cannot carry "text + expr" on its own (`Span "{$price}/mo"` with price: "{money(p)}").
function subInterp(i: Interp, args: ArgMap): Interp {
  const parts: Array<string | Expr> = [];
  for (const p of i.parts) {
    if (typeof p !== 'string' && p.kind === Ek.Ref && p.name.startsWith('$') && !p.name.includes('.')) {
      const a = args[p.name.slice(1)];
      if (a !== undefined && typeof a === 'object' && '$lit' in a && a.$interp) { parts.push(...a.$interp.parts); continue; }
    }
    parts.push(typeof p === 'string' ? p : subExpr(p, args));
  }
  return { kind: Ek.Interp, parts };
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
  if ('$lit' in v) return v;        // quoted literal: nothing to substitute
  return args[v.$param];            // nested $param -> the arg
}

// Custom `inputs` are read by customValue, which marks a REACTIVE ref with a leading `@` (else it's a literal).
// A part param resolves to a bare ref string (`vol`), which would be JSON-stringified as the literal "vol" and
// never update - so when a param's arg is a ref (not a $lit/number), restore the `@` so it stays reactive.
function subInputs(m: ArgMap, args: ArgMap): ArgMap {
  const out: ArgMap = {};
  for (const [k, v] of Object.entries(m)) {
    const sub = subArgValue(v, args); // resolves a {$param}/"$x" param to its arg (a bare ref string, a number, or a {$lit})
    // A resolved bare string is a state/param REF; restore the `@` customValue needs so it stays reactive
    // (without it the ref is JSON-stringified as a literal and never updates). Numbers and {$lit} pass through.
    out[k] = (typeof sub === 'string' && sub.length > 0 && !sub.startsWith('@')) ? '@' + sub : sub;
  }
  return out;
}

// "$char.image" + {char:"c"} -> "c.image";  "$onSave" -> "addFav".  Non-$ strings pass through.
function refText(name: string, args: ArgMap): string {
  if (!name.startsWith('$')) return name;
  const head = name.slice(1).split('.')[0];
  const rest = name.slice(1 + head.length);
  const a = args[head];
  const av = (a !== undefined && typeof a === 'object' && '$lit' in a) ? a.$lit : (typeof a === 'string' ? a : head);
  return av + rest;
}
