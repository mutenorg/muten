// types-tooling: the shapes of the tools around the compiler: IO and the editor, the browser runtime, the build and
// its plugins, and `.test` files. Part of types.ts, which re-exports it: import from types.ts.
import type { TestKw } from '#engine/shared/vocab.js';
import type { ClassValidator, Doc, Expr, IR, Loc, PartParam, StoreSlice, ThemeAdapter, ThemeRaw, Value } from '#engine/shared/types.js';

// ── 12. Tooling / IO shapes ──────────────────────────────────────────────────

/** One resolved route from app.muten: route slug, page name, and its screen file path. */
export interface RouteEntry {
  route: string;
  page: string;
  screenPath: string;
  layout?: string;   // the `layout` the route mounts inside, when it declares `in name`
  guard?: Expr;      // `guard … else "/x"`: who may open it, and where the others go
  redirect?: string;
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
/** An effect: calling it runs it again now; `dispose` stops it for good (it lets go of everything it read). */
export interface EffectRun { (): void; readonly sync: boolean; dispose(): void; }
/** One mounted node, addressable by id for surgical HMR: its element and the parent it lives under (so a patch
 *  can rebuild + swap it in place). `dispose` is set only by a prior patch — the initial mount's per-node effects
 *  live in the page scope (cleaned on navigation), so a first patch just leaves them on the detached old node. */
// `loc` is the node's line in the PAGE. A node inlined from a part has none — `owner`/`oloc` say which part file its
// source lives in and where. The element picker climbs to the nearest `loc` (a line the app owns) and reports `owner`
// as a hint; it must never turn `owner` into a path, because a plugin part's file lives in node_modules.
export interface MountedNode { el: Element; parent: Element; dispose?: () => void; type?: string; part?: string; partArgs?: { [name: string]: string }; loc?: { line: number; col: number }; owner?: string; oloc?: { line: number; col: number }; }
export type NodeRegistry = { [id: string]: MountedNode };
/** The live HMR handle stashed on a mounted page's root element (`el.__muten`): the reactive context (state/
 *  actions as addressable data, so a patch can rebuild a node against the SAME signals) + the node registry. */
export interface PageInstance { el: Element; ctx: { [name: string]: unknown }; nodes: NodeRegistry; }
/** A compiled page/shell module: its scoped CSS + a mount() that builds it into a root element (returning it). */
export interface PageModule { css: string; mount(root: Element, params?: { [key: string]: string }): Element; meta?: { [key: string]: string }; screen?: string; }
/** One route's lazy loader + optional guard/redirect (the hash router consumes a map of these). */
export interface RouteDef { load(): Promise<PageModule>; guard?: () => boolean; redirect?: string; layout?: string; }
/** The lazy loaders of the app's layouts, by name (a layout module mounts like the shell and returns its outlet). */
export interface LayoutDefs { [name: string]: () => Promise<PageModule>; }

// ── 14. Build / plugin shapes ────────────────────────────────────────────────

/** A muten STYLING PLUGIN (the seam for library-specific behavior), configured via muten.config `styling`.
 *  The engine ships NONE and expects no library; a plugin provides how to emit the theme (a ThemeAdapter,
 *  data) and optionally how to validate class() (e.g. via that library's own tooling). */
export type ClassValidatorLoader = (cssPath: string, base: string, themeRaw: ThemeRaw) => Promise<ClassValidator>;
export interface StylingPlugin { theme?: ThemeAdapter; validate?: ClassValidatorLoader; classes?: { [slot: string]: string }; }

/** The app graph the build emits to app.map.json (+ serves live at /_muten/graph): the root the AI reads. */
export interface AppMap {
  app: string;
  parts: string[];
  stores: { [domain: string]: StoreSlice };
  routes: { [url: string]: { file: string; models: string[]; state: { [name: string]: Value }; sources: { [name: string]: string }; layout?: string } };
  layouts?: string[];   // the app's `layout` names (routes point at them through their `layout` field)
}

/** Ambient shape for the OPTIONAL `sass` dependency — only imported when a .scss exists. */
declare module 'sass' {
  export function compile(path: string): { css: string };
}

// A file of an imported plugin that could not be parsed: the app still runs without its parts (the plugin is not the
// user's code), but `muten check` says which file and why, instead of a bare «not a known part» on every caller.
export interface PluginFileError { file: string; message: string; loc: Loc | null; }


// ── 15. Test files (`muten test`) ───────────────────────────────────────────────
/** One step of a `.test` (vocab TestKw); `loc` points a failure at its line. */
export type TestStep =
  | { kind: TestKw.Open; route: string; loc: Loc }
  | { kind: TestKw.Press; target: string; loc: Loc }
  | { kind: TestKw.Fill; target: string; value: string; loc: Loc }
  | { kind: TestKw.See; text: string; absent: boolean; loc: Loc }
  | { kind: TestKw.Wait; ms: number; loc: Loc };
export interface TestCase { name: string; steps: TestStep[]; loc: Loc }
export interface TestFile { tests: TestCase[] }
