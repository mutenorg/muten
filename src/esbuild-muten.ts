// esbuild-muten.ts: the muten build, on embedded esbuild — the ONLY runner. Compiles .muten -> JS, serves the
// runtime/shell/store as virtual modules, runs the oracle, wired to esbuild's onResolve/onLoad so muten owns
// the bundler directly. No Vite: `muten dev` / `muten bundle` route straight here.
//
// `bundleEsbuild` = production build (per-route chunks + hashed CSS); the dev server (`devEsbuild`) is dev-server.ts,
// on the same model and plugin. CSS (sass -> theme -> Tailwind) is built as its own
// artifact, not through esbuild's graph. The TS compiler stays the single source of truth — esbuild moves bytes.

import { pluginNames } from '#engine/project/plugins.js';
import * as esbuild from 'esbuild';
import { readFileSync, existsSync, mkdirSync, writeFileSync, cpSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { load, loadAllParts, findStores, loadPluginComponents } from '#engine/project/load.js';
import { storeContext, type StoreContext } from '#engine/project/context.js';
import { guardJs } from '#engine/compile/guard.js';
import { apiWithEnv, envDefines } from '#engine/project/env.js';
import { themeLibrary, withLibraryCss, themeRoot, withThemeRoot } from '#engine/project/theme-library.js';
import { inlineCssImports } from '#engine/project/css-imports.js';
import { filesText, PUBLIC_CODE } from './css-prune.js';
import { writeStyles, routeStylesTag } from './css-routes.js';
import { routePreloadTags, routeFiles } from './route-preload.js';
import { prerender } from './prerender.js';
import { customSource } from './use-bundle.js';
import { readMutenConfig, configThemeAdapter, configClasses } from '#engine/project/config.js';
import { apiClientNames } from '#engine/project/routes.js';
import { mapApp } from '#engine/project/map.js';
import { validate } from '#engine/ir/validate.js';
import { ParseError } from '#engine/shared/diagnostics.js';
import { compileModule, compileStore } from '#engine/compile/compile.js';
import { dataModule } from '#engine/compile/emit.js';
import { emitTheme } from '#engine/style/tokens.js';
import { getIconChecker } from '#engine/project/icon-check.js';
import { makeIconResolver } from './icons.js';
import { cspFrom, withCsp, writeSecurityHeaders, scriptOrigins, withScriptOrigins } from './dev-security.js';
import { writeAppMap, writeBundleRecord } from './app-map-file.js';
import { LAYOUT_PREFIX, layoutDoc, layoutLoaders } from './layout-modules.js';
import { TEXTS_LANG, textsModule, textsLanguageModule } from './texts-modules.js';
import { routeLayout } from '#engine/project/layouts.js';
import { Nt, HOST_EXTS } from '#engine/shared/vocab.js';
import type { IR, PartDef, ThemeAdapter, Doc, Translations, ThemeRaw, ThemeKit } from '#engine/shared/types.js';
import { readThemeKit } from '#engine/project/theme-values.js';
import { readTranslations, langFiles } from '#engine/project/lang-files.js';
import { configMetaTags } from '#engine/project/page-metas.js';
import { recordIcons, shareIcons } from './icon-share.js';
import { libraryOptions } from '#engine/project/bundle-options.js';
import { missingComponents } from '#engine/project/custom-check.js';
import { onPage, onPageDiagnostic } from '#engine/ir/places.js';
import { overBudget, readBudget } from './budget.js';
import { shipReport } from './ship-report.js';
import { pwaHead, writePwa } from './pwa.js';

const here = dirname(fileURLToPath(import.meta.url));
// the browser runtime (the virtual:muten/runtime module), read on every build: read once, a rebuilt engine stayed invisible
// until `muten dev` was restarted
const runtimeSource = (): string => readFileSync(join(here, 'runtime.js'), 'utf8');

const RID = 'virtual:muten/runtime';
const DATA = 'virtual:muten/data';
// The app's texts for code outside a page (a `use` function, a Custom): `import { t, texts } from 'muten:texts'` gives the
// same t() a page has, over the same src/lang files, with the language passed in: t(lang, key, ...values).
const TEXTS_IMPORT = 'muten:texts';
const TEXTS = 'virtual:muten/texts';
const SHELL = 'virtual:muten/shell';
const STORE_PREFIX = 'virtual:muten/store/';
const VNS = 'muten-virtual';
const DEVTOOLS_PLUGIN = 'devtools';
const USE_SHEET = /^[ \t]*use[ \t]+"([^"]+)"/gm;

// The whole-app model the compile needs, scanned once (the same facts the Vite plugin's loadProject gathers).
export interface Model {
  parts: { [name: string]: PartDef };
  slices: { [domain: string]: IR };
  store: StoreContext;
  appIr: IR | undefined;
  themeRaw: ReturnType<typeof parse>['theme'];
  themeAdapter: ThemeAdapter | undefined;
  classes: { [slot: string]: string } | undefined;
  iconResolver: ReturnType<typeof makeIconResolver>;
  iconExists: ReturnType<typeof getIconChecker>;
  stylesHref: string | null;   // /src/styles.css|scss, imported by the boot
  translations: Translations | undefined;   // src/lang/<code>.lang, what t("key") reads
  themeValues: ThemeRaw | undefined;        // theme.muten, what `theme.colors.primary` reads
  themeKit: ThemeKit | undefined;           // and its providers, around every component of their library
  mocksOnly?: boolean;         // `muten test`: every query reads its `mock`, no `sources` (the tests never reach a real API)
}

export async function loadModel(root: string): Promise<Model> {
  const parts = await loadAllParts(root);
  const slices = findStores(join(root, 'src'));
  const appFile = join(root, 'src', 'app.muten');
  // Speak like the oracle: without src/app.muten there is no entry, and esbuild would otherwise fail with a cryptic
  // "Could not resolve …/src/app.muten". Give the SAME clear message `muten check` does (bundle + dev share this loader).
  if (!existsSync(appFile)) throw new Error(`No app.muten at src/app.muten — every muten app needs a root. Create src/app.muten with:\n  routes {\n    "/" -> home\n  }`);
  let appIr: ReturnType<typeof parse>;
  try { appIr = parse(readFileSync(appFile, 'utf8')); }
  catch (e) { if (e instanceof ParseError && !e.file) e.file = appFile; throw e; }   // a mistake in it points at app.muten
  if (appIr.api) appIr.api = apiWithEnv(appIr.api, root);   // `base: "{env.api}"` -> the active environment (env.ts)
  const themeFile = join(root, 'theme.muten');
  let themeRaw: ReturnType<typeof parse>['theme'] = {};
  try { if (existsSync(themeFile)) themeRaw = parse(readFileSync(themeFile, 'utf8')).theme || {}; }
  catch (e) { if (e instanceof ParseError && !e.file) e.file = themeFile; throw e; }   // a mistake in it points at theme.muten, not `src`
  const cfg = readMutenConfig(root);
  let stylesHref: string | null = null;
  for (const name of ['styles.css', 'styles.scss']) if (existsSync(join(root, 'src', name))) { stylesHref = '/src/' + name; break; }
  return {
    parts, slices, store: storeContext(slices), appIr, themeRaw,
    themeAdapter: configThemeAdapter(cfg), classes: configClasses(cfg),
    iconResolver: makeIconResolver(root), iconExists: getIconChecker(root), stylesHref, translations: readTranslations(root), themeValues: themeRaw, themeKit: readThemeKit(root),
  };
}

// The self-booting entry: shell + route map -> mount. The stylesheet is NOT imported here — CSS is built as a
// separate artifact (buildCss) so a new class() in a .muten always re-runs Tailwind, instead of esbuild caching
// an unchanged styles.css and missing it.
function buildBoot(model: Model, root: string, dev: boolean): string {
  const { appIr } = model;
  const guardDomains = new Set<string>();
  const seen = new Set<string>();
  const routes = (appIr?.routes || []).map((r) => {
    const path = JSON.stringify('/' + r.url.replace(/^\//, ''));
    if (seen.has(path)) throw new Error(`[muten] duplicate route ${path} in app.muten`);
    seen.add(path);
    const imp = `() => import(${JSON.stringify('/src/pages/' + r.page + '/' + r.page + '.muten')})`;
    const layout = routeLayout(appIr, r);   // `in x`, else the default layout unless `without` it (layouts.ts)
    const inLayout = layout ? `, layout: ${JSON.stringify(layout)}` : '';
    if (r.guard) return `  ${path}: { page: ${JSON.stringify(r.page)}, load: ${imp}, guard: () => ${guardJs(r.guard, guardDomains)}, redirect: ${JSON.stringify(r.redirect)}${inLayout} },`;
    return `  ${path}: { page: ${JSON.stringify(r.page)}, load: ${imp}${inLayout} },`;
  }).join('\n');
  const guardImports = [...guardDomains].map((d) => `import * as __store_${d} from '${STORE_PREFIX}${d}';`).join('\n');
  // dev-only: auto-mount any enabled plugin that declares a `muten.devBoot` export (e.g. @muten/devtools). The
  // import hoists; the call runs after the app mounts. Never emitted by `muten bundle` -> zero production cost.
  // the devtools ship with muten: on in dev unless `dev { devtools false }`; the old @muten/devtools plugin steps aside
  const devConfig = readMutenConfig(root).dev;
  const devtools = dev && !(devConfig && typeof devConfig === 'object' && !Array.isArray(devConfig) && devConfig.devtools === false);
  const devPlugins = dev ? devBootPlugins(root).filter((p) => !(devtools && p.name === DEVTOOLS_PLUGIN)) : [];
  const bootCode = `import * as __shell from '${SHELL}';
import { route, injectCss } from '${RID}';
${guardImports}
${devPlugins.map((p) => `import { ${p.fn} as __devboot_${p.name} } from '@muten/${p.name}';`).join('\n')}
${devtools ? `import { mountDevtools as __devtools } from ${JSON.stringify(join(here, 'devtools', 'index.js'))};` : ''}
const routes = {
${routes}
};
${layoutLoaders(appIr)}
const root = document.getElementById('app');
if (root) {
  injectCss(__shell.css);
  const outlet = __shell.mount(root);
  route(outlet, routes, layouts);
}
${devPlugins.map((p) => `try { __devboot_${p.name}(); } catch (__e) { console.warn('[muten] dev plugin @muten/${p.name} failed to mount', __e); }`).join('\n')}
${devtools ? `try { __devtools(); } catch (__e) { console.warn('[muten] the devtools failed to mount', __e); }` : ''}`;
  return bootCode;
}

// installed+enabled plugins (from muten.config `plugins {}`) whose package.json declares `muten.devBoot: "<export>"`.
function devBootPlugins(root: string): { name: string; fn: string }[] {
  const req = createRequire(join(root, 'package.json'));
  const out: { name: string; fn: string }[] = [];
  for (const name of pluginNames(root)) {
    try {
      const pkg = JSON.parse(readFileSync(req.resolve(`@muten/${name}/package.json`), 'utf8'));
      const fn = pkg && pkg.muten && pkg.muten.devBoot;
      if (typeof fn === 'string') out.push({ name, fn });
    } catch { /* not installed / no devBoot */ }
  }
  return out;
}

// An oracle/syntax diagnostic as an esbuild message — `location` carries file:line:col + the source line, so
// esbuild's own formatter renders a Vite-style code frame in the terminal AND the dev overlay.
const muError = (path: string, message: string, loc?: { line: number; col: number } | null): esbuild.PartialMessage => ({
  text: message,
  location: loc ? { file: path, line: loc.line, column: loc.col - 1, lineText: readFileSync(path, 'utf8').split('\n')[loc.line - 1] ?? '' } : { file: path },
});

// Compile a single .muten page (parse -> compose -> flatten -> validate -> emit), the same path the Vite
// plugin's transform runs. Returns the JS or esbuild-shaped errors from the oracle (syntax + validation).
async function compilePage(root: string, path: string, model: Model, dev = false): Promise<{ contents?: string; errors?: esbuild.PartialMessage[]; warnings?: esbuild.PartialMessage[]; watchFiles?: string[] }> {
  let loaded;
  try { loaded = await load(path, model.parts); }
  catch (e) { if (e instanceof ParseError) return { errors: [muError(path, e.message, e.loc)] }; throw e; } // syntax error -> located message
  const storeMembers = model.store.storeMembers;
  const validated = validate(loaded.doc, {   // `ok` is derived below: only ERROR severity blocks the build
    parts: loaded.partNames, stores: model.store.stores, storeMembers, storeFns: model.store.storeFns, storeActions: model.store.storeActions,
    storeEntities: model.store.storeEntities, storeSelfMut: model.store.storeSelfMut,
    iconExists: model.iconExists, apiClients: apiClientNames(model.appIr?.api || {}), translations: model.translations, themeValues: model.themeValues,
    routes: (model.appIr?.routes || []).map((r) => r.url),   // a static `Link -> "/x"` must match a declared route
    // `src/pages/<name>/<name>.muten` -> this page's own url, so a link back to itself is caught in dev too
    selfRoute: (model.appIr?.routes || []).find((r) => r.page === path.replace(/\\/g, '/').split('/').slice(-2)[0])?.url,
  });
  const diagnostics = [...validated.diagnostics, ...missingComponents(root, loaded.doc).map(onPageDiagnostic)];   // a Custom with nothing to mount stops here, at its line
  // Only ERROR severity stops the build. Split explicitly here so a warning can never masquerade as a compile error
  // again — `validate` used to report `ok: D.length === 0`, so the first warning it ever emitted broke every page.
  // Warnings are carried on `result.warnings` for a caller that wants them; the CLI runs esbuild at `logLevel: 'silent'`
  // and prints nothing today, so they surface through `muten check` (which counts them by severity).
  const errs = diagnostics.filter((d) => d.severity === 'error');
  const warns = diagnostics.filter((d) => d.severity !== 'error').map((d) => muError(path, d.message, d.loc));
  if (errs.length) return { errors: errs.map((d) => muError(path, d.message + (d.suggestion ? ` (did you mean \`${d.suggestion}\`?)` : ''), d.loc)), warnings: warns };
  const { components, watchFiles } = customComponents(root, loaded.doc);
  const sources = model.mocksOnly ? {} : { ...(model.appIr?.sources || {}), ...loaded.sources };
  const icons = recordIcons(model.iconResolver);   // icon-share.ts: each icon this page shows, written once in it
  return {
    warnings: warns,   // non-blocking findings (a dead `self-link`) travel with the result; they never fail the build
    watchFiles,        // so an edit to a Custom .js re-runs THIS page's onLoad (else esbuild caches the old inlined copy)
    contents: shareIcons(compileModule(loaded.doc, loaded.data, loaded.styles.css, components, sources, {
      stores: model.store.storesMeta, storeEntities: model.store.storeEntities, api: model.appIr?.api || {},
      iconResolver: icons.resolve, classes: model.classes, translations: model.translations, themeValues: model.themeValues, themeKit: model.themeKit, dev, // dev: emit the HMR node registry + el.__muten handle
      sourceMap: { file: path, source: readFileSync(path, 'utf8') }, // runtime errors -> the .muten line, not the compiled JS
    }), icons.used),
  };
}

// Tailwind v4, in-process, resolved from the APP (the same packages @tailwindcss/vite uses). We feed it the
// stylesheet + theme.muten's @theme block, scan the .muten files for class() tokens, and emit the final CSS.
// Resolved from the app so muten doesn't carry Tailwind. A minimal typing of just the slice we call.
interface TwSource { base: string; pattern: string; negated: boolean; }
interface TwCompiler { sources: TwSource[]; build(candidates: string[]): string; }
interface TwNode { compile(css: string, opts: { base: string; onDependency: (p: string) => void }): Promise<TwCompiler>; }
interface TwScanner { new(opts: { sources: TwSource[] }): { scan(): string[] }; }

async function runTailwind(css: string, root: string): Promise<string> {
  const req = createRequire(join(root, 'package.json'));
  const node: TwNode = await import(pathToFileURL(req.resolve('@tailwindcss/node')).href);
  const oxide: { Scanner: TwScanner } = await import(pathToFileURL(req.resolve('@tailwindcss/oxide')).href);
  const compiler = await node.compile(css, { base: root, onDependency() { } });
  // Scan the .muten files AND the escapes' source under src/ (a `Custom` component's .js holds classes too —
  // e.g. the playground's `hidden` tab toggles). Tailwind can't auto-detect .muten, and missing src/*.js would
  // drop those utilities (panels then never hide). src-scoped so node_modules is never scanned.
  const sources: TwSource[] = [
    ...compiler.sources,
    { base: root, pattern: '**/*.muten', negated: false },
    { base: join(root, 'src'), pattern: '**/*.{js,ts,jsx,tsx}', negated: false },
  ];
  // Sanitize the scanned candidates: a stray glob-like token (e.g. `row-span-*` written in a CSS comment or a
  // doc string) is NOT a real utility, and Tailwind's build throws on it - dropping the ENTIRE stylesheet and
  // flashing the app unstyled. A `*` that survives stripping every `[…]` arbitrary group can never be a class,
  // so drop those candidates and keep the build alive.
  const candidates = new oxide.Scanner({ sources }).scan().filter((c) => !c.replace(/\[[^\]]*\]/g, '').includes('*'));
  return compiler.build(candidates);
}

// Last successful Tailwind output, kept across rebuilds: a transient Tailwind failure (e.g. a file caught
// mid-write during an incremental dev rebuild) must NOT serve un-utility'd raw CSS - that flashes the whole app
// unstyled. We serve the last good CSS until the next build succeeds.
let lastGoodCss = '';

// The project stylesheet, fully resolved as one artifact (outside esbuild's graph): sass (.scss) -> theme.muten's
// @theme block -> Tailwind (if used). Regenerated on every build so a new class() in a .muten is always scanned.
/** The app's index.html with what the theme puts on <html> (theme-library.ts themeRoot). A missing file is said plainly. */
export function readIndexHtml(root: string, model: Model): string {
  const file = join(root, 'index.html');
  if (!existsSync(file)) throw new Error('index.html is missing at the app root. It is the page the app mounts in: <!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>');
  const metas = configMetaTags(root);   // `i18n { detect false }`, `routes { preload }`: the runtime reads them (page-metas.ts)
  const html = metas ? readFileSync(file, 'utf8').replace(/<head([^>]*)>/i, `<head$1>${metas}`) : readFileSync(file, 'utf8');
  const lib = themeLibrary(root, model.themeRaw);
  return lib && model.themeRaw ? withThemeRoot(html, themeRoot(lib, model.themeRaw)) : html;
}

/** The stylesheets the app's .muten files bring with `use "…"`, each once. */
function usedStylesheets(root: string): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); } else if (entry.name.endsWith('.muten')) for (const m of readFileSync(full, 'utf8').matchAll(USE_SHEET)) out.add(m[1]); } };
  if (existsSync(join(root, 'src'))) walk(join(root, 'src'));
  return [...out];
}

export async function buildCss(root: string, model: Model): Promise<string> {
  const lib = themeLibrary(root, model.themeRaw);   // `theme shadcn { … }`: the library's stylesheets come in with it
  const sheets = usedStylesheets(root);   // `use "swiper/css"` in any page or part: imported first, then the app's own
  if (!model.stylesHref && !lib && !sheets.length) return '';
  const file = model.stylesHref ? join(root, model.stylesHref.replace(/^\//, '')) : '';
  let css = file ? readFileSync(file, 'utf8') : '';
  if (lib && model.themeRaw) css = withLibraryCss(css, lib, model.themeRaw);
  if (file.endsWith('.scss')) {
    const req = createRequire(join(root, 'package.json'));
    const mod = await import(pathToFileURL(req.resolve('sass')).href); // dart-sass is CJS -> API is on .default under dynamic import
    const sass: { compileString(src: string, opts: { loadPaths: string[] }): { css: string } } = mod.default ?? mod;
    css = sass.compileString(css, { loadPaths: [dirname(file)] }).css;
  }
  if (sheets.length) css = sheets.map((sheet) => `@import ${JSON.stringify(sheet)};`).join('\n') + '\n' + css;
  const block = emitTheme(model.themeRaw, model.themeAdapter, lib?.dark);
  if (block) css += '\n\n/* muten: generated from theme.muten */\n' + block;
  // Tailwind whole (`@import "tailwindcss"`) or in pieces (`@import "tailwindcss/theme.css"` + `…/utilities.css`, the
  // way to use it without its preflight reset when an app keeps its own base styles)
  if (/@import\s+["']tailwindcss(?:\/[^"']*)?["']|@plugin\s+["']daisyui/.test(css)) {
    try { css = await runTailwind(css, root); lastGoodCss = css; }
    catch (e) { console.warn(`  ⚠ Tailwind step failed (${e instanceof Error ? e.message : String(e)}); serving the last good CSS`); if (lastGoodCss) css = lastGoodCss; }
  } else css = inlineCssImports(css, file ? dirname(file) : join(root, 'src'), root);   // a package's stylesheet comes in (Tailwind does this itself)
  return css;
}

// The host Custom components a doc uses, read to be INLINED (not imported — esbuild can't see them), with
// the files to watch so an edit re-runs the module. Pages AND the shell go through here: the shell used to
// be compiled with no components at all, so a Custom in it called an undefined mount and rendered nothing.
export function customComponents(root: string, doc: Doc): { components: { [name: string]: string }; watchFiles: string[] } {
  const customNames = [...new Set(Object.values(doc.nodes).filter((n) => n.type === Nt.Custom).map((n) => n.props?.component))];
  const components: { [name: string]: string } = {};
  const watchFiles: string[] = [];
  const pluginComponents = loadPluginComponents(root); // Custom host .js shipped by imported plugins (Chart, …)
  for (const name of customNames) {
    if (typeof name !== 'string' || !name) continue;
    const own = HOST_EXTS.map((ext) => join(root, 'src', 'components', name + ext)).find((path) => existsSync(path));
    const file = own ?? pluginComponents[name];   // local/ejected wins (Name.ts, then Name.js), else the plugin's
    if (!file) continue;
    components[name] = customSource(file); watchFiles.push(file);
  }
  return { components, watchFiles };
}

// The esbuild plugin: virtual modules (runtime/shell/store), the `~/` and `/src/` path roots, and the
// .muten -> JS loader (with the oracle). CSS is handled separately (buildCss), not here.
export function mutenEsbuild(root: string, model: Model, dev = false): esbuild.Plugin {
  const appFile = join(root, 'src', 'app.muten');
  const missingIn = (doc: Doc): esbuild.PartialMessage[] => missingComponents(root, doc).map((d) => muError(appFile, d.message, onPage(d.loc)));
  return {
    name: 'muten',
    setup(build) {
      // virtual:muten/* -> our namespace
      build.onResolve({ filter: /^virtual:muten\// }, (args) => ({ path: args.path, namespace: VNS }));
      build.onResolve({ filter: new RegExp(`^${TEXTS_IMPORT}$`) }, () => ({ path: TEXTS, namespace: VNS }));
      // `~/` = src root; `/src/...` = app-absolute paths the boot emits (route imports, stylesheet)
      build.onResolve({ filter: /^~\// }, (args) => ({ path: join(root, 'src', args.path.slice(2)) }));
      build.onResolve({ filter: /^\/src\// }, (args) => ({ path: join(root, args.path) }));

      build.onLoad({ filter: /.*/, namespace: VNS }, (args) => {
        if (args.path === RID) return { contents: runtimeSource(), loader: 'js', resolveDir: here };
        if (args.path === DATA) return { contents: dataModule(), loader: 'js', resolveDir: here };   // the data layer, once per app
        if (args.path === TEXTS) return { contents: textsModule(model.translations), loader: 'js', resolveDir: here, watchFiles: Object.values(langFiles(root)) };
        if (args.path.startsWith(TEXTS_LANG)) return { contents: textsLanguageModule(model.translations, args.path.slice(TEXTS_LANG.length)), loader: 'js', resolveDir: here, watchFiles: Object.values(langFiles(root)) };
        if (args.path === SHELL) {   // the shell and each layout: a Custom with nothing to mount stops the build at its line in app.muten
          const tree = model.appIr?.shell || { type: Nt.Shell, props: {}, children: [{ type: Nt.Slot, props: {} }] };
          const doc = toDoc({ ...(model.appIr || {}), screen: 'shell', entities: {}, state: {}, actions: {}, tree });
          const unmounted = missingIn(doc);
          if (unmounted.length) return { errors: unmounted };
          const { components, watchFiles } = customComponents(root, doc);
          return { contents: compileModule(doc, {}, '', components, {}, { stores: model.store.storesMeta, storeEntities: model.store.storeEntities, iconResolver: model.iconResolver, classes: model.classes, translations: model.translations, themeValues: model.themeValues, themeKit: model.themeKit }), loader: 'js', resolveDir: join(root, 'src'), watchFiles };
        }
        if (args.path.startsWith(LAYOUT_PREFIX)) {
          const built = layoutDoc(model.appIr, model.parts, args.path.slice(LAYOUT_PREFIX.length));
          if (!built) return { errors: [{ text: `unknown layout: ${args.path.slice(LAYOUT_PREFIX.length)}` }] };
          const unmounted = missingIn(built.doc);
          if (unmounted.length) return { errors: unmounted };
          const { components, watchFiles } = customComponents(root, built.doc);
          return { contents: compileModule(built.doc, {}, built.css, components, {}, { stores: model.store.storesMeta, storeEntities: model.store.storeEntities, api: model.appIr?.api || {}, iconResolver: model.iconResolver, classes: model.classes, translations: model.translations, themeValues: model.themeValues, themeKit: model.themeKit, dev }), loader: 'js', resolveDir: join(root, 'src'), watchFiles: [...watchFiles, join(root, 'src', 'app.muten')] };
        }
        if (args.path.startsWith(STORE_PREFIX)) {
          const domain = args.path.slice(STORE_PREFIX.length);
          const ir = model.slices[domain];
          if (!ir) return { errors: [{ text: `unknown store: ${domain}` }] };
          const imports = (ir.imports || []).map((im) => im.from.startsWith('.') ? { ...im, from: '/' + join('src', im.from).replace(/\\/g, '/') } : im);
          return { contents: compileStore({ state: ir.state || {}, gets: ir.gets || {}, fns: ir.fns || {}, actions: ir.actions || {}, effects: ir.effects || [], entities: ir.entities || {}, imports, domain, dev, api: model.appIr?.api || {}, stores: model.store.storesMeta, translations: model.translations, themeValues: model.themeValues }, ir.mock || {}, model.mocksOnly ? {} : ir.sources || {}), loader: 'js', resolveDir: join(root, 'src') };
        }
        return { errors: [{ text: `unknown virtual module: ${args.path}` }] };
      });

      build.onLoad({ filter: /\.muten$/ }, async (args) => {
        if (args.path.replace(/\\/g, '/').endsWith('/src/app.muten')) return { contents: buildBoot(model, root, dev), loader: 'js', resolveDir: join(root, 'src') };
        const out = await compilePage(root, args.path, model, dev);
        return out.errors ? { errors: out.errors } : { contents: out.contents, loader: 'js', resolveDir: dirname(args.path), watchFiles: out.watchFiles };
      });
    },
  };
}

// `muten bundle` on esbuild: bundle the boot (+ per-route chunks), build the CSS separately, then write index.html
// pointing at the hashed outputs and copy public/. NOTHING ABOUT THE SOURCE SHIPS unless asked: source maps hand anyone
// the app's whole source, so they come only with `--sourcemap`; and the app graph (app.map.json) is for the AI on this
// machine, so it is written to .muten/, never into the folder that gets deployed.
export interface BundleOptions { sourcemap?: boolean; mocksOnly?: boolean; quiet?: boolean; prerender?: boolean }   // prerender: on whatever muten.config says
export async function bundleEsbuild(root: string, target = join(root, 'dist'), options: BundleOptions = {}): Promise<{ outDir: string }> {
  const model = { ...await loadModel(root), mocksOnly: options.mocksOnly };
  // BUILT ASIDE, SWAPPED IN AT THE END. Emptying dist/ first left a window where a page loading from it got the new
  // index.html without its stylesheet (a desktop shell reloading on save showed the editor as plain text), and a build
  // that failed left no dist/ at all. The new one is written next to it and replaces it in one rename.
  const outDir = `${target}.building-${process.pid}`;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'assets'), { recursive: true });
  try {
    await bundleInto(root, model, outDir, options);
  } catch (e) {
    rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
  const previous = `${target}.previous-${process.pid}`;
  if (existsSync(target)) renameSync(target, previous);
  renameSync(outDir, target);
  rmSync(previous, { recursive: true, force: true });
  return { outDir: target };
}

async function bundleInto(root: string, model: Model, outDir: string, options: BundleOptions): Promise<void> {
  const say = options.quiet ? (): void => {} : (line: string): void => console.log(line);   // `muten test` builds without the report

  let result;
  const nativeWeb = libraryOptions(root);   // React Native libraries on the web, and Preact for React when the config says so (bundle-options.ts)
  try {
    result = await esbuild.build({
      entryPoints: { boot: join(root, 'src', 'app.muten') },
      bundle: true, format: 'esm', splitting: true, minify: true, sourcemap: options.sourcemap === true, metafile: true,
      ...nativeWeb, define: { __MUTEN_DEV__: 'false', ...envDefines(root), ...nativeWeb.define }, // prod: DCE the dev-only __muten_rt registry so unused helpers (chart/DnD/arc) tree-shake out
      outdir: outDir, entryNames: 'assets/[name]-[hash]', chunkNames: 'assets/[name]-[hash]',
      assetNames: 'assets/[name]-[hash]', publicPath: '/', logLevel: 'silent',
      plugins: [mutenEsbuild(root, model)],
    });
  } catch (e) {
    const errs = buildFailureErrors(e); // print the oracle/compile errors with file:line:col + code frame, then fail
    if (errs) console.error('\n' + (await esbuild.formatMessages(errs, { kind: 'error', color: true, terminalWidth: 100 })).join('\n'));
    throw new Error(errs ? `bundle failed — ${errs.length} error${errs.length > 1 ? 's' : ''} (see above)` : (e instanceof Error ? e.message : String(e)));
  }

  // the boot is the entry whose entryPoint is app.muten; route chunks are separate outputs.
  // esbuild reports entryPoint relative to cwd (e.g. "src/app.muten", no leading slash), so match either form.
  let jsHref = '';
  for (const [file, meta] of Object.entries(result.metafile.outputs)) {
    if (meta.entryPoint && /(?:^|\/)src\/app\.muten$/.test(meta.entryPoint.replace(/\\/g, '/')) && file.endsWith('.js')) jsHref = '/' + relative(outDir, file).replace(/\\/g, '/');
  }

  // CSS is built outside esbuild (sass + theme + Tailwind), then minified, pruned to the rules the code can match
  // (css-prune.ts) and split into a common sheet plus one per route (css-routes.ts), each content-hashed
  let cssHref = '';
  let routeTag = '';
  let routeSheets: { [page: string]: string } = {};
  const rawCss = await buildCss(root, model);
  if (rawCss) {
    const cssConfig = readMutenConfig(root).css;
    const sheets = writeStyles({ outDir, css: (await esbuild.transform(rawCss, { loader: 'css', minify: true })).code, metafile: result.metafile, html: readIndexHtml(root, model), publicCode: filesText(join(root, 'public'), PUBLIC_CODE), perRoute: cssConfig?.routes !== false, prune: cssConfig?.prune !== false, say });
    cssHref = sheets.href;
    routeSheets = sheets.routes;
    routeTag = routeStylesTag(sheets.routes);
  }

  // index.html: swap the /src/app.muten script for the bundled boot, inject the stylesheet link
  let html = readIndexHtml(root, model);
  html = html.replace(/<script\s+type="module"\s+src="\/src\/app\.muten"\s*><\/script>/, `<script type="module" src="${jsHref}"></script>`);
  if (cssHref) html = html.replace('</head>', () => `  <link rel="stylesheet" href="${cssHref}">${routeTag ? `\n  ${routeTag}` : ''}\n</head>`);
  // what the boot imports, preloaded, and each page's files for the router to ask for at once (route-preload.ts)
  const files = routeFiles(result.metafile, outDir);
  const preloads = routePreloadTags(files);
  if (preloads) html = html.replace('</head>', () => `  ${preloads}\n</head>`);
  const pwa = pwaHead(root);   // muten.config `pwa { }` (pwa.ts)
  if (pwa) html = html.replace('</head>', () => `  ${pwa}\n</head>`);
  // the page's Content-Security-Policy (dev-security.ts): an injected script does not run. muten.config `security { csp }`
  const policy = cspFrom(readMutenConfig(root).security);
  const fullPolicy = policy ? withScriptOrigins(policy, scriptOrigins(root)) : null;
  if (fullPolicy) html = withCsp(html, fullPolicy);   // with the libraries it loads by <script>
  else if (policy === null && !/http-equiv=["']content-security-policy["']/i.test(html)) say('  \x1b[33m!\x1b[0m no Content-Security-Policy: add `security { csp "default" }` to muten.config (or your own policy)');
  // copy public/ (favicons, images, an app's own plain modules and their CSS) to the dist root BEFORE index.html:
  // index.html is written last, so its presence means the build is whole (a server answering a window mid-build
  // can wait for it; written first, a window got the app without its public/ files)
  const pub = join(root, 'public');
  if (existsSync(pub)) for (const e of readdirSync(pub)) cpSync(join(pub, e), join(outDir, e), { recursive: true });
  writeSecurityHeaders(root, outDir);
  writePwa(root, outDir, result.metafile, [cssHref, ...Object.entries(routeSheets).filter(([page]) => page !== '*').map(([, href]) => href)].filter(Boolean), say);
  writeFileSync(join(outDir, 'index.html'), html);

  // every page drawn once and written out as its own HTML, painted before the app runs (prerender.ts)
  const prerenderConfig = readMutenConfig(root).prerender;
  if (options.prerender ?? prerenderConfig !== undefined) {
    await prerender({ root, outDir, routes: model.appIr?.routes || [], config: prerenderConfig || {}, files, sheets: { href: cssHref, routes: routeSheets }, policy: fullPolicy, languages: Object.keys(model.translations || {}), say });
  }

  // app.map.json: the app graph (routes/stores/parts), the root an AI reads to know the whole app. It names every route,
  // guard, store and state field, so it stays on this machine (.muten/), out of the deployed folder.
  writeAppMap(root, await mapApp(root));
  writeBundleRecord(root, result.metafile);

  // what each route ships and who loads every other file (ship-report.ts), so accidental bloat is seen
  say(`\n  bundled → ${relative(root, outDir).replace(/\.building-\d+$/, '')}/\n`);
  const routeList = (model.appIr?.routes ?? []).map((r) => ({ url: r.url, page: r.page }));
  const cssFile = cssHref ? join(outDir, cssHref.replace(/^\//, '')) : null;
  shipReport(result.metafile, routeList, cssFile, say);
  // `budget { js "150kb" css "50kb" }`: a route that ships more stops the build, here, with what weighs most (budget.ts)
  const over = overBudget(result.metafile, routeList, cssFile, readBudget(readMutenConfig(root)), (file) => gzipSync(readFileSync(file)).length);
  if (over.length) throw new Error(`over budget (muten.config budget { }):\n  ${over.join('\n  ')}`);
}

// esbuild rejects build()/rebuild() with a BuildFailure carrying `.errors` (each with a code-frame location);
// pull them out so we can format them Vite-style. null if the failure isn't a build failure (a real crash).
export function buildFailureErrors(e: unknown): esbuild.Message[] | null {
  if (!(e instanceof Error) || !('errors' in e) || !Array.isArray(e.errors) || !e.errors.length) return null;
  return e.errors;
}
