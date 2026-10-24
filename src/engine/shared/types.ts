// types: core domain contracts for the engine compile pipeline (parse -> flatten -> validate ->
// compose -> compile). Consumed by every stage. Strict and honest: no `any`, no `unknown`,
// no `as`, no phantom Record. Open-keyed maps use index signatures with real value types.
// String/keyword/operator constants live in vocab.ts.

import type { TsFn, Timer, Settle } from '#engine/shared/types-fn.js';
import type { Stray } from '#engine/shared/types-stray.js';
import type { ThemeScale, ThemeProvider } from '#engine/shared/types-theme.js';

import type { Tk, BOp, UOp, Ek, StOp, UseKind, WakeMode } from '#engine/shared/vocab.js';


// ── 1. Primitive value shapes ───────────────────────────────────────────────

/** A leaf literal the parser can read (const values, enum members, flags). */
export type Scalar = string | number | boolean | null;

/** A JSON-ish literal: the value of `mock`, `sources` entries and state initials. */
export type Value = Scalar | Value[] | ValueObject;
export interface ValueObject { [key: string]: Value; }

/** A real data source for a query: a bare URL, or a complete HTTP request (method, headers, body, and
 *  the JSON path to the array). (The parser stores sources as raw `Value`; build + runtime read them
 *  through engine/shared/source.ts, the single definition of these semantics.) */
export type Source = string | { url: string; method?: string; headers?: { [k: string]: string }; body?: Value; at?: string };

/** A manifest prop's type hint (`"?"` marks optional) — the vocabulary the linter shows. */
export type PropHint =
  | 'text' | 'text?' | 'state' | 'state?' | 'action' | 'action?' | 'expr' | 'expr?'
  | 'fields' | 'route' | 'name' | 'map?' | 'clauses?' | 'ident' | 'ident?' | 'idents';

/** A primitive's manifest entry: its vocabulary + docs (the single source the linter reads).
 *  `string` = positional prop; `props` = each prop's type hint; `children` = accepts `{ }`;
 *  `interp` = its positional string interpolates state; `control` = a when/each keyword node. */
export interface Primitive {
  string?: StringPropName;
  props: { [prop: string]: PropHint };
  children: boolean;
  interp?: boolean;
  control?: boolean;
  doc: string;
  snippet: string;
}


// ── 2. Source location ───────────────────────────────────────────────────────

/** 1-based line/col into the .muten source — carried by tokens, nodes, diagnostics. */
export interface Loc {
  line: number;
  col: number;
  in?: PartPlace;   // set when the position is in a PART's file, not the file being read (see PartPlace)
}
/** A position inside part `part`'s own file, reached through the call at `call` (in the page, or itself inside another part). */
export interface PartPlace {
  part: string;
  call: Loc | null;
}


// ── 3. Tokenizer ─────────────────────────────────────────────────────────────

/** A token stores `pos` = its start index in the source, `end` = one past its
 *  last char (so `[pos, end)` is the token's exact source span, quotes included). */
export interface Token {
  t: Tk;
  v: string;   // raw text value (numbers are kept as their source text)
  pos: number;
  end: number;
}

/** A cursor over a token stream — shared by the main parser and { } interpolation. */
export interface Cursor {
  toks: Token[];
  i: number;
}


// ── 4. Expression AST ────────────────────────────────────────────────────────
// Shared expression grammar: conditions, arithmetic, ternaries, interpolation.

export interface LitExpr { kind: Ek.Lit; value: Scalar; }
export interface RefExpr { kind: Ek.Ref; name: string; }
export interface UnExpr { kind: Ek.Un; op: UOp; operand: Expr; }
export interface BinExpr { kind: Ek.Bin; op: BOp; left: Expr; right: Expr; }
export interface TernExpr { kind: Ek.Tern; cond: Expr; then: Expr; else: Expr; }
/** A call to a `use`'d JS function: `fmt(date, "…")`. `fn` is the imported name; never a muten primitive. */
/** One step after a call on something from npm: `.select("*")` (a method) or `.success` (a property). */
export interface ChainStep { name: string; args?: Expr[]; }
/** `fmt(x)`, `format.money(x)`, or a package's own API: `z.string().email()` → fn `z.string`, chain [email()]. */
export interface CallExpr { kind: Ek.Call; fn: string; args: Expr[]; chain?: ChainStep[]; ctor?: boolean; }   // ctor: `new X(…)`
/** `[4.6, -74.08]` / `[{ price: id, quantity: 1 }]`: a list written in place, for a package's config (a map's center…). */
export interface ListExpr { kind: Ek.List; items: Expr[]; }
export interface ObjExpr { kind: Ek.Obj; fields: Array<{ key: string; value: Expr }>; } // inline object literal, e.g. `{ title: @draft.title, qty: 1 }`
export interface AggExpr { kind: Ek.Agg; op: string; list: string; body: Expr; member?: string; take?: Expr; } // e.g. `lines.sum by price * qty` (item-implicit). `member` = the field read off an `at(n)` element. `take` = the top-n cap on `sort by … take(n)`.
export interface FilterExpr { kind: Ek.Filter; list: string; cond: Expr; } // derived list, e.g. `tasks where status == "todo"` (item-implicit)
export interface ArrExpr { kind: Ek.Arr; items: Value[]; } // inline literal list, ONLY as an `each [ {…} {…} ] as x` source — hoisted to a synthesized state in toDoc (shape inferred from the literal), so it never reaches validate/compile
export type Expr = LitExpr | RefExpr | UnExpr | BinExpr | TernExpr | CallExpr | ObjExpr | AggExpr | FilterExpr | ArrExpr | ListExpr;

/** A `use a, b from "./lib.ts"` — named JS functions muten may call. The seam to the JS ecosystem. */
export interface ImportDef {
  names: string[];
  from: string;
  kind?: UseKind;   // a component from npm (element / widget / react); absent = functions
  tag?: string;     // `use element`: the custom element's tag name ("sl-rating")
  returns?: { [name: string]: string };   // `use rowsOf: list<Row> from …`: what a function gives back, so its result is checked
  arity?: { [name: string]: { min: number; max: number } };   // from the package's types: how many values it takes (max -1 = any)
  loc?: Loc;
  script?: boolean; // `use google from script "https://…"`: a global its <script> leaves, loaded when first called
  server?: string;  // set when the package belongs on a server (project/server-packages.ts): why, and what the app uses instead
}

/** "Hi, {user.name}" → a list of plain strings interleaved with embedded expressions. */
export interface Interp {
  kind: Ek.Interp;
  parts: Array<string | Expr>;
}

/** A deferred reference to a part parameter (`$title`), resolved at compose time. */
export interface ParamRef { $param: string; }

/** A positional string prop: plain/interpolated text, or a deferred part param. */
export type StringPropValue = string | Interp | ParamRef;

/** The prop names that a primitive's positional string can land in (manifest `.string`). */
export type StringPropName = 'value' | 'label' | 'src' | 'alt' | 'name' | 'placeholder' | 'submitLabel' | 'summary';


// ── 5. Action / effect statements ────────────────────────────────────────────
// Discriminated union of mutations in an action body or a `.store` effect.

export interface PushStmt { op: StOp.Push; target: string; arg: Expr; }
export interface SetStmt { op: StOp.Set; target: string; arg: Expr; }
export interface ResetStmt { op: StOp.Reset; target: string; }
export interface ToggleStmt { op: StOp.Toggle; target: string; arg?: Expr; } // `open.toggle()` -> flip a bool; `favs.toggle(x)` -> add/remove x in a list<scalar> (membership)
export interface RemoveStmt { op: StOp.Remove; target: string; pred: Expr; } // e.g. `tasks.remove where id == taskId` (item-implicit)
export interface PatchStmt { op: StOp.Patch; target: string; pred: Expr; patch: Expr; } // e.g. `tasks.patch where id == taskId with { done: true }`, position-preserving (item-implicit)
/** Server CRUD on a source-backed list: POST/PUT/DELETE the item, then reflect the result in the list. */
export interface CreateStmt { op: StOp.Create; target: string; arg: Expr; }
export interface UpdateStmt { op: StOp.Update; target: string; arg: Expr; }
export interface DeleteStmt { op: StOp.Delete; target: string; arg: Expr; }
/** Re-run a query with N query-string params (pagination / search / filters): `products.refetch(q: x, page: n)`. */
export interface RefetchStmt { op: StOp.Refetch; target: string; params: { [k: string]: Expr }; }
/** A message up the socket of a `query x live`: `messages.send({ text: draft })`. */
export interface SendStmt { op: StOp.Send; target: string; arg: Expr; }
/** Explicit non-REST request (escape hatch): `post "shop:/orders" body item`, `delete "shop:/x/{id}"`. */
export interface RequestStmt { op: StOp.Request; method: string; url: string | Interp; body: Expr | null; into?: string; } // `into <state>` captures the JSON response (order id / confirmation code)
export interface CallStmt { op: StOp.Call; target: string; method: string; args: Expr[]; } // page action calling a store action, e.g. `shop.addProduct(draft)`
/** Calling a `use`'d function as a side-effect statement: `persist(messages)`, `scrollBottom()`. Bounded: the fn is declared + checked. */
export interface ExternStmt { op: StOp.Extern; fn: string; args: Expr[]; chain?: ChainStep[]; ctor?: boolean; }
export interface IfStmt { op: StOp.If; cond: Expr; then: Stmt[]; else: Stmt[] | null; }
export type Stmt = (PushStmt | SetStmt | ResetStmt | ToggleStmt | RemoveStmt | PatchStmt | CreateStmt | UpdateStmt | DeleteStmt | RefetchStmt | SendStmt | RequestStmt | CallStmt | ExternStmt | IfStmt) & { loc?: Loc };


// ── 6. Entities & validation schema ──────────────────────────────────────────

/** The serialized field-type tag the parser stores. */
export type EnumType = `enum:${string}`;
export type ListType = `list<${string}>`;
// Known scalar tags + enum/list encodings. `(string & {})` also admits entity-name field
// types (e.g. `author User`) while keeping known tags as autocomplete hints. Still honest:
// the stored value is genuinely a string, never `any`/`unknown`.
export type FieldType = 'uuid' | 'string' | 'number' | 'bool' | 'email' | EnumType | ListType | (string & {});

// Heading level for Title (structure, not style).
export type Level = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/** An entity: field name → its type tag (always carries an implicit `id: 'uuid'`). */
export interface Entity { [field: string]: FieldType; }

/** Per-field rules and words pulled from the entity schema (`email email required`, `min:8`, `"Correo"`). */
export interface FieldConstraint {
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;   // `pattern:"<regex>"` — a non-empty value must match this regular expression (phone/zip/SKU/…)
  label?: string;     // `customer text required "Nombre"` — what a Form shows for the field (else its name)
  choices?: { [value: string]: string };   // `delivery today "Hoy" | tomorrow "Mañana"` — what each enum value shows
}
/** field name → its constraints. */
export interface EntityConstraints { [field: string]: FieldConstraint; }


// ── 7. Declared values: state, store, get, actions, parts, routes, theme ──────

/** A reactive state (page-local `state {}` or app-global `store {}`). */
export interface StateDef {
  type: string;       // declared type tag: scalar, list<X>, or an entity name
  source?: string;    // "query:<name>" for async query-backed state
  refresh?: number;   // `query x every 30s`: asked again on that beat while the tab is visible (ms)
  live?: boolean;     // `query x live` -> a WebSocket subscription (server pushes); socket closes via onCleanup
  feed?: Expr;       // `live db.channel("x").on(…, change).subscribe()`: what keeps it current, one change at a time
  call?: CallExpr;   // `query lookup(q)` / `query db.from("orders").select("*")`: the data comes from a function (a `use`, async or not), asked again when an arg changes
  initial?: Value;    // declared initial literal (when not query-backed)
  persist?: boolean;  // `state { x = … : T persist }` — auto load/save to localStorage (survives reload)
  loc?: Loc;
}

/** A quoted literal passed as a part/Custom arg. Kept distinct from a bare ref string so compose
 *  substitutes "Send" as text, not as a dangling reference to a variable named Send.
 *  `$interp` is set when the literal contains `{…}` (`price: "{money(p.amount)}"`): TEXT positions render it
 *  reactively, while every other sink (icon names, refs, Custom inputs, DevTools) keeps reading the raw,
 *  static `$lit`. Carrying both is what keeps the change from rippling through those sinks. */
export interface LitRef { $lit: string; $interp?: Interp; }
/** The value of a part-instance arg: a quoted literal, a bare ref string, a number, or a $param. */
/** An object written as a prop (`animate: { opacity: shown ? 1 : 0 }`): a component from npm takes it as it is, live. */
export interface ExprArg { $expr: Expr; }
export type ArgValue = string | number | boolean | ParamRef | LitRef | ExprArg;
/** key → arg value, for part instances and Custom inputs/on. */
export interface ArgMap { [key: string]: ArgValue; }

/** A part definition: its params + the (single-root) tree it expands to. */
/** `fallback`: a literal the param takes when a call leaves it out (`size: text = "sm"`); without one the param is required. */
export interface PartParam { name: string; type: string; fallback?: ArgValue; }
export interface PartDef {
  file?: string;   // the file it is written in (a plugin's: inside node_modules), so a finding inside it can name it
  params: PartParam[];
  tree: IRNode;
  // hoisted by the loader/analyzer so a part's @refs validate against its own data:
  state?: { [name: string]: StateDef };
  entities?: { [name: string]: Entity };
  mock?: { [name: string]: Value };
  css?: string;
  imports?: ImportDef[];   // the part file's own `use` lines, anchored to src/ so they resolve from any page
}

/** A declared action: which state it may mutate, its input name, and its body.
 *  `params` is the multi-param form `action f(a: T, b: T)`; `input` is the legacy `<- v` form. */
export interface ActionDef {
  mutates: string[];
  input: string;
  params?: PartParam[];
  body: Stmt[];
  failed?: Stmt[];   // `} failed { … }`: runs when the body throws (a `post` answered non-2xx, the network failed)
}

/** One route line: `routes { /url -> page [guard <expr over store members> else /path] }`. */
export interface Route {
  url: string;
  page: string;
  loc?: Loc;
  guard?: Expr;      // `guard auth.signedIn and not auth.blocked`: any expression, every ref a store member
  redirect?: string;
  layout?: string;   // `-> page in pro`: the route mounts inside the named `layout`, which stays mounted across its routes
  without?: string;  // `-> page without site`: this route does not mount in the app's `default` layout
}


// ── 8. Nested IR (parser output) ─────────────────────────────────────────────

/** A `class()` entry: a plain look class, or one toggled reactively (`active when isOpen`). */
export interface ClassCond { name: string; cond: Expr; }
export interface ClassInterp { interp: Interp; }   // `class("status-{x}")` — a class token whose value interpolates state, applied reactively (swap on change)

/** A node's props: a named bag of authoring options (no catch-all — every field is declared). */
/** The NodeProps that hold one plain expression a part's $param can sit in (`checked($on)`, `min($lo)`, `cx($x)`, …). */
export type ExprPropKey = 'checked' | 'draggable' | 'min' | 'max' | 'step' | 'filter' | 'take'
  | 'x' | 'y' | 'w' | 'h' | 'cx' | 'cy' | 'r' | 'x1' | 'y1' | 'x2' | 'y2' | 'rx' | 'start' | 'end' | 'inner';

export interface NodeProps {
  // positional / textual
  value?: StringPropValue;
  label?: StringPropValue;
  src?: StringPropValue;
  alt?: StringPropValue;
  accept?: string;          // File accept("image/*,.pdf")
  currency?: string;        // Number currency("COP"): a money field
  name?: StringPropValue;   // Icon "set:name" (a static Iconify ref)
  flags?: string[];         // Video boolean attrs: controls / autoplay / loop / muted / playsinline
  ordered?: boolean;        // List `ordered` -> <ol> instead of <ul>
  open?: boolean;           // Details `open` -> <details open> (expanded by default)
  lazy?: boolean;           // Custom X lazy -> mounted (and what its mount imports, downloaded) as its place nears the screen
  wake?: { mode: WakeMode; query?: string };   // an island's `wake idle` / `wake media "(min-width: 800px)"` (runtime-island.ts)
  eager?: boolean;          // Image eager -> loading=eager + fetchPriority=high; without it an Image is loading=lazy (it loads as it nears the screen)
  group?: string;           // Details group("faq") -> <details name="faq">: the browser keeps one of the group open
  head?: boolean;           // Row `head` -> a header row (its cells become <th>, grouped into <thead>)
  summary?: StringPropValue; // Details summary text -> <summary>
  placeholder?: StringPropValue;
  submitLabel?: StringPropValue;
  // structure & wiring
  level?: Level;
  component?: string;
  data?: string;
  id?: string;           // id("features") — a stable DOM id; what an in-page `Link -> "#features"` anchor scrolls to
  to?: string | Interp;  // route path; interpolated (e.g. `/product/{p.id}`) for dynamic navigation
  action?: string;
  arg?: Expr;
  argRest?: Expr[];  // 2nd+ args of `-> f(a, b, c)` (`arg` holds the 1st); unset for single-arg calls
  bind?: string;
  checked?: Expr;    // Checkbox checked(expr): display a bool one-way (read-only, or `-> action` to toggle) — the store-list-row alternative to bind
  submit?: string;
  // modifiers
  where?: string[];
  columns?: string[];
  columnLabels?: { [field: string]: string };   // DataTable columns(name "Nombre") — what each header says
  options?: string[];   // Select options(a, b, c) — the fixed value list of a standalone dropdown
  optionLabels?: { [value: string]: string };   // Select options(name "Nombre", price "Precio") — what each value shows
  kind?: string;        // Chart mark: bar | line | area | point
  color?: string;       // Chart color/series encoding — a field to split series by (optional)
  // geometry: x/y are SHARED — a Chart reads them as field refs (bare ref → field name); an SVG mark as
  // coordinate EXPRESSIONS (reactive). The rest are SVG-mark-only. All numeric attrs are `Expr`.
  x?: Expr; y?: Expr; w?: Expr; h?: Expr; cx?: Expr; cy?: Expr; r?: Expr; x1?: Expr; y1?: Expr; x2?: Expr; y2?: Expr; rx?: Expr;
  start?: Expr; end?: Expr; inner?: Expr;   // Arc: sweep start→end (degrees), inner radius (donut)
  viewBox?: string;              // Svg viewBox ("0 0 W H")
  d?: string | Interp;           // Path data ("M{x},{y} L…") — interpolated
  transform?: string | Interp;   // Group / mark transform
  class?: Array<string | ClassCond | ClassInterp>;   // static classes, reactive toggles (`active when isOpen`), interpolated tokens (`status-{x}`)
  inputs?: ArgMap;
  on?: ArgMap;
  aria?: { [key: string]: Expr };   // aria(label: "Close", expanded: isOpen) → aria-*/role attrs; reactive when the value reads state
  styleVars?: { [name: string]: string | Interp };   // style(w: "{pct}%") → sets CSS custom property `--w` (reactive when interpolated); CSS reads it via var(--w)
  disabled?: Expr;   // `disabled when <cond>` → reactive `el.disabled` on Button/inputs (bare `disabled` = always). A literal is set once; a state-reading cond is wrapped in an effect.
  draggable?: Expr;  // `draggable(item.id)` → el.draggable + dragstart carrying the id (HTML5 DnD); the drop target reads it
  dropGroup?: StringPropValue; // `droptarget("done")` → a drop zone; `on(drop: move)` fires move(draggedId, "done"). Interpolates: `droptarget("{row.id}")` carries the row's own id, so a list can be reordered by dropping onto a row.
  // control flow (When/Each)
  cond?: Expr;
  list?: Expr;
  as?: string;
  min?: Expr; max?: Expr; step?: Expr;  // Number/Range numeric bounds + increment (each one number expression, static or a state)
  index?: string;  // `each x as item, i` -> `i` is the item's 0-based position (a reactive number, updates on reorder)
  filter?: Expr;  // `each x as i where <cond>` -> render only matching items (avoids the each+when nesting leak)
  take?: Expr;  // `each x as i [where …] take(n)` -> render only the first n (after filtering): top-N / "first few"
}

/** A nested authoring node (before flatten); also the shape parts/shell hold. */
export interface IRNode {
  type: string;
  props?: NodeProps;
  children?: IRNode[];
  args?: ArgMap;   // unresolved part instance args: Name(arg: value)
  loc?: Loc;
  endLoc?: Loc;    // 1-based line/col one past the node's last token — its source span END, for a bidirectional editor that splices by node
  fromPart?: string;   // dev: the part this node's subtree was inlined from (DevTools component tree)
  partArgs?: { [name: string]: string };  // dev: the args the part was called with (Name(a: v)) — DevTools "props"
  // Parts are inlined at build, so a node from a part has no position in the PAGE. `loc` must stay unset for it, or a
  // diagnostic would print the page's filename against a line number from the part. These two say where it really lives:
  // which part file owns it, and where inside that file. The element picker reads them to edit the right line.
  ownerPart?: string;  // dev: the part file this node's source lives in (the innermost one, for nested parts)
  partLoc?: Loc;       // dev: the node's position inside `ownerPart`'s own file
  place?: Loc;         // the same position with the way it was reached (Loc.in): what `check` resolves to a file and a line
  strays?: Stray[];    // names this node uses that its part does not declare (ir/part-params.ts): validate says them
}

/** The nested IR the parser produces. Optional members are populated as the grammar encounters them. */
/** `get initials(name) = upper(…)`: a derived value that takes parameters, a pure function written in muten's own
 *  expression grammar (no .ts for the app's own small logic). Called like any function: `initials(user.name)`. */
export interface FnDef { params: string[]; body: Expr; loc?: Loc }

export interface IR {
  screen: string;
  entities: { [name: string]: Entity };
  state: { [name: string]: StateDef };
  actions: { [name: string]: ActionDef };
  tree: IRNode | null;
  store?: { [name: string]: StateDef };          // app-global state slice
  gets?: { [name: string]: Expr };               // .store derived/memoized values
  getLocs?: { [name: string]: Loc };             // where each get is written
  langFrom?: Expr;                               // `lang from shop.lang`: the language this page's t(…) speaks
  fns?: { [name: string]: FnDef };               // `get name(params) = expr`: gets that take parameters
  tsFns?: { [name: string]: TsFn };              // `fn name(…): T { … }`: TypeScript functions (types-fn.ts)
  timers?: Timer[];                              // `every 1m { … }`: statements on a beat (types-fn.ts)
  settles?: Settle[];                            // `settle q 350ms { … }`: once a value stops changing (types-fn.ts)
  effects?: Stmt[][];                            // .store reactive side-effects (each entry = one body)
  constraints?: { [entity: string]: EntityConstraints };
  mock?: { [name: string]: Value };              // inline test data
  sources?: { [name: string]: Value };           // real data sources (raw; plugin reads them as Source)
  api?: { [name: string]: Value };               // app-wide backend config (base URL + default headers)
  routes?: Route[];
  shell?: IRNode;
  layouts?: { [name: string]: IRNode };          // `layout pro { … slot … }` in app.muten: chrome shared by a group of routes
  defaultLayout?: string;                        // `layout site default { … }`: every route mounts in it unless it says otherwise
  parts?: { [name: string]: PartDef };
  consts?: { [name: string]: Scalar };           // compile-time immutable scalars
  theme?: { [scale: string]: ThemeScale };       // project theme (raw blocks)
  providers?: ThemeProvider[];                   // theme.muten: `provider X(…) from "pkg"`, around every component of that library
  params?: string[];                             // route params declared by the page (`param id`), injected at mount
  meta?: { [k: string]: string };                // page <head> metadata (title/description -> tags + og)
  imports?: ImportDef[];                         // `use a, b from "./lib.ts"` -> named JS functions to call
  stylesheets?: string[];                        // `use "swiper/css"` -> a package's stylesheet, in the app's CSS
}


// ── 9. Flat DOC (the canonical IR: validated, mutated, compiled) ──────────────

/** A flattened node, addressable by id. Children are referenced by id. */
export interface FlatNode {
  id: string;
  type: string;
  props: NodeProps;
  children: string[];
  loc?: Loc;
  endLoc?: Loc;   // paired with `loc`: the node's source span END (own-file nodes only, like `loc`)
  fromPart?: string;   // dev: source part (DevTools component tree)
  partArgs?: { [name: string]: string };  // dev: readable part-call args -> DevTools "props"
  ownerPart?: string;  // dev: the part file this node's source lives in (see IRNode) — the picker's real target
  partLoc?: Loc;       // dev: the node's position inside `ownerPart`'s own file
  place?: Loc;         // see IRNode
  strays?: Stray[];    // see IRNode
  args?: ArgMap;  // unresolved part instance args (live-lint path, before compose)
}

/** The canonical flat doc — the only thing validated, mutated and compiled. */
export interface Doc {
  screen: string;
  entities: { [name: string]: Entity };
  state: { [name: string]: StateDef };
  actions: { [name: string]: ActionDef };
  consts: { [name: string]: Scalar };
  constraints: { [entity: string]: EntityConstraints };
  rootId: string | undefined;
  nodes: { [id: string]: FlatNode };
  fns?: { [name: string]: FnDef };
  tsFns?: { [name: string]: TsFn };
  timers?: Timer[];
  settles?: Settle[];
  gets?: { [name: string]: Expr };
  getLocs?: { [name: string]: Loc };
  langFrom?: Expr;
  effects?: Stmt[][];
  params?: string[];   // route params declared by the page (`param id`)
  meta?: { [k: string]: string };   // page <head> metadata (title/description)
  imports?: ImportDef[];   // `use a, b from "./lib.ts"` -> named JS functions the page may call
}


// ── 10. Diagnostics ──────────────────────────────────────────────────────────

export type Severity = 'error' | 'warning' | 'info';
export interface Fix { from: string; to: string; } // deterministic replacement: swap `from` for `to` at the diagnostic's loc
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  loc: Loc | null;
  suggestion: string | null;
  fix?: Fix | null;       // exact text to replace when a suggestion exists (AI applies deterministically)
  word?: string | null;   // the text at fault, when the finding names one (with or without a fix): where `check` points
  related?: Loc | null;   // declaration loc of the referenced symbol (for navigation), when known
}
export interface ValidateResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}
/** Options for a structured diagnostic (`diag()`). */
export interface DiagOpts {
  loc?: Loc | null;
  suggestion?: string | null;
  severity?: Severity;
  from?: string | null;    // the bad token; with `suggestion` this becomes a `fix` { from, to }
  related?: Loc | null;    // declaration loc of the referenced symbol
  word?: string | null;    // the text at fault when there is no `from` (defaults to `from`)
}


// ── 11. Compile options & context: types-compile.ts (re-exported below) ──────────

// ── 12-14. Tooling, runtime and build shapes: types-tooling.ts (re-exported below) ──

export * from '#engine/shared/types-compile.js';
export * from '#engine/shared/types-theme.js';
export * from '#engine/shared/types-tooling.js';
