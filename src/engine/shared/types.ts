// types: core domain contracts for the engine compile pipeline (parse -> flatten -> validate ->
// compose -> compile). Consumed by every stage. Strict and honest: no `any`, no `unknown`,
// no `as`, no phantom Record. Open-keyed maps use index signatures with real value types.
// String/keyword/operator constants live in vocab.ts.

import type { Tk, BOp, UOp, Ek, StOp, Fmt, Fk } from '#engine/shared/vocab.js';


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
  | 'text' | 'text?' | 'state' | 'action' | 'action?' | 'expr' | 'expr?'
  | 'fields' | 'route' | 'name' | 'map?' | 'clauses?' | 'ident';

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
}


// ── 3. Tokenizer ─────────────────────────────────────────────────────────────

/** A token stores `pos` = its start index in the source (line/col resolved on demand). */
export interface Token {
  t: Tk;
  v: string;   // raw text value (numbers are kept as their source text)
  pos: number;
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
export interface CallExpr { kind: Ek.Call; fn: string; args: Expr[]; }
export interface ObjExpr { kind: Ek.Obj; fields: Array<{ key: string; value: Expr }>; } // inline object literal, e.g. `{ title: @draft.title, qty: 1 }`
export interface AggExpr { kind: Ek.Agg; op: string; list: string; body: Expr; } // e.g. `lines.sum by price * qty` (item-implicit: fields read bare off the row)
export interface FilterExpr { kind: Ek.Filter; list: string; cond: Expr; } // derived list, e.g. `tasks where status == "todo"` (item-implicit)
export type Expr = LitExpr | RefExpr | UnExpr | BinExpr | TernExpr | CallExpr | ObjExpr | AggExpr | FilterExpr;

/** A `use a, b from "./lib.ts"` — named JS functions muten may call. The seam to the JS ecosystem. */
export interface ImportDef { names: string[]; from: string; }

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
export type StringPropName = 'value' | 'label' | 'src' | 'alt' | 'name' | 'placeholder' | 'submitLabel';


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
/** Explicit non-REST request (escape hatch): `post "shop:/orders" body item`, `delete "shop:/x/{id}"`. */
export interface RequestStmt { op: StOp.Request; method: string; url: string | Interp; body: Expr | null; into?: string; } // `into <state>` captures the JSON response (order id / confirmation code)
export interface CallStmt { op: StOp.Call; target: string; method: string; args: Expr[]; } // page action calling a store action, e.g. `shop.addProduct(draft)`
/** Calling a `use`'d function as a side-effect statement: `persist(messages)`, `scrollBottom()`. Bounded: the fn is declared + checked. */
export interface ExternStmt { op: StOp.Extern; fn: string; args: Expr[]; }
export interface IfStmt { op: StOp.If; cond: Expr; then: Stmt[]; else: Stmt[] | null; }
export type Stmt = (PushStmt | SetStmt | ResetStmt | ToggleStmt | RemoveStmt | PatchStmt | CreateStmt | UpdateStmt | DeleteStmt | RefetchStmt | RequestStmt | CallStmt | ExternStmt | IfStmt) & { loc?: Loc };


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

/** Per-field validation pulled from the entity schema (`email email required`, `min:8`). */
export interface FieldConstraint {
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;   // `pattern:"<regex>"` — a non-empty value must match this regular expression (phone/zip/SKU/…)
}
/** field name → its constraints. */
export interface EntityConstraints { [field: string]: FieldConstraint; }


// ── 7. Declared values: state, store, get, actions, parts, routes, theme ──────

/** A reactive state (page-local `state {}` or app-global `store {}`). */
export interface StateDef {
  type: string;       // declared type tag: scalar, list<X>, or an entity name
  source?: string;    // "query:<name>" for async query-backed state
  refresh?: number;   // parked: `query x every Ns` (polling rejected, kept so it still parses)
  live?: boolean;     // `query x live` -> a WebSocket subscription (server pushes); socket closes via onCleanup
  initial?: Value;    // declared initial literal (when not query-backed)
  persist?: boolean;  // `state { x = … : T persist }` — auto load/save to localStorage (survives reload)
  loc?: Loc;
}

/** A quoted literal passed as a part/Custom arg. Kept distinct from a bare ref string so compose
 *  substitutes "Send" as text, not as a dangling reference to a variable named Send. */
export interface LitRef { $lit: string; }
/** The value of a part-instance arg: a quoted literal, a bare ref string, a number, or a $param. */
export type ArgValue = string | number | ParamRef | LitRef;
/** key → arg value, for part instances and Custom inputs/on. */
export interface ArgMap { [key: string]: ArgValue; }

/** A part definition: its params + the (single-root) tree it expands to. */
export interface PartParam { name: string; type: string; }
export interface PartDef {
  params: PartParam[];
  tree: IRNode;
  // hoisted by the loader/analyzer so a part's @refs validate against its own data:
  state?: { [name: string]: StateDef };
  entities?: { [name: string]: Entity };
  mock?: { [name: string]: Value };
  css?: string;
}

/** A declared action: which state it may mutate, its input name, and its body.
 *  `params` is the multi-param form `action f(a: T, b: T)`; `input` is the legacy `<- v` form. */
export interface ActionDef {
  mutates: string[];
  input: string;
  params?: PartParam[];
  body: Stmt[];
}

/** One route line: `routes { /url -> page [guard [not] store.flag else /path] }`. */
export interface Route {
  url: string;
  page: string;
  loc?: Loc;
  guardNeg?: boolean;
  guard?: string;
  redirect?: string;
}

/** A theme scale: step name (md/lg/…) → its CSS value ("16px", "1.5", "768px"). */
export interface ThemeScale { [step: string]: string; }
/** The theme.muten file as parsed: section name (space/colors/radius/…) → its scale. Open set:
 *  parseTheme reads any `<section> { <step> "value" }`, so colors/radius come for free. */
export type ThemeRaw = { [section: string]: ThemeScale };

/** A theme ADAPTER: pure DATA describing how to render theme.muten's values for ANY styling backend.
 *  The engine has zero per-library logic — a new library is just a new adapter (no engine change). */
export interface ThemeBlock {
  open: string;                       // block opener — `:root {` by default, or whatever wrapper a styling plugin supplies
  close: string;                      // usually `}`
  attrs?: { [key: string]: string };  // literal lines inside (e.g. name/default); value `$scheme` -> theme.scheme.mode
  sections: string[];                 // which theme.muten sections render in this block
}
export interface ThemeAdapter {
  prefix: { [section: string]: string };  // section -> CSS var prefix (colors -> `--color-`); fallback `--<section>-`
  blocks: ThemeBlock[];
}


// ── 8. Nested IR (parser output) ─────────────────────────────────────────────

/** A `class()` entry: a plain look class, or one toggled reactively (`active when isOpen`). */
export interface ClassCond { name: string; cond: Expr; }
export interface ClassInterp { interp: Interp; }   // `class("status-{x}")` — a class token whose value interpolates state, applied reactively (swap on change)

/** A node's props: a named bag of authoring options (no catch-all — every field is declared). */
export interface NodeProps {
  // positional / textual
  value?: StringPropValue;
  label?: StringPropValue;
  src?: StringPropValue;
  alt?: StringPropValue;
  name?: StringPropValue;   // Icon "set:name" (a static Iconify ref)
  flags?: string[];         // Video boolean attrs: controls / autoplay / loop / muted / playsinline
  placeholder?: StringPropValue;
  submitLabel?: StringPropValue;
  // structure & wiring
  level?: Level;
  component?: string;
  data?: string;
  to?: string | Interp;  // route path; interpolated (e.g. `/product/{p.id}`) for dynamic navigation
  action?: string;
  arg?: Expr;
  argRest?: Expr[];  // 2nd+ args of `-> f(a, b, c)` (`arg` holds the 1st); unset for single-arg calls
  bind?: string;
  submit?: string;
  // modifiers
  where?: string[];
  columns?: string[];
  class?: Array<string | ClassCond | ClassInterp>;   // static classes, reactive toggles (`active when isOpen`), interpolated tokens (`status-{x}`)
  inputs?: ArgMap;
  on?: ArgMap;
  aria?: { [key: string]: Expr };   // aria(label: "Close", expanded: isOpen) → aria-*/role attrs; reactive when the value reads state
  styleVars?: { [name: string]: string | Interp };   // style(w: "{pct}%") → sets CSS custom property `--w` (reactive when interpolated); CSS reads it via var(--w)
  // control flow (When/Each)
  cond?: Expr;
  list?: Expr;
  as?: string;
  filter?: Expr;  // `each x as i where <cond>` -> render only matching items (avoids the each+when nesting leak)
}

/** A nested authoring node (before flatten); also the shape parts/shell hold. */
export interface IRNode {
  type: string;
  props?: NodeProps;
  children?: IRNode[];
  args?: ArgMap;   // unresolved part instance args: Name(arg: value)
  loc?: Loc;
}

/** The nested IR the parser produces. Optional members are populated as the grammar encounters them. */
export interface IR {
  screen: string;
  entities: { [name: string]: Entity };
  state: { [name: string]: StateDef };
  actions: { [name: string]: ActionDef };
  tree: IRNode | null;
  store?: { [name: string]: StateDef };          // app-global state slice
  gets?: { [name: string]: Expr };               // .store derived/memoized values
  effects?: Stmt[][];                            // .store reactive side-effects (each entry = one body)
  constraints?: { [entity: string]: EntityConstraints };
  mock?: { [name: string]: Value };              // inline test data
  sources?: { [name: string]: Value };           // real data sources (raw; plugin reads them as Source)
  api?: { [name: string]: Value };               // app-wide backend config (base URL + default headers)
  routes?: Route[];
  shell?: IRNode;
  parts?: { [name: string]: PartDef };
  consts?: { [name: string]: Scalar };           // compile-time immutable scalars
  theme?: { [scale: string]: ThemeScale };       // project theme (raw blocks)
  params?: string[];                             // route params declared by the page (`param id`), injected at mount
  meta?: { [k: string]: string };                // page <head> metadata (title/description -> tags + og)
  imports?: ImportDef[];                         // `use a, b from "./lib.ts"` -> named JS functions to call
}


// ── 9. Flat DOC (the canonical IR: validated, mutated, compiled) ──────────────

/** A flattened node, addressable by id. Children are referenced by id. */
export interface FlatNode {
  id: string;
  type: string;
  props: NodeProps;
  children: string[];
  loc?: Loc;
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
  gets?: { [name: string]: Expr };
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
}


// ── 11. Compile options & context ────────────────────────────────────────────

/** App-global store slice, by domain: which members are state / gets / actions. */
export interface StoreSlice {
  state?: string[];
  gets?: string[];
  actions?: string[];
}

export interface CompileOpts {
  format?: Fmt;
  stores?: { [domain: string]: StoreSlice };
  storeCode?: string;                // standalone build only: `.store` slices inlined (CLI SSG has no virtual modules -> `muten build` bakes them into the page)
  api?: { [name: string]: Value };   // app-wide backend config (base + default headers) applied to `sources`
  iconResolver?: (ref: string) => string;  // `Icon "set:name"` -> inline SVG, resolved at build (Iconify). Provided by the vite plugin; absent in unit/SSG -> Icon renders empty.
  storeEntities?: { [domainDotMember: string]: Entity };  // element entity of each store list, so a page aggregate over a store list emits the right item fields
  persistScope?: string;            // namespaces `persist` keys (a store's domain / a page's screen) so two scopes' same-named state don't share one localStorage key
  classes?: { [slot: string]: string };  // styling-plugin class map: a primitive's internal parts (Form's input/label/submit/…) emit these instead of the default `mu-*` — so a library (DaisyUI) restyles the auto-generated bits with NO bridge CSS, while the engine stays agnostic (ships only the `mu-*` defaults)
  sourceMap?: { file: string; source: string };  // emit an inline source map (compiled JS -> this .muten file), so runtime errors map back to the source line
  ctxRefs?: boolean;     // Fmt.Patch: refs go through the live `ctx` (HMR patch builder rebuilds a node against the SAME signals)
  patchRoot?: string;    // Fmt.Patch: the node id whose subtree to emit as a `(ctx, nodes, parent) => el` builder
  dev?: boolean;         // dev server only: emit the HMR node registry + `el.__muten` handle (omitted in prod bundles — dead there)
}

/** One screen's resolved compile context shared by compile.ts (DOM) and logic.ts.
 *  `usedStores` is mutable: refs/actions add the domains they touch; compile.ts emits an import for each. */
export interface CompileCtx {
  state: { [name: string]: StateDef };
  entities: { [name: string]: Entity };
  actions: { [name: string]: ActionDef };
  consts: { [name: string]: Scalar };
  gets: { [name: string]: Expr };
  effects: Stmt[][];
  stateKeys: Set<string>;     // all local state names (for `.get()` resolution)
  queryStates: Set<string>;   // states backed by a query (expose { data, loading, error } signals)
  stores: { [domain: string]: StoreSlice };
  usedStores: Set<string>;    // store domains actually referenced (-> import list)
  params: Set<string>;        // route params (`param id`) -> local string injected at mount
  storeEntities?: { [domainDotMember: string]: Entity };  // element entity of each store list, so a cross-store aggregate emits __it.<field>
  persistScope: string;             // namespace for `persist` localStorage keys (store domain / page screen)
  format?: Fmt;
  ctxRefs?: boolean;                // HMR patch builders: read state/actions/gets/params via the live `ctx` object
}

/** An editable Form field derived from an entity (excludes the auto uuid id). */
export interface EnumField { name: string; kind: Fk.Enum; options: string[]; }
export interface SimpleField { name: string; kind: Fk.Text | Fk.Email | Fk.Number | Fk.Bool | Fk.Date | Fk.Password | Fk.Textarea; }
export type EditableField = EnumField | SimpleField;

/** Input to compileStore(): one .store domain slice (state + get + actions + effects + entities). */
export interface StoreInput {
  state?: { [name: string]: StateDef };
  gets?: { [name: string]: Expr };
  actions?: { [name: string]: ActionDef };
  effects?: Stmt[][];
  entities?: { [name: string]: Entity };
  imports?: ImportDef[];                          // `use fmt from "./lib.ts"` -> without this, use'd calls in a store have no import (ReferenceError)
  domain?: string;                                // the store's domain (filename) -> namespaces its `persist` localStorage keys so two stores' same-named state don't collide
}

/** The pre-computed pieces an emit target assembles into the final output (HTML/module/store). */
export interface EmitParts {
  screen: string;
  projectCss: string;
  data: { [name: string]: Value };
  sources: { [name: string]: Value };
  api: { [name: string]: Value };
  meta: { [k: string]: string };
  queryUuids: { [query: string]: string[] };
  stateDecls: string;
  paramDecls: string;
  actionDecls: string;
  getDecls: string;
  effectDecls: string;
  componentDecls: string;
  storeImports: string;
  storeDecls: string;      // standalone HTML/SSR only: `.store` slices inlined as `const __store_X = (...)()`
  externImports: string;   // `import { fmt } from "./lib.ts"` for each `use` declaration
  renderBody: string;
  staticHtml: string;
  hasSlot: boolean;
  ctxNames: string[];      // state/action/get/param names exposed as `el.__muten.ctx` for surgical HMR (dev only)
  dev: boolean;            // dev build: emit the HMR node registry + `el.__muten` stash (off in prod bundles)
}

/** The kind of file being analyzed (drives which top-level blocks are allowed). */
export type FileKind = 'page' | 'store' | 'app' | 'part' | 'theme';

/** validate()'s project-aware context. */
/** One invalid token found in a `class()`, with the closest valid class (null if none is near). */
export interface ClassIssue { cls: string; suggestion: string | null; }
/** Validates class() names. Provided by a styling PLUGIN (a library knows how to check its own classes);
 *  the engine ships none. `available` is false when no plugin is connected -> class() is left unchecked. */
export interface ClassValidator { available: boolean; check(classString: string): ClassIssue[]; }

export interface ValidateCtx {
  parts?: string[];
  stores?: string[];
  storeMembers?: { [domain: string]: string[] };  // each store's members (state + gets + actions) -> catch typos like `cart.kount`
  kind?: FileKind;
  classValidator?: ClassValidator;                // when set, class() names are validated against the framework's theme
  apiClients?: string[];                           // named api clients (from app.muten `api {}`); a `post "client:/x"` prefix is checked against these. undefined -> not threaded, skip the check
  iconExists?: (ref: string) => string | null;     // `Icon "set:name"` existence check (reads the set's icons.json). null -> ok; a string -> the error. undefined -> not threaded (skip)
  storeSelfMut?: Set<string>;                       // "domain.action" of store actions that update a signal from its own value -> an `effect { domain.action() }` loops forever
  storeEntities?: { [domainDotMember: string]: Entity };  // element entity of each store list ("orders.items" -> Order fields), so a page can aggregate over a store list (`orders.items.count where …`)
}

/** A lexical scope while compiling expressions: lambda locals + the action input. */
export interface Scope {
  locals: Set<string>;
  sigLocals?: Set<string>;   // keyed-each row vars backed by a per-row signal -> refs compile to `<v>.get()` so bindings stay live
  input?: string;
  inputIsState?: boolean;
  item?: { var: string; fields: Set<string> };  // `<list> where <cond>` filter: bare field refs resolve to `<var>.<field>` (item-implicit)
}


// ── 12. Tooling / IO shapes ──────────────────────────────────────────────────

/** One resolved route from app.muten: route slug, page name, and its screen file path. */
export interface RouteEntry {
  route: string;
  page: string;
  screenPath: string;
}

/** The project stylesheet resolved for a screen (CSS text + the file it came from). */
export interface ResolvedStyles {
  css: string;
  from: string | null;
}

/** Everything load() produces from a .muten page: ready to compile. */
export interface LoadResult {
  ir: IR;
  doc: Doc;
  data: { [name: string]: Value };
  sources: { [name: string]: Value };
  styles: ResolvedStyles;
  partNames: string[];
}

/** Autocomplete context for one file, aware of the whole app. */
export interface CompletionState { name: string; type: string; query: boolean; }
export interface CompletionPart { name: string; params: PartParam[]; }
export interface CompletionResult {
  parts: CompletionPart[];
  state: CompletionState[];
  actions: string[];
  primitives: string[];
}

// ── 13. Runtime shapes (the browser side) ────────────────────────────────────

/** A reactive cell: read tracks the current effect, write notifies subscribers. */
export interface Signal<T> { get(): T; set(next: T): void; }
/** An effect's run function, carrying its current dependency set + a disposed flag. */
export interface EffectRun { (): void; deps: Set<Set<EffectRun>>; disposed: boolean; sync?: boolean; }
/** One mounted node, addressable by id for surgical HMR: its element and the parent it lives under (so a patch
 *  can rebuild + swap it in place). `dispose` is set only by a prior patch — the initial mount's per-node effects
 *  live in the page scope (cleaned on navigation), so a first patch just leaves them on the detached old node. */
export interface MountedNode { el: Element; parent: Element; dispose?: () => void; }
export type NodeRegistry = { [id: string]: MountedNode };
/** The live HMR handle stashed on a mounted page's root element (`el.__muten`): the reactive context (state/
 *  actions as addressable data, so a patch can rebuild a node against the SAME signals) + the node registry. */
export interface PageInstance { el: Element; ctx: { [name: string]: unknown }; nodes: NodeRegistry; }
/** A compiled page/shell module: its scoped CSS + a mount() that builds it into a root element (returning it). */
export interface PageModule { css: string; mount(root: Element, params?: { [key: string]: string }): Element; meta?: { [key: string]: string }; screen?: string; }
/** One route's lazy loader + optional guard/redirect (the hash router consumes a map of these). */
export interface RouteDef { load(): Promise<PageModule>; guard?: () => boolean; redirect?: string; }

// ── 14. Build / plugin shapes ────────────────────────────────────────────────

/** Options for the Vite plugin: store auto-detection on/off + an optional inline theme. */
/** A muten STYLING PLUGIN, connected via `muten({ styling })` — the seam for library-specific behavior.
 *  The engine ships NONE and expects no library; a plugin provides how to emit the theme (a ThemeAdapter,
 *  data) and optionally how to validate class() (e.g. via that library's own tooling). */
export type ClassValidatorLoader = (cssPath: string, base: string, themeRaw: ThemeRaw) => Promise<ClassValidator>;
export interface StylingPlugin { theme?: ThemeAdapter; validate?: ClassValidatorLoader; classes?: { [slot: string]: string }; }
export interface MutenOptions { store?: boolean; theme?: { [scale: string]: ThemeScale }; styling?: StylingPlugin; }

/** The app graph the build emits to app.map.json (+ serves live at /_muten/graph): the root the AI reads. */
export interface AppMap {
  app: string;
  parts: string[];
  stores: { [domain: string]: StoreSlice };
  routes: { [url: string]: { file: string; models: string[]; state: { [name: string]: Value }; sources: { [name: string]: string } } };
}

/** Ambient shape for the OPTIONAL `sass` dependency — only imported when a .scss exists. */
declare module 'sass' {
  export function compile(path: string): { css: string };
}
