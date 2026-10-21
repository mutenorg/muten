// parse: .muten source text -> nested IR. Pipeline: .muten -> IR -> compose -> flatten -> compile -> JS.
// The grammar is layered, each layer a class on the one below:
//   Grammar (grammar.ts)        the token cursor + expressions and values
//   Readers (readers.ts)        small shared readers: types, dotted names, args, clauses
//   ActionParser (parse-actions) `get`, `action` and the statements of a body
//   DeclParser (parse-decls)    the data declarations: entity, state, mock, sources, api, meta, routes, theme, use
//   Parser (this file)          the entry, the declarations that hold a tree (shell, layout, part), and the node tree
// Dispatch is data-driven via Maps (keyword -> handler, modifier -> handler, method -> builder), never growing if/else
// chains. No magic strings.

import { ParseError } from '#engine/shared/diagnostics.js';
import { PRIMITIVES } from '#engine/lang/manifest.js';
import { DeclParser } from '#engine/lang/parse-decls.js';
import { LANG_STORE, THEME_PROVIDER, FROM_SCRIPT, Tk, Pn, Kw, Nt, Mod, Ek, BOp, UOp, nonPrimitiveHint, DATA_PREFIX, PART_WRAP_CLASS } from '#engine/shared/vocab.js';
import type {
  IR, IRNode, NodeProps, StringPropName, Expr, Level, PartParam, Loc,
} from '#engine/shared/types.js';

// Derived from the MANIFEST (single vocabulary source):
//   STRING_PROP  - where a primitive's positional string lands (Text "x" -> props.value)
//   INTERPOLATES - which primitives reactively interpolate that string: Text/Title/Span/Image
const STRING_PROP: { [primitive: string]: StringPropName } = {};
for (const [name, primitive] of Object.entries(PRIMITIVES)) if (primitive.string) STRING_PROP[name] = primitive.string;
const INTERPOLATES = new Set<string>(
  Object.entries(PRIMITIVES).filter(([, primitive]) => primitive.interp).map(([name]) => name),
);

const isLevel = (word: string): word is Level => /^h[1-6]$/.test(word);             // heading level h1..h6
const VIDEO_FLAGS = new Set(['controls', 'autoplay', 'loop', 'muted', 'playsinline']); // <video> boolean attrs (bare keywords)


export class Parser extends DeclParser {
  // Built once per parse. Keys double as membership tests: an ident not in a map
  // is simply not a valid modifier or action method.
  private readonly modifiers: Map<string, (props: NodeProps) => void>;   // modifier -> parse + attach its prop

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
      // columns(name "Nombre", stock) · options(name "Nombre", price "Precio"): a field / value, and the words it shows
      [Mod.Columns, (props: NodeProps) => { const list = this.labelledIdents(); props.columns = list.values; if (list.labels) props.columnLabels = list.labels; }],
      [Mod.Options, (props: NodeProps) => { const list = this.labelledIdents(); props.options = list.values; if (list.labels) props.optionLabels = list.labels; }],
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
        const name = this.className();
        this.nestGuard(name); // `class("x" aria(…))` — modifiers are siblings, not nested
        if (this.at(Tk.Ident, Kw.When)) { this.next(); return { name, cond: this.parseExpr() }; }
        return name;
      })]; }],
      [Mod.Currency, (props: NodeProps) => { const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next(); props.currency = this.eat(Tk.String).v; if (paren) this.eat(Tk.Punct, Pn.ParenR); }],   // Number currency("COP")
      [Mod.Accept, (props: NodeProps) => { const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next(); props.accept = this.eat(Tk.String).v; if (paren) this.eat(Tk.Punct, Pn.ParenR); }],   // File accept("image/*")
      [Mod.Alt, (props: NodeProps) => { const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next(); const t = this.eat(Tk.String); props.alt = this.parseInterpolation(t.v, t.pos + 1); if (paren) this.eat(Tk.Punct, Pn.ParenR); }],  // Image a11y/SEO alt text
      [Mod.Inputs, (props: NodeProps) => { props.inputs = { ...props.inputs, ...this.parseArgs() }; }],   // Custom inputs(k: value, ...)
      [Mod.On, (props: NodeProps) => { props.on = { ...props.on, ...this.parseArgs() }; }],               // Custom on(event: action, ...)
      [Mod.Aria, (props: NodeProps) => { props.aria = { ...props.aria, ...this.parseAriaArgs() }; }],      // aria(label: "Close", expanded: isOpen) -> aria-*/role
      // data(slot: "card", state: isOpen ? "open" : "closed") -> data-* attrs. Stored beside aria's keys with the full `data-` name, so the
      // same compose/validate/compile path (literal = static, state-reading = effect) carries them; compile keeps a `data-` key as is.
      [Mod.Data, (props: NodeProps) => { const attrs = this.parseAriaArgs(); props.aria = { ...props.aria, ...Object.fromEntries(Object.entries(attrs).map(([key, expr]) => [DATA_PREFIX + key, expr])) }; }],
      [Mod.Style, (props: NodeProps) => { props.styleVars = { ...props.styleVars, ...this.parseStyleArgs() }; }], // style(w: "{pct}%") -> CSS var --w (the bounded path for dynamic values: progress, transforms)
      [Mod.Disabled, (props: NodeProps) => { // `disabled when <cond>` -> reactive el.disabled; bare `disabled` = always disabled
        if (this.at(Tk.Ident, Kw.When)) { this.next(); props.disabled = this.parseExpr(); }
        else props.disabled = { kind: Ek.Lit, value: true };
      }],
      [Mod.Min, (props: NodeProps) => { props.min = this.parseExpr(); }],   // Number/Range min(0) — `(n)` parses as a grouped expression
      [Mod.Max, (props: NodeProps) => { props.max = this.parseExpr(); }],   // Number/Range max(100)
      [Mod.Step, (props: NodeProps) => { props.step = this.parseExpr(); }], // Number/Range step(5)
      [Mod.Draggable, (props: NodeProps) => { props.draggable = this.parseExpr(); }],                 // draggable(item.id) — the id the drop carries
      [Mod.Droptarget, (props: NodeProps) => { const p = this.at(Tk.Punct, Pn.ParenL); if (p) this.next(); const t = this.eat(Tk.String); props.dropGroup = this.parseInterpolation(t.v, t.pos + 1); if (p) this.eat(Tk.Punct, Pn.ParenR); }], // droptarget("group") — the group interpolates, so `droptarget("{row.id}")` makes each row carry its own id (list reorder), while a static `droptarget("done")` is unchanged
      [Mod.Id, (props: NodeProps) => { const p = this.at(Tk.Punct, Pn.ParenL); if (p) this.next(); props.id = this.eat(Tk.String).v; if (p) this.eat(Tk.Punct, Pn.ParenR); }], // id("features") — a STATIC literal, so the oracle can prove every `-> "#features"` lands
      [Mod.Eager, (props: NodeProps) => { props.eager = true; }], // Image eager — a bare flag: this image loads at once, at high priority (lazy is the default)
      [Mod.Group, (props: NodeProps) => { const p = this.at(Tk.Punct, Pn.ParenL); if (p) this.next(); props.group = this.eat(Tk.String).v; if (p) this.eat(Tk.Punct, Pn.ParenR); }], // Details group("faq") — a STATIC name: the oracle checks it sits on a Details
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
      [Kw.Layout, () => this.parseLayout(ir)],                                                 // chrome shared by a group of routes
      [Kw.Part, () => this.parsePart(ir)],
      [Kw.Const, () => this.parseConst(ir)],                                                   // compile-time immutable scalar
      [Kw.Theme, () => this.parseTheme(ir)],                                                   // project token scale
      [LANG_STORE, () => { this.next(); this.eat(Tk.Ident, Kw.From); ir.langFrom = this.parseExpr(); }],   // `lang from shop.lang`: this page speaks that language, not the app's
      [Kw.Param, () => { this.next(); (ir.params = ir.params || []).push(this.eat(Tk.Ident).v); }], // route param (`param id`)
      [THEME_PROVIDER, () => {   // theme.muten: `provider ThemeProvider(theme: look) from "@mui/material"`
        const loc = this.locOf(this.next().pos);
        const component = this.eat(Tk.Ident).v;
        const args = this.at(Tk.Punct, Pn.ParenL) ? this.parseForeignArgs() : {};
        this.eat(Tk.Ident, Kw.From);
        (ir.providers = ir.providers || []).push({ component, args, from: this.eat(Tk.String).v, loc });
      }],
      [Kw.Use, () => { // `use a, b from "./lib.ts"` - named JS functions muten may call
        const loc = this.locOf(this.next().pos);
        if (this.parseForeignUse(ir)) return;   // `use element|widget|react Name … from "…"`: a component from npm
        // each name may say what it returns (`rowsOf: list<Row>`), so a list it gives back is read with its fields
        const names: string[] = [];
        const returns: { [name: string]: string } = {};
        do {
          if (names.length) this.next();
          const name = this.eat(Tk.Ident).v;
          names.push(name);
          if (this.at(Tk.Punct, Pn.Colon)) { this.next(); returns[name] = this.parseType(); }
        } while (this.at(Tk.Punct, Pn.Comma));
        this.eat(Tk.Ident, Kw.From);
        const script = this.at(Tk.Ident, FROM_SCRIPT) ? (this.next(), true) : false;   // `from script "https://…"`: a global, not a module
        const from = this.eat(Tk.String).v;
        (ir.imports = ir.imports || []).push({ names, from, loc, ...(script ? { script } : {}), ...(Object.keys(returns).length ? { returns } : {}) });
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

  // `shell { <node>* }`: persistent app chrome wrapping every route; holds the `slot` outlet.
  private parseShell(ir: IR): void {
    this.eat(Tk.Ident, Kw.Shell);
    ir.shell = { type: Nt.Shell, props: {}, children: this.parseChildren() };
  }

  // `layout name { <node>* }`: chrome shared by the routes declared `in name`; mounted once, kept across them.
  private parseLayout(ir: IR): void {
    const start = this.eat(Tk.Ident, Kw.Layout);
    const name = this.eat(Tk.Ident).v;
    (ir.layouts = ir.layouts || {})[name] = { type: Nt.Layout, props: {}, children: this.parseChildren(), loc: this.locOf(start.pos) };
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
      const param: PartParam = { name: paramName, type: this.parseType() };
      // `size: text = "sm"`: an optional param. Only a literal: a ref would be read in each caller's scope, not the part's.
      if (this.at(Tk.Punct, Pn.Assign)) {
        const eq = this.next();
        if (!this.at(Tk.String) && !this.at(Tk.Number) && !this.atBool()) throw new ParseError(`part "${name}": the default of "${paramName}" must be a literal ("text", a number, true or false).`, this.locOf(eq.pos));
        param.fallback = this.parseArgValue();
      }
      params.push(param);
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    const nodes = this.parseChildren();
    ir.parts = ir.parts || {};
    // One root, or several nodes auto-wrapped in a Stack (a part always expands to a single subtree). The wrapper wears
    // PART_WRAP_CLASS so a stylesheet can name it (`.mu-part`) instead of guessing it by its bare class attribute.
    const tree = nodes.length === 1 ? nodes[0] : { type: Nt.Stack, props: { class: [PART_WRAP_CLASS] }, children: nodes };
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
    if (this.at(Tk.Ident, Kw.Else)) throw new ParseError('`else` goes right after the `}` of a `when`: `when x { … } else { … }` (or `else when y { … }`). For an enum use `match status { active -> …  lead -> … }`.', this.locOf(this.peek().pos));
    // `<div>`/`<span>`/… — the model wrote an HTML tag where a primitive goes. muten has NO tags; map it to the primitive.
    if (this.at(Tk.Punct, Pn.Lt)) {
      const nx = this.toks[this.pos + 1]; const tag = nx && nx.t === Tk.Ident ? nx.v : ''; const hint = nonPrimitiveHint(tag);
      throw new ParseError(hint ? `muten has no HTML tags — \`<${tag}>\` is ${hint}. Elements are \`Primitive class("…") { … }\`, never \`<${tag}>\`.` : 'muten has no HTML tags (`<div>`, `<span>`…). Use a primitive: `Stack` for a div, `Text` for a paragraph, `Span` for inline text, `Image`/`Link`/`Button`. Elements are `Primitive class("…") { … }`, never `<tag>`.', this.locOf(this.peek().pos));
    }
    const head = this.eat(Tk.Ident);
    const type = head.v;
    const loc = this.locOf(head.pos);
    // a component from npm: `Rating(value: x)`, and a library's parts as its docs write them, `Dialog.Root { … }`
    if (this.foreign.has(type) && !this.at(Tk.String)) {   // `Card class(…) { … }` too; `Text "…"` stays muten's (a library may also export a Text)
      let path = type;
      while (this.at(Tk.Punct, Pn.Dot)) { this.next(); path += '.' + this.eat(Tk.Ident).v; }
      return this.parseForeignCall(path, loc);
    }
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
        const readClass = this.modifiers.get(Mod.Class);
        if (word === Mod.Class && readClass) { this.next(); readClass(props); continue; }
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
          if ((type === Nt.Video || type === Nt.Audio) && VIDEO_FLAGS.has(word)) { this.next(); (props.flags = props.flags || []).push(word); break; } // <video> boolean attr
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
          if (tok.v === Pn.BraceL) { this.next(); while (!this.at(Tk.Punct, Pn.BraceR)) children.push(...this.parseChild()); this.eat(Tk.Punct, Pn.BraceR); }
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

  // A component from npm, called like a part: `Rating(value: stars, max: 5) on(sl-change: rate) class("x") { … }`. It
  // becomes a Custom node (inputs, events and live updates are the Custom machinery); compile reads the `use` to know
  // whether to create the element, mount the widget or render the React island. Event names may be kebab-case.
  private parseForeignCall(type: string, loc: Loc): IRNode {
    const props: NodeProps = { component: type, inputs: this.at(Tk.Punct, Pn.ParenL) ? this.parseForeignArgs() : {} };
    while (this.at(Tk.Ident)) {
      const word = this.peek().v;
      const classModifier = word === Mod.Class ? this.modifiers.get(Mod.Class) : undefined;
      if (classModifier) { this.next(); classModifier(props); continue; }
      if (word === Mod.On) { this.next(); props.on = { ...props.on, ...this.parseArgs(true) }; continue; }
      if (this.modifiers.has(word)) throw new ParseError(`\`${word}(…)\` cannot be attached to \`${type}\` — a component from npm takes its props in \`${type}(…)\`, events in \`on(…)\` and \`class(…)\`.`, this.locOf(this.peek().pos));
      break;
    }
    const node: IRNode = { type: Nt.Custom, props, loc };
    if (this.at(Tk.Punct, Pn.BraceL)) node.children = this.parseChildren();   // slotted content (a Web Component's <slot>)
    return node;
  }

  // ── small readers ────────────────────────────────────────────────────────────

  // `{ <node>* }`: a children block shared by shell/part/when/each and inline blocks.
  private parseChildren(): IRNode[] {
    this.eat(Tk.Punct, Pn.BraceL);
    const children: IRNode[] = [];
    while (!this.at(Tk.Punct, Pn.BraceR)) children.push(...this.parseChild());
    this.eat(Tk.Punct, Pn.BraceR);
    return children;
  }

  // One child in a block: a node, a `match` (one When per arm), or a `when` with its `else` chain.
  private parseChild(): IRNode[] {
    if (this.at(Tk.Ident, Kw.Match)) return this.parseMatch();
    const node = this.parseNode();
    return node.type === Nt.When && this.at(Tk.Ident, Kw.Else) ? [node, ...this.parseElse(node)] : [node];
  }

  // `when a { … } else when b { … } else { … }`: SUGAR, like `match` — each branch is a plain When on «none of the
  // earlier conditions, and its own», so validate and compile only ever see Whens. Two `when`s with a hand-negated
  // condition was the friction the model hit most (star ratings, sent / not sent).
  private parseElse(first: IRNode): IRNode[] {
    const branches: IRNode[] = [];
    const firstCond = first.props?.cond;
    if (!firstCond) return branches;
    const notYet: Expr[] = [firstCond];
    while (this.at(Tk.Ident, Kw.Else)) {
      const head = this.next();
      const none = notYet.map((cond): Expr => ({ kind: Ek.Un, op: UOp.Not, operand: cond })).reduce((acc, next): Expr => ({ kind: Ek.Bin, op: BOp.And, left: acc, right: next }));
      if (this.at(Tk.Ident, Kw.When)) {
        this.next();
        const own = this.parseExpr();
        branches.push({ type: Nt.When, props: { cond: { kind: Ek.Bin, op: BOp.And, left: none, right: own } }, children: this.parseChildren(), loc: this.locOf(head.pos) });
        notYet.push(own);
      } else {
        branches.push({ type: Nt.When, props: { cond: none }, children: this.parseChildren(), loc: this.locOf(head.pos) });
        break;
      }
    }
    return branches;
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

}

export function parse(source: string): IR { return new Parser(source).parse(); }
