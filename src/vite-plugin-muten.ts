// Vite plugin: compiles .muten files to ESM modules (mount + css) and serves the runtime,
// stores, shell, and router entry as virtual modules. Gives a Muten app a full dev server,
// HMR, and navigation while authoring stays in the .muten DSL.
// Consumed by host apps via vite.config.(t|j)s: plugins: [muten()].

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Plugin, ResolvedConfig, HmrContext, ViteDevServer } from 'vite';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { load, loadAllParts, findStores } from '#engine/project/load.js';
import { storeContext, type StoreContext } from '#engine/project/context.js';
import { getIconChecker } from '#engine/project/icon-check.js';
import { apiClientNames } from '#engine/project/routes.js';
import { validate } from '#engine/ir/validate.js';
import { compileModule, compileStore } from '#engine/compile/compile.js';
import { emitTheme } from '#engine/style/tokens.js';
import { readMutenConfig, configThemeAdapter, configClasses } from '#engine/project/config.js';
import { makeIconResolver } from './icons.js';
import { Nt } from '#engine/shared/vocab.js';
import type { IR, ThemeRaw, ThemeAdapter, ClassValidator, MutenOptions, PartDef } from '#engine/shared/types.js';

// virtual module IDs this plugin owns (leading \0 prevents Vite from resolving them to disk).
const RID = 'virtual:muten/runtime';
const STORE_PREFIX = 'virtual:muten/store/';
const SHELL = 'virtual:muten/shell';

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = readFileSync(join(here, 'runtime.js'), 'utf8'); // browser runtime served verbatim as the virtual:muten/runtime module

export default function muten(options: MutenOptions = {}): Plugin {
  const storeEnabled = options.store !== false;
  let themeRaw: ThemeRaw = options.theme || {};  // FULL theme.muten (incl. colors/radius) -> emitTheme CSS vars
  let classValidator: ClassValidator | undefined; // class() checker backed by the framework's design system
  let appRoot = process.cwd();
  let parts: { [name: string]: PartDef } = {};
  let slices: { [domain: string]: IR } = {};
  let storeCtx: StoreContext = storeContext({}); // store facts (members/entities/selfMut/meta), assembled once per loadProject — shared with check + build
  let iconExists: ReturnType<typeof getIconChecker>; // `Icon "set:name"` existence, the same check `check`/`build` run
  let appIr: IR | undefined;                      // parsed app.muten (shell + routes)
  let stylesHref: string | null = null;           // project stylesheet (/src/styles.css|scss), injected by the boot module
  let configTheme: ThemeAdapter | undefined;      // styling adapter from muten.config (the build config, in muten); overrides the JS option
  let configCls: { [slot: string]: string } | undefined; // Form class map from muten.config styling.classes

  // Generates the self-booting entry module. index.html imports /src/app.muten; the transform hook
  // rewrites it to this: imports the shell + route map (with guards) + stylesheet, then mounts onto
  // #app. The app needs no hand-written main.js.
  const buildBoot = (): string => {
    const guardDomains = new Set<string>();
    const seen = new Set<string>();
    const routes = (appIr?.routes || []).map((r) => {
      const path = JSON.stringify('/' + r.url.replace(/^\//, ''));
      if (seen.has(path)) throw new Error(`[muten] duplicate route ${path} in app.muten`); // parity with check/build (readRoutes)
      seen.add(path);
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

  // (Re)scan the project: parts, store slices, app root, theme, stylesheet.
  // Runs at startup and on each relevant file change in dev. These are read from disk (not the module
  // graph), so without a rescan a newly added/edited part would wrongly report "not a known part".
  const loadProject = async (): Promise<void> => {
    parts = await loadAllParts(appRoot);
    slices = storeEnabled ? findStores(join(appRoot, 'src')) : {};
    storeCtx = storeContext(slices); // ONE store-facts assembly (members/entities/selfMut/meta), shared with check + build
    iconExists = getIconChecker(appRoot);
    const rootFile = join(appRoot, 'src', 'app.muten');
    appIr = existsSync(rootFile) ? parse(readFileSync(rootFile, 'utf8')) : undefined;
    const themeFile = join(appRoot, 'theme.muten');
    themeRaw = existsSync(themeFile) ? (parse(readFileSync(themeFile, 'utf8')).theme || {}) : (options.theme || {});
    // muten.config (muten syntax) is the build config; its `styling {}` block IS the theme adapter + Form class
    // map. ONE reader shared with `muten build` (config.ts), so dev / bundle / SSG never emit different theme.
    const cfg = readMutenConfig(appRoot);
    configTheme = configThemeAdapter(cfg);
    configCls = configClasses(cfg);
    stylesHref = null;
    let stylesPath: string | null = null;
    for (const name of ['styles.css', 'styles.scss']) {
      const p = join(appRoot, 'src', name);
      if (existsSync(p)) { stylesHref = '/src/' + name; stylesPath = p; break; }
    }
    // class() validation is a styling-plugin concern (library-specific), never baked into the core.
    // If a plugin is connected via `muten({ styling: { validate } })`, use it; else class() is unchecked.
    classValidator = (stylesPath && options.styling?.validate) ? await options.styling.validate(stylesPath, appRoot, themeRaw) : undefined;
  };

  // Debounced HMR handler. Pages inline parts/data/theme; shell and stores are virtual modules.
  // Vite served cached output after edits, requiring a manual restart. Fix: re-read disk, invalidate
  // all muten modules from the graph, then full-reload so every .muten/.store/theme/style edit is live.
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const reload = (server: ViteDevServer): void => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      loadProject().then(() => {
        for (const mod of server.moduleGraph.idToModuleMap.values()) {
          const id = mod.id || '';
          if (id.endsWith('.muten') || id.endsWith('/styles.css') || id.endsWith('/styles.scss') || id.includes('virtual:muten/shell') || id.includes('virtual:muten/store/')) {
            server.moduleGraph.invalidateModule(mod); // styles too: a theme.muten edit must re-inject the native theme block
          }
        }
        server.ws.send({ type: 'full-reload' });
      });
    }, 30);
  };

  return {
    name: 'vite-plugin-muten',
    enforce: 'pre',

    // resolve the project once at startup; refreshed on file change in dev via reload().
    async configResolved(config: ResolvedConfig) {
      appRoot = config.root;
      await loadProject();
    },

    resolveId(id: string) {
      if (id === RID || id === SHELL || id.startsWith(STORE_PREFIX)) return '\0' + id;
      // `~/` = the project's `src/` root: ONE absolute path that resolves identically from any .muten file,
      // so the AI never counts `../` (relative depth is pure entropy for a model). Works from page + store
      // virtual modules alike (those have no disk anchor, so relative wouldn't resolve anyway).
      if (id.startsWith('~/')) return join(appRoot, 'src', id.slice(2)).replace(/\\/g, '/');
    },

    load(id: string) {
      if (id === '\0' + RID) return RUNTIME; // browser runtime, served as-is

      if (id.startsWith('\0' + STORE_PREFIX)) { // one store domain -> compiled ESM slice
        const domain = id.slice(('\0' + STORE_PREFIX).length);
        const ir = slices[domain];
        if (ir) {
          // A store compiles to a VIRTUAL module, so a relative `use … from "./x"` has no disk anchor.
          // Rewrite it to a root-absolute path (the store lives at <root>/src/<domain>.store).
          const imports = (ir.imports || []).map((im) => im.from.startsWith('.') ? { ...im, from: '/' + join('src', im.from).replace(/\\/g, '/') } : im);
          return compileStore({ state: ir.state || {}, gets: ir.gets || {}, actions: ir.actions || {}, effects: ir.effects || [], entities: ir.entities || {}, imports, domain }, ir.mock || {}, ir.sources || {});
        }
      }

      if (id === '\0' + SHELL) { // persistent chrome (navbar + slot); falls back to a bare outlet if no shell defined
        const tree = appIr?.shell || { type: Nt.Shell, props: {}, children: [{ type: Nt.Slot, props: {} }] };
        const doc = toDoc({ ...(appIr || {}), screen: 'shell', entities: {}, state: {}, actions: {}, tree }); // spread appIr so shell `imports` survive; chrome stays state/action-free
        // shell + pages emit only their token CSS; reset/base lives in the project stylesheet
        // loaded once via main, so there's no duplicate .stack fighting the cascade.
        return compileModule(doc, {}, '', {}, {}, { stores: storeCtx.storesMeta, storeEntities: storeCtx.storeEntities, iconResolver: makeIconResolver(appRoot), classes: configCls ?? options.styling?.classes });
      }

    },

    async transform(code: string, id: string) {
      // theme.muten -> a native theme block (or generic :root vars), appended to the project stylesheet.
      // `enforce: 'pre'` runs before the user's styling Vite plugin. The adapter (how to emit) comes from
      // `muten({ styling: { theme } })` — pure data in the user's config; the engine knows no library.
      const sheet = id.replace(/\\/g, '/').split('?')[0];
      if (sheet.endsWith('/styles.css') || sheet.endsWith('/styles.scss')) {
        const block = emitTheme(themeRaw, configTheme ?? options.styling?.theme);
        return block ? { code: code + '\n\n/* muten: generated from theme.muten */\n' + block, map: null } : null;
      }
      if (!id.endsWith('.muten')) return null;
      if (id.replace(/\\/g, '/').endsWith('/src/app.muten')) return { code: buildBoot(), map: null }; // app root is the boot entry
      const loaded = await load(id, parts); // engine load() with parts gathered up front, not the Vite hook above
      // store facts (members/entities/selfMut) + icon existence come from storeContext — the SAME context
      // `check`/`build` use, so the dev overlay no longer skips the effect-loop guard or the bad-icon check.
      const { ok, diagnostics } = validate(loaded.doc, { parts: loaded.partNames, stores: storeCtx.stores, storeMembers: storeCtx.storeMembers, storeEntities: storeCtx.storeEntities, storeSelfMut: storeCtx.storeSelfMut, iconExists, classValidator, apiClients: apiClientNames(appIr?.api || {}) });
      if (!ok) {
        // A TRACKABLE live error: point at the exact .muten line with a code frame + the "did you mean",
        // not a flat join of messages. The dev-server overlay then reads like a TypeScript error.
        const first = diagnostics.find((d) => d.loc) || diagnostics[0];
        const rel = id.replace(/\\/g, '/');
        const where = first.loc ? `${rel}:${first.loc.line}:${first.loc.col}` : rel;
        let frame = '';
        if (first.loc) {
          const srcLine = code.split('\n')[first.loc.line - 1] ?? '';
          const gutter = String(first.loc.line);
          frame = `\n  ${gutter} | ${srcLine}\n  ${' '.repeat(gutter.length)} | ${' '.repeat(Math.max(0, first.loc.col - 1))}^`;
        }
        const tip = first.suggestion ? `\n  did you mean \`${first.suggestion}\`?` : '';
        const more = diagnostics.length > 1 ? `\n  (+${diagnostics.length - 1} more problem${diagnostics.length > 2 ? 's' : ''})` : '';
        const err = new Error(`[muten] ${first.message}\n  at ${where}${frame}${tip}${more}`) as Error & { loc?: { file: string; line: number; column: number }; id?: string };
        if (first.loc) { err.loc = { file: id, line: first.loc.line, column: first.loc.col }; err.id = id; }
        throw err;
      }

      const customNames = [...new Set(Object.values(loaded.doc.nodes).filter((n) => n.type === Nt.Custom).map((n) => n.props?.component))];
      const components: { [name: string]: string } = {};
      for (const name of customNames) {
        if (!name) continue;
        const path = join(appRoot, 'src', 'components', name + '.js');
        if (existsSync(path)) components[name] = readFileSync(path, 'utf8');
      }

      // sources live in app.muten (next to `api`), so a page's `query x` resolves against the APP's sources; a page-local `sources` block still overrides.
      return { code: compileModule(loaded.doc, loaded.data, loaded.styles.css, components, { ...(appIr?.sources || {}), ...loaded.sources }, { stores: storeCtx.storesMeta, storeEntities: storeCtx.storeEntities, api: appIr?.api || {}, iconResolver: makeIconResolver(appRoot), classes: configCls ?? options.styling?.classes }), map: null };
    },

    handleHotUpdate(ctx: HmrContext) {
      // return [] so Vite skips its default HMR; reload() handles invalidation + full-reload
      if (ctx.file.endsWith('.muten') || ctx.file.endsWith('.store')) { reload(ctx.server); return []; }
    },

    configureServer(server: ViteDevServer) {
      // Parts, stores, theme, app.muten, and styles are read from disk (not the module graph) and
      // pages inline them, so HMR alone never sees changes to these files. Watch everything muten-relevant:
      // add/change/unlink -> reload() re-reads, invalidates, and full-reloads (debounced).
      const onFile = (f: string): void => {
        const p = f.replace(/\\/g, '/');
        // covers .muten/.store/styles and Custom component JS (pages inline these too)
        if (p.endsWith('.muten') || p.endsWith('.store') || p.endsWith('/muten.config') || p.endsWith('/styles.css') || p.endsWith('/styles.scss')
          || (p.includes('/components/') && p.endsWith('.js'))) reload(server);
      };
      server.watcher.on('add', onFile);
      server.watcher.on('change', onFile);
      server.watcher.on('unlink', onFile);

      // Vite won't route /src/app.muten through `transform` on a direct browser fetch (it's not a JS file).
      // Serve the compiled boot explicitly. Production resolves it via transform + Rollup.
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
