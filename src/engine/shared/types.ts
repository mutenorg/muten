// ============================================================================
// Muten engine — core domain types
// ============================================================================
// The contracts every stage passes around: parse → flatten → validate → compose
// → compile. Inferred from the engine code and the original JS in _engine_bak.
//
// House rule (strict & honest): NO `any`, NO `unknown`, NO `as`, NO phantom
// `Record<string, string>`. Every shape is named. Open-keyed maps (user-chosen
// names → a definition) use an index signature whose VALUE is a real type.
// String/keyword/operator constants live in vocab.ts (no magic strings).
// ============================================================================

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
  | 'text' | 'text?' | 'tokens?' | 'state' | 'action' | 'action?' | 'expr' | 'expr?'
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

/** Every lexeme kind the tokenizer emits. */
/** A token stores `pos` = its start index in the source (→ line/col on demand). */
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
// The shared expression grammar: conditions, arithmetic, ternaries, interpolation.

export interface LitExpr { kind: Ek.Lit; value: Scalar; }
export interface RefExpr { kind: Ek.Ref; name: string; }
export interface UnExpr { kind: Ek.Un; op: UOp; operand: Expr; }
export interface BinExpr { kind: Ek.Bin; op: BOp; left: Expr; right: Expr; }
export interface TernExpr { kind: Ek.Tern; cond: Expr; then: Expr; else: Expr; }
export type Expr = LitExpr | RefExpr | UnExpr | BinExpr | TernExpr;

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
export type StringPropName = 'value' | 'label' | 'src' | 'alt' | 'placeholder' | 'submitLabel';


// ── 5. Action / effect statements ────────────────────────────────────────────
// A mutation in an action body (or a `.store` effect), as a discriminated union.

export interface PushStmt { op: StOp.Push; target: string; arg: Expr; }
export interface SetStmt { op: StOp.Set; target: string; arg: Expr; }
export interface ResetStmt { op: StOp.Reset; target: string; }
export interface RemoveStmt { op: StOp.Remove; target: string; param: string; pred: Expr; }
/** Server CRUD on a source-backed list: POST/PUT/DELETE the item, then reflect the result in the list. */
export interface CreateStmt { op: StOp.Create; target: string; arg: Expr; }
export interface UpdateStmt { op: StOp.Update; target: string; arg: Expr; }
export interface DeleteStmt { op: StOp.Delete; target: string; arg: Expr; }
/** Re-run a query with N query-string params (pagination / search / filters): `products.refetch(q: x, page: n)`. */
export interface RefetchStmt { op: StOp.Refetch; target: string; params: { [k: string]: Expr }; }
/** Explicit non-REST request (escape hatch): `post "shop:/orders" body item`, `delete "shop:/x/{id}"`. */
export interface RequestStmt { op: StOp.Request; method: string; url: string | Interp; body: Expr | null; }
export interface IfStmt { op: StOp.If; cond: Expr; then: Stmt[]; else: Stmt[] | null; }
export type Stmt = PushStmt | SetStmt | ResetStmt | RemoveStmt | CreateStmt | UpdateStmt | DeleteStmt | RefetchStmt | RequestStmt | IfStmt;


// ── 6. Entities & validation schema ──────────────────────────────────────────

/** The serialized field-type tag the parser stores. */
export type EnumType = `enum:${string}`;
export type ListType = `list<${string}>`;
// known scalar tags + enum/list encodings; `(string & {})` also admits an entity-name field
// type (e.g. `author User`) while keeping the known tags as autocomplete hints — still honest
// (the stored value genuinely is a string), never `any`/`unknown`.
export type FieldType = 'uuid' | 'string' | 'number' | 'bool' | 'email' | EnumType | ListType | (string & {});

// heading level for Title (structure, not style).
export type Level = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/** An entity: field name → its type tag (always carries an implicit `id: 'uuid'`). */
export interface Entity { [field: string]: FieldType; }

/** Per-field validation pulled from the entity schema (`email email required`, `min:8`). */
export interface FieldConstraint {
  required?: boolean;
  min?: number;
  max?: number;
}
/** field name → its constraints. */
export interface EntityConstraints { [field: string]: FieldConstraint; }


// ── 7. Declared values: state, store, get, actions, parts, routes, theme ──────

/** A reactive state (page-local `state {}` or app-global `store {}`). */
export interface StateDef {
  type: string;       // declared type tag: scalar | list<X> | an entity name
  source?: string;    // "query:<name>" for async query-backed state
  initial?: Value;    // declared initial literal (when not query-backed)
  loc?: Loc;
}

/** The value of a part-instance arg: a literal/ref string, a number, or a $param. */
export type ArgValue = string | number | ParamRef;
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

/** A declared action: which state it may mutate, its input name, and its body. */
export interface ActionDef {
  mutates: string[];
  input: string;
  body: Stmt[];
}

/** One route line from `routes { /url -> page [guard [not] store.flag else /path] }`. */
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
export interface Theme {
  space: ThemeScale;
  font: ThemeScale;
  weight: ThemeScale;
  leading: ThemeScale;
  breakpoints: ThemeScale;
}
/** A token family resolver: (modifier, theme) → CSS declarations, or null if unresolved. */
export type FamilyFn = (m: string, t: Theme) => string | null;


// ── 8. Nested IR (parser output) ─────────────────────────────────────────────

/** A `class()` entry: a plain look class, or one toggled reactively (`active when isOpen`). */
export interface ClassCond { name: string; cond: Expr; }

/** A node's props: a named bag of authoring options (no catch-all — every field is declared). */
export interface NodeProps {
  // positional / textual
  value?: StringPropValue;
  label?: StringPropValue;
  src?: StringPropValue;
  alt?: StringPropValue;
  placeholder?: StringPropValue;
  submitLabel?: StringPropValue;
  // structure & wiring
  level?: Level;
  component?: string;
  data?: string;
  to?: string | Interp;  // a route path; interpolated (`/product/{p.id}`) for dynamic navigation
  action?: string;
  arg?: Expr;
  bind?: string;
  submit?: string;
  // modifiers
  where?: string[];
  columns?: string[];
  style?: string[];
  class?: Array<string | ClassCond>;   // static look classes + reactive toggles (`active when isOpen`)
  inputs?: ArgMap;
  on?: ArgMap;
  // control flow (When/Each)
  cond?: Expr;
  list?: Expr;
  as?: string;
}

/** A nested authoring node (before flatten); also the shape parts/shell hold. */
export interface IRNode {
  type: string;
  props?: NodeProps;
  children?: IRNode[];
  args?: ArgMap;   // unresolved part instance: Name(arg: value)
  loc?: Loc;
}

/** The nested IR the parser produces. Optional members are added as the grammar meets them. */
export interface IR {
  screen: string;
  entities: { [name: string]: Entity };
  state: { [name: string]: StateDef };
  actions: { [name: string]: ActionDef };
  tree: IRNode | null;
  store?: { [name: string]: StateDef };          // app-global state slice
  gets?: { [name: string]: Expr };               // .store derived/memoized values
  effects?: Stmt[][];                            // .store reactive side-effects (each = a body)
  constraints?: { [entity: string]: EntityConstraints };
  mock?: { [name: string]: Value };              // inline test data
  sources?: { [name: string]: Value };           // real data sources (raw; the plugin reads them as Source)
  api?: { [name: string]: Value };               // app-wide backend config (base URL + default headers)
  routes?: Route[];
  shell?: IRNode;
  parts?: { [name: string]: PartDef };
  consts?: { [name: string]: Scalar };           // compile-time immutable scalars
  theme?: { [scale: string]: ThemeScale };       // project theme (raw blocks)
  params?: string[];                             // route params a page declares (`param id`), injected at mount
  meta?: { [k: string]: string };                // page <head> metadata (title/description → tags + og)
}


// ── 9. Flat DOC (the canonical IR: validated, mutated, compiled) ──────────────

/** A flattened node, addressable by id. Children are referenced by id. */
export interface FlatNode {
  id: string;
  type: string;
  props: NodeProps;
  children: string[];
  loc?: Loc;
  args?: ArgMap;  // unresolved part instance (live-lint without compose)
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
}


// ── 10. Diagnostics ──────────────────────────────────────────────────────────

export type Severity = 'error' | 'warning' | 'info';
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  loc: Loc | null;
  suggestion: string | null;
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
  theme?: Theme;
  stores?: { [domain: string]: StoreSlice };
  api?: { [name: string]: Value };   // app-wide backend config (base + default headers) applied to `sources`
}

/** One screen's resolved compile context — the shared state the DOM half (compile.ts) and the
 *  logic half (logic.ts) both read. `usedStores` is mutable: refs/actions add the domains they
 *  touch, and compile.ts emits an import for each. */
export interface CompileCtx {
  state: { [name: string]: StateDef };
  entities: { [name: string]: Entity };
  actions: { [name: string]: ActionDef };
  consts: { [name: string]: Scalar };
  gets: { [name: string]: Expr };
  effects: Stmt[][];
  stateKeys: Set<string>;     // names of all local states (for `.get()` resolution)
  queryStates: Set<string>;   // states backed by a query (rich { data, loading, error } signals)
  stores: { [domain: string]: StoreSlice };
  usedStores: Set<string>;    // store domains actually referenced (→ import list)
  params: Set<string>;        // route params (`param id`) — resolve to a local string injected at mount
  format?: Fmt;
}

/** An editable Form field derived from an entity (excludes the auto uuid id). */
export interface EnumField { name: string; kind: Fk.Enum; options: string[]; }
export interface SimpleField { name: string; kind: Fk.Text | Fk.Email; }
export type EditableField = EnumField | SimpleField;

/** Input to compileStore(): one .store domain slice (state + get + actions + effects + entities). */
export interface StoreInput {
  state?: { [name: string]: StateDef };
  gets?: { [name: string]: Expr };
  actions?: { [name: string]: ActionDef };
  effects?: Stmt[][];
  entities?: { [name: string]: Entity };
}

/** The pre-computed pieces an emit target assembles into the final output (HTML/module/store). */
export interface EmitParts {
  screen: string;
  tokenCss: string;
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
  renderBody: string;
  staticHtml: string;
  hasSlot: boolean;
}

/** The kind of file being analyzed (drives which top-level blocks are allowed). */
export type FileKind = 'page' | 'store' | 'app' | 'part' | 'theme';

/** validate()'s project-aware context. */
export interface ValidateCtx {
  parts?: string[];
  stores?: string[];
  theme?: Theme;
  kind?: FileKind;
}

/** A lexical scope while compiling expressions: lambda locals + the action input. */
export interface Scope {
  locals: Set<string>;
  input?: string;
  inputIsState?: boolean;
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
  theme: Theme;
}

// ── 13. Runtime shapes (the browser side) ────────────────────────────────────

/** A reactive cell: read tracks the current effect, write notifies subscribers. */
export interface Signal<T> { get(): T; set(next: T): void; }
/** An effect's run function, carrying its current dependency set + a disposed flag. */
export interface EffectRun { (): void; deps: Set<Set<EffectRun>>; disposed: boolean; }
/** A compiled page/shell module: its scoped CSS + a mount() that builds it into a root element. */
export interface PageModule { css: string; mount(root: Element, params?: { [key: string]: string }): Element; meta?: { [key: string]: string }; }
/** One route's lazy loader + optional guard/redirect (the hash router consumes a map of these). */
export interface RouteDef { load(): Promise<PageModule>; guard?: () => boolean; redirect?: string; }

// ── 14. Build / plugin shapes ────────────────────────────────────────────────

/** Options for the Vite plugin: store auto-detection on/off + an optional inline theme. */
export interface MutenOptions { store?: boolean; theme?: { [scale: string]: ThemeScale }; }

/** The generated app graph build emits to app.map.json — "the root the AI reads". */
export interface AppMap {
  app: string;
  parts: string[];
  routes: { [url: string]: { file: string; models: string[]; state: { [name: string]: Value }; sources: { [name: string]: string } } };
}

/** Ambient shape for the OPTIONAL `sass` dependency — only imported when a .scss exists. */
declare module 'sass' {
  export function compile(path: string): { css: string };
}
