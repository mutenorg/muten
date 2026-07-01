// esbuild-muten.ts: the muten build on esbuild instead of Vite. Same job as vite-plugin-muten.ts (compile
// .muten -> JS, serve the runtime/shell/store as virtual modules, run the oracle), wired to esbuild's
// onResolve/onLoad so muten owns the bundler directly — Vite is now only the `--vite` fallback.
//
// `bundleEsbuild` = production build (per-route chunks + source maps + hashed CSS); `devEsbuild` = a dev server
// (own HTTP + esbuild incremental + SSE full-reload). CSS (sass -> theme -> Tailwind) is built as its own
// artifact, not through esbuild's graph. The TS compiler stays the single source of truth — esbuild moves bytes.

import * as esbuild from 'esbuild';
import { readFileSync, existsSync, mkdirSync, writeFileSync, cpSync, rmSync, readdirSync, statSync, watch } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, extname, basename } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { load, loadAllParts, findStores } from '#engine/project/load.js';
import { storeContext, type StoreContext } from '#engine/project/context.js';
import { readMutenConfig, configThemeAdapter, configClasses } from '#engine/project/config.js';
import { apiClientNames } from '#engine/project/routes.js';
import { mapApp } from '#engine/project/map.js';
import { validate } from '#engine/ir/validate.js';
import { ParseError } from '#engine/shared/diagnostics.js';
import { compileModule, compileStore, compileNodePatch } from '#engine/compile/compile.js';
import { emitTheme } from '#engine/style/tokens.js';
import { getIconChecker } from '#engine/project/icon-check.js';
import { makeIconResolver } from './icons.js';
import { Nt } from '#engine/shared/vocab.js';
import type { IR, PartDef, ThemeAdapter, Doc } from '#engine/shared/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = readFileSync(join(here, 'runtime.js'), 'utf8'); // browser runtime, the virtual:muten/runtime module

const RID = 'virtual:muten/runtime';
const SHELL = 'virtual:muten/shell';
const STORE_PREFIX = 'virtual:muten/store/';
const VNS = 'muten-virtual'; // esbuild namespace for the virtual modules

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
}

export async function loadModel(root: string): Promise<Model> {
  const parts = await loadAllParts(root);
  const slices = findStores(join(root, 'src'));
  const appFile = join(root, 'src', 'app.muten');
  const appIr = existsSync(appFile) ? parse(readFileSync(appFile, 'utf8')) : undefined;
  const themeFile = join(root, 'theme.muten');
  const themeRaw = existsSync(themeFile) ? (parse(readFileSync(themeFile, 'utf8')).theme || {}) : {};
  const cfg = readMutenConfig(root);
  let stylesHref: string | null = null;
  for (const name of ['styles.css', 'styles.scss']) if (existsSync(join(root, 'src', name))) { stylesHref = '/src/' + name; break; }
  return {
    parts, slices, store: storeContext(slices), appIr, themeRaw,
    themeAdapter: configThemeAdapter(cfg), classes: configClasses(cfg),
    iconResolver: makeIconResolver(root), iconExists: getIconChecker(root), stylesHref,
  };
}

// The self-booting entry: shell + route map -> mount. The stylesheet is NOT imported here — CSS is built as a
// separate artifact (buildCss) so a new class() in a .muten always re-runs Tailwind, instead of esbuild caching
// an unchanged styles.css and missing it.
function buildBoot(model: Model): string {
  const { appIr } = model;
  const guardDomains = new Set<string>();
  const seen = new Set<string>();
  const routes = (appIr?.routes || []).map((r) => {
    const path = JSON.stringify('/' + r.url.replace(/^\//, ''));
    if (seen.has(path)) throw new Error(`[muten] duplicate route ${path} in app.muten`);
    seen.add(path);
    const imp = `() => import(${JSON.stringify('/src/pages/' + r.page + '/' + r.page + '.muten')})`;
    if (r.guard) {
      const [domain, field] = r.guard.split('.');
      guardDomains.add(domain);
      return `  ${path}: { load: ${imp}, guard: () => ${r.guardNeg ? '!' : ''}__store_${domain}.${field}.get(), redirect: ${JSON.stringify(r.redirect)} },`;
    }
    return `  ${path}: { load: ${imp} },`;
  }).join('\n');
  const guardImports = [...guardDomains].map((d) => `import * as __store_${d} from '${STORE_PREFIX}${d}';`).join('\n');
  return `import * as __shell from '${SHELL}';
import { route, injectCss } from '${RID}';
${guardImports}
const routes = {
${routes}
};
const root = document.getElementById('app');
if (root) {
  injectCss(__shell.css);
  const outlet = __shell.mount(root);
  route(outlet, routes);
}`;
}

// An oracle/syntax diagnostic as an esbuild message — `location` carries file:line:col + the source line, so
// esbuild's own formatter renders a Vite-style code frame in the terminal AND the dev overlay.
const muError = (path: string, message: string, loc?: { line: number; col: number } | null): esbuild.PartialMessage => ({
  text: message,
  location: loc ? { file: path, line: loc.line, column: loc.col - 1, lineText: readFileSync(path, 'utf8').split('\n')[loc.line - 1] ?? '' } : { file: path },
});

// Compile a single .muten page (parse -> compose -> flatten -> validate -> emit), the same path the Vite
// plugin's transform runs. Returns the JS or esbuild-shaped errors from the oracle (syntax + validation).
async function compilePage(root: string, path: string, model: Model, dev = false): Promise<{ contents?: string; errors?: esbuild.PartialMessage[] }> {
  let loaded;
  try { loaded = await load(path, model.parts); }
  catch (e) { if (e instanceof ParseError) return { errors: [muError(path, e.message, e.loc)] }; throw e; } // syntax error -> located message
  const storeMembers = model.store.storeMembers;
  const { ok, diagnostics } = validate(loaded.doc, {
    parts: loaded.partNames, stores: model.store.stores, storeMembers,
    storeEntities: model.store.storeEntities, storeSelfMut: model.store.storeSelfMut,
    iconExists: model.iconExists, apiClients: apiClientNames(model.appIr?.api || {}),
  });
  if (!ok) return { errors: diagnostics.map((d) => muError(path, d.message + (d.suggestion ? ` (did you mean \`${d.suggestion}\`?)` : ''), d.loc)) };
  const customNames = [...new Set(Object.values(loaded.doc.nodes).filter((n) => n.type === Nt.Custom).map((n) => n.props?.component))];
  const components: { [name: string]: string } = {};
  for (const name of customNames) {
    if (!name) continue;
    const cpath = join(root, 'src', 'components', name + '.js');
    if (existsSync(cpath)) components[name] = readFileSync(cpath, 'utf8');
  }
  const sources = { ...(model.appIr?.sources || {}), ...loaded.sources };
  return {
    contents: compileModule(loaded.doc, loaded.data, loaded.styles.css, components, sources, {
      stores: model.store.storesMeta, storeEntities: model.store.storeEntities, api: model.appIr?.api || {},
      iconResolver: model.iconResolver, classes: model.classes, dev, // dev: emit the HMR node registry + el.__muten handle
      sourceMap: { file: path, source: readFileSync(path, 'utf8') }, // runtime errors -> the .muten line, not the compiled JS
    }),
  };
}

// HMR diff: compare the previously-mounted page Doc with the freshly-compiled one, by node id. A change confined
// to a node's own props/text (same type, same children) → patch just that node. Anything touching the signal graph
// or tree shape (declarations, node set, types, children) → full reload. Conservative on purpose.
function diffDoc(a: Doc, b: Doc): { reload: boolean; patches: string[] } {
  const decls = (d: Doc): string => JSON.stringify([d.state, d.actions, d.gets, d.params, d.entities, d.consts, d.effects, d.meta]);
  if (decls(a) !== decls(b)) return { reload: true, patches: [] };
  const ka = Object.keys(a.nodes), kb = Object.keys(b.nodes);
  if (ka.length !== kb.length || kb.some((id) => !a.nodes[id])) return { reload: true, patches: [] };
  const patches: string[] = [];
  for (const id of kb) {
    const na = a.nodes[id], nb = b.nodes[id];
    if (na.type !== nb.type || JSON.stringify(na.children) !== JSON.stringify(nb.children)) return { reload: true, patches: [] };
    if (JSON.stringify(na.props) !== JSON.stringify(nb.props)) patches.push(id);
  }
  return { reload: false, patches };
}

// Tailwind v4, in-process, resolved from the APP (the same packages @tailwindcss/vite uses). We feed it the
// stylesheet + theme.muten's @theme block, scan the .muten files for class() tokens, and emit the final CSS.
// Resolved from the app so muten doesn't carry Tailwind. A minimal typing of just the slice we call.
interface TwSource { base: string; pattern: string; negated: boolean; }
interface TwCompiler { sources: TwSource[]; build(candidates: string[]): string; }
interface TwNode { compile(css: string, opts: { base: string; onDependency: (p: string) => void }): Promise<TwCompiler>; }
interface TwScanner { new (opts: { sources: TwSource[] }): { scan(): string[] }; }

async function runTailwind(css: string, root: string): Promise<string> {
  const req = createRequire(join(root, 'package.json'));
  const node: TwNode = await import(pathToFileURL(req.resolve('@tailwindcss/node')).href);
  const oxide: { Scanner: TwScanner } = await import(pathToFileURL(req.resolve('@tailwindcss/oxide')).href);
  const compiler = await node.compile(css, { base: root, onDependency() {} });
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
async function buildCss(root: string, model: Model): Promise<string> {
  if (!model.stylesHref) return '';
  const file = join(root, model.stylesHref.replace(/^\//, ''));
  let css = readFileSync(file, 'utf8');
  if (file.endsWith('.scss')) {
    const req = createRequire(join(root, 'package.json'));
    const mod = await import(pathToFileURL(req.resolve('sass')).href); // dart-sass is CJS -> API is on .default under dynamic import
    const sass: { compileString(src: string, opts: { loadPaths: string[] }): { css: string } } = mod.default ?? mod;
    css = sass.compileString(css, { loadPaths: [dirname(file)] }).css;
  }
  const block = emitTheme(model.themeRaw, model.themeAdapter);
  if (block) css += '\n\n/* muten: generated from theme.muten */\n' + block;
  if (/@import\s+["']tailwindcss["']|@plugin\s+["']daisyui/.test(css)) {
    try { css = await runTailwind(css, root); lastGoodCss = css; }
    catch (e) { console.warn(`  ⚠ Tailwind step failed (${e instanceof Error ? e.message : String(e)}); serving the last good CSS`); if (lastGoodCss) css = lastGoodCss; }
  }
  return css;
}

// The esbuild plugin: virtual modules (runtime/shell/store), the `~/` and `/src/` path roots, and the
// .muten -> JS loader (with the oracle). CSS is handled separately (buildCss), not here.
export function mutenEsbuild(root: string, model: Model, dev = false): esbuild.Plugin {
  return {
    name: 'muten',
    setup(build) {
      // virtual:muten/* -> our namespace
      build.onResolve({ filter: /^virtual:muten\// }, (args) => ({ path: args.path, namespace: VNS }));
      // `~/` = src root; `/src/...` = app-absolute paths the boot emits (route imports, stylesheet)
      build.onResolve({ filter: /^~\// }, (args) => ({ path: join(root, 'src', args.path.slice(2)) }));
      build.onResolve({ filter: /^\/src\// }, (args) => ({ path: join(root, args.path) }));

      build.onLoad({ filter: /.*/, namespace: VNS }, (args) => {
        if (args.path === RID) return { contents: RUNTIME, loader: 'js', resolveDir: here };
        if (args.path === SHELL) {
          const tree = model.appIr?.shell || { type: Nt.Shell, props: {}, children: [{ type: Nt.Slot, props: {} }] };
          const doc = toDoc({ ...(model.appIr || {}), screen: 'shell', entities: {}, state: {}, actions: {}, tree });
          return { contents: compileModule(doc, {}, '', {}, {}, { stores: model.store.storesMeta, storeEntities: model.store.storeEntities, iconResolver: model.iconResolver, classes: model.classes }), loader: 'js', resolveDir: join(root, 'src') };
        }
        if (args.path.startsWith(STORE_PREFIX)) {
          const domain = args.path.slice(STORE_PREFIX.length);
          const ir = model.slices[domain];
          if (!ir) return { errors: [{ text: `unknown store: ${domain}` }] };
          const imports = (ir.imports || []).map((im) => im.from.startsWith('.') ? { ...im, from: '/' + join('src', im.from).replace(/\\/g, '/') } : im);
          return { contents: compileStore({ state: ir.state || {}, gets: ir.gets || {}, actions: ir.actions || {}, effects: ir.effects || [], entities: ir.entities || {}, imports, domain }, ir.mock || {}, ir.sources || {}), loader: 'js', resolveDir: join(root, 'src') };
        }
        return { errors: [{ text: `unknown virtual module: ${args.path}` }] };
      });

      build.onLoad({ filter: /\.muten$/ }, async (args) => {
        if (args.path.replace(/\\/g, '/').endsWith('/src/app.muten')) return { contents: buildBoot(model), loader: 'js', resolveDir: join(root, 'src') };
        const out = await compilePage(root, args.path, model, dev);
        return out.errors ? { errors: out.errors } : { contents: out.contents, loader: 'js', resolveDir: dirname(args.path) };
      });
    },
  };
}

// `muten bundle` on esbuild: bundle the boot (+ per-route chunks) with source maps, build the CSS separately,
// then write index.html pointing at the hashed outputs and copy public/.
export async function bundleEsbuild(root: string, outDir = join(root, 'dist')): Promise<{ outDir: string }> {
  const model = await loadModel(root);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'assets'), { recursive: true });

  let result;
  try {
    result = await esbuild.build({
      entryPoints: { boot: join(root, 'src', 'app.muten') },
      bundle: true, format: 'esm', splitting: true, minify: true, sourcemap: true, metafile: true,
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

  // CSS is built outside esbuild (sass + theme + Tailwind), then minified + content-hashed for cache-busting.
  let cssHref = '';
  const rawCss = await buildCss(root, model);
  if (rawCss) {
    const css = (await esbuild.transform(rawCss, { loader: 'css', minify: true })).code;
    const hash = createHash('sha256').update(css).digest('hex').slice(0, 8).toUpperCase();
    cssHref = `/assets/boot-${hash}.css`;
    writeFileSync(join(outDir, 'assets', `boot-${hash}.css`), css);
  }

  // index.html: swap the /src/app.muten script for the bundled boot, inject the stylesheet link
  let html = readFileSync(join(root, 'index.html'), 'utf8');
  html = html.replace(/<script\s+type="module"\s+src="\/src\/app\.muten"\s*><\/script>/, `<script type="module" src="${jsHref}"></script>`);
  if (cssHref) html = html.replace('</head>', `  <link rel="stylesheet" href="${cssHref}">\n</head>`);
  writeFileSync(join(outDir, 'index.html'), html);

  // copy public/ (favicons, images) to the dist root
  const pub = join(root, 'public');
  if (existsSync(pub)) for (const e of readdirSync(pub)) cpSync(join(pub, e), join(outDir, e), { recursive: true });

  // app.map.json: the app graph (routes/stores/parts) — the root an AI reads to know the whole app.
  writeFileSync(join(outDir, 'app.map.json'), JSON.stringify(await mapApp(root), null, 2));

  // Per-route ship report: what each route actually ships (gzipped), so "minimal by construction" is visible
  // and accidental bloat is caught. Routes first (their own chunk), then shared chunks (boot/runtime/commons).
  const fmt = (n: number): string => `${(n / 1024).toFixed(1)} KB`.padStart(9);
  const sizeOf = (file: string): { raw: number; gz: number } => { const buf = readFileSync(file); return { raw: buf.length, gz: gzipSync(buf).length }; };
  const row = (label: string, raw: number, gz: number): void => console.log('  ' + label.padEnd(26) + fmt(raw) + '  ' + fmt(gz).trim() + ' gz');
  const claimed = new Set<string>();
  let totalRaw = 0, totalGz = 0;
  console.log(`\n  bundled → ${relative(root, outDir)}/\n`);
  for (const r of model.appIr?.routes ?? []) { // a route's own chunk: dist/assets/<page>-<hash>.js
    const file = Object.keys(result.metafile.outputs).find((o) => basename(o).startsWith(r.page + '-') && o.endsWith('.js') && !claimed.has(o));
    if (!file) continue;
    claimed.add(file); const s = sizeOf(file); totalRaw += s.raw; totalGz += s.gz;
    row('/' + r.url.replace(/^\//, ''), s.raw, s.gz);
  }
  for (const o of Object.keys(result.metafile.outputs)) { // boot + shared/common chunks
    if (claimed.has(o) || !o.endsWith('.js')) continue;
    claimed.add(o); const s = sizeOf(o); totalRaw += s.raw; totalGz += s.gz;
    row('· ' + basename(o).replace(/-[A-Z0-9]+\.js$/, '') + ' (shared)', s.raw, s.gz);
  }
  if (cssHref) { const s = sizeOf(join(outDir, cssHref.replace(/^\//, ''))); totalRaw += s.raw; totalGz += s.gz; row('· styles.css', s.raw, s.gz); }
  console.log('  ' + '─'.repeat(46));
  row('total', totalRaw, totalGz);

  return { outDir };
}

const MIME: { [ext: string]: string } = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// Injected into the dev page: SSE full-reload + a RUNTIME-error overlay. Today an uncaught error (a throwing
// Custom, a bad ref) only hits the console and leaves a blank page; this surfaces it like Vite, with the stack
// (source maps attribute frames to the .muten file). Compile errors use the server-side overlay() instead.
const DEV_CLIENT = `<script>(function(){function show(m){var d=document.getElementById('__mu_err');if(!d){d=document.createElement('div');d.id='__mu_err';document.body.appendChild(d);}d.style.cssText='position:fixed;inset:0;z-index:99999;background:#1a1a1f;color:#ffb4b4;font:13px/1.6 ui-monospace,monospace;overflow:auto';d.innerHTML='<div style="padding:16px 24px;background:#2a1416;color:#ff6b6b;font-weight:600;border-bottom:1px solid #471c1f">muten \\u2014 runtime error</div><pre style="padding:24px;white-space:pre-wrap">'+String(m).replace(/[<&]/g,function(c){return c==='<'?'&lt;':'&amp;';})+'</pre>';}
addEventListener('error',function(e){show((e.error&&e.error.stack)||e.message);});
addEventListener('unhandledrejection',function(e){show('Unhandled promise rejection:\\n'+((e.reason&&e.reason.stack)||e.reason));});
new EventSource('/_reload').onmessage=function(e){var m;try{m=JSON.parse(e.data)}catch(_){return location.reload()}if(m.type!=='patch')return location.reload();var rt=window.__muten_rt,pg=window.__muten_page;if(!rt||!pg||window.__muten_screen!==m.screen)return location.reload();try{for(var i=0;i<m.patches.length;i++){var p=m.patches[i],b=eval('('+p.src+')');if(!rt.patchNode(pg,p.id,function(c,par,n){return b(c,n,par,rt)}))return location.reload();}}catch(err){console.error('[muten hmr]',err);location.reload();}};})();</script>`;

// esbuild rejects build()/rebuild() with a BuildFailure carrying `.errors` (each with a code-frame location);
// pull them out so we can format them Vite-style. null if the failure isn't a build failure (a real crash).
function buildFailureErrors(e: unknown): esbuild.Message[] | null {
  const errs = (e as Partial<esbuild.BuildFailure>)?.errors;
  return Array.isArray(errs) && errs.length ? errs : null;
}

// `muten dev` on esbuild: an incremental JS build kept fully IN MEMORY (write:false → nothing is written to
// the project, no `.muten-dev/` folder) + the CSS rebuilt each pass + a tiny static server with SPA fallback +
// SSE full-reload. On any .muten/.store/theme/muten.config change: refresh the model, rebuild JS + CSS, reload
// the browser — the same coarse-but-correct HMR the Vite plugin used. Oracle errors surface as an overlay.
export async function devEsbuild(root: string, port = 5173): Promise<void> {
  const model = await loadModel(root);
  const outdir = join(root, '.muten-dev'); // a virtual base for output paths only — write:false, so nothing hits disk
  const ctx = await esbuild.context({
    entryPoints: { boot: join(root, 'src', 'app.muten') },
    bundle: true, format: 'esm', splitting: true, sourcemap: true, write: false,
    // entry stays unhashed (index.html references /assets/boot.js); SHARED CHUNKS must be hashed, or ≥2 of them
    // (e.g. the runtime + a shared lib like fruta) both land on assets/chunk.js and esbuild aborts the dev build.
    outdir, entryNames: 'assets/[name]', chunkNames: 'assets/[name]-[hash]', assetNames: 'assets/[name]',
    publicPath: '/', logLevel: 'silent', plugins: [mutenEsbuild(root, model, true)], // dev: HMR registry on
  });

  const clients = new Set<ServerResponse>();
  let lastError = '';
  let files = new Map<string, Uint8Array>(); // url -> bytes (boot.js, route chunks, source maps), all in memory
  let cssBytes: Buffer | null = null;
  const rebuild = async (): Promise<void> => {
    try {
      Object.assign(model, await loadModel(root));
      const result = await ctx.rebuild();
      const next = new Map<string, Uint8Array>();
      for (const f of result.outputFiles ?? []) next.set('/' + relative(outdir, f.path).replace(/\\/g, '/'), f.contents);
      files = next;
      const css = await buildCss(root, model);
      cssBytes = css ? Buffer.from(css) : null;
      if (lastError) console.log('  \x1b[32m✓\x1b[0m fixed');
      lastError = '';
    } catch (e) {
      const errs = buildFailureErrors(e);
      if (errs) {
        // terminal: the same file:line:col + code frame Vite shows; overlay: the plain version (no ANSI).
        console.error('\n' + (await esbuild.formatMessages(errs, { kind: 'error', color: true, terminalWidth: 100 })).join('\n'));
        lastError = (await esbuild.formatMessages(errs, { kind: 'error', color: false })).join('\n');
      } else {
        lastError = e instanceof Error ? e.message : String(e);
        console.error('\n  \x1b[31m✗\x1b[0m ' + lastError);
      }
    }
  };
  await rebuild();

  // HMR: cache the last compiled Doc per page; on a single-page edit, diff it and try a surgical patch, else reload.
  const docCache = new Map<string, Doc>();
  const reload = (): void => { for (const c of clients) c.write('data: {"type":"reload"}\n\n'); };
  const notify = async (changed: string[]): Promise<void> => {
    if (lastError) return reload();
    const pages = changed.filter((f) => f.endsWith('.muten') && f.includes('pages'));
    if (pages.length !== 1) return reload(); // store/theme/config/multi-file edits: full reload
    try {
      const path = pages[0];
      const newDoc = (await load(path, model.parts)).doc;
      const oldDoc = docCache.get(path);
      docCache.set(path, newDoc);
      if (!oldDoc) return reload(); // cold cache (first edit this session) — reload once, patch after
      const diff = diffDoc(oldDoc, newDoc);
      if (diff.reload || !diff.patches.length) return diff.reload ? reload() : undefined; // no visible change → no-op
      const opts = { stores: model.store.storesMeta, storeEntities: model.store.storeEntities, api: model.appIr?.api || {}, iconResolver: model.iconResolver, classes: model.classes };
      const patches = diff.patches.map((id) => ({ id, src: compileNodePatch(newDoc, id, opts) }));
      const msg = JSON.stringify({ type: 'patch', screen: newDoc.screen, patches });
      for (const c of clients) c.write(`data: ${msg}\n\n`);
    } catch { reload(); }
  };

  const indexHtml = (): string => {
    let html = readFileSync(join(root, 'index.html'), 'utf8');
    html = html.replace(/<script\s+type="module"\s+src="\/src\/app\.muten"\s*><\/script>/, '<script type="module" src="/assets/boot.js"></script>');
    if (cssBytes) html = html.replace('</head>', '  <link rel="stylesheet" href="/assets/boot.css">\n</head>');
    return html.replace('</body>', `  ${DEV_CLIENT}\n</body>`);
  };
  const overlay = (): string => `<!doctype html><body style="margin:0;background:#1a1a1f;color:#f5f5f5;font:14px/1.6 ui-monospace,monospace">`
    + `<div style="padding:16px 24px;background:#2a1416;color:#ff6b6b;font-weight:600;border-bottom:1px solid #471c1f">muten — compile error</div>`
    + `<pre style="padding:24px;white-space:pre-wrap;color:#ffb4b4">${lastError.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre>`
    + `<script>new EventSource('/_reload').onmessage=()=>location.reload()</script></body>`;

  createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    res.setHeader('Cache-Control', 'no-cache'); // dev: assets change on every edit (boot.css has no hash); never let the browser serve a stale copy
    if (url === '/_reload') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url === '/_muten/graph') { // the live app graph (routes/stores/parts) — an AI reads the structure without parsing files
      res.setHeader('Content-Type', 'application/json');
      try { res.end(JSON.stringify(await mapApp(root), null, 2)); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); }
      return;
    }
    if (lastError) { res.setHeader('Content-Type', 'text/html'); res.end(overlay()); return; }
    if (url === '/assets/boot.css' && cssBytes) { res.setHeader('Content-Type', 'text/css'); res.end(cssBytes); return; }
    const mem = files.get(url);
    if (mem) { res.setHeader('Content-Type', MIME[extname(url)] || 'application/octet-stream'); res.end(Buffer.from(mem)); return; }
    const pub = join(root, 'public', url); // public assets (favicons, /docs, /code) still come from disk
    if (url !== '/' && existsSync(pub) && !statSync(pub).isDirectory()) { res.setHeader('Content-Type', MIME[extname(pub)] || 'application/octet-stream'); res.end(readFileSync(pub)); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(indexHtml()); // SPA fallback
  }).listen(port, () => console.log(`  muten dev (esbuild) → http://localhost:${port}/`));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = new Set<string>();
  const onChange = (file: string): void => {
    if (file) changed.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => { const batch = [...changed]; changed.clear(); await rebuild(); await notify(batch); }, 40);
  };
  watch(join(root, 'src'), { recursive: true }, (_e, f) => onChange(f ? join(root, 'src', f) : ''));
  for (const f of ['theme.muten', 'muten.config']) { const p = join(root, f); if (existsSync(p)) watch(p, () => onChange(p)); }
}
