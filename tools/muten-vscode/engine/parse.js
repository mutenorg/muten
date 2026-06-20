// Parser for the human SYNTAX (.screen) -> nested IR.
//
// This is the top layer: what a person (or the AI) writes. It reads like a description
// of the screen. From here down everything already exists (validate/flatten/compile).
//
//   .screen  ->  [parse]  ->  IR  ->  validate -> flatten -> compile  ->  JS
//
// Plain recursive descent. ~15 primitives, each with a known "shape".

import { ParseError } from './diagnostics.js';
import { PRIMITIVES, MODIFIERS } from './manifest.js';

// Derived from the MANIFEST (single source of the vocabulary):
//  - positional string per primitive (Text "x" -> props.value)
//  - the modifiers valid inside a node
const STRING_PROP = Object.fromEntries(
  Object.entries(PRIMITIVES).filter(([, p]) => p.string).map(([k, p]) => [k, p.string]),
);
const NODE_MODIFIERS = new Set(MODIFIERS);

const mapFieldType = (t) => (t === 'text' ? 'string' : t);

// "Hi, {user.name}" -> { kind:'interp', parts:[ "Hi, ", {kind:'ref',name:'user.name'} ] }
// (refs only inside {}, for now). A plain string with no { } stays a plain string.
function parseInterpolation(raw) {
  if (!raw.includes('{')) return raw;
  const parts = [];
  let i = 0;
  while (i < raw.length) {
    const open = raw.indexOf('{', i);
    if (open < 0) { parts.push(raw.slice(i)); break; }
    if (open > i) parts.push(raw.slice(i, open));
    const close = raw.indexOf('}', open);
    if (close < 0) { parts.push(raw.slice(open)); break; }
    parts.push({ kind: 'ref', name: raw.slice(open + 1, close).trim() });
    i = close + 1;
  }
  return { kind: 'interp', parts };
}

function locFromIndex(src, idx) {
  let line = 1, col = 1;
  for (let k = 0; k < idx && k < src.length; k++) { if (src[k] === '\n') { line++; col = 1; } else col++; }
  return { line, col };
}

// ── tokenizer ── (each token stores `pos` = start index, for line/col)
function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const isIdent = (c) => c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c === '_';
  const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

  while (i < n) {
    const c = src[i];
    const p = i; // token start index
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      let s = ''; let j = i + 1;
      while (j < n && src[j] !== '"') { s += src[j]; j++; }
      toks.push({ t: 'string', v: s, pos: p }); i = j + 1; continue;
    }
    if (c === '@') {
      let s = ''; let j = i + 1;
      while (j < n && isIdent(src[j])) { s += src[j]; j++; }
      toks.push({ t: 'ref', v: '@' + s, pos: p }); i = j; continue;
    }
    if (c === '$') {
      let s = ''; let j = i + 1;
      while (j < n && isIdent(src[j])) { s += src[j]; j++; }
      toks.push({ t: 'param', v: s, pos: p }); i = j; continue; // $title = reference to a part param
    }
    if (c === '-' && src[i + 1] === '>') { toks.push({ t: 'arrow', v: '->', pos: p }); i += 2; continue; }
    if (c === '<' && src[i + 1] === '-') { toks.push({ t: 'larrow', v: '<-', pos: p }); i += 2; continue; }
    if (c === '=' && src[i + 1] === '=') { toks.push({ t: 'eq', v: '==', pos: p }); i += 2; continue; }
    if (c === '=' && src[i + 1] === '>') { toks.push({ t: 'fatarrow', v: '=>', pos: p }); i += 2; continue; }
    if (c === '!' && src[i + 1] === '=') { toks.push({ t: 'neq', v: '!=', pos: p }); i += 2; continue; }
    if (c === '<' && src[i + 1] === '=') { toks.push({ t: 'lte', v: '<=', pos: p }); i += 2; continue; }
    if (c === '>' && src[i + 1] === '=') { toks.push({ t: 'gte', v: '>=', pos: p }); i += 2; continue; }
    if ((c >= '0' && c <= '9') || (c === '-' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i + (c === '-' ? 1 : 0);
      while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      if (src[j] === '.') { j++; while (j < n && src[j] >= '0' && src[j] <= '9') j++; }
      toks.push({ t: 'number', v: src.slice(i, j), pos: p }); i = j; continue;
    }
    if ('{}()[],|:=<>./'.includes(c)) { toks.push({ t: 'punct', v: c, pos: p }); i++; continue; } // `/` = route paths
    if (isIdentStart(c)) {
      let s = ''; let j = i;
      while (j < n && isIdent(src[j])) { s += src[j]; j++; }
      toks.push({ t: 'ident', v: s, pos: p }); i = j; continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)}`, locFromIndex(src, i));
  }
  toks.push({ t: 'eof', v: '', pos: i });
  return toks;
}

// ── parser ──
export function parse(src) {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const at = (t, v) => peek().t === t && (v === undefined || peek().v === v);
  const next = () => toks[pos++];

  // pos (index) -> { line, col }  (binary search over line starts)
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const locOf = (p) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= p) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: p - lineStarts[lo] + 1 };
  };

  const eat = (t, v) => {
    if (!at(t, v)) {
      const tk = peek();
      throw new ParseError(`expected ${t}${v ? ' "' + v + '"' : ''}, got ${tk.t} "${tk.v}"`, locOf(tk.pos));
    }
    return next();
  };

  const ir = { screen: '', entities: {}, state: {}, actions: {}, tree: null };

  while (!at('eof')) {
    if (at('ident', 'screen')) { next(); ir.screen = eat('ident').v; }
    else if (at('ident', 'entity')) parseEntity();
    else if (at('ident', 'state')) parseState();
    else if (at('ident', 'action')) parseAction();
    else if (at('ident', 'mock')) parseMock();
    else if (at('ident', 'sources')) parseSources();
    else if (at('ident', 'routes')) parseRoutes();
    else if (at('ident', 'part')) parsePart();
    else ir.tree = parseNode(); // tree root
  }
  return ir;

  // type: IDENT optionally < IDENT >   (e.g. list<User>)
  function parseType() {
    let s = eat('ident').v;
    if (at('punct', '<')) { next(); s += '<' + eat('ident').v + '>'; eat('punct', '>'); }
    return s;
  }

  function parseEntity() {
    eat('ident', 'entity');
    const name = eat('ident').v;
    eat('punct', '{');
    const fields = { id: 'uuid' }; // implicit uuid id
    while (!at('punct', '}')) {
      const fname = eat('ident').v;
      const opts = [eat('ident').v];
      while (at('punct', '|')) { next(); opts.push(eat('ident').v); }
      fields[fname] = opts.length > 1 ? 'enum:' + opts.join('|') : mapFieldType(opts[0]);
    }
    eat('punct', '}');
    ir.entities[name] = fields;
  }

  function parseState() {
    eat('ident', 'state');
    eat('punct', '{');
    while (!at('punct', '}')) {
      const nameTok = eat('ident');
      const name = nameTok.v;
      eat('punct', '=');
      let source, initial, hasInitial = false;
      if (at('ident', 'query')) { next(); source = 'query:' + eat('ident').v; }
      else if (at('punct', '{')) { next(); eat('punct', '}'); initial = {}; hasInitial = true; }
      else if (at('punct', '[')) { next(); eat('punct', ']'); initial = []; hasInitial = true; } // ponytail: empty list only; non-empty state init is YAGNI
      else if (at('string')) { initial = next().v; hasInitial = true; }
      else { initial = next().v; hasInitial = true; } // fallback literal
      eat('punct', ':');
      const type = parseType();
      const loc = locOf(nameTok.pos);
      ir.state[name] = source ? { type, source, loc } : { type, initial: hasInitial ? initial : null, loc };
    }
    eat('punct', '}');
  }

  function parseAction() {
    eat('ident', 'action');
    const name = eat('ident').v;
    eat('ident', 'mutates');
    const mutates = [eat('ident').v];
    while (at('punct', ',')) { next(); mutates.push(eat('ident').v); }
    eat('larrow');
    const input = eat('ident').v;
    const body = parseActionBody(); // the body (the logic) lives HERE, not in the compiler
    ir.actions[name] = { mutates, input, body };
  }

  // { statement* }  — each statement is a declared mutation
  function parseActionBody() {
    eat('punct', '{');
    const body = [];
    while (!at('punct', '}')) body.push(parseStatement());
    eat('punct', '}');
    return body;
  }

  // target.method(args)  →  push | remove | reset | set
  function parseStatement() {
    const target = eat('ident').v;
    eat('punct', '.');
    const method = eat('ident').v;
    eat('punct', '(');
    let stmt;
    if (method === 'push') stmt = { op: 'push', target, arg: parseExpr() };
    else if (method === 'set') stmt = { op: 'set', target, arg: parseExpr() };
    else if (method === 'reset') stmt = { op: 'reset', target };
    else if (method === 'remove') {
      const param = eat('ident').v;
      eat('fatarrow');
      stmt = { op: 'remove', target, param, pred: parseExpr() };
    } else {
      throw new Error(`unsupported action method: ${target}.${method}()`);
    }
    eat('punct', ')');
    return stmt;
  }

  // expression grammar (precedence): or < and < comparison < unary < primary
  function parseExpr() { return parseOr(); }
  function parseOr() {
    let l = parseAnd();
    while (at('ident', 'or')) { next(); l = { kind: 'bin', op: 'or', left: l, right: parseAnd() }; }
    return l;
  }
  function parseAnd() {
    let l = parseCmp();
    while (at('ident', 'and')) { next(); l = { kind: 'bin', op: 'and', left: l, right: parseCmp() }; }
    return l;
  }
  function parseCmp() {
    let l = parseUnary();
    let op;
    while ((op = cmpOp())) { next(); l = { kind: 'bin', op, left: l, right: parseUnary() }; }
    return l;
  }
  function cmpOp() {
    if (at('eq')) return '=='; if (at('neq')) return '!=';
    if (at('lte')) return '<='; if (at('gte')) return '>=';
    if (at('punct', '<')) return '<'; if (at('punct', '>')) return '>';
    if (at('ident', 'contains')) return 'contains';
    return null;
  }
  function parseUnary() {
    if (at('ident', 'not')) { next(); return { kind: 'un', op: 'not', operand: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    if (at('punct', '(')) { next(); const e = parseExpr(); eat('punct', ')'); return e; }
    if (at('string')) return { kind: 'lit', value: next().v };
    if (at('number')) return { kind: 'lit', value: Number(next().v) };
    let name = at('param') ? '$' + next().v : eat('ident').v; // $param resolves at compose time
    if (name === 'true') return { kind: 'lit', value: true };
    if (name === 'false') return { kind: 'lit', value: false };
    if (name === 'null') return { kind: 'lit', value: null };
    while (at('punct', '.')) { next(); name += '.' + eat('ident').v; }
    return { kind: 'ref', name };
  }

  // when <expr> { node* }  — conditional render
  function parseWhen() {
    const head = eat('ident', 'when');
    const cond = parseExpr();
    eat('punct', '{');
    const children = [];
    while (!at('punct', '}')) children.push(parseNode());
    eat('punct', '}');
    return { type: 'When', props: { cond }, children, loc: locOf(head.pos) };
  }

  // each <list> as <item> { node* }  — list render (item is a scope var in the template)
  function parseEach() {
    const head = eat('ident', 'each');
    const list = parseExpr();
    eat('ident', 'as');
    const item = eat('ident').v;
    eat('punct', '{');
    const children = [];
    while (!at('punct', '}')) children.push(parseNode());
    eat('punct', '}');
    return { type: 'Each', props: { list, as: item }, children, loc: locOf(head.pos) };
  }

  function parseNode() {
    if (at('ident', 'when')) return parseWhen(); // control-flow nodes
    if (at('ident', 'each')) return parseEach();
    const head = eat('ident');
    const type = head.v;
    const loc = locOf(head.pos); // node position, for inline diagnostics
    if (at('punct', '(')) return { type, args: parseArgs(), loc }; // part instance: Name(arg: value)
    const props = {};
    const children = [];
    if (type === 'Custom') props.component = eat('ident').v; // Custom <Name> inputs(...) on(...)
    let parsing = true;
    while (parsing) {
      const tk = peek();
      switch (tk.t) {
        case 'string': props[STRING_PROP[type] || 'label'] = (type === 'Text' || type === 'Image') ? parseInterpolation(next().v) : next().v; break;
        case 'param': props[STRING_PROP[type] || 'label'] = { $param: next().v }; break;
        case 'ref': props.data = next().v; break; // positional @ref = data
        case 'arrow': {
          next();
          props.action = at('param') ? '$' + next().v : eat('ident').v; // -> $onSave : callback param
          if (at('punct', '(')) {
            next();
            if (!at('punct', ')')) props.arg = parseDotted();
            eat('punct', ')');
          }
          break;
        }
        case 'ident': {
          const kw = tk.v;
          if (!NODE_MODIFIERS.has(kw)) { parsing = false; break; } // starts a sibling
          next();
          if (kw === 'bind') props.bind = eat('ref').v;
          else if (kw === 'submit') props.submit = eat('ident').v;
          else if (kw === 'where') props.where = parseParenList(rebuildClause);
          else if (kw === 'columns') props.columns = parseParenList(() => eat('ident').v);
          else if (kw === 'style') props.style = parseParenList(parseDotted);
          else if (kw === 'inputs') props.inputs = parseArgs(); // Custom: inputs(k: value, ...)
          else if (kw === 'on') props.on = parseArgs();         // Custom: on(event: action, ...)
          break;
        }
        case 'punct':
          if (tk.v === '{') {
            next();
            while (!at('punct', '}')) children.push(parseNode());
            eat('punct', '}');
          }
          parsing = false; // any punct (including '}') closes the node parts
          break;
        default:
          parsing = false;
      }
    }
    const node = { type, props, loc };
    if (children.length) node.children = children;
    return node;
  }

  // IDENT(.IDENT)*  -> "row.id"
  function parseDotted() {
    let s = at('param') ? '$' + next().v : eat('ident').v; // $param.member resolves at compose time
    while (at('punct', '.')) { next(); s += '.' + eat('ident').v; }
    return s;
  }

  // ( item , item , ... )   with a parameterizable item reader
  function parseParenList(readItem) {
    eat('punct', '(');
    const out = [];
    while (!at('punct', ')')) {
      out.push(readItem());
      if (at('punct', ',')) next();
    }
    eat('punct', ')');
    return out;
  }

  // a where clause: reads tokens until , or ) and rebuilds them -> "role == admin"
  function rebuildClause() {
    const parts = [];
    while (!at('punct', ',') && !at('punct', ')')) parts.push(next().v);
    return parts.join(' ');
  }

  // mock { queryName: <value>, ... }  — test data defined IN the .screen
  function parseMock() {
    eat('ident', 'mock');
    eat('punct', '{');
    const mock = ir.mock || {};
    while (!at('punct', '}')) {
      const name = eat('ident').v;
      eat('punct', ':');
      mock[name] = parseValue();
      if (at('punct', ',')) next();
    }
    eat('punct', '}');
    ir.mock = mock;
  }

  // sources { queryName: "url" | { url: "...", at: "results" }, ... } — REAL data sources
  function parseSources() {
    eat('ident', 'sources');
    eat('punct', '{');
    const sources = ir.sources || {};
    while (!at('punct', '}')) {
      const name = eat('ident').v;
      eat('punct', ':');
      sources[name] = parseValue();
      if (at('punct', ',')) next();
    }
    eat('punct', '}');
    ir.sources = sources;
  }

  // routes { /url -> page  ... }  — the app ROOT (app.screen). URL decoupled from folder.
  function parseRoutes() {
    eat('ident', 'routes');
    eat('punct', '{');
    const routes = ir.routes || [];
    while (!at('punct', '}')) {
      const start = peek();
      let url = '';
      while (!at('arrow')) {
        if (at('punct', '/')) { next(); url += '/'; }
        else url += eat('ident').v;
      }
      eat('arrow');
      routes.push({ url, page: eat('ident').v, loc: locOf(start.pos) });
    }
    eat('punct', '}');
    ir.routes = routes;
  }

  // JSON-ish literals: string | number | bool | null | ident(enum) | [..] | {..}
  function parseValue() {
    if (at('string')) return next().v;
    if (at('number')) return Number(next().v);
    if (at('punct', '[')) return parseArray();
    if (at('punct', '{')) return parseObject();
    const w = eat('ident').v;
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return w; // enum value (e.g. admin) → string
  }

  function parseArray() {
    eat('punct', '[');
    const arr = [];
    while (!at('punct', ']')) {
      arr.push(parseValue());
      if (at('punct', ',')) next();
    }
    eat('punct', ']');
    return arr;
  }

  function parseObject() {
    eat('punct', '{');
    const obj = {};
    while (!at('punct', '}')) {
      const key = at('string') ? next().v : eat('ident').v;
      eat('punct', ':');
      obj[key] = parseValue();
      if (at('punct', ',')) next();
    }
    eat('punct', '}');
    return obj;
  }

  // part Name(p: type, ...) { <tree> }  — reusable composition (inlined in compose)
  function parsePart() {
    eat('ident', 'part');
    const name = eat('ident').v;
    eat('punct', '(');
    const params = [];
    while (!at('punct', ')')) {
      const pn = eat('ident').v;
      eat('punct', ':');
      params.push({ name: pn, type: parseType() });
      if (at('punct', ',')) next();
    }
    eat('punct', ')');
    eat('punct', '{');
    const nodes = [];
    while (!at('punct', '}')) nodes.push(parseNode());
    eat('punct', '}');
    ir.parts = ir.parts || {};
    // single root, or several nodes auto-wrapped in a Stack
    ir.parts[name] = { params, tree: nodes.length === 1 ? nodes[0] : { type: 'Stack', props: {}, children: nodes } };
  }

  // ( key: value, ... )  — args of a part instance
  function parseArgs() {
    eat('punct', '(');
    const args = {};
    while (!at('punct', ')')) {
      const key = eat('ident').v;
      eat('punct', ':');
      args[key] = parseArgValue();
      if (at('punct', ',')) next();
    }
    eat('punct', ')');
    return args;
  }

  function parseArgValue() {
    if (at('string')) return next().v;
    if (at('number')) return Number(next().v);
    if (at('ref')) return next().v;               // @state
    if (at('param')) return { $param: next().v }; // $param (nested parts)
    return eat('ident').v;                          // enum / literal
  }
}
