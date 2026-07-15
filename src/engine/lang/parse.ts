// parse: .muten source text -> nested IR. Pipeline: .muten -> IR -> compose -> flatten -> compile -> JS.
// Parser extends Grammar, inheriting the token cursor and expression/value sub-grammars.
// This file holds only the screen grammar: top-level declarations (entity/state/action/routes ...)
// and the node tree (Stack/Text/Form/when/each ...). Dispatch is data-driven via Maps (keyword ->
// handler, modifier -> handler, method -> builder), never growing if/else chains. No magic strings.

import { ParseError } from '#engine/shared/diagnostics.js';
import { PRIMITIVES } from '#engine/lang/manifest.js';
import { Grammar } from '#engine/lang/grammar.js';
import { Tk, Pn, Kw, Nt, Mod, StOp, Ek, BOp, nonPrimitiveHint } from '#engine/shared/vocab.js';
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
        if (this.at(Tk.Punct, Pn.BraceL)) throw new ParseError('bind takes ONE state name, not an inline object. muten has no `Form bind({…})` — DROP the `Form` wrapper and bind each input to its own state: `SearchField bind(name)  SearchField bind(email)  Button "Save" -> save`.', this.locOf(this.peek().pos));
        if (this.at(Tk.Ref)) { let b = this.eat(Tk.Ref).v; while (this.at(Tk.Punct, Pn.Dot)) { this.next(); b += '.' + this.eat(Tk.Ident).v; } props.bind = b; }
        else props.bind = this.parseDotted();
        // `bind(name, email)` — several states in one bind (usually a `Form`). bind is single; teach the individual-inputs form.
        if (this.at(Tk.Punct, Pn.Comma)) throw new ParseError('`bind` takes ONE state, not several. DROP the `Form` wrapper and bind each input to its own state: `SearchField bind(name)  SearchField bind(email)  Button "Save" -> save`.', this.locOf(this.peek().pos));
        if (paren) this.eat(Tk.Punct, Pn.ParenR);
      }],
      [Mod.Checked, (props: NodeProps) => { const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next(); props.checked = this.parseExpr(); if (paren) this.eat(Tk.Punct, Pn.ParenR); }], // Checkbox checked(expr) — display a bool one-way (pair with `-> action` to toggle)
      [Mod.Submit, (props: NodeProps) => { const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next(); props.submit = this.parseDotted(); if (paren) this.eat(Tk.Punct, Pn.ParenR); }],
      [Mod.Where, (props: NodeProps) => { props.where = this.parseParenList(() => this.rebuildClause()); }],
      [Mod.Columns, (props: NodeProps) => { props.columns = this.parseParenList(() => this.eat(Tk.Ident).v); }],
      [Mod.Options, (props: NodeProps) => { props.options = this.parseParenList(() => this.eat(Tk.Ident).v); }], // Select options(a, b, c)
      [Mod.Kind, (props: NodeProps) => { props.kind = this.parenIdent(); }],   // Chart kind(bar) — the mark type
      [Mod.Color, (props: NodeProps) => { props.color = this.parenIdent(); }], // Chart color(field) — the series encoding
      // geometry (Chart encodings read x/y as field refs; SVG marks compile them as numbers). `(...)` = one expression.
      [Mod.X, (props: NodeProps) => { props.x = this.parseExpr(); }],
      [Mod.Y, (props: NodeProps) => { props.y = this.parseExpr(); }],
      [Mod.W, (props: NodeProps) => { props.w = this.parseExpr(); }],
      [Mod.H, (props: NodeProps) => { props.h = this.parseExpr(); }],
      [Mod.Cx, (props: NodeProps) => { props.cx = this.parseExpr(); }],
      [Mod.Cy, (props: NodeProps) => { props.cy = this.parseExpr(); }],
      [Mod.R, (props: NodeProps) => { props.r = this.parseExpr(); }],
      [Mod.X1, (props: NodeProps) => { props.x1 = this.parseExpr(); }],
      [Mod.Y1, (props: NodeProps) => { props.y1 = this.parseExpr(); }],
      [Mod.X2, (props: NodeProps) => { props.x2 = this.parseExpr(); }],
      [Mod.Y2, (props: NodeProps) => { props.y2 = this.parseExpr(); }],
      [Mod.Rx, (props: NodeProps) => { props.rx = this.parseExpr(); }],
      [Mod.Start, (props: NodeProps) => { props.start = this.parseExpr(); }], // Arc sweep start (degrees)
      [Mod.End, (props: NodeProps) => { props.end = this.parseExpr(); }],     // Arc sweep end (degrees)
      [Mod.Inner, (props: NodeProps) => { props.inner = this.parseExpr(); }], // Arc inner radius (donut)
      [Mod.ViewBox, (props: NodeProps) => { const p = this.at(Tk.Punct, Pn.ParenL); if (p) this.next(); props.viewBox = this.eat(Tk.String).v; if (p) this.eat(Tk.Punct, Pn.ParenR); }], // Svg viewBox("0 0 W H")
      [Mod.D, (props: NodeProps) => { const p = this.at(Tk.Punct, Pn.ParenL); if (p) this.next(); const t = this.eat(Tk.String); props.d = this.parseInterpolation(t.v, t.pos + 1); if (p) this.eat(Tk.Punct, Pn.ParenR); }], // Path d("M{x},{y} …")
      [Mod.Transform, (props: NodeProps) => { const p = this.at(Tk.Punct, Pn.ParenL); if (p) this.next(); const t = this.eat(Tk.String); props.transform = this.parseInterpolation(t.v, t.pos + 1); if (p) this.eat(Tk.Punct, Pn.ParenR); }], // transform("rotate(45)")
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
      [Mod.Disabled, (props: NodeProps) => { // `disabled when <cond>` -> reactive el.disabled; bare `disabled` = always disabled
        if (this.at(Tk.Ident, Kw.When)) { this.next(); props.disabled = this.parseExpr(); }
        else props.disabled = { kind: Ek.Lit, value: true };
      }],
      [Mod.Min, (props: NodeProps) => { props.min = this.parseExpr(); }],   // Number/Range min(0) — `(n)` parses as a grouped expression
      [Mod.Max, (props: NodeProps) => { props.max = this.parseExpr(); }],   // Number/Range max(100)
      [Mod.Step, (props: NodeProps) => { props.step = this.parseExpr(); }], // Number/Range step(5)
      [Mod.Draggable, (props: NodeProps) => { props.draggable = this.parseExpr(); }],                 // draggable(item.id) — the id the drop carries
      [Mod.Droptarget, (props: NodeProps) => { const p = this.at(Tk.Punct, Pn.ParenL); if (p) this.next(); props.dropGroup = this.eat(Tk.String).v; if (p) this.eat(Tk.Punct, Pn.ParenR); }], // droptarget("group")
      [Mod.Id, (props: NodeProps) => { const p = this.at(Tk.Punct, Pn.ParenL); if (p) this.next(); props.id = this.eat(Tk.String).v; if (p) this.eat(Tk.Punct, Pn.ParenR); }], // id("features") — a STATIC literal, so the oracle can prove every `-> "#features"` lands
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
      let head = this.eat(Tk.Ident).v;
      // `features list<text>` — a field holding a list of scalars (feature bullets, tags, categories). muten values
      // already support list<scalar>; letting an entity FIELD be one spares the model the cryptic `expected ident, got "<"`.
      if (head === 'list' && this.at(Tk.Punct, Pn.Lt)) { this.next(); const elem = this.eat(Tk.Ident).v; this.eat(Tk.Punct, Pn.Gt); head = `list<${mapFieldType(elem)}>`; }
      const options = [head];                                                  // type, then any `| enum` alternatives
      while (this.at(Tk.Punct, Pn.Pipe)) { this.next(); options.push(this.eat(Tk.Ident).v); }
      fields[fieldName] = options.length > 1 ? 'enum:' + options.join('|') : (head.startsWith('list<') ? head : mapFieldType(options[0]));
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
      // accept BOTH `min:8` (muten) and `min(8)` (the function-call style every model reaches for) — same meaning.
      const paren = this.at(Tk.Punct, Pn.ParenL);
      if (paren) this.next(); else this.eat(Tk.Punct, Pn.Colon);
      if (key === Kw.Pattern) { constraint.pattern = this.eat(Tk.String).v; if (paren) this.eat(Tk.Punct, Pn.ParenR); continue; } // `pattern:"^\d{5}$"` — a regex string
      const num = Number(this.eat(Tk.Number).v);
      if (paren) this.eat(Tk.Punct, Pn.ParenR);
      if (key === Kw.Min) constraint.min = num; else constraint.max = num;
    }
    return constraint;
  }

  // The scalar type a literal initial reveals, for an untyped state (`= false` → bool). '' when it can't be inferred
  // (an object draft or `= null` — those still need an explicit `: type`). An array → 'list' (element synthesized in toDoc).
  private inferType(v: Value | undefined): string {
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'text';
    if (Array.isArray(v)) return 'list';
    return '';
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
      // `: type` is OPTIONAL when a literal initial reveals it (`x = false` → bool, `q = ""` → text, `n = 0` → number,
      // `cards = [ … ]` → list). Only a query / `= null` / an object draft still needs the annotation. Same "infer, don't
      // demand a redundant declaration" as list shapes — spares the model the cryptic `expected ":", got "}"`.
      let type: string;
      if (this.at(Tk.Punct, Pn.Colon)) { this.next(); type = this.parseType(); }
      else {
        const inferred = source ? '' : this.inferType(hasInitial ? initial : undefined);
        if (!inferred) throw new ParseError(`state "${nameTok.v}" needs a type — write \`${nameTok.v} = <value> : text|number|bool|list<T>\`${source ? ' (a query returns a list: `: list<T>`)' : ''}.`, this.locOf(this.peek().pos));
        type = inferred;
      }
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
    if (this.at(Tk.Punct, Pn.Colon)) throw new ParseError(`action \`${name}\` declares a return type (\`: …\`) — muten actions cannot return a value, they only \`mutates\` state. Since \`${name}\` just derives a value from its inputs, make it a \`get\`, not an action — e.g. a detail page reads \`param pid\` then \`get match = store.items where id == pid\`. Drop the \`: Type\` and the \`return\`.`, this.locOf(this.peek().pos));
    const mutates: string[] = []; // a pure command (e.g. explicit `post`) may mutate nothing local
    if (this.at(Tk.Ident, Kw.Mutates)) {
      this.next();
      // `mutates` with no target (`action f mutates { … }`) is the classic slip: teach the two fixes instead of "expected ident".
      if (!this.at(Tk.Ident)) throw new ParseError(`\`mutates\` needs at least one state name (e.g. \`mutates users\`). If \`${name}\` changes no local state, drop \`mutates\` entirely: \`action ${name} { … }\`.`, this.locOf(this.peek().pos));
      mutates.push(this.eat(Tk.Ident).v);
      while (this.at(Tk.Punct, Pn.Comma)) { this.next(); mutates.push(this.eat(Tk.Ident).v); }
    }
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
    if (this.at(Tk.Ident, 'let') || this.at(Tk.Ident, 'const') || this.at(Tk.Ident, 'var')) { const kw = this.peek().v; const nx = this.toks[this.pos + 1]; const vn = nx ? nx.v : 'x'; throw new ParseError(`\`${kw} ${vn} = …\` — muten actions have no \`${kw}\`/local variables. Make \`${vn}\` a \`get\` (declared outside the action), or inline its value where it's used. To bump-or-add (e.g. a cart): \`if (items.count where id == x) > 0 { items.patch where id == x with { … } } else { items.push({ … }) }\`.`, this.locOf(this.peek().pos)); }
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

  // `each <list> as <item>[, <i>] { ... }`: list render; `item` (and optional 0-based index `i`) are scope variables.
  private parseEach(): IRNode {
    const head = this.eat(Tk.Ident, Kw.Each);
    // `each [ {…} {…} ] as x` — an inline list of static rows (feature cards, plans, testimonials). Parse the literal;
    // toDoc hoists it into a synthesized state (shape inferred from the literal), so downstream sees a normal named list.
    // (A list you MUTATE still needs a named state/store — you can't `push` to an anonymous inline list.)
    const list: Expr = this.at(Tk.Punct, Pn.BrackL) ? { kind: Ek.Arr, items: this.parseArray() } : this.parseExpr();
    this.eat(Tk.Ident, Kw.As);
    const as = this.eat(Tk.Ident).v;
    const props: NodeProps = { list, as };
    if (this.at(Tk.Punct, Pn.Comma)) { this.next(); props.index = this.eat(Tk.Ident).v; } // `each x as item, i`: i = the item's 0-based position (reactive)
    if (this.at(Tk.Ident, Kw.Where)) { this.next(); props.filter = this.parseExpr(); } // `each x as i where cond`: render only matching items
    if (this.at(Tk.Ident, 'take')) { this.next(); this.eat(Tk.Punct, Pn.ParenL); props.take = this.parseExpr(); this.eat(Tk.Punct, Pn.ParenR); } // `each x as i [where …] take(n)`: only the first n (top-N)
    return { type: Nt.Each, props, children: this.parseChildren(), loc: this.locOf(head.pos) };
  }

  // `Type <positionals> <modifiers> [{ children }]`, or a part instance `Name(args)`.
  // The inner loop reads by token kind until a sibling bare ident or `}` ends it.
  // One choke point that stamps every tree node's END position (the offset just
  // past its last token — the block's `}` for a container, the last prop for a
  // leaf). All node shapes (leaf/block/when/each/part-instance) flow through here,
  // so a bidirectional editor can splice a node by its exact `[loc, endLoc)` span.
  private parseNode(): IRNode {
    const node = this.parseNodeBody();
    const last = this.toks[this.pos - 1];
    if (last && node.loc) node.endLoc = this.locOf(last.end);
    return node;
  }

  private parseNodeBody(): IRNode {
    if (this.at(Tk.Ident, Kw.When)) return this.parseWhen();   // control-flow nodes look like keywords
    if (this.at(Tk.Ident, Kw.Each)) return this.parseEach();
    // `if <cond> { … }` in the TREE — conditional rendering is `when`, not `if` (`if` is action-body only). Teach it
    // instead of the cryptic `expected ":", got …` the model gets when `if` is parsed as a primitive name.
    if (this.at(Tk.Ident, Kw.If)) throw new ParseError('conditional rendering is `when <cond> { … }`, not `if` (`if/else` is only inside an action body) — e.g. `when not user.isAnonymous { … }`.', this.locOf(this.peek().pos));
    if (this.at(Tk.Ident, Kw.Else)) throw new ParseError('muten has no `else` in the tree (`if/else` is action-body only). Two branches on a page = two `when`s: `when x { … }` then `when x == false { … }` (or `when not x { … }`). For an enum use `match status { active -> …  lead -> … }`.', this.locOf(this.peek().pos));
    // `<div>`/`<span>`/… — the model wrote an HTML tag where a primitive goes. muten has NO tags; map it to the primitive.
    if (this.at(Tk.Punct, Pn.Lt)) {
      const nx = this.toks[this.pos + 1]; const tag = nx && nx.t === Tk.Ident ? nx.v : ''; const hint = nonPrimitiveHint(tag);
      throw new ParseError(hint ? `muten has no HTML tags — \`<${tag}>\` is ${hint}. Elements are \`Primitive class("…") { … }\`, never \`<${tag}>\`.` : 'muten has no HTML tags (`<div>`, `<span>`…). Use a primitive: `Stack` for a div, `Text` for a paragraph, `Span` for inline text, `Image`/`Link`/`Button`. Elements are `Primitive class("…") { … }`, never `<tag>`.', this.locOf(this.peek().pos));
    }
    const head = this.eat(Tk.Ident);
    const type = head.v;
    const loc = this.locOf(head.pos);
    if (this.at(Tk.Punct, Pn.ParenL)) { // part instance: `Name(arg: value)`, optional `class(…)`, optional `{ … }` slot
      const args = this.parseArgs();
      const node: IRNode = { type, args, loc };
      // `class()` is muten's ONE styling mechanism and a part instance is a node like any other, so it takes one too —
      // it merges onto the part's root at compose time. Everything else stays out: `id`, `on`, `style`, `disabled`
      // carry identity and behaviour that belong INSIDE the part, not at its call site.
      // Before this, `class(` was read as a part instance NAMED `class`, and its string blew up `parseArgs` with
      // `expected ident, got string` — an error raised from a place the parser had already reached by mistake.
      const props: NodeProps = {};
      while (this.at(Tk.Ident)) {
        const word = this.peek().v;
        if (word === Mod.Class) { this.next(); (this.modifiers.get(Mod.Class) as (p: NodeProps) => void)(props); continue; }
        if (this.modifiers.has(word)) throw new ParseError(`\`${word}(…)\` cannot be attached to the part \`${type}\` — only \`class(…)\` can. Put \`${word}\` inside ${type}'s own definition, or wrap the call in a \`Stack ${word}(…) { ${type}(…) }\`.`, this.locOf(this.peek().pos));
        break;   // an ordinary ident starts the next sibling node
      }
      if (props.class) node.props = props;
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
        case Tk.Ref: { let r = this.next().v; while (this.at(Tk.Punct, Pn.Dot)) { this.next(); r += '.' + this.eat(Tk.Ident).v; } props.data = r; break; } // positional @ref = data list: a page state/query/get (`@rows`) OR a store member (`@orders.items`)
        case Tk.Arrow: this.parseArrow(type, props); break;                        // -> "/route" (Link) or -> action(arg)
        case Tk.Ident: {
          const word = tok.v;
          if (type === Nt.Title && isLevel(word)) { this.next(); props.level = word; break; } // heading level (h1..h6)
          if (type === Nt.Video && VIDEO_FLAGS.has(word)) { this.next(); (props.flags = props.flags || []).push(word); break; } // <video> boolean attr
          if (type === Nt.List && word === Kw.Ordered) { this.next(); props.ordered = true; break; }                          // List ordered -> <ol>
          if (type === Nt.Details && word === Kw.Open) { this.next(); props.open = true; break; }                              // Details open -> <details open>
          if (type === Nt.Row && word === Kw.Head) { this.next(); props.head = true; break; }                                  // Row head -> a header row (cells -> <th>, in <thead>)
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
    // `Button -> "/route"` — the model wants NAVIGATION. Only a Link navigates; a Button `-> action` runs an action.
    // Teach the swap instead of the "expected ident, got string" ↔ "unknown-action" bounce that traps the model.
    if (this.at(Tk.String)) throw new ParseError(`${type} runs an ACTION, not navigation. Only \`Link\` goes to a route — style it as a button: \`Link "…" -> "${this.peek().v}" class("btn btn-default")\`. (\`${type} -> action\` calls an action.)`, this.locOf(this.peek().pos));
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
    if (this.at(Tk.Punct, Pn.Question)) throw new ParseError(`\`${type}?\` — muten has no nullable types and no \`null\`. Model "absent / nothing selected" with a bool flag + scalars instead: \`loggedIn = false : bool persist\` + \`userName = "" : text\`, shown with \`when loggedIn { … }\`.`, this.locOf(this.peek().pos));
    return type;
  }

  // `(ident)` — one identifier in parens (Chart kind/x/y/color); bare `ident` also accepted.
  private parenIdent(): string {
    const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next();
    const v = this.eat(Tk.Ident).v;
    if (paren) this.eat(Tk.Punct, Pn.ParenR);
    return v;
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
    if (this.at(Tk.String)) {                                // quoted: literal, not a ref (compose keeps it as text)
      const t = this.next();                                 // …but `{…}` must interpolate here as in every other string
      const parsed = this.parseInterpolation(t.v, t.pos + 1);
      return typeof parsed === 'string' ? { $lit: parsed } : { $lit: t.v, $interp: parsed };
    }
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
