// print: IR -> .muten source, the inverse of parse. parse -> print -> parse yields the same IR,
// so an AI can mutate the IR by node id (engine/ir/mutate.ts) and re-emit faithful source instead
// of regenerating the file or text-patching it. Output is canonical (declaration order and spacing
// are normalized); parsed equality is guaranteed, not byte identity.
import { Ek, StOp, Nt, Mod } from '#engine/shared/vocab.js';
import type {
  IR, IRNode, Expr, Interp, ParamRef, Stmt, Value, Scalar, StateDef, ActionDef,
  Route, Entity, EntityConstraints, PartDef, ArgMap, ArgValue, ClassCond, ClassInterp, StringPropValue,
} from '#engine/shared/types.js';

const IND = '  ';
const isParam = (v: StringPropValue): v is ParamRef => typeof v === 'object' && '$param' in v;
const isIdent = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(s); // bare word (class name / ref) vs a quoted literal

// ── expressions ──────────────────────────────────────────────────────────────
function printExpr(e: Expr): string {
  switch (e.kind) {
    case Ek.Lit: return printScalar(e.value);
    case Ek.Ref: return e.name;
    case Ek.Un: return `${e.op} ${wrap(e.operand)}`;
    case Ek.Bin: return `${wrap(e.left)} ${e.op} ${wrap(e.right)}`;
    case Ek.Tern: return `${wrap(e.cond)} ? ${wrap(e.then)} : ${wrap(e.else)}`;
    case Ek.Call: return `${e.fn}(${e.args.map(printExpr).join(', ')})`;
    case Ek.Obj: return `{ ${e.fields.map((f) => `${f.key}: ${printExpr(f.value)}`).join(', ')} }`;
    case Ek.Agg: return `${e.list}.${e.op} ${e.op === 'count' ? 'where' : 'by'} ${printExpr(e.body)}`; // e.g. `lines.sum by price * qty` / `tasks.count where not done`
    case Ek.Filter: return `${e.list} where ${printExpr(e.cond)}`; // derived list, e.g. `tasks where status == "todo"`
    case Ek.Arr: return `[ ${e.items.map(printValue).join('  ')} ]`; // inline `each [ … ]` list literal
  }
}
// parenthesize nested binary/ternary so re-parse rebuilds the same tree (over-parenthesizes to preserve structure)
const wrap = (e: Expr): string => (e.kind === Ek.Bin || e.kind === Ek.Tern) ? `(${printExpr(e)})` : printExpr(e);

const printScalar = (s: Scalar): string => typeof s === 'string' ? JSON.stringify(s) : String(s);

function printValue(v: Value): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(printValue).join(', ')}]`;
  if (typeof v === 'object') return `{ ${Object.entries(v).map(([k, val]) => `${k}: ${printValue(val)}`).join(', ')} }`;
  return printScalar(v);
}

// interpolation inside a quoted string: "Hi {user.name}"
const printInterp = (i: Interp): string => '"' + i.parts.map((p) => typeof p === 'string' ? p : `{${printExpr(p)}}`).join('') + '"';
// a path is a quoted string literal (interpolated): "/product/{p.id}"
const printPath = (to: string | Interp): string => typeof to === 'string' ? JSON.stringify(to) : printInterp(to);

function printStringProp(v: StringPropValue): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (isParam(v)) return '$' + v.$param;
  return printInterp(v);
}

const printArgValue = (v: ArgValue): string => typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '$lit' in v ? JSON.stringify(v.$lit) : '$' + v.$param;
const printArgMap = (m: ArgMap): string => Object.entries(m).map(([k, v]) => `${k}: ${printArgValue(v)}`).join(', ');
const printClass = (c: string | ClassCond | ClassInterp): string =>
  typeof c === 'string' ? (isIdent(c) ? c : JSON.stringify(c))
    : 'interp' in c ? printStringProp(c.interp)
      : `${isIdent(c.name) ? c.name : JSON.stringify(c.name)} when ${printExpr(c.cond)}`;

// ── statements (action bodies / store effects) ────────────────────────────────
function printStmt(s: Stmt, ind: string): string {
  switch (s.op) {
    case StOp.Push: return `${s.target}.push(${printExpr(s.arg)})`;
    case StOp.Set: return `${s.target}.set(${printExpr(s.arg)})`;
    case StOp.Reset: return `${s.target}.reset()`;
    case StOp.Toggle: return `${s.target}.toggle()`;
    case StOp.Remove: return `${s.target}.remove where ${printExpr(s.pred)}`;
    case StOp.Patch: return `${s.target}.patch where ${printExpr(s.pred)} with ${printExpr(s.patch)}`;
    case StOp.Create: return `${s.target}.create(${printExpr(s.arg)})`;
    case StOp.Update: return `${s.target}.update(${printExpr(s.arg)})`;
    case StOp.Delete: return `${s.target}.delete(${printExpr(s.arg)})`;
    case StOp.Refetch: return `${s.target}.refetch(${Object.entries(s.params).map(([k, e]) => `${k}: ${printExpr(e)}`).join(', ')})`;
    case StOp.Request: return `${s.method.toLowerCase()} ${typeof s.url === 'string' ? JSON.stringify(s.url) : printInterp(s.url)}${s.body ? ` body ${printExpr(s.body)}` : ''}`;
    case StOp.Call: return `${s.target}.${s.method}(${s.args.map(printExpr).join(', ')})`;
    case StOp.Extern: return `${s.fn}(${s.args.map(printExpr).join(', ')})`;
    case StOp.If: {
      const then = s.then.map((st) => ind + IND + printStmt(st, ind + IND)).join('\n');
      const elsePart = s.else ? ` else {\n${s.else.map((st) => ind + IND + printStmt(st, ind + IND)).join('\n')}\n${ind}}` : '';
      return `if ${printExpr(s.cond)} {\n${then}\n${ind}}${elsePart}`;
    }
  }
}

// ── the node tree ──────────────────────────────────────────────────────────────
function printNode(n: IRNode, ind: string): string {
  if (n.args) return `${ind}${n.type}(${printArgMap(n.args)})`;          // part instance: Name(key: value)
  if (n.type === Nt.Slot) return `${ind}slot`;
  const p = n.props || {};
  let head: string;
  if (n.type === Nt.When) head = `when ${printExpr(p.cond as Expr)}`;
  else if (n.type === Nt.Each) head = `each ${printExpr(p.list as Expr)} as ${p.as}`;
  else {
    head = n.type;
    if (n.type === Nt.Custom && p.component) head += ` ${p.component}`; // Custom's component is a BARE ident (Custom Foo), not a quoted string
    else {
      const pos = p.value ?? p.label ?? p.src ?? p.name ?? p.placeholder ?? p.submitLabel; // `name` = Icon's set:name
      if (pos !== undefined) head += ` ${printStringProp(pos)}`;
    }
    if (p.to !== undefined) head += ` -> ${printPath(p.to)}`;
    else if (p.action) head += ` -> ${p.action}${p.arg !== undefined ? `(${[p.arg, ...(p.argRest || [])].map(printExpr).join(', ')})` : ''}`;
    if (p.data) head += ` @${p.data}`;
    if (p.bind) head += ` bind ${p.bind.includes('.') ? p.bind : '@' + p.bind}`;
    if (p.where) head += ` ${Mod.Where}(${p.where.join(', ')})`;
    if (p.columns) head += ` ${Mod.Columns}(${p.columns.join(', ')})`;
    if (p.class) head += ` ${Mod.Class}(${p.class.map(printClass).join(', ')})`;
    if (p.alt !== undefined) head += ` ${Mod.Alt} ${printStringProp(p.alt)}`;
    if (p.inputs) head += ` ${Mod.Inputs}(${printArgMap(p.inputs)})`;
    if (p.on) head += ` ${Mod.On}(${printArgMap(p.on)})`;
    if (p.submit) head += ` ${Mod.Submit} ${p.submit}`;
  }
  if (n.children && n.children.length) return `${ind}${head} {\n${n.children.map((c) => printNode(c, ind + IND)).join('\n')}\n${ind}}`;
  return `${ind}${head}`;
}

// ── declarations ────────────────────────────────────────────────────────────────
const printEntity = (name: string, e: Entity, cs?: EntityConstraints): string => {
  const fields = Object.entries(e).map(([f, t]) => {
    let s = `${f} ${t}`;
    const c = cs?.[f];
    if (c?.required) s += ' required';
    if (c?.min !== undefined) s += ` min:${c.min}`;
    if (c?.max !== undefined) s += ` max:${c.max}`;
    return s;
  });
  return `entity ${name} { ${fields.join('  ')} }`;
};
const printState = (name: string, s: StateDef): string => {
  const rhs = s.source?.startsWith('query:') ? `query ${s.source.slice(6)}` : printValue(s.initial ?? null);
  return `${name} = ${rhs} : ${s.type}`;
};
const printAction = (name: string, a: ActionDef): string => {
  const sig = a.params?.length ? `(${a.params.map((p) => `${p.name}: ${p.type}`).join(', ')})` : '';
  const tail = a.params?.length ? '' : (a.input ? ` <- ${a.input}` : ''); // multi-param and `<- input` are mutually exclusive
  const head = `action ${name}${sig}${a.mutates.length ? ` mutates ${a.mutates.join(', ')}` : ''}${tail}`;
  return `${head} {\n${a.body.map((s) => IND + printStmt(s, IND)).join('\n')}\n}`;
};
const printRoute = (r: Route): string =>
  `${JSON.stringify(r.url)} -> ${r.page}${r.guard ? ` guard ${r.guardNeg ? 'not ' : ''}${r.guard}${r.redirect ? ` else ${JSON.stringify(r.redirect)}` : ''}` : ''}`;
const printPart = (name: string, part: PartDef): string =>
  `part ${name}(${part.params.map((pp) => `${pp.name}: ${pp.type}`).join(', ')}) {\n${printNode(part.tree, IND)}\n}`;
const block = (kw: string, body: string): string => `${kw} {\n${body}\n}`;
const kvBlock = (kw: string, entries: [string, Value][], sep: ':' | ''): string =>
  block(kw, entries.map(([k, v]) => `${IND}${k}${sep} ${printValue(v)}`).join('\n'));

// ── top level ──────────────────────────────────────────────────────────────────
export function print(ir: IR): string {
  const out: string[] = [];
  const push = (s: string | undefined): void => { if (s) out.push(s); };

  if (ir.consts) for (const [n, v] of Object.entries(ir.consts)) push(`const ${n} = ${printScalar(v)}`);
  push(ir.screen ? `screen ${ir.screen}` : undefined);
  if (ir.imports) for (const i of ir.imports) push(`use ${i.names.join(', ')} from ${JSON.stringify(i.from)}`);
  if (ir.meta) push(block('meta', Object.entries(ir.meta).map(([k, v]) => `${IND}${k} ${JSON.stringify(v)}`).join('\n')));
  if (ir.params) for (const p of ir.params) push(`param ${p}`);
  if (ir.api) push(kvBlock('api', Object.entries(ir.api), ':'));
  if (ir.entities) for (const [n, e] of Object.entries(ir.entities)) push(printEntity(n, e, ir.constraints?.[n]));
  if (ir.state && Object.keys(ir.state).length) push(block('state', Object.entries(ir.state).map(([n, s]) => IND + printState(n, s)).join('\n')));
  if (ir.store && Object.keys(ir.store).length) push(block('store', Object.entries(ir.store).map(([n, s]) => IND + printState(n, s)).join('\n')));
  if (ir.theme && Object.keys(ir.theme).length) push(`theme {\n${Object.entries(ir.theme).map(([section, scale]) => `${IND}${section} {\n${Object.entries(scale).map(([k, v]) => `${IND}${IND}${k} ${JSON.stringify(v)}`).join('\n')}\n${IND}}`).join('\n')}\n}`);
  if (ir.gets) for (const [n, e] of Object.entries(ir.gets)) push(`get ${n} = ${printExpr(e)}`);
  if (ir.sources) push(kvBlock('sources', Object.entries(ir.sources), ':'));
  if (ir.mock) push(kvBlock('mock', Object.entries(ir.mock), ':'));
  if (ir.actions) for (const [n, a] of Object.entries(ir.actions)) push(printAction(n, a));
  if (ir.effects) for (const body of ir.effects) push(block('effect', body.map((s) => IND + printStmt(s, IND)).join('\n')));
  if (ir.parts) for (const [n, part] of Object.entries(ir.parts)) push(printPart(n, part));
  if (ir.shell) push(block('shell', (ir.shell.children || []).map((c) => printNode(c, IND)).join('\n')));
  if (ir.tree) push(printNode(ir.tree, ''));
  if (ir.routes) push(block('routes', ir.routes.map((r) => IND + printRoute(r)).join('\n')));

  return out.join('\n\n') + '\n';
}
