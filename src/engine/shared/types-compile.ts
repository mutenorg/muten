// types-compile: the shapes of compiling a page: options, the compile context shared by compile.ts and logic.ts,
// what each generator (fields, svg, tables, form, static, custom) and each check (validate-nodes, validate-actions,
// calls) reads. Part of types.ts, which re-exports it: import from types.ts.
import type { Fmt, Fk } from '#engine/shared/vocab.js';
import type { Logic } from '#engine/compile/logic.js';
import type { ActionDef, Diagnostic, Doc, Entity, EntityConstraints, Expr, FlatNode, FnDef, ImportDef, Interp, Loc, NodeProps, RequestStmt, Scalar, StateDef, Stmt, StringPropValue, Value, Translations, ThemeRaw, ThemeKit } from '#engine/shared/types.js';
import type { CssSheet, NativeReport } from '#engine/shared/types-native.js';

/** App-global store slice, by domain: which members are state / gets / actions. */
export interface StoreSlice {
  state?: string[];
  gets?: string[];
  actions?: string[];
  queries?: string[];   // subset of state backed by a `query` (holds { data, loading, error }) — a bare ref unwraps to .data
  fns?: string[];       // its `get name(…)` functions — a page calls them `domain.name(x)`
}

export interface CompileOpts {
  format?: Fmt;
  native?: { sheet: CssSheet; report: NativeReport };   // Fmt.Native: the app's CSS in, what translated and what did not out (engine/native/)
  stores?: { [domain: string]: StoreSlice };
  routeGuard?: { check: string; redirect: string };   // standalone build only: the route's guard as JS — the page checks it before it renders (never the zero-JS path)
  translations?: Translations;       // the app's texts (src/lang/*.lang): a page's t(…) table is cut from these
  themeValues?: ThemeRaw;            // theme.muten, read by `theme.colors.primary` (style/theme-ref.ts)
  themeKit?: ThemeKit;               // theme.muten's providers, around every React component of their library (react-tree.ts)
  storeCode?: string;                // standalone build only: `.store` slices inlined (CLI SSG has no virtual modules -> `muten build` bakes them into the page)
  api?: { [name: string]: Value };   // app-wide backend config (base + default headers) applied to `sources`
  iconResolver?: (ref: string) => string;  // `Icon "set:name"` -> inline SVG, resolved at build (Iconify). Provided by the runner; absent in unit/SSG -> Icon renders empty.
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
  ownCalls: Set<string>;
  fns: { [name: string]: FnDef };   // this file's `get name(…)`
  foreign: Set<string>;             // names that hold something from npm: their methods and chains compile as written
  useCalls: Set<string>;            // the functions this file `use`s (not components): they may return a promise
  translations?: Translations;       // the app's src/lang/*.lang: t(…) and `lang` speak them
  themeValues?: ThemeRaw;            // theme.muten: `theme.colors.primary` is its value, fixed at build
  langFrom?: Expr;                  // `lang from …`: the language this page speaks
  tKeys: Set<string>;               // the text keys this file uses (its table carries only those)
  tPatterns: RegExp[];              // keys built at run time (`t("post.{id}.fee")`): every key that fits comes along
  calls: { [fn: string]: string };  // what each `use`'d function says it returns            // what this file calls by its own name (its `get name(…)`, its `use`'d functions): those win over a built-in
  persistScope: string;             // namespace for `persist` localStorage keys (store domain / page screen)
  format?: Fmt;
  ctxRefs?: boolean;                // HMR patch builders: read state/actions/gets/params via the live `ctx` object
  dev?: boolean;                    // dev builds: actions announce themselves to the DevTools (window.__muten_rt.__dispatch)
}

/** An editable Form field derived from an entity (excludes the auto uuid id). */
export interface EnumField { name: string; kind: Fk.Enum; options: string[]; }
export interface SimpleField { name: string; kind: Fk.Text | Fk.Email | Fk.Number | Fk.Bool | Fk.Date | Fk.Password | Fk.Textarea; }
export type EditableField = EnumField | SimpleField;

/** Input to compileStore(): one .store domain slice (state + get + actions + effects + entities). */
export interface StoreInput {
  state?: { [name: string]: StateDef };
  fns?: { [name: string]: FnDef };
  gets?: { [name: string]: Expr };
  actions?: { [name: string]: ActionDef };
  effects?: Stmt[][];
  entities?: { [name: string]: Entity };
  translations?: Translations;
  themeValues?: ThemeRaw;
  imports?: ImportDef[];                          // `use fmt from "./lib.ts"` -> without this, use'd calls in a store have no import (ReferenceError)
  domain?: string;                                // the store's domain (filename) -> namespaces its `persist` localStorage keys so two stores' same-named state don't collide
  dev?: boolean;                                  // dev build: self-register the store on window.__muten_stores for the DevTools
  api?: { [name: string]: Value };                // app-wide backend config (base URL + default headers) so a store's sources/`post` resolve relative URLs, same as a page
  stores?: { [domain: string]: StoreSlice };      // the OTHER stores, so `ui.lang` / `ui.setLang()` inside this store resolve to their imports
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
  storeDomain?: string;    // for a .store module: its domain, so dev can self-register it on window.__muten_stores
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
  storeFns?: { [domain: string]: { [name: string]: string[] } };  // each store's `get name(params)`, by name -> its params: `format.money(x)` is checked for existence and arity
  storeActions?: { [domain: string]: string[] };  // which of them are actions -> `cart.add.done` is flagged (an action exposes .pending / .error). undefined -> not threaded (skip)
  kind?: FileKind;
  classValidator?: ClassValidator;                // when set, class() names are validated against the framework's theme
  apiClients?: string[];                           // named api clients (from app.muten `api {}`); a `post "client:/x"` prefix is checked against these. undefined -> not threaded, skip the check
  iconExists?: (ref: string) => string | null;     // `Icon "set:name"` existence check (reads the set's icons.json). null -> ok; a string -> the error. undefined -> not threaded (skip)
  storeSelfMut?: Set<string>;                       // "domain.action" of store actions that update a signal from its own value -> an `effect { domain.action() }` loops forever
  storeEntities?: { [domainDotMember: string]: Entity };  // element entity of each store list ("orders.items" -> Order fields), so a page can aggregate over a store list (`orders.items.count where …`)
  routes?: string[];   // every declared route url ("/", "/product/:pid"); a static `Link -> "/x"` must match one. undefined -> not threaded (skip)
  translations?: Translations;   // the app's src/lang/*.lang: t("key") must name a key every language has
  themeValues?: ThemeRaw;        // theme.muten: `theme.colors.primary` must name a value it has
  places?: boolean;   // findings inside a part keep their place in the part's file (Loc.in), for `check` to resolve; else the call in the page
  around?: { ids: string[]; where: string };   // a layout: the ids EVERY page mounted in it declares (its `#top` link lands there), and how to name those pages in a message
  selfRoute?: string;  // THIS page's own url. A link to it is provably dead: the router's `go()` ignores a nav to the current path
}

/** What the `Form` code needs from the page: its entity, its fields and their rules, the draft signal it edits. */
export interface FormInput {
  id: string;
  entityName: string;
  fields: EditableField[];
  constraints: EntityConstraints;
  draft: string;                                  // the bound draft's signal
  lang: string;                                   // the page's `meta { lang }`: the validation copy is in it
  slot: (name: string, fallback: string) => string;   // the class a muten.config `classes {}` gives a Form part
  submitText: string;                             // JS for the submit label
  submitAction: string;                           // JS that names the action the submit calls
}

/** What the static renderer (compile/static.ts) reads from the page being compiled. */
export interface StaticFacts {
  nodes: { [id: string]: FlatNode };
  classFor: (base: string, props: NodeProps) => string;
  iconSvg: (ref: string) => string;
  headCells: Set<string>;
}

/** What a node's code generator (compile/fields.ts, svg.ts, tables.ts…) can use: the page being compiled and the
 *  helpers every primitive shares. compile.ts builds one per page; each family of primitives lives in its own file. */
export interface Emitter {
  push(...code: string[]): void;                                   // append compiled lines (to the current capture)
  capture(emit: () => void): string[];                             // the lines `emit` produces, kept apart (a when/each body)
  declEl(id: string, tag: string, className: string): void;
  appendEl(id: string, parentVar: string): void;
  classFor(base: string, props: NodeProps): string;
  slot(name: string, fallback: string): string;
  genDynamics(id: string, props: NodeProps): void;
  genChildren(id: string, parentVar: string): void;
  genNode(id: string, parentVar: string): void;          // one child, compiled in place
  interpAttr(id: string, attr: string, value: StringPropValue | undefined): void;
  nameField(id: string, text: StringPropValue | undefined): void;
  textEl(id: string, tag: string, className: string, value: StringPropValue | undefined, parentVar: string): void;
  textWrite(id: string, bind: string | undefined, writeJS: string): void;
  geo(id: string, attr: string, expr: Expr | undefined): void;
  svgStr(id: string, attr: string, value: StringPropValue | undefined): void;
  writeOnChange(element: string, property: string, value: string): string;
  interpConcat(value: Interp): string;
  logic: Logic;
  scope: Scope;
  nodes: { [id: string]: FlatNode };
  doc: Doc;
  opts: CompileOpts;
  headCells: Set<string>;
  queryStates: Set<string>;                         // states backed by a query: read as `.get().data`
}
/** One node type's code generator. */
export type NodeEmitter = (em: Emitter, id: string, n: FlatNode, parentVar: string) => void;

/** What the checks of effects and actions (ir/validate-actions.ts) read from the page's validation. */
export interface ActionCheck {
  D: Diagnostic[];
  doc: Doc;
  ctx: ValidateCtx;
  checkExpr(expr: Expr, loc: Loc | null, scope: Map<string, string>): void;
  itemPredScope(base: Map<string, string>, target: string): Map<string, string>;
  checkItemShadow(target: string, params: Set<string>, exprs: Expr[], loc: Loc | null): void;
  checkReqUrl(st: RequestStmt & { loc?: Loc }): void;
  stateKeys: Set<string>;
  storeDomains: Set<string>;
  storeMemberMap: Map<string, Set<string>>;
  externs: Set<string>;
  foreign: Set<string>;   // names that hold something from npm: `posthog.capture(…)` is a call, not a store action
  actionNames: Set<string>;
}

/** The list behind a Chart / DataTable `@data`: its element entity and fields, when they are known. */
export interface DataElement { name: string; fields: { readonly [f: string]: string } | null; isList: boolean; known: boolean }

/** What the walk over a page's nodes (ir/validate-nodes.ts) reads from the page's validation. */
export interface NodeCheck {
  D: Diagnostic[];
  doc: Doc;
  ctx: ValidateCtx;
  nodes: { [id: string]: FlatNode };
  stateKeys: Set<string>;
  storeDomains: Set<string>;
  anchorIds: Set<string>;                // the ids this page declares, so a `-> "#x"` is proven to land
  seen: Set<string>;                     // nodes already walked (a node reached twice is an error)
  EXTERNAL: RegExp;                      // an href that leaves the app (http:, mailto:, //…)
  checkExpr(expr: Expr, loc: Loc | null, scope: Map<string, string>): void;
  checkAction(value: string | undefined, node: FlatNode): void;
  checkRef(value: string | undefined, node: FlatNode): void;
  dataElement(name: string): DataElement;
  listElem(list: Expr | undefined): string;
  routeExists(href: string): boolean;
}

/** The props that place an SVG mark (all expressions). */
export type GeoProp = 'x' | 'y' | 'w' | 'h' | 'cx' | 'cy' | 'r' | 'x1' | 'y1' | 'x2' | 'y2' | 'rx' | 'start' | 'end' | 'inner';

/** What a call in an expression may name: built-ins and `use`'d functions, this file's `get name(…)`, the stores'. */
export interface CallFacts {
  externs: Set<string>;
  fns: { [name: string]: FnDef };
  storeFns?: { [domain: string]: { [name: string]: string[] } };   // undefined -> not threaded: a store call is not checked
  stores: Set<string>;
  arity?: { [fn: string]: { min: number; max: number } };   // from the `use`d package's types: how many values each function takes
  foreign?: Set<string>;         // names that hold something from npm (calls.ts foreignNames): their API is theirs
  translations?: Translations;   // set when t() is the app's (src/lang), not a `use`d one: its key and values are checked
}

/** A lexical scope while compiling expressions: lambda locals + the action input. */
export interface Scope {
  locals: Set<string>;
  sigLocals?: Set<string>;   // keyed-each row vars backed by a per-row signal -> refs compile to `<v>.get()` so bindings stay live
  itemBinds?: { [rowVar: string]: string };   // each row var -> the settable source list state, so `bind(row.field)` writes back a patch (inline-editable list items)
  input?: string;
  inputIsState?: boolean;
  item?: { var: string; fields: Set<string> };  // `<list> where <cond>` filter: bare field refs resolve to `<var>.<field>` (item-implicit)
  awaitUse?: boolean;   // inside an async action: a call to a `use` function is awaited (it may return a promise)
}


