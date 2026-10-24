// foreign: the module imports for a `use` line. Functions import by name; components from npm import what mounting
// them needs: a Web Component its defining module (side effect, it registers the tag), a widget its `mount`, a React
// component itself (named or default export, whichever the package has) plus the two React calls an island uses.
import type { ChainStep, CompileCtx, Expr, ImportDef } from '#engine/shared/types.js';
import { UseKind, Fmt, LIVE_CHANGE } from '#engine/shared/vocab.js';
import { callValues } from '#engine/ir/calls.js';

export const OWN_FILE = /^(\.|~\/|\/)/;   // the app's own .ts/.js, imported by name exactly as written

/** The functions a `use` line brings from a package, each bound by `keyword` (`const` in a page, `export const` in
 *  muten build's bundle). A name the package lacks is looked for on its default export, and a single name falls back
 *  to the default export itself: `use confetti from "canvas-confetti"`, `use posthog from "posthog-js"`, and a
 *  CommonJS package all come in the way their docs show them. */
export function packageBindings(def: ImportDef, index: number, keyword: string): string[] {
  const ns = `__pkg_${index}`;
  const single = def.names.length === 1;
  return [`import * as ${ns} from ${JSON.stringify(def.from)};`,
    ...def.names.map((name) => `${keyword} ${name} = ${ns}.${name} ?? ${ns}.default?.${name}${single ? ` ?? ${ns}.default` : ''};`)];
}

/** The import a `use` line becomes at the top of the page module. */
export function foreignImport(def: ImportDef, index = 0): string {
  if (def.script) return '';   // a global its <script> leaves: made by scriptGlobals, in every output
  const from = JSON.stringify(def.from);
  const name = def.names[0] || '';
  if (def.kind === UseKind.Element) return `import ${from};`;
  if (def.kind === UseKind.Widget) return `import { mount as __custom_${name} } from ${from};`;
  if (def.kind === UseKind.React) return `import * as __react_ns_${name} from ${from};`;
  if (def.kind === UseKind.Vue || def.kind === UseKind.Svelte || def.kind === UseKind.Solid) return '';   // framework-island.ts frameworkLoader   // its components are picked by name at render (react-tree.ts)
  return OWN_FILE.test(def.from) ? `import { ${def.names.join(', ')} } from ${from};` : packageBindings(def, index, 'const').join('\n');
}

/** React's two calls an island needs, imported once per page that has one (the app installs react + react-dom). */
export const REACT_RUNTIME = "import { createElement as __react_h } from 'react';\nimport { createRoot as __react_root } from 'react-dom/client';";

/** `use google from script "https://…"`: each name is the global the script leaves, loaded the first time it is called
 *  (its calls answer a promise, awaited in actions). Written in the page itself, so `bundle` and `build` both have it. */
export function scriptGlobals(imports: ImportDef[] | undefined): string {
  return (imports || []).filter((def) => def.script).flatMap((def) => def.names.map((name) => `const ${name} = __script(${JSON.stringify(def.from)}, ${JSON.stringify(name)});`)).join('\n  ');
}

/** Is this call a package's own API (`posthog.capture(…)`, `z.string().email()`, `db.from("t").select("*")`)? */
export function isForeignCall(ctx: CompileCtx, fn: string, chain: ChainStep[] | undefined, ctor?: boolean): boolean {
  return ctx.foreign.has(fn.split('.')[0]) && (fn.includes('.') || !!chain || !!ctor);
}

/** What a package-API call calls: `posthog.capture`, or `db.get().from` for what a get holds. */
export function foreignPath(ctx: CompileCtx, fn: string, ref: (name: string) => string): string {
  const head = fn.split('.')[0];
  return ctx.useCalls.has(head) ? fn : ref(head) + fn.slice(head.length);
}

/** That call as the package documents it. The head is the imported name itself, or the get or query that holds what
 *  a package gave back (`db` from `get db = createClient(…)`), read through its signal. */
export function foreignCallJs(ctx: CompileCtx, fn: string, args: Expr[], chain: ChainStep[] | undefined, value: (arg: Expr) => string, ref: (name: string) => string, ctor?: boolean): string {
  const base = foreignPath(ctx, fn, ref);
  const values = (list: Expr[]): string => list.map(value).join(', ');
  return `${ctor ? 'new ' : ''}${base}(${values(args)})` + (chain || []).map((step) => `.${step.name}${step.args ? `(${values(step.args)})` : ''}`).join('');
}

/** The queries of a function: `__callQuery(<the values it reads>, <what asks>, live, empty)`. A package's API asks
 *  through its object (`db.from("t").select("*")`), so the method keeps its `this`. */
export function callQueryDecls(ctx: CompileCtx, value: (arg: Expr) => string, callee: (fn: string) => string, ref: (name: string) => string, call: (fn: string, args: Expr[], chain: ChainStep[] | undefined) => string, feed: (expr: Expr) => string): string {
  const exp = ctx.format === Fmt.Store ? 'export ' : '';
  const out: string[] = [];
  for (const [name, def] of Object.entries(ctx.state)) {
    if (!def.call) continue;
    const { fn, args, chain } = def.call;
    const asks = !isForeignCall(ctx, fn, chain) ? callee(fn) : chain ? `() => ${call(fn, args, chain)}` : `(...__v) => ${foreignPath(ctx, fn, ref)}(...__v)`;
    out.push(`${exp}const ${name} = __callQuery(() => [${callValues(def.call).map(value).join(', ')}], ${asks}, ${def.live ? 'true' : 'false'}, ${def.type.startsWith('list') ? '[]' : 'null'});`);
    if (def.refresh) out.push(`__every(null, ${name}, ${def.refresh});`);   // `every 30s`
  }
  // `live <feed>`: the package's subscription, with muten's `change` where its callback goes
  for (const [name, def] of Object.entries(ctx.state)) if (def.feed) out.push(`__feed(${name}, ${def.source ? 'true' : 'false'}, (${LIVE_CHANGE}) => ${feed(def.feed)});`);
  return out.join('\n  ');
}
