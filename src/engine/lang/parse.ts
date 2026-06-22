// ============================================================================
// Parser — the .muten screen grammar (text → nested IR)
// ============================================================================
//   .muten ─[parse]→ IR ─→ compose → flatten → validate → compile → JS
//
// `Parser extends Grammar`, inheriting the token cursor and the expression/value sub-grammars,
// so this file holds only the SCREEN grammar: the top-level declarations (entity/state/action/
// routes/…) and the node tree (Stack/Text/Form/when/each/…). Dispatch is data-driven — keyword→
// handler, modifier→handler, method→builder are all Maps, never growing if/else chains — and every
// matched token comes from vocab (Tk/Pn/Kw/Nt/Mod/StOp): no magic strings.

import { ParseError } from '#engine/shared/diagnostics.js';
import { PRIMITIVES } from '#engine/lang/manifest.js';
import { Grammar } from '#engine/lang/grammar.js';
import { Tk, Pn, Kw, Nt, Mod, StOp, Ek } from '#engine/shared/vocab.js';
import type {
  IR, IRNode, NodeProps, StringPropName, Stmt, IfStmt, Expr, Interp, Value, Level,
  Entity, FieldType, EntityConstraints, FieldConstraint,
  StateDef, Route, PartParam, ArgValue, ArgMap, ThemeScale,
} from '#engine/shared/types.js';

// Derived from the MANIFEST (the single source of the vocabulary):
//   STRING_PROP  — where a primitive's positional string lands (Text "x" → props.value)
//   INTERPOLATES — which primitives reactively interpolate that string ({ref}): Text/Title/Span/Image
const STRING_PROP: { [primitive: string]: StringPropName } = {};
for (const [name, primitive] of Object.entries(PRIMITIVES)) if (primitive.string) STRING_PROP[name] = primitive.string;
const INTERPOLATES = new Set<string>(
  Object.entries(PRIMITIVES).filter(([, primitive]) => primitive.interp).map(([name]) => name),
);

const mapFieldType = (raw: string): FieldType => (raw === 'text' ? 'string' : raw); // `text` is the friendly alias for string
const isLevel = (word: string): word is Level => /^h[1-6]$/.test(word);             // Title heading level h1..h6

export class Parser extends Grammar {
  // Two dispatch tables, built once per parse. Their KEYS double as the membership test:
  // an ident that isn't a key simply isn't a modifier / a known action method.
  private readonly modifiers: Map<string, (props: NodeProps) => void>;   // node modifier → parse + attach its prop
  private readonly statements: Map<string, (target: string) => Stmt>;    // action method → parse the call into a Stmt

  constructor(source: string) {
    super(source);

    this.modifiers = new Map([
      [Mod.Bind, (props: NodeProps) => { props.bind = this.at(Tk.Ref) ? this.eat(Tk.Ref).v : this.parseDotted(); }], // @local or store field
      [Mod.Submit, (props: NodeProps) => { props.submit = this.parseDotted(); }],
      [Mod.Where, (props: NodeProps) => { props.where = this.parseParenList(() => this.rebuildClause()); }],
      [Mod.Columns, (props: NodeProps) => { props.columns = this.parseParenList(() => this.eat(Tk.Ident).v); }],
      [Mod.Style, (props: NodeProps) => { props.style = this.parseParenList(() => this.parseStyleToken()); }],
      [Mod.Class, (props: NodeProps) => { props.class = this.parseParenList(() => { // raw look classes + `name when cond`
        const name = this.at(Tk.String) ? this.next().v : this.eat(Tk.Ident).v;
        if (this.at(Tk.Ident, Kw.When)) { this.next(); return { name, cond: this.parseExpr() }; }
        return name;
      }); }],
      [Mod.Alt, (props: NodeProps) => { props.alt = this.parseInterpolation(this.eat(Tk.String).v); }],  // Image a11y/SEO text
      [Mod.Inputs, (props: NodeProps) => { props.inputs = this.parseArgs(); }],   // Custom: inputs(k: value, …)
      [Mod.On, (props: NodeProps) => { props.on = this.parseArgs(); }],           // Custom: on(event: action, …)
    ]);

    this.statements = new Map([
      [StOp.Push, (target: string): Stmt => ({ op: StOp.Push, target, arg: this.parseExpr() })],
      [StOp.Set, (target: string): Stmt => ({ op: StOp.Set, target, arg: this.parseExpr() })],
      [StOp.Reset, (target: string): Stmt => ({ op: StOp.Reset, target })],
      [StOp.Remove, (target: string): Stmt => { const param = this.eat(Tk.Ident).v; this.eat(Tk.FatArrow); return { op: StOp.Remove, target, param, pred: this.parseExpr() }; }],
      [StOp.Create, (target: string): Stmt => ({ op: StOp.Create, target, arg: this.parseExpr() })], // POST to the source
      [StOp.Update, (target: string): Stmt => ({ op: StOp.Update, target, arg: this.parseExpr() })], // PUT /:id
      [StOp.Delete, (target: string): Stmt => ({ op: StOp.Delete, target, arg: this.parseExpr() })], // DELETE /:id
      [StOp.Refetch, (target: string): Stmt => { // refetch a query with N named query params: refetch(q: x, page: n)
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
  // Read top-level constructs until EOF. A leading keyword dispatches to its declaration parser;
  // anything else is the page's root node (a screen has exactly one root primitive).
  parse(): IR {
    const ir: IR = { screen: '', entities: {}, state: {}, actions: {}, tree: null };
    const declarations = new Map<string, () => void>([
      [Kw.Screen, () => { this.next(); ir.screen = this.eat(Tk.Ident).v; }],
      [Kw.Entity, () => this.parseEntity(ir)],
      [Kw.State, () => this.parseState(Kw.State, ir.state)],
      [Kw.Store, () => { ir.store = ir.store || {}; this.parseState(Kw.Store, ir.store); }],   // app-global state
      [Kw.Get, () => this.parseGet(ir)],                                                       // .store derived value
      [Kw.Effect, () => { this.next(); (ir.effects = ir.effects || []).push(this.parseActionBody()); }], // .store side-effect
      [Kw.Action, () => this.parseAction(ir)],
      [Kw.Mock, () => this.parseMock(ir)],
      [Kw.Sources, () => this.parseSources(ir)],
      [Kw.Api, () => this.parseApi(ir)],
      [Kw.Meta, () => this.parseMeta(ir)],
      [Kw.Routes, () => this.parseRoutes(ir)],
      [Kw.Shell, () => this.parseShell(ir)],                                                   // app chrome + slot
      [Kw.Part, () => this.parsePart(ir)],
      [Kw.Const, () => this.parseConst(ir)],                                                   // compile-time immutable
      [Kw.Theme, () => this.parseTheme(ir)],                                                   // project theme
      [Kw.Param, () => { this.next(); (ir.params = ir.params || []).push(this.eat(Tk.Ident).v); }], // route param: `param id`
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

  // entity User { name text required  role admin | member  password text min:8 }  — a data shape
  // + its validation contract. Every entity gets an implicit `id uuid`.
  private parseEntity(ir: IR): void {
    this.eat(Tk.Ident, Kw.Entity);
    const name = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.BraceL);
    const fields: Entity = { id: 'uuid' };
    const constraints: EntityConstraints = {};
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const fieldName = this.eat(Tk.Ident).v;
      const options = [this.eat(Tk.Ident).v];                                  // the type, then any `| enum` alternatives
      while (this.at(Tk.Punct, Pn.Pipe)) { this.next(); options.push(this.eat(Tk.Ident).v); }
      fields[fieldName] = options.length > 1 ? 'enum:' + options.join('|') : mapFieldType(options[0]);
      const constraint = this.parseConstraints();                              // optional: required, min:N, max:N
      if (Object.keys(constraint).length) constraints[fieldName] = constraint;
    }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.entities[name] = fields;
    if (Object.keys(constraints).length) (ir.constraints = ir.constraints || {})[name] = constraints;
  }

  // the validation suffix on an entity field: `required`, `min:N`, `max:N` (any order, all optional).
  private parseConstraints(): FieldConstraint {
    const constraint: FieldConstraint = {};
    while (this.at(Tk.Ident, Kw.Required) || this.at(Tk.Ident, Kw.Min) || this.at(Tk.Ident, Kw.Max)) {
      const key = this.next().v;
      if (key === Kw.Required) { constraint.required = true; continue; }
      this.eat(Tk.Punct, Pn.Colon);
      const num = Number(this.eat(Tk.Number).v);
      if (key === Kw.Min) constraint.min = num; else constraint.max = num;
    }
    return constraint;
  }

  // state { } (page-local) and store { } (app-global) share one grammar: `name = <initial|query> : <type>`.
  private parseState(keyword: Kw, target: { [name: string]: StateDef }): void {
    this.eat(Tk.Ident, keyword);
    this.eat(Tk.Punct, Pn.BraceL);
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const nameTok = this.eat(Tk.Ident);
      this.eat(Tk.Punct, Pn.Assign);
      let source: string | undefined;
      let initial: Value | undefined;
      let hasInitial = false;
      if (this.at(Tk.Ident, Kw.Query)) { this.next(); source = 'query:' + this.eat(Tk.Ident).v; } // async, list-shaped
      else if (this.at(Tk.Punct, Pn.BraceL) || this.at(Tk.Punct, Pn.BrackL)) { initial = this.parseValue(); hasInitial = true; }
      else if (this.at(Tk.String)) { initial = this.next().v; hasInitial = true; }
      else if (this.at(Tk.Number)) { initial = Number(this.next().v); hasInitial = true; }
      else if (this.at(Tk.Ident, Kw.True) || this.at(Tk.Ident, Kw.False)) { initial = this.next().v === Kw.True; hasInitial = true; }
      else { initial = this.next().v; hasInitial = true; }                                       // a bare enum value
      this.eat(Tk.Punct, Pn.Colon);
      const type = this.parseType();
      const loc = this.locOf(nameTok.pos);
      target[nameTok.v] = source ? { type, source, loc } : { type, initial: hasInitial ? initial : null, loc };
    }
    this.eat(Tk.Punct, Pn.BraceR);
  }

  // get <name> = <expr>  — a .store derived/memoized value (compiles to a `computed`).
  private parseGet(ir: IR): void {
    this.eat(Tk.Ident, Kw.Get);
    const name = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.Assign);
    (ir.gets = ir.gets || {})[name] = this.parseExpr();
  }

  // action <name> mutates <targets> <- <input> { <statements> } — the mutation logic lives HERE
  // (in the source), declared and bounded; the compiler only translates it, it never invents it.
  private parseAction(ir: IR): void {
    this.eat(Tk.Ident, Kw.Action);
    const name = this.eat(Tk.Ident).v;
    const mutates: string[] = []; // optional: a pure command (e.g. an explicit `post`) mutates nothing local
    if (this.at(Tk.Ident, Kw.Mutates)) { this.next(); mutates.push(this.eat(Tk.Ident).v); while (this.at(Tk.Punct, Pn.Comma)) { this.next(); mutates.push(this.eat(Tk.Ident).v); } }
    let input = '';               // optional input parameter (`<- item`)
    if (this.at(Tk.LArrow)) { this.next(); input = this.eat(Tk.Ident).v; }
    ir.actions[name] = { mutates, input, body: this.parseActionBody() };
  }

  // { statement* } — an action body or an `if` branch; each statement is a declared mutation.
  private parseActionBody(): Stmt[] {
    this.eat(Tk.Punct, Pn.BraceL);
    const body: Stmt[] = [];
    while (!this.at(Tk.Punct, Pn.BraceR)) body.push(this.parseStatement());
    this.eat(Tk.Punct, Pn.BraceR);
    return body;
  }

  // if <expr> { … } [else { … }] — the only branching inside an action (toggles, validation, add-or-remove).
  private parseIf(): IfStmt {
    this.eat(Tk.Ident, Kw.If);
    const cond = this.parseExpr();
    const then = this.parseActionBody();
    const otherwise = this.at(Tk.Ident, Kw.Else) ? (this.next(), this.parseActionBody()) : null;
    return { op: StOp.If, cond, then, else: otherwise };
  }

  // a statement: an `if` block, or `target.method(args)` dispatched through the `statements` table.
  // explicit non-REST request (escape hatch): `post "client:/path" body expr` · `delete "client:/path"`.
  private parseRequest(): Stmt {
    const method = this.eat(Tk.Ident).v.toUpperCase();
    const url = this.parseInterpolation(this.eat(Tk.String).v);
    let body: Expr | null = null;
    if (this.at(Tk.Ident, Kw.Body)) { this.next(); body = this.parseExpr(); }
    return { op: StOp.Request, method, url, body };
  }

  private parseStatement(): Stmt {
    if (this.at(Tk.Ident, Kw.If)) return this.parseIf();
    if (this.at(Tk.Ident, 'post') || this.at(Tk.Ident, 'put') || this.at(Tk.Ident, 'delete')) return this.parseRequest();
    const target = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.Dot);
    const method = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.ParenL);
    const build = this.statements.get(method);
    if (!build) throw new ParseError(`unknown action method "${method}" on "${target}"`, this.locOf(this.peek().pos));
    const stmt = build(target);
    this.eat(Tk.Punct, Pn.ParenR);
    return stmt;
  }

  // mock { query: <value>, … } — test data inline in the screen. sources { query: "url" | { url, at } }.
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
  // app-wide backend config: `api { base: "…" headers: { … } }` (in app.muten). Applied to every `sources`.
  private parseApi(ir: IR): void {
    this.eat(Tk.Ident, Kw.Api);
    const api: { [name: string]: Value } = ir.api || {};
    this.parseEntries((name) => { api[name] = this.parseValue(); });
    ir.api = api;
  }
  // page <head> metadata: `meta { title "…" description "…" }` → <title>/<meta> tags (og auto-derived).
  private parseMeta(ir: IR): void {
    this.eat(Tk.Ident, Kw.Meta);
    this.eat(Tk.Punct, Pn.BraceL);
    const meta: { [k: string]: string } = ir.meta || {};
    while (!this.at(Tk.Punct, Pn.BraceR)) { const key = this.eat(Tk.Ident).v; meta[key] = this.eat(Tk.String).v; }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.meta = meta;
  }

  // routes { /url -> page [guard [not] store.flag else /redirect] } — the app root (app.muten).
  private parseRoutes(ir: IR): void {
    this.eat(Tk.Ident, Kw.Routes);
    this.eat(Tk.Punct, Pn.BraceL);
    const routes: Route[] = ir.routes || [];
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const start = this.peek();
      const line = this.locOf(start.pos).line;       // a route is one line, so paths can't bleed across lines
      const url = this.pathOnLine(line);
      this.eat(Tk.Arrow);
      const route: Route = { url, page: this.eat(Tk.Ident).v, loc: this.locOf(start.pos) };
      if (this.at(Tk.Ident, Kw.Guard)) {             // guard [not] store.flag else /redirect
        this.next();
        route.guardNeg = this.at(Tk.Ident, Kw.Not) ? (this.next(), true) : false;
        route.guard = this.parseDotted();            // a store boolean, e.g. auth.loggedIn
        this.eat(Tk.Ident, Kw.Else);
        route.redirect = this.pathOnLine(line);
      }
      routes.push(route);
    }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.routes = routes;
  }

  // shell { <node>* } — persistent app chrome (navbar/footer) wrapping every route; holds the `slot` outlet.
  private parseShell(ir: IR): void {
    this.eat(Tk.Ident, Kw.Shell);
    ir.shell = { type: Nt.Shell, props: {}, children: this.parseChildren() };
  }

  // const NAME = <scalar> — a compile-time immutable, inlined at build. SCALARS ONLY: structured config
  // uses a block (e.g. theme { … }), so Muten never grows a JS-style `= { … }` object literal.
  private parseConst(ir: IR): void {
    this.eat(Tk.Ident, Kw.Const);
    const name = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.Assign);
    if (this.at(Tk.Punct, Pn.BraceL) || this.at(Tk.Punct, Pn.BrackL)) {
      throw new ParseError('const holds a single value (string/number/bool) — use a block like `theme { … }` for structured data', this.locOf(this.peek().pos));
    }
    (ir.consts = ir.consts || {})[name] = this.parseScalar();
  }

  // theme { space { md "16px" … }  breakpoints { md "768px" … } } — the project's token scale, in native
  // Muten blocks. No CSS here (that lives in the stylesheet); the build plugin reads this for token values.
  private parseTheme(ir: IR): void {
    this.eat(Tk.Ident, Kw.Theme);
    this.eat(Tk.Punct, Pn.BraceL);
    const theme: { [scale: string]: ThemeScale } = {};
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const scale = this.eat(Tk.Ident).v;            // space | font | weight | leading | breakpoints
      this.eat(Tk.Punct, Pn.BraceL);
      const steps: ThemeScale = {};
      while (!this.at(Tk.Punct, Pn.BraceR)) steps[this.eat(Tk.Ident).v] = this.eat(Tk.String).v; // step "value"
      this.eat(Tk.Punct, Pn.BraceR);
      theme[scale] = steps;
    }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.theme = theme;
  }

  // part Name(p: type, …) { <tree> } — reusable composition, inlined at build by `compose`.
  private parsePart(ir: IR): void {
    this.eat(Tk.Ident, Kw.Part);
    const name = this.eat(Tk.Ident).v;
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
    // one root, or several nodes auto-wrapped in a Stack (a part always expands to a single subtree).
    ir.parts[name] = { params, tree: nodes.length === 1 ? nodes[0] : { type: Nt.Stack, props: {}, children: nodes } };
  }

  // ── the node tree ──────────────────────────────────────────────────────────

  // when <expr> { … } — conditional render (mounts/unmounts reactively).
  private parseWhen(): IRNode {
    const head = this.eat(Tk.Ident, Kw.When);
    const cond = this.parseExpr();
    return { type: Nt.When, props: { cond }, children: this.parseChildren(), loc: this.locOf(head.pos) };
  }

  // each <list> as <item> { … } — list render; `item` is a scope variable inside the block.
  private parseEach(): IRNode {
    const head = this.eat(Tk.Ident, Kw.Each);
    const list = this.parseExpr();
    this.eat(Tk.Ident, Kw.As);
    const as = this.eat(Tk.Ident).v;
    return { type: Nt.Each, props: { list, as }, children: this.parseChildren(), loc: this.locOf(head.pos) };
  }

  // A primitive node: `Type <positionals> <modifiers> [ { children } ]`, or a part instance `Name(args)`.
  // The inner loop reads parts of the node by token kind until a sibling (a bare ident) or `}` ends it.
  private parseNode(): IRNode {
    if (this.at(Tk.Ident, Kw.When)) return this.parseWhen();   // control-flow nodes look like keywords
    if (this.at(Tk.Ident, Kw.Each)) return this.parseEach();
    const head = this.eat(Tk.Ident);
    const type = head.v;
    const loc = this.locOf(head.pos);
    if (this.at(Tk.Punct, Pn.ParenL)) return { type, args: this.parseArgs(), loc }; // part instance: Name(arg: value)

    const props: NodeProps = {};
    const children: IRNode[] = [];
    if (type === Nt.Custom) props.component = this.eat(Tk.Ident).v;                 // Custom <Name> inputs(…) on(…)
    let reading = true;
    while (reading) {
      const tok = this.peek();
      switch (tok.t) {
        case Tk.String: { const key = STRING_PROP[type] || 'label'; props[key] = INTERPOLATES.has(type) ? this.parseInterpolation(this.next().v) : this.next().v; break; }
        case Tk.Param: { const key = STRING_PROP[type] || 'label'; props[key] = { $param: this.next().v }; break; } // a part param standing in for the string
        case Tk.Ref: props.data = this.next().v; break;                            // a positional @ref = data (DataTable @rows)
        case Tk.Arrow: this.parseArrow(type, props); break;                        // -> /route (Link) or -> action(arg)
        case Tk.Ident: {
          const word = tok.v;
          if (type === Nt.Title && isLevel(word)) { this.next(); props.level = word; break; } // Title heading level (structure)
          const applyModifier = this.modifiers.get(word);                          // the table's keys ARE the valid modifiers
          if (!applyModifier) { reading = false; break; }                          // an unknown ident starts a sibling node
          this.next();
          applyModifier(props);
          break;
        }
        case Tk.Punct:
          if (tok.v === Pn.BraceL) { this.next(); while (!this.at(Tk.Punct, Pn.BraceR)) children.push(this.parseNode()); this.eat(Tk.Punct, Pn.BraceR); }
          reading = false;                                                         // any punct (incl. `}`) closes the node
          break;
        default:
          reading = false;
      }
    }
    const node: IRNode = { type, props, loc };
    if (children.length) node.children = children;
    return node;
  }

  // the `->` part of a node: a Link's destination, or an action (with an optional single argument).
  private parseArrow(type: string, props: NodeProps): void {
    this.next();
    if (type === Nt.Link) { props.to = this.parsePath(); return; }
    props.action = this.parseDotted();                  // local `add`, store `cart.add`, or a `$onSave` param
    if (!this.at(Tk.Punct, Pn.ParenL)) return;
    this.next();
    if (!this.at(Tk.Punct, Pn.ParenR)) props.arg = this.parseExpr(); // one arg: a ref OR a literal
    this.eat(Tk.Punct, Pn.ParenR);
  }

  // ── small readers ────────────────────────────────────────────────────────────

  // { <node>* } — a children block; returns the nodes (shared by shell/part/when/each and inline blocks).
  private parseChildren(): IRNode[] {
    this.eat(Tk.Punct, Pn.BraceL);
    const children: IRNode[] = [];
    while (!this.at(Tk.Punct, Pn.BraceR)) children.push(this.parseNode());
    this.eat(Tk.Punct, Pn.BraceR);
    return children;
  }

  // a type: IDENT optionally parameterised, e.g. `text` or `list<User>`.
  private parseType(): string {
    let type = this.eat(Tk.Ident).v;
    if (this.at(Tk.Punct, Pn.Lt)) { this.next(); type += '<' + this.eat(Tk.Ident).v + '>'; this.eat(Tk.Punct, Pn.Gt); }
    return type;
  }

  // a style token: ident + optional breakpoint prefix (md:) + dotted scale (.md / .3 / .x.md).
  // Segments may be idents OR numbers, so the numeric scale (gap.20, cols.3) parses too.
  private parseStyleToken(): string {
    const segment = () => (this.at(Tk.Number) ? this.next().v : this.eat(Tk.Ident).v);
    let token = segment();
    if (this.at(Tk.Punct, Pn.Colon)) { this.next(); token += ':' + segment(); }     // breakpoint prefix
    while (this.at(Tk.Punct, Pn.Dot)) { this.next(); token += '.' + segment(); }     // .md | .3 | .x.md
    return token;
  }

  // IDENT(.IDENT)* → "cart.total" (a `$param` head resolves at compose time).
  private parseDotted(): string {
    let path = this.at(Tk.Param) ? '$' + this.next().v : this.eat(Tk.Ident).v;
    while (this.at(Tk.Punct, Pn.Dot)) { this.next(); path += '.' + this.eat(Tk.Ident).v; }
    return path;
  }

  // ( item, item, … ) with a caller-supplied item reader (used by style/class/columns/where).
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

  // a where() clause: raw tokens up to the next `,` or `)`, re-joined → "role == admin".
  private rebuildClause(): string {
    const parts: string[] = [];
    while (!this.at(Tk.Punct, Pn.Comma) && !this.at(Tk.Punct, Pn.ParenR)) parts.push(this.next().v);
    return parts.join(' ');
  }

  // { key: <read>, … } — a keyed block; the reader handles each value (shared by mock/sources).
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

  // a URL path /seg/seg — an ident attaches to a slash ONLY if glued to it, so `-> /` (root) followed by
  // a sibling node doesn't greedily swallow the node's name into the path.
  private parsePath(): string | Interp {
    const parts: Array<string | Expr> = [];
    let url = '';
    while (this.at(Tk.Punct, Pn.Slash)) {
      const slash = this.next(); url += '/';
      if (this.at(Tk.Punct, Pn.BraceL) && this.peek().pos === slash.pos + 1) {  // `/{expr}` → a dynamic segment
        parts.push(url); url = '';
        this.next(); parts.push(this.parseExpr()); this.eat(Tk.Punct, Pn.BraceR);
      } else if (this.at(Tk.Ident) && this.peek().pos === slash.pos + 1) {
        url += this.eat(Tk.Ident).v;
      }
    }
    if (!parts.length) return url;                                              // fully static → plain string (unchanged)
    if (url) parts.push(url);
    return { kind: Ek.Interp, parts };
  }

  // like parsePath, but stops at end-of-line — a route guard's `else /redirect` can't eat the next route.
  private pathOnLine(line: number): string {
    let url = '';
    while (this.at(Tk.Punct, Pn.Slash) && this.locOf(this.peek().pos).line === line) {
      this.next(); url += '/';
      if (this.at(Tk.Punct, Pn.Colon)) { this.next(); url += ':' + this.eat(Tk.Ident).v; } // `:id` param segment
      else if (this.at(Tk.Ident)) url += this.eat(Tk.Ident).v;
    }
    return url;
  }

  // ( key: value, … ) — the args of a part instance / Custom inputs|on.
  private parseArgs(): ArgMap {
    this.eat(Tk.Punct, Pn.ParenL);
    const args: ArgMap = {};
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const key = this.eat(Tk.Ident).v;
      this.eat(Tk.Punct, Pn.Colon);
      args[key] = this.parseArgValue();
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return args;
  }

  private parseArgValue(): ArgValue {
    if (this.at(Tk.String)) return this.next().v;
    if (this.at(Tk.Number)) return Number(this.next().v);
    if (this.at(Tk.Ref)) return this.next().v;               // @state
    if (this.at(Tk.Param)) return { $param: this.next().v }; // $param (nested parts)
    return this.parseDotted();                                // bare ref / store action (cart.add) / enum
  }
}

export function parse(source: string): IR { return new Parser(source).parse(); }
