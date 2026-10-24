// compose: replaces each part instance with its tree, substituting $params with the args.
// Parts disappear at build-time so the IR stays flat and all-primitives, and the AI can
// still mutate it by id. Resolves nested parts. Substitution is explicit per value shape
// (prop / expression / interpolation / arg), honestly typed with no generic any.

import { BOp, Ek, Nt } from '#engine/shared/vocab.js';
import { toDoc } from '#engine/ir/flatten.js';
import { mergeImports } from '#engine/ir/imports.js';
import { ParseError } from '#engine/shared/diagnostics.js';
import { strayParams, strayArgs } from '#engine/ir/part-params.js';
import type { IR, Doc, IRNode, NodeProps, StringPropValue, Expr, Interp, ArgMap, ArgValue, PartDef, PartParam, ExprPropKey, Loc } from '#engine/shared/types.js';

type Parts = { [name: string]: PartDef };

// a readable form of a part-call arg value, for the DevTools "props" view (bare ref / number / "literal" / $param).
function argToStr(v: ArgValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if ('$lit' in v) return JSON.stringify(v.$lit);
  if ('$expr' in v) return '{…}';
  return '$' + v.$param;
}

// The page outlet a shell/layout keeps: composing a page, a top-level `slot` has no caller and composes away; composing
// a layout, it IS the point where the router mounts the page, so it survives as itself.
const OUTLET: IRNode = { type: Nt.Slot, props: {} };
// the one-expression props a $param can sit in: each is substituted like `cond` (left out, `checked($on)` inside a part
// reached the page as an unknown ref)
const EXPR_PROPS: ExprPropKey[] = ['checked', 'draggable', 'min', 'max', 'step', 'filter', 'take', 'x', 'y', 'w', 'h', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'rx', 'start', 'end', 'inner'];

export function compose(tree: IRNode | null, parts: Parts, keepOutlet = false): { tree: IRNode | null; used: string[] } {
  const used = new Set<string>();                      // which parts were instantiated (to hoist their data)
  const out = tree ? composeNode(tree, parts, used, new Set(), keepOutlet ? [OUTLET] : []) : tree;
  return { tree: out, used: [...used] };
}

// The single page-doc builder: inline parts, hoist the used parts' entities/state, then flatten.
// Spreads `ir` so every field (imports/params/meta/...) survives. Both the CLI loader and the editor
// analyzer go through here, so a new IR field can never silently drop in just one path.
export function composeDoc(ir: IR, parts: Parts, keepOutlet = false): { doc: Doc; used: string[] } {
  const { tree, used } = compose(ir.tree, parts, keepOutlet);
  const entities = { ...ir.entities };
  const state = { ...ir.state };
  for (const name of used) {
    const p = parts[name];
    if (!p) continue;
    Object.assign(entities, p.entities);
    Object.assign(state, p.state);
  }
  const imports = mergeImports(ir.imports || [], used.flatMap((name) => parts[name]?.imports || []));
  return { doc: toDoc({ ...ir, entities, state, tree, imports }), used };
}

// The defaults a part declares (`size: text = "sm"`), as the args a call that omits them would have passed.
function fallbacks(params: PartParam[]): ArgMap {
  const out: ArgMap = {};
  for (const param of params) if (param.fallback !== undefined) out[param.name] = param.fallback;
  return out;
}

// `slot` carries the call-site children to inject at the part's `slot` marker. They're composed once, in the
// CALLER's chain — so nesting the same wrapper (`Panel { Panel { … } }`) is fine; only a part whose BODY cites
// itself is the unterminating cycle the chain guard catches.
function composeNode(node: IRNode, parts: Parts, used: Set<string>, chain: Set<string> = new Set(), slot: IRNode[] = []): IRNode {
  const part = parts[node.type];
  if (part) {                                          // it's a part instance
    if (chain.has(node.type)) {   // a finding at the line that closes the cycle (check, --json), not a crash
      const cycle = new ParseError(`part "${node.type}" references itself (directly or through another part) — parts inline at build, so a cycle can never terminate. Remove the self-reference.`, node.place || node.loc);
      cycle.code = 'part-cycle';
      throw cycle;
    }
    used.add(node.type);
    const kids = (node.children || []).flatMap((c) => composeChild(c, parts, used, chain, slot)); // the call's children become this part's slot content (forwarding any enclosing slot)
    const args = { ...fallbacks(part.params), ...(node.args || {}) };   // a param the call leaves out takes its declared default
    let inlined: IRNode;
    try { inlined = substitute(part.tree, args, { name: node.type, part }, node.place || node.loc || null); }   // every inlined node remembers which part file it was written in
    catch (error) { const missing = new ParseError(`${node.type}(…): ${error instanceof Error ? error.message : String(error)}`, node.loc); missing.code = 'part-arg-missing'; throw missing; }   // a diagnostic at the CALL (file:line in check), not a crash
    const composed = composeNode(inlined, parts, used, new Set([...chain, node.type]), kids);   // resolve nested parts; the part's `slot` fills with kids
    const strayArgsHere = strayArgs(node.type, part, node);   // an argument that is no parameter: said at the call (part-params.ts)
    if (strayArgsHere.length) composed.strays = [...(composed.strays || []), ...strayArgsHere];
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
  if (node.place) out.place = node.place;
  if (node.strays) out.strays = node.strays;
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
function substitute(node: IRNode, args: ArgMap, from: { name: string; part: PartDef }, call: Loc | null): IRNode {
  const owner = from.name;
  const out: IRNode = { type: node.type };
  out.ownerPart = node.ownerPart || owner;
  const strays = node.place ? [] : strayParams(owner, from.part, node);   // a `$name` that is no parameter, on this node as written
  if (strays.length) out.strays = strays;
  const src = node.partLoc || node.loc;
  if (src) out.partLoc = src;
  const place = node.place || (node.loc ? { line: node.loc.line, col: node.loc.col, in: { part: owner, call } } : null);
  if (place) out.place = place;
  if (node.fromPart) out.fromPart = node.fromPart;
  if (node.props) out.props = subProps(node.props, args);
  if (node.args) out.args = subArgs(node.args, args);    // args of nested parts
  if (node.children) out.children = node.children.map((c) => substitute(c, args, from, call));
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
  if (props.summary !== undefined) out.summary = subStringProp(props.summary, args); // Details "{$question}" in a part: the summary is a positional string too
  if (props.submitLabel !== undefined) out.submitLabel = subStringProp(props.submitLabel, args);
  if (props.cond !== undefined) out.cond = subExpr(props.cond, args);
  if (props.disabled !== undefined) out.disabled = subExpr(props.disabled, args); // `disabled when $disabled` in a part (Btn): the caller's bool, a state or true/false
  if (props.list !== undefined) out.list = subExpr(props.list, args);
  if (props.arg !== undefined) out.arg = subExpr(props.arg, args);
  if (props.argRest !== undefined) out.argRest = props.argRest.map((a) => subExpr(a, args));
  if (props.action !== undefined) out.action = refText(props.action, args); // action/submit names can be $params too
  if (props.submit !== undefined) out.submit = refText(props.submit, args);
  if (props.bind !== undefined) {
    // a part that binds one of its params (`SearchField bind($value)`) needs that param passed: left out, it bound a
    // state named `value` that does not exist and the page crashed when it opened, with a clean check
    const own = props.bind.startsWith('$') ? props.bind.slice(1).split('.')[0] : '';
    if (own && args[own] === undefined) throw new Error(`this part binds \`${own}\` (bind($${own})) but the call does not pass it: add \`${own}: <a state>\` to the call`);
    out.bind = refText(props.bind, args);
  }
  if (props.to !== undefined) out.to = typeof props.to === 'string' ? props.to : subInterp(props.to, args);
  if (props.id !== undefined) out.id = subId(props.id, args);
  if (props.inputs !== undefined) out.inputs = subInputs(props.inputs, args);
  if (props.on !== undefined) out.on = subOn(props.on, args);
  if (props.styleVars !== undefined) out.styleVars = Object.fromEntries(Object.entries(props.styleVars).map(([k, v]) => [k, typeof v === 'string' ? v : subInterp(v, args)])); // `style(w: "{$pct}")` in a part: sub the param
  if (props.aria !== undefined) out.aria = Object.fromEntries(Object.entries(props.aria).map(([k, e]) => [k, subExpr(e, args)]));                                          // `aria(label: $lbl)` in a part: sub the param
  for (const key of EXPR_PROPS) { const expr = props[key]; if (expr !== undefined) out[key] = subExpr(expr, args); }
  return out;
}

// `id("{$anchor}")` in a part: the id stays a STATIC literal (the oracle proves every `-> "#anchor"` lands), so the param
// is replaced by the quoted text the call passed. Left alone, every section came out with the id «{$anchor}» and the
// table of contents of a document pointed nowhere.
const ID_PARAM = /^\{\$(\w+)\}$/;
function subId(id: string, args: ArgMap): string {
  const match = ID_PARAM.exec(id);
  if (!match) return id;
  const value = args[match[1]];
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && '$lit' in value && !value.$interp) return value.$lit;
  throw new Error(`id("{$${match[1]}}") needs a quoted text: pass ${match[1]}: "…" (an id is static, so the anchors that point to it can be checked)`);
}

// a positional string prop: plain text passes through, { $param } resolves to the arg, interpolation recurses.
function subStringProp(v: StringPropValue, args: ArgMap): StringPropValue {
  if (typeof v === 'string') return v;
  if ('$param' in v) {
    const a = args[v.$param];
    if (typeof a === 'number' || typeof a === 'boolean') return String(a);
    if (typeof a === 'object' && '$lit' in a) return a.$interp ?? a.$lit;   // a quoted literal (an interpolated one keeps its Interp)
    if (typeof a === 'object' && '$expr' in a) return { kind: Ek.Interp, parts: [a.$expr] };
    // a ref (`label: tab.label`, `label: title`): the text follows it. It used to be written out as its own name, «tab.label»
    return typeof a === 'string' && a ? { kind: Ek.Interp, parts: [{ kind: Ek.Ref, name: a }] } : a;
  }
  return subInterp(v, args);                                                                      // interpolation
}

// "{t(lang, k)} más" as ONE expression ("" + t(lang, k) + " más"), for the sinks that read an expr (aria, conditions).
function interpExpr(interp: Interp): Expr {
  return interp.parts.reduce<Expr>((acc, part) => ({ kind: Ek.Bin, op: BOp.Add, left: acc, right: typeof part === 'string' ? { kind: Ek.Lit, value: part } : part }), { kind: Ek.Lit, value: '' });
}

// expression: substitute $param refs inside; structure (kind) is preserved.
function subExpr(e: Expr, args: ArgMap): Expr {
  if (e.kind === Ek.Ref) {
    if (e.name.startsWith('$')) {                                       // a part param in an expr position
      const a = args[e.name.slice(1).split('.')[0]];
      if (a !== undefined && typeof a === 'object' && '$lit' in a) return a.$interp && !e.name.includes('.') ? interpExpr(a.$interp) : { kind: Ek.Lit, value: a.$lit }; // literal stays a literal, not a ref; an interpolated one (`label: "{t(lang, k)}"`) stays live, so aria and other expr sinks get the text, never the raw `{…}`
      if (typeof a === 'number' || typeof a === 'boolean') return { kind: Ek.Lit, value: a };
    }
    return { kind: Ek.Ref, name: refText(e.name, args) };              // $char.image -> c.image
  }
  if (e.kind === Ek.Bin) return { ...e, left: subExpr(e.left, args), right: subExpr(e.right, args) };
  if (e.kind === Ek.Un) return { ...e, operand: subExpr(e.operand, args) };
  if (e.kind === Ek.Tern) return { ...e, cond: subExpr(e.cond, args), then: subExpr(e.then, args), else: subExpr(e.else, args) };
  if (e.kind === Ek.Call) return { ...e, args: e.args.map((a) => subExpr(a, args)), ...(e.chain ? { chain: e.chain.map((step) => (step.args ? { ...step, args: step.args.map((a) => subExpr(a, args)) } : step)) } : {}) }; // a use'd fn: substitute $params in its args and its chain's
  if (e.kind === Ek.Obj) return { ...e, fields: e.fields.map((f) => ({ key: f.key, value: subExpr(f.value, args) })) };
  if (e.kind === Ek.List) return { ...e, items: e.items.map((item) => subExpr(item, args)) };
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
  if (typeof v === 'string') {
    if (!v.startsWith('$')) return v;
    // a part forwarding its OWN param to a nested part (`NumberField(step: $step)`): when that param holds a number
    // or a quoted literal (passed, or its declared default), forward the VALUE. refText would turn it into a bare
    // name — `step` — that reads as a state ref that does not exist.
    const own = v.includes('.') ? undefined : args[v.slice(1)];
    if (typeof own === 'number' || typeof own === 'boolean' || (own !== undefined && typeof own === 'object')) return own;
    return refText(v, args);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if ('$lit' in v) return v;        // quoted literal: nothing to substitute
  if ('$expr' in v) return { $expr: subExpr(v.$expr, args) };   // an object prop: its $params too
  return args[v.$param] ?? v;       // nested $param -> the arg (left as is when missing: validate names it)
}

// Custom `on(...)`: a handler that forwards an action param the caller did not pass (`open: $onOpen` with no onOpen)
// is dropped, so the widget sees no handler at all instead of a call to a name that does not exist.
function subOn(m: ArgMap, args: ArgMap): ArgMap {
  const out: ArgMap = {};
  for (const [k, v] of Object.entries(m)) {
    const name = typeof v === 'string' ? (v.startsWith('$') && !v.includes('.') ? v.slice(1) : '') : (typeof v === 'object' && '$param' in v ? v.$param : '');
    if (name && args[name] === undefined) continue;
    out[k] = subArgValue(v, args);
  }
  return out;
}

// Custom `inputs` are read by customValue, which marks a REACTIVE ref with a leading `@` (else it's a literal).
// A part param resolves to a bare ref string (`vol`), which would be JSON-stringified as the literal "vol" and
// never update - so when a param's arg is a ref (not a $lit/number), restore the `@` so it stays reactive.
function subInputs(m: ArgMap, args: ArgMap): ArgMap {
  const out: ArgMap = {};
  for (const [k, v] of Object.entries(m)) {
    // a param the caller did not pass (and that has no default) is left out: otherwise its bare name would read as a
    // state of the same name on the calling page (AgendaLive's `free` picked up a page's own `free` list)
    const name = typeof v === 'string' ? (v.startsWith('$') && !v.includes('.') ? v.slice(1) : '') : (typeof v === 'object' && '$param' in v ? v.$param : '');
    if (name && args[name] === undefined) continue;
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
  const av = (a !== undefined && typeof a === 'object' && '$lit' in a) ? a.$lit : (typeof a === 'string' ? a : typeof a === 'boolean' ? String(a) : head);
  return av + rest;
}
