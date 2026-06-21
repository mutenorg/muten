// Vite plugin: compiles `.muten` files to ESM modules (mount + css) via the Muten engine, and serves
// the runtime, the app-global stores, the persistent shell and the router entry — so a Muten app gets
// npm + a dev server + HMR + navigation while authoring stays the .muten DSL.
//
//   muten()                → stores on if any `.store` exists; shell + router from app.muten
//   muten({ store: false}) → stores off

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import type { Plugin, ResolvedConfig, HmrContext, ViteDevServer } from 'vite';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { load, loadAllParts } from '#engine/project/load.js';
import { validate } from '#engine/ir/validate.js';
import { compileModule, compileStore } from '#engine/compile/compile.js';
import { mergeTheme } from '#engine/style/tokens.js';
import { Nt } from '#engine/shared/vocab.js';
import type { IR, Theme, MutenOptions, StoreSlice, PartDef } from '#engine/shared/types.js';

// virtual modules this plugin owns (resolved with a leading \0 so Vite leaves them to us).
const RID = 'virtual:muten/runtime';
const STORE_PREFIX = 'virtual:muten/store/';
const SHELL = 'virtual:muten/shell';

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = readFileSync(join(here, 'runtime.js'), 'utf8'); // the browser runtime, served verbatim

// every *.store file under a directory → its parsed IR, keyed by domain name.
function findStores(dir: string, out: { [domain: string]: IR } = {}): { [domain: string]: IR } {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findStores(full, out);
    else if (entry.name.endsWith('.store')) out[basename(entry.name, '.store')] = parse(readFileSync(full, 'utf8'));
  }
  return out;
}

export default function muten(options: MutenOptions = {}): Plugin {
  const storeEnabled = options.store !== false;
  let theme: Theme = mergeTheme(options.theme);  // the project's theme; overridden by theme.muten if present
  let appRoot = process.cwd();
  let parts: { [name: string]: PartDef } = {};
  let slices: { [domain: string]: IR } = {};
  const storesMeta: { [domain: string]: StoreSlice } = {}; // which members each store exposes (for ref resolution)
  let appIr: IR | undefined;                      // parsed app.muten (shell + routes)
  let stylesHref: string | null = null;           // the project stylesheet (/src/styles.css|scss), imported by the boot

  // The self-booting entry. index.html imports `/src/app.muten`, and the transform hook below turns
  // that root into this module: it pulls in the shell, the route→module map (+ guards) and the
  // project stylesheet, then mounts onto #app. The app needs no hand-written main.js.
  const buildBoot = (): string => {
    const guardDomains = new Set<string>();
    const routes = (appIr?.routes || []).map((r) => {
      const path = JSON.stringify('/' + r.url.replace(/^\//, ''));
      const imp = `() => import(${JSON.stringify('/src/pages/' + r.page + '/' + r.page + '.muten')})`;
      if (r.guard) {
        const [domain, field] = r.guard.split('.');
        guardDomains.add(domain);
        return `  ${path}: { load: ${imp}, guard: () => ${r.guardNeg ? '!' : ''}__store_${domain}.${field}.get(), redirect: ${JSON.stringify(r.redirect)} },`;
      }
      return `  ${path}: { load: ${imp} },`;
    }).join('\n');
    const guardImports = [...guardDomains].map((domain) => `import * as __store_${domain} from '${STORE_PREFIX}${domain}';`).join('\n');
    return `import * as __shell from '${SHELL}';
import { route, injectCss } from '${RID}';
${stylesHref ? `import ${JSON.stringify(stylesHref)};\n` : ''}${guardImports}
const routes = {
${routes}
};
const root = document.getElementById('app');
if (root) {
  injectCss(__shell.css);
  const outlet = __shell.mount(root);
  route(outlet, routes);
}`;
  };

  return {
    name: 'vite-plugin-muten',
    enforce: 'pre',

    // resolve the project: gather parts, store slices, the app root and the theme — once, up front.
    async configResolved(config: ResolvedConfig) {
      appRoot = config.root;
      parts = await loadAllParts(appRoot);
      if (storeEnabled) {
        slices = findStores(join(appRoot, 'src'));
        for (const [domain, ir] of Object.entries(slices)) {
          storesMeta[domain] = { state: Object.keys(ir.state || {}), gets: Object.keys(ir.gets || {}), actions: Object.keys(ir.actions || {}) };
        }
      }
      const rootFile = join(appRoot, 'src', 'app.muten');
      if (existsSync(rootFile)) appIr = parse(readFileSync(rootFile, 'utf8'));
      const themeFile = join(appRoot, 'theme.muten');
      if (existsSync(themeFile)) theme = mergeTheme(parse(readFileSync(themeFile, 'utf8')).theme || {});
      // the project's look: imported by the boot module so the app needs no hand-written entry.
      for (const name of ['styles.css', 'styles.scss']) {
        if (existsSync(join(appRoot, 'src', name))) { stylesHref = '/src/' + name; break; }
      }
    },

    resolveId(id: string) { if (id === RID || id === SHELL || id.startsWith(STORE_PREFIX)) return '\0' + id; },

    load(id: string) {
      if (id === '\0' + RID) return RUNTIME; // the runtime, served as-is

      if (id.startsWith('\0' + STORE_PREFIX)) { // one store domain → its compiled ESM slice
        const ir = slices[id.slice(('\0' + STORE_PREFIX).length)];
        if (ir) return compileStore({ state: ir.state || {}, gets: ir.gets || {}, actions: ir.actions || {}, effects: ir.effects || [], entities: ir.entities || {} }, ir.mock || {}, ir.sources || {});
      }

      if (id === '\0' + SHELL) { // persistent chrome (navbar + slot); falls back to a bare outlet
        const tree = appIr?.shell || { type: Nt.Shell, props: {}, children: [{ type: Nt.Slot, props: {} }] };
        const doc = toDoc({ screen: 'shell', entities: {}, state: {}, actions: {}, tree });
        // shell + pages emit ONLY their token CSS; the reset/base lives in the project stylesheet
        // (loaded once via main), so there's no duplicate .stack to fight the cascade.
        return compileModule(doc, {}, '', {}, {}, { stores: storesMeta, theme });
      }

    },

    async transform(code: string, id: string) {
      if (!id.endsWith('.muten')) return null;
      if (id.replace(/\\/g, '/').endsWith('/src/app.muten')) return { code: buildBoot(), map: null }; // the root IS the entry
      const loaded = await load(id, parts); // engine load() (parts gathered up front), not the hook above
      const { ok, diagnostics } = validate(loaded.doc, { parts: loaded.partNames, stores: Object.keys(storesMeta), theme });
      if (!ok) throw new Error('muten: ' + diagnostics.map((d) => d.message).join(' · '));

      const customNames = [...new Set(Object.values(loaded.doc.nodes).filter((n) => n.type === Nt.Custom).map((n) => n.props?.component))];
      const components: { [name: string]: string } = {};
      for (const name of customNames) {
        if (!name) continue;
        const path = join(appRoot, 'src', 'components', name + '.js');
        if (existsSync(path)) components[name] = readFileSync(path, 'utf8');
      }

      return { code: compileModule(loaded.doc, loaded.data, loaded.styles.css, components, loaded.sources, { stores: storesMeta, theme }), map: null };
    },

    handleHotUpdate(ctx: HmrContext) {
      if (ctx.file.endsWith('.muten') || ctx.file.endsWith('.store')) ctx.server.ws.send({ type: 'full-reload' });
    },

    // Dev only: Vite won't route a non-JS html entry (/src/app.muten) through `transform` on a direct
    // browser fetch, so serve the compiled boot for it explicitly. (The production build resolves the
    // same entry via `transform` + Rollup.) transformRequest runs the full pipeline, so the boot's
    // imports come back already rewritten to dev URLs.
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if ((req.url || '').split('?')[0] !== '/src/app.muten') { next(); return; }
        server.transformRequest('/src/app.muten').then((result) => {
          if (!result) { next(); return; }
          res.setHeader('Content-Type', 'text/javascript');
          res.end(result.code);
        }, next);
      });
    },
  };
}
