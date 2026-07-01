// parse: .muten source text -> nested IR. Pipeline: .muten -> IR -> compose -> flatten -> compile -> JS.
// Parser extends Grammar, inheriting the token cursor and expression/value sub-grammars.
// This file holds only the screen grammar: top-level declarations (entity/state/action/routes ...)
// and the node tree (Stack/Text/Form/when/each ...). Dispatch is data-driven via Maps (keyword ->
// handler, modifier -> handler, method -> builder), never growing if/else chains. No magic strings.

import { ParseError } from '#engine/shared/diagnostics.js';
import { PRIMITIVES } from '#engine/lang/manifest.js';
import { Grammar } from '#engine/lang/grammar.js';
import { Tk, Pn, Kw, Nt, Mod, StOp, Ek, BOp } from '#engine/shared/vocab.js';
import type {
  IR, IRNode, NodeProps, StringPropName, Stmt, IfStmt, Expr, Interp, Value, Level,
  Entity, FieldType, EntityConstraints, FieldConstraint,
  StateDef, Route, PartParam, ArgValue, ArgMap, ThemeScale,
} from '#engine/shared/types.js';

// Derived from the MANIFEST (single vocabulary source):
//   STRING_PROP  - where a primitive's positional string lands (Text "x" -> props.value)
//   INTERPOLATES - which primitives reactively interpolate that string: Text/Title/Span/Image
const STRING_PROP: { [primitive: string]: StringPropName } = {};
for (const [name, primitive] of Object.entries(PRIMITIVES)) if (primitive.string) STRING_PROP[name] = primitive.string;
const INTERPOLATES = new Set<string>(
  Object.entries(PRIMITIVES).filter(([, primitive]) => primitive.interp).map(([name]) => name),
);

const mapFieldType = (raw: string): FieldType => (raw === 'text' ? 'string' : raw); // `text` is the user-facing alias for `string`
const isLevel = (word: string): word is Level => /^h[1-6]$/.test(word);             // heading level h1..h6
const VIDEO_FLAGS = new Set(['controls', 'autoplay', 'loop', 'muted', 'playsinline']); // <video> boolean attrs (bare keywords)

export class Parser extends Grammar {
  // Built once per parse. Keys double as membership tests: an ident not in a map
  // is simply not a valid modifier or action method.
  private readonly modifiers: Map<string, (props: NodeProps) => void>;   // modifier -> parse + attach its prop
  private readonly statements: Map<string, (target: string) => Stmt>;    // action method -> parse the call into a Stmt

  constructor(source: string) {
    super(source);

    this.modifiers = new Map([
      [Mod.Bind, (props: NodeProps) => { // canonical `bind(name)`; bare name / `@name` accepted during migration
        const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next();
        if (this.at(Tk.Ref)) { let b = this.eat(Tk.Ref).v; while (this.at(Tk.Punct, Pn.Dot)) { this.next(); b += '.' + this.eat(Tk.Ident).v; } props.bind = b; }
        else props.bind = this.parseDotted();
        if (paren) this.eat(Tk.Punct, Pn.ParenR);
      }],
      [Mod.Submit, (props: NodeProps) => { const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next(); props.submit = this.parseDotted(); if (paren) this.eat(Tk.Punct, Pn.ParenR); }],
      [Mod.Where, (props: NodeProps) => { props.where = this.parseParenList(() => this.rebuildClause()); }],
      [Mod.Columns, (props: NodeProps) => { props.columns = this.parseParenList(() => this.eat(Tk.Ident).v); }],
      // a second `class()` appends, never overwrites the first
      [Mod.Class, (props: NodeProps) => { props.class = [...(props.class || []), ...this.parseParenList(() => { // raw classes + `name when cond` + interpolated `"prefix-{x}"`
        if (this.at(Tk.String)) {
          const t = this.next();
          if (t.v.includes('{')) { const i = this.parseInterpolation(t.v, t.pos + 1); return typeof i === 'string' ? i : { interp: i }; } // `class("status-{x}")` -> reactive class token
          if (this.at(Tk.Ident, Kw.When)) { this.next(); return { name: t.v, cond: this.parseExpr() }; }
          return t.v;
        }
        const name = this.eat(Tk.Ident).v;
        this.nestGuard(name); // `class("x" aria(…))` — modifiers are siblings, not nested
        if (this.at(Tk.Ident, Kw.When)) { this.next(); return { name, cond: this.parseExpr() }; }
        return name;
      })]; }],
      [Mod.Alt, (props: NodeProps) => { const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next(); const t = this.eat(Tk.String); props.alt = this.parseInterpolation(t.v, t.pos + 1); if (paren) this.eat(Tk.Punct, Pn.ParenR); }],  // Image a11y/SEO alt text
      [Mod.Inputs, (props: NodeProps) => { props.inputs = { ...props.inputs, ...this.parseArgs() }; }],   // Custom inputs(k: value, ...)
      [Mod.On, (props: NodeProps) => { props.on = { ...props.on, ...this.parseArgs() }; }],               // Custom on(event: action, ...)
      [Mod.Aria, (props: NodeProps) => { props.aria = { ...props.aria, ...this.parseAriaArgs() }; }],      // aria(label: "Close", expanded: isOpen) -> aria-*/role
      [Mod.Style, (props: NodeProps) => { props.styleVars = { ...props.styleVars, ...this.parseStyleArgs() }; }], // style(w: "{pct}%") -> CSS var --w (the bounded path for dynamic values: progress, transforms)
    ]);

    this.statements = new Map([
      [StOp.Push, (target: string): Stmt => ({ op: StOp.Push, target, arg: this.parseExpr() })],
      [StOp.Set, (target: string): Stmt => ({ op: StOp.Set, target, arg: this.parseExpr() })],
      [StOp.Reset, (target: string): Stmt => ({ op: StOp.Reset, target })],
      [StOp.Toggle, (target: string): Stmt => this.at(Tk.Punct, Pn.ParenR) ? { op: StOp.Toggle, target } : { op: StOp.Toggle, target, arg: this.parseExpr() }], // `open.toggle()` flips a bool; `favs.toggle(x)` toggles x's membership in a list<scalar>
      // remove/patch are NOT here: they parse inline as `remove where <cond>` / `patch where <cond> with { ... }` (no parens, item-implicit)
      [StOp.Create, (target: string): Stmt => ({ op: StOp.Create, target, arg: this.parseExpr() })], // POST to source
      [StOp.Update, (target: string): Stmt => ({ op: StOp.Update, target, arg: this.parseExpr() })], // PUT /:id
      [StOp.Delete, (target: string): Stmt => ({ op: StOp.Delete, target, arg: this.parseExpr() })], // DELETE /:id
      [StOp.Refetch, (target: string): Stmt => { // refetch with N named query params: refetch(q: x, page: n)
        const params: { [k: string]: Expr } = {};
        while (!this.at(Tk.Punct, Pn.ParenR)) {
          const key = this.eat(Tk.Ident).v; this.eat(Tk.Punct, Pn.Colon); params[key] = this.parseExpr();
          if (this.at(Tk.Punct, Pn.Comma)) this.next();
        }
        return { op: StOp.Refetch, target, params };
      }],
    ]);
  }

  // ── entry ──────────────────────────────────────────────────────────────────
  // Reads top-level constructs until EOF. A leading keyword dispatches to its declaration parser;
  // anything else is the page root node (a screen has exactly one root primitive).
  parse(): IR {
    const ir: IR = { screen: '', entities: {}, state: {}, actions: {}, tree: null };
    const declarations = new Map<string, () => void>([
      [Kw.Screen, () => { this.next(); ir.screen = this.eat(Tk.Ident).v; }],
      [Kw.Entity, () => this.parseEntity(ir)],
      [Kw.State, () => this.parseState(Kw.State, ir.state)],
      [Kw.Store, () => { ir.store = ir.store || {}; this.parseState(Kw.Store, ir.store); }],   // app-global reactive state
      [Kw.Get, () => this.parseGet(ir)],                                                       // store derived value
      [Kw.Effect, () => { this.next(); (ir.effects = ir.effects || []).push(this.parseActionBody()); }], // store side-effect
      [Kw.Action, () => this.parseAction(ir)],
      [Kw.Mock, () => this.parseMock(ir)],
      [Kw.Sources, () => this.parseSources(ir)],
      [Kw.Api, () => this.parseApi(ir)],
      [Kw.Meta, () => this.parseMeta(ir)],
      [Kw.Routes, () => this.parseRoutes(ir)],
      [Kw.Shell, () => this.parseShell(ir)],                                                   // persistent app chrome with slot
      [Kw.Part, () => this.parsePart(ir)],
      [Kw.Const, () => this.parseConst(ir)],                                                   // compile-time immutable scalar
      [Kw.Theme, () => this.parseTheme(ir)],                                                   // project token scale
      [Kw.Param, () => { this.next(); (ir.params = ir.params || []).push(this.eat(Tk.Ident).v); }], // route param (`param id`)
      [Kw.Use, () => { // `use a, b from "./lib.ts"` - named JS functions muten may call
        this.next();
        const names = [this.eat(Tk.Ident).v];
        while (this.at(Tk.Punct, Pn.Comma)) { this.next(); names.push(this.eat(Tk.Ident).v); }
        this.eat(Tk.Ident, Kw.From);
        const from = this.eat(Tk.String).v;
        (ir.imports = ir.imports || []).push({ names, from });
      }],
    ]);
    while (!this.at(Tk.Eof)) {
      const tok = this.peek();
      const declaration = tok.t === Tk.Ident ? declarations.get(tok.v) : undefined;
      if (declaration) declaration();
      else ir.tree = this.parseNode(); // anything else begins the tree root
    }
    return ir;
  }

  // ── declarations ─────────────────────────────────────────────────────────────

  // entity User { name text required  role admin | member  password text min:8 }
  // A data shape + its validation contract. Every entity gets an implicit `id uuid`.
  private parseEntity(ir: IR): void {
    this.eat(Tk.Ident, Kw.Entity);
    const name = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.BraceL);
    const fields: Entity = { id: 'uuid' };
    const constraints: EntityConstraints = {};
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const fieldName = this.eat(Tk.Ident).v;
      const options = [this.eat(Tk.Ident).v];                                  // type, then any `| enum` alternatives
      while (this.at(Tk.Punct, Pn.Pipe)) { this.next(); options.push(this.eat(Tk.Ident).v); }
      fields[fieldName] = options.length > 1 ? 'enum:' + options.join('|') : mapFieldType(options[0]);
      const constraint = this.parseConstraints();                              // optional constraints: required, min:N, max:N
      if (Object.keys(constraint).length) constraints[fieldName] = constraint;
    }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.entities[name] = fields;
    if (Object.keys(constraints).length) (ir.constraints = ir.constraints || {})[name] = constraints;
  }

  // Validation suffix on an entity field: `required`, `min:N`, `max:N`, `pattern:"<regex>"` (any order, all optional).
  private parseConstraints(): FieldConstraint {
    const constraint: FieldConstraint = {};
    while (this.at(Tk.Ident, Kw.Required) || this.at(Tk.Ident, Kw.Min) || this.at(Tk.Ident, Kw.Max) || this.at(Tk.Ident, Kw.Pattern)) {
      const key = this.next().v;
      if (key === Kw.Required) { constraint.required = true; continue; }
      this.eat(Tk.Punct, Pn.Colon);
      if (key === Kw.Pattern) { constraint.pattern = this.eat(Tk.String).v; continue; } // `pattern:"^\d{5}$"` — a regex string
      const num = Number(this.eat(Tk.Number).v);
      if (key === Kw.Min) constraint.min = num; else constraint.max = num;
    }
    return constraint;
  }

  // state { } (page-local) and store { } (app-global) share one grammar: `name = <initial|query> : <type>`
  private parseState(keyword: Kw, target: { [name: string]: StateDef }): void {
    this.eat(Tk.Ident, keyword);
    this.eat(Tk.Punct, Pn.BraceL);
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const nameTok = this.eat(Tk.Ident);
      this.eat(Tk.Punct, Pn.Assign);
      let source: string | undefined;
      let refresh: number | undefined;
      let live: boolean | undefined;
      let initial: Value | undefined;
      let hasInitial = false;
      if (this.at(Tk.Ident, Kw.Query)) { this.next(); source = 'query:' + this.eat(Tk.Ident).v; if (this.at(Tk.Ident, Kw.Live)) { this.next(); live = true; } else if (this.at(Tk.Ident, Kw.Every)) { this.next(); refresh = this.parseDuration(); } } // `query x live` -> WebSocket; `every Ns` -> poll
      else if (this.at(Tk.Punct, Pn.BraceL) || this.at(Tk.Punct, Pn.BrackL)) { initial = this.parseValue(); hasInitial = true; }
      else if (this.at(Tk.String)) { initial = this.next().v; hasInitial = true; }
      else if (this.at(Tk.Number)) { initial = Number(this.next().v); hasInitial = true; }
      else if (this.at(Tk.Ident, Kw.True) || this.at(Tk.Ident, Kw.False)) { initial = this.next().v === Kw.True; hasInitial = true; }
      else if (this.at(Tk.Ident, 'null')) { this.next(); hasInitial = true; }                    // `= null` → initial stays undefined → genState emits signal(null), NOT the string "null"
      else { initial = this.next().v; hasInitial = true; }                                       // bare enum value
      this.eat(Tk.Punct, Pn.Colon);
      const type = this.parseType();
      const persist = this.at(Tk.Ident, Kw.Persist) ? (this.next(), true) : undefined; // `: T persist` -> localStorage-backed
      const loc = this.locOf(nameTok.pos);
      target[nameTok.v] = source ? { type, source, refresh, live, loc } : { type, initial: hasInitial ? initial : null, persist, loc };
    }
    this.eat(Tk.Punct, Pn.BraceR);
  }

  // `every 5s | 500ms | 2m` -> poll interval in milliseconds (for `query x every ...`).
  private parseDuration(): number {
    const start = this.peek();
    const n = Number(this.eat(Tk.Number).v);
    const unit = this.eat(Tk.Ident).v;
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 0;
    if (!mult || !(n > 0)) throw new ParseError('`every` expects a positive duration like `5s`, `500ms`, or `2m`', this.locOf(start.pos));
    return n * mult;
  }

  // `get <name> = <expr>`: a store derived/memoized value (compiles to a `computed`).
  private parseGet(ir: IR): void {
    this.eat(Tk.Ident, Kw.Get);
    const name = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.Assign);
    (ir.gets = ir.gets || {})[name] = this.parseExpr();
  }

  // `action <name>[(a: T, b: T)] mutates <targets> [<- <input>] { <statements> }`.
  // Mutation logic lives in the source, declared and bounded; the compiler only translates it.
  // Two parameter forms: multi-param `(a: T, b: T)` (typed, like a part) and legacy `<- input`.
  // They never combine: a `(...)` action reads its params; a `<- v` action reads its input.
  private parseAction(ir: IR): void {
    this.eat(Tk.Ident, Kw.Action);
    const name = this.eat(Tk.Ident).v;
    let params: PartParam[] | undefined;   // optional typed params: `action f(a: T, b: T)`
    if (this.at(Tk.Punct, Pn.ParenL)) params = this.parseParenList(() => { const pn = this.eat(Tk.Ident).v; this.eat(Tk.Punct, Pn.Colon); return { name: pn, type: this.parseType() }; });
    const mutates: string[] = []; // a pure command (e.g. explicit `post`) may mutate nothing local
    if (this.at(Tk.Ident, Kw.Mutates)) { this.next(); mutates.push(this.eat(Tk.Ident).v); while (this.at(Tk.Punct, Pn.Comma)) { this.next(); mutates.push(this.eat(Tk.Ident).v); } }
    let input = '';               // optional legacy input parameter (`<- item`)
    if (this.at(Tk.LArrow)) { this.next(); input = this.eat(Tk.Ident).v; }
    ir.actions[name] = { mutates, input, params, body: this.parseActionBody() };
  }

  // `{ statement* }`: an action body or an `if` branch; each statement is a declared mutation.
  private parseActionBody(): Stmt[] {
    this.eat(Tk.Punct, Pn.BraceL);
    const body: Stmt[] = [];
    while (!this.at(Tk.Punct, Pn.BraceR)) body.push(this.parseStatement());
    this.eat(Tk.Punct, Pn.BraceR);
    return body;
  }

  // `if <expr> { ... } [else { ... }]`: the only branching inside an action (toggles, validation, add-or-remove).
  private parseIf(): IfStmt {
    this.eat(Tk.Ident, Kw.If);
    const cond = this.parseExpr();
    const then = this.parseActionBody();
    const otherwise = this.at(Tk.Ident, Kw.Else) ? (this.next(), this.parseActionBody()) : null;
    return { op: StOp.If, cond, then, else: otherwise };
  }

  // A statement: an `if` block, or `target.method(args)` dispatched through the `statements` table.
  // Explicit non-REST request (escape hatch): `post "client:/path" body expr` or `delete "client:/path"`.
  private parseRequest(): Stmt {
    const method = this.eat(Tk.Ident).v.toUpperCase();
    const ut = this.eat(Tk.String); const url = this.parseInterpolation(ut.v, ut.pos + 1);
    let body: Expr | null = null;
    if (this.at(Tk.Ident, Kw.Body)) { this.next(); body = this.parseExpr(); }
    // optional `into <state>`: capture the JSON response (e.g. an order id / confirmation code) into a local state.
    let into: string | undefined;
    if (this.at(Tk.Ident, Kw.Into)) { this.next(); into = this.eat(Tk.Ident).v; }
    return { op: StOp.Request, method, url, body, into };
  }

  private parseStatement(): Stmt {
    const pos = this.peek().pos;            // first token's position, so action-body diagnostics land on the right line
    const st = this.parseStatementInner();
    st.loc = this.locOf(pos);
    return st;
  }
  private parseStatementInner(): Stmt {
    if (this.at(Tk.Ident, Kw.If)) return this.parseIf();
    if (this.at(Tk.Ident, 'post') || this.at(Tk.Ident, 'put') || this.at(Tk.Ident, 'delete')) return this.parseRequest();
    const target = this.eat(Tk.Ident).v;
    if (this.at(Tk.Punct, Pn.ParenL)) { // `fn(args)`: call a use'd function as a side-effect statement (validate checks fn is declared)
      this.next();
      const args: Expr[] = [];
      while (!this.at(Tk.Punct, Pn.ParenR)) { args.push(this.parseExpr()); if (this.at(Tk.Punct, Pn.Comma)) this.next(); }
      this.eat(Tk.Punct, Pn.ParenR);
      return { op: StOp.Extern, fn: target, args };
    }
    this.eat(Tk.Punct, Pn.Dot);
    const method = this.eat(Tk.Ident).v;
    // Lambda-free predicate mutation (the ONLY form): `tasks.remove where id == x` / `tasks.patch where id == x with { ... }`
    if (method === StOp.Remove || method === StOp.Patch) {
      if (!this.at(Tk.Ident, Kw.Where)) throw new ParseError(`\`${method}\` takes a \`where <cond>\` predicate now, not a \`(x => …)\` lambda — write \`${target}.${method} where <cond>\`${method === StOp.Patch ? ' with { … }' : ''} (item fields read bare)`, this.locOf(this.peek().pos));
      this.next();
      const pred = this.parseExpr();
      if (method === StOp.Patch) { this.eat(Tk.Ident, Kw.With); return { op: StOp.Patch, target, pred, patch: this.parseExpr() }; }
      return { op: StOp.Remove, target, pred };
    }
    this.eat(Tk.Punct, Pn.ParenL);
    const build = this.statements.get(method);
    if (!build) { // not a built-in op: a store-action call `shop.add(draft)` (validate confirms target is a store)
      const args: Expr[] = [];
      while (!this.at(Tk.Punct, Pn.ParenR)) { args.push(this.parseExpr()); if (this.at(Tk.Punct, Pn.Comma)) this.next(); }
      this.eat(Tk.Punct, Pn.ParenR);
      return { op: StOp.Call, target, method, args };
    }
    const stmt = build(target);
    this.eat(Tk.Punct, Pn.ParenR);
    return stmt;
  }

  // mock { query: <value>, ... }: inline test data. sources { query: "url" | { url, at } }: real endpoints.
  private parseMock(ir: IR): void {
    this.eat(Tk.Ident, Kw.Mock);
    const mock: { [name: string]: Value } = ir.mock || {};
    this.parseEntries((name) => { mock[name] = this.parseValue(); });
    ir.mock = mock;
  }
  private parseSources(ir: IR): void {
    this.eat(Tk.Ident, Kw.Sources);
    const sources: { [name: string]: Value } = ir.sources || {};
    this.parseEntries((name) => { sources[name] = this.parseValue(); });
    ir.sources = sources;
  }
  // App-wide backend config: `api { base: "..." headers: { ... } }` (in app.muten). Applied to every `sources`.
  private parseApi(ir: IR): void {
    this.eat(Tk.Ident, Kw.Api);
    const api: { [name: string]: Value } = ir.api || {};
    this.parseEntries((name) => { api[name] = this.parseValue(); });
    ir.api = api;
  }
  // `meta { title "..." description "..." }` -> `<title>` + `<meta>` tags (og:* auto-derived).
  private parseMeta(ir: IR): void {
    this.eat(Tk.Ident, Kw.Meta);
    this.eat(Tk.Punct, Pn.BraceL);
    const meta: { [k: string]: string } = ir.meta || {};
    while (!this.at(Tk.Punct, Pn.BraceR)) { const key = this.eat(Tk.Ident).v; meta[key] = this.eat(Tk.String).v; }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.meta = meta;
  }

  // `routes { "/url" -> page [guard [not] store.flag else "/redirect"] }`: the app root (app.muten).
  private parseRoutes(ir: IR): void {
    this.eat(Tk.Ident, Kw.Routes);
    this.eat(Tk.Punct, Pn.BraceL);
    const routes: Route[] = ir.routes || [];
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const start = this.peek();
      const url = this.eat(Tk.String).v;             // path is a quoted string literal (no path sub-grammar)
      this.eat(Tk.Arrow);
      const route: Route = { url, page: this.eat(Tk.Ident).v, loc: this.locOf(start.pos) };
      if (this.at(Tk.Ident, Kw.Guard)) {             // `guard [not] store.flag else "/redirect"`
        this.next();
        route.guardNeg = this.at(Tk.Ident, Kw.Not) ? (this.next(), true) : false;
        route.guard = this.parseDotted();            // store boolean, e.g. auth.loggedIn
        this.eat(Tk.Ident, Kw.Else);
        route.redirect = this.eat(Tk.String).v;
      }
      routes.push(route);
    }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.routes = routes;
  }

  // `shell { <node>* }`: persistent app chrome wrapping every route; holds the `slot` outlet.
  private parseShell(ir: IR): void {
    this.eat(Tk.Ident, Kw.Shell);
    ir.shell = { type: Nt.Shell, props: {}, children: this.parseChildren() };
  }

  // `const NAME = <scalar>`: compile-time immutable, inlined at build. Scalars only: structured
  // config uses a block (e.g. `theme { ... }`), so Muten never needs a JS-style object literal.
  private parseConst(ir: IR): void {
    this.eat(Tk.Ident, Kw.Const);
    const name = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.Assign);
    if (this.at(Tk.Punct, Pn.BraceL) || this.at(Tk.Punct, Pn.BrackL)) {
      throw new ParseError('const holds a single value (string/number/bool) — use a block like `theme { … }` for structured data', this.locOf(this.peek().pos));
    }
    (ir.consts = ir.consts || {})[name] = this.parseScalar();
  }

  // `theme { space { md "16px" ... }  breakpoints { md "768px" ... } }`: project token scale.
  // No CSS here (that lives in the stylesheet); the build plugin reads this for token values.
  private parseTheme(ir: IR): void {
    this.eat(Tk.Ident, Kw.Theme);
    this.eat(Tk.Punct, Pn.BraceL);
    const theme: { [scale: string]: ThemeScale } = {};
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const scale = this.eat(Tk.Ident).v;            // e.g. space, font, weight, leading, breakpoints
      this.eat(Tk.Punct, Pn.BraceL);
      const steps: ThemeScale = {};
      // step -> "value". A hyphenated key (e.g. "base-100", "primary-content") is QUOTED, like a
      // hyphenated class name; a plain key (primary, md) stays bare.
      while (!this.at(Tk.Punct, Pn.BraceR)) steps[this.at(Tk.String) ? this.next().v : this.eat(Tk.Ident).v] = this.eat(Tk.String).v;
      this.eat(Tk.Punct, Pn.BraceR);
      theme[scale] = steps;
    }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.theme = theme;
  }

  // `part Name(p: type, ...) { <tree> }`: reusable composition, inlined at build by `compose`.
  private parsePart(ir: IR): void {
    const start = this.eat(Tk.Ident, Kw.Part);
    const name = this.eat(Tk.Ident).v;
    // A part must NOT shadow a built-in primitive: naming one `Sidebar`/`Button`/… makes the primitive unreachable
    // and gives callers cryptic "unknown ref" errors from the part's own body. Fail here, clearly, with a location.
    if (name in PRIMITIVES) throw new ParseError(`part "${name}" shadows the built-in ${name} primitive — rename it (e.g. App${name}) so the primitive stays reachable.`, this.locOf(start.pos));
    this.eat(Tk.Punct, Pn.ParenL);
    const params: PartParam[] = [];
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const paramName = this.eat(Tk.Ident).v;
      this.eat(Tk.Punct, Pn.Colon);
      params.push({ name: paramName, type: this.parseType() });
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    const nodes = this.parseChildren();
    ir.parts = ir.parts || {};
    // One root, or several nodes auto-wrapped in a Stack (a part always expands to a single subtree).
    const tree = nodes.length === 1 ? nodes[0] : { type: Nt.Stack, props: {}, children: nodes };
    // A part takes a single `slot` (the caller's children inline there). >1 would inject the same content twice.
    const slots = (nd: IRNode): number => (nd.type === Nt.Slot ? 1 : 0) + (nd.children || []).reduce((s, c) => s + slots(c), 0);
    if (slots(tree) > 1) throw new ParseError(`part "${name}" has more than one \`slot\` — a part takes a single slot, where the caller's children inline.`, this.locOf(start.pos));
    ir.parts[name] = { params, tree };
  }

  // ── the node tree ──────────────────────────────────────────────────────────

  // `when <expr> { ... }`: conditional render (mounts/unmounts reactively).
  private parseWhen(): IRNode {
    const head = this.eat(Tk.Ident, Kw.When);
    const cond = this.parseExpr();
    return { type: Nt.When, props: { cond }, children: this.parseChildren(), loc: this.locOf(head.pos) };
  }

  // `each <list> as <item> { ... }`: list render; `item` is a scope variable inside the block.
  private parseEach(): IRNode {
    const head = this.eat(Tk.Ident, Kw.Each);
    const list = this.parseExpr();
    this.eat(Tk.Ident, Kw.As);
    const as = this.eat(Tk.Ident).v;
    const props: NodeProps = { list, as };
    if (this.at(Tk.Ident, Kw.Where)) { this.next(); props.filter = this.parseExpr(); } // `each x as i where cond`: render only matching items
    return { type: Nt.Each, props, children: this.parseChildren(), loc: this.locOf(head.pos) };
  }

  // `Type <positionals> <modifiers> [{ children }]`, or a part instance `Name(args)`.
  // The inner loop reads by token kind until a sibling bare ident or `}` ends it.
  private parseNode(): IRNode {
    if (this.at(Tk.Ident, Kw.When)) return this.parseWhen();   // control-flow nodes look like keywords
    if (this.at(Tk.Ident, Kw.Each)) return this.parseEach();
    const head = this.eat(Tk.Ident);
    const type = head.v;
    const loc = this.locOf(head.pos);
    if (this.at(Tk.Punct, Pn.ParenL)) { // part instance: `Name(arg: value)`, with optional `{ … }` slot content
      const args = this.parseArgs();
      const node: IRNode = { type, args, loc };
      if (this.at(Tk.Punct, Pn.BraceL)) node.children = this.parseChildren();
      return node;
    }

    const props: NodeProps = {};
    const children: IRNode[] = [];
    if (type === Nt.Custom) props.component = this.eat(Tk.Ident).v;                 // Custom <Name> inputs(…) on(…)
    let reading = true;
    while (reading) {
      const tok = this.peek();
      switch (tok.t) {
        case Tk.String: { const key = STRING_PROP[type] || 'label'; if (props[key] !== undefined) { reading = false; break; } const t = this.next(); props[key] = INTERPOLATES.has(type) ? this.parseInterpolation(t.v, t.pos + 1) : t.v; break; } // a 2nd positional string is NOT a prop — it's the next sibling (e.g. the next `match` arm with a quoted value)
        case Tk.Param: { const key = STRING_PROP[type] || 'label'; props[key] = { $param: this.next().v }; break; } // part param standing in for the string
        case Tk.Ref: props.data = this.next().v; break;                            // positional @ref = data (DataTable @rows)
        case Tk.Arrow: this.parseArrow(type, props); break;                        // -> "/route" (Link) or -> action(arg)
        case Tk.Ident: {
          const word = tok.v;
          if (type === Nt.Title && isLevel(word)) { this.next(); props.level = word; break; } // heading level (h1..h6)
          if (type === Nt.Video && VIDEO_FLAGS.has(word)) { this.next(); (props.flags = props.flags || []).push(word); break; } // <video> boolean attr
          if (type === Nt.List && word === Kw.Ordered) { this.next(); props.ordered = true; break; }                          // List ordered -> <ol>
          if (type === Nt.Details && word === Kw.Open) { this.next(); props.open = true; break; }                              // Details open -> <details open>
          const applyModifier = this.modifiers.get(word);                          // table keys are the valid modifiers
          if (!applyModifier) { reading = false; break; }                          // unknown ident starts a sibling node
          this.next();
          applyModifier(props);
          break;
        }
        case Tk.Punct:
          if (tok.v === Pn.BraceL) { this.next(); while (!this.at(Tk.Punct, Pn.BraceR)) { if (this.at(Tk.Ident, Kw.Match)) children.push(...this.parseMatch()); else children.push(this.parseNode()); } this.eat(Tk.Punct, Pn.BraceR); }
          reading = false;                                                         // any punct (including `}`) closes the node
          break;
        default:
          reading = false;
      }
    }
    const node: IRNode = { type, props, loc };
    if (children.length) node.children = children;
    return node;
  }

  // The `->` part of a node: a Link destination or an action with optional arguments.
  // One arg lands in `props.arg`; a multi-param `-> f(a, b)` keeps the rest in `argRest`.
  private parseArrow(type: string, props: NodeProps): void {
    this.next();
    if (type === Nt.Link) { props.to = this.parsePath(); return; }
    props.action = this.parseDotted();                  // local `add`, store `cart.add`, or a `$onSave` part param
    if (!this.at(Tk.Punct, Pn.ParenL)) return;
    this.next();
    if (!this.at(Tk.Punct, Pn.ParenR)) {
      props.arg = this.parseExpr();                     // first arg: a ref OR a literal
      const rest: Expr[] = [];
      while (this.at(Tk.Punct, Pn.Comma)) { this.next(); rest.push(this.parseExpr()); }
      if (rest.length) props.argRest = rest;            // 2nd+ args, only present for a multi-arg call
    }
    this.eat(Tk.Punct, Pn.ParenR);
  }

  // ── small readers ────────────────────────────────────────────────────────────

  // `{ <node>* }`: a children block shared by shell/part/when/each and inline blocks.
  private parseChildren(): IRNode[] {
    this.eat(Tk.Punct, Pn.BraceL);
    const children: IRNode[] = [];
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      if (this.at(Tk.Ident, Kw.Match)) children.push(...this.parseMatch()); // `match` desugars to one When per arm
      else children.push(this.parseNode());
    }
    this.eat(Tk.Punct, Pn.BraceR);
    return children;
  }

  // `match <expr> { value -> node|{…}  … }`: render the arm whose value the subject equals. SUGAR — desugars to
  // one `when <expr> == "value"` per arm, so validate + compile only ever see plain When nodes. Cuts the N-whens
  // boilerplate of rendering an enum (status badges, deal stages, …) that every real app hits.
  private parseMatch(): IRNode[] {
    const head = this.eat(Tk.Ident, Kw.Match);
    const subject = this.parseExpr();
    this.eat(Tk.Punct, Pn.BraceL);
    const arms: IRNode[] = [];
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const value = this.at(Tk.String) ? this.next().v : this.eat(Tk.Ident).v; // enum value: bare ident or quoted
      this.eat(Tk.Arrow);                                                       // `->`
      const children = this.at(Tk.Punct, Pn.BraceL) ? this.parseChildren() : [this.parseNode()];
      const cond: Expr = { kind: Ek.Bin, op: BOp.Eq, left: subject, right: { kind: Ek.Lit, value } };
      arms.push({ type: Nt.When, props: { cond }, children, loc: this.locOf(head.pos) });
    }
    this.eat(Tk.Punct, Pn.BraceR);
    return arms;
  }

  // IDENT optionally parameterized: `text` or `list<User>`.
  private parseType(): string {
    let type = this.eat(Tk.Ident).v;
    if (this.at(Tk.Punct, Pn.Lt)) { this.next(); type += '<' + this.eat(Tk.Ident).v + '>'; this.eat(Tk.Punct, Pn.Gt); }
    return type;
  }

  // IDENT(.IDENT)* -> "cart.total". A `$param` head resolves at compose time.
  private parseDotted(): string {
    let path = this.at(Tk.Param) ? '$' + this.next().v : this.eat(Tk.Ident).v;
    while (this.at(Tk.Punct, Pn.Dot)) { this.next(); path += '.' + this.eat(Tk.Ident).v; }
    return path;
  }

  // `( item, item, ... )` with a caller-supplied item reader (used by class/columns/where).
  private parseParenList<T>(readItem: () => T): T[] {
    this.eat(Tk.Punct, Pn.ParenL);
    const items: T[] = [];
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      items.push(readItem());
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return items;
  }

  // `where()` clause: raw tokens up to the next `,` or `)`, re-joined -> "role == admin".
  private rebuildClause(): string {
    const parts: string[] = [];
    while (!this.at(Tk.Punct, Pn.Comma) && !this.at(Tk.Punct, Pn.ParenR)) parts.push(this.next().v);
    return parts.join(' ');
  }

  // `{ key: <read>, ... }`: keyed block; the reader handles each value (shared by mock/sources).
  private parseEntries(read: (name: string) => void): void {
    this.eat(Tk.Punct, Pn.BraceL);
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const name = this.eat(Tk.Ident).v;
      this.eat(Tk.Punct, Pn.Colon);
      read(name);
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.BraceR);
  }

  // A URL path is a quoted string literal, interpolated like any other: `-> "/blog/{post.id}"`.
  // No path sub-grammar: any path (numbers, `:id` params, dashes) is just the string's text.
  private parsePath(): string | Interp {
    return this.parseInterpolation(this.eat(Tk.String).v);
  }

  // `( key: value, ... )`: the args of a part instance or Custom inputs/on.
  // modifiers attach to the node, never inside another modifier's () — turn the JSX-props slip (`class("x" aria(…))`) into a message that teaches, not a cryptic "expected ident".
  private nestGuard(name: string): void {
    if (this.at(Tk.Punct, Pn.ParenL)) throw new ParseError(`modifiers don't nest: \`${name}(…)\` attaches to the node, not inside another modifier's (). Write each as a sibling — e.g. \`Stack class(…) ${name}(…) { … }\`.`, this.locOf(this.peek().pos));
  }

  private parseArgs(): ArgMap {
    this.eat(Tk.Punct, Pn.ParenL);
    const args: ArgMap = {};
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const key = this.eat(Tk.Ident).v;
      this.nestGuard(key);
      this.eat(Tk.Punct, Pn.Colon);
      args[key] = this.parseArgValue();
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return args;
  }

  private parseArgValue(): ArgValue {
    if (this.at(Tk.String)) return { $lit: this.next().v }; // quoted: literal, not a ref (compose keeps it as text)
    if (this.at(Tk.Number)) return Number(this.next().v);
    if (this.at(Tk.Ref)) return this.next().v;               // @state
    if (this.at(Tk.Param)) return { $param: this.next().v }; // $param (nested parts)
    return this.parseDotted();                                // bare ref / store action (cart.add) / enum
  }

  // `aria( key: <expr>, ... )`: each value is a full expression — a literal compiles to a static attribute,
  // a value that reads state compiles to a reactive effect (e.g. `aria(expanded: menuOpen)`).
  private parseAriaArgs(): { [key: string]: Expr } {
    this.eat(Tk.Punct, Pn.ParenL);
    const out: { [key: string]: Expr } = {};
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const key = this.eat(Tk.Ident).v;
      this.nestGuard(key);
      this.eat(Tk.Punct, Pn.Colon);
      out[key] = this.parseExpr();
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return out;
  }

  // style(name: "value") — each key becomes a CSS custom property `--name`; the value is an interpolated string
  // (e.g. "{pct}%", "translateX({x}px)"). Only CSS variables: muten prepends `--`, so it can't set an arbitrary
  // property and compete with class()/Tailwind. The CSS reads it with `var(--name)`. Reactive when interpolated.
  private parseStyleArgs(): { [name: string]: string | Interp } {
    this.eat(Tk.Punct, Pn.ParenL);
    const out: { [name: string]: string | Interp } = {};
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const key = this.eat(Tk.Ident).v;
      this.nestGuard(key);
      this.eat(Tk.Punct, Pn.Colon);
      const t = this.eat(Tk.String);
      out[key] = this.parseInterpolation(t.v, t.pos + 1);
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return out;
  }
}

export function parse(source: string): IR { return new Parser(source).parse(); }
