// Build orchestration: compiles a host app (.muten files) to dist/<url>/index.html, and the app graph to .muten/app.map.json.
// Throws on any error; the CLI (bin/muten.ts) catches, formats, and exits.

import { writeAppMap } from './app-map-file.js';
import { cspFrom, withCsp, writeSecurityHeaders, scriptOrigins, withScriptOrigins } from './dev-security.js';
import { writeFileSync, mkdirSync, rmSync, existsSync, cpSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Nt, Fmt } from '#engine/shared/vocab.js';
import { readRoutes, readApi, readSources } from '#engine/project/routes.js';
import { renderSsrBody, fetchSources } from '#engine/project/ssr.js';
import { routeEntry } from '#engine/project/map.js';
import { load, loadAllParts, findStores } from '#engine/project/load.js';
import { storeContext } from '#engine/project/context.js';
import { readMutenConfig, configClasses } from '#engine/project/config.js';
import { pruneCss, filesText, PUBLIC_CODE } from './css-prune.js';
import { guardJs } from '#engine/compile/guard.js';
import { bundleUses, bundleCustoms } from './use-bundle.js';
import { inlineSafe } from '#engine/compile/emit.js';
import { customComponents, buildCss, loadModel } from './esbuild-muten.js';
import { themeLibrary, themeRoot, withThemeRoot } from '#engine/project/theme-library.js';
import { validateStoresAndGuards } from '#engine/project/check-app.js';
import { validate } from '#engine/ir/validate.js';
import { getIconChecker } from '#engine/project/icon-check.js';
import { compile, compileStore } from '#engine/compile/compile.js';
import { readTranslations } from '#engine/project/lang-files.js';
import { readThemeKit } from '#engine/project/theme-values.js';
import { withThemeImports } from '#engine/compile/react-tree.js';
import { makeIconResolver } from './icons.js';
import { formatDiagnostic, ParseError } from '#engine/shared/diagnostics.js';
import type { Diagnostic, AppMap } from '#engine/shared/types.js';

// index.html's <head> without what each built page writes itself (charset, viewport, title, description, the CSP) and
// without the dev entry script: the tags left are the app's own (icons, manifest, fonts, theme-color…).
const OWN_HEAD = /<!--[\s\S]*?-->|<meta\s+charset[^>]*>|<meta\s+name=["'](?:viewport|description)["'][^>]*>|<title>[\s\S]*?<\/title>|<meta\s+http-equiv=["']content-security-policy["'][^>]*>|<script[^>]*src=["']\/src\/app\.muten["'][^>]*>\s*<\/script>/gi;
// the language index.html says the app speaks (`<html lang="es">`): a page without its own `meta { lang }` speaks it too
function indexLang(appRoot: string): string {
  const file = join(appRoot, 'index.html');
  return (existsSync(file) && /<html[^>]*\slang=["']([^"']+)["']/i.exec(readFileSync(file, 'utf8'))?.[1]) || 'en';
}

function indexHeadExtras(appRoot: string): string {
  const file = join(appRoot, 'index.html');
  if (!existsSync(file)) return '';
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
  return head.replace(OWN_HEAD, '').split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

export async function buildApp(appRoot: string, outDir = join(appRoot, 'dist'), baseUrl = ''): Promise<{ routes: string[]; outDir: string }> {
  const rel = (p: string) => relative(appRoot, p);
  const appLang = indexLang(appRoot);   // what a page without `meta { lang }` speaks
  const configured = cspFrom(readMutenConfig(appRoot).security);
  const csp = configured ? withScriptOrigins(configured, scriptOrigins(appRoot)) : configured;   // with the libraries it loads by <script>
  const base = baseUrl.replace(/\/+$/, ''); // app's deploy origin (from --url=) for canonical / og:url / sitemap; '' → relative
  rmSync(outDir, { recursive: true, force: true }); // wipe first so deleted pages don't leave stale routes
  // public/ goes out as it is (images, icons, robots.txt, a manifest), first, so a generated page wins a name clash.
  // The SSG used to leave it behind: every site added its own copy step, and one that forgot deployed 404s.
  mkdirSync(outDir, { recursive: true });
  if (existsSync(join(appRoot, 'public'))) cpSync(join(appRoot, 'public'), outDir, { recursive: true });
  // what index.html's <head> carries beyond what each page writes for itself (a favicon, the manifest, install tags,
  // fonts): every page gets it. The SSG used to drop it, so sites shipped with no favicon and no installable manifest.
  const headExtras = indexHeadExtras(appRoot);

  const sharedParts = await loadAllParts(appRoot); // parts are global: load all up front
  if (Object.keys(sharedParts).length) console.log(`Parts: ${Object.keys(sharedParts).join(', ')}`);

  // Validate cross-page store refs (e.g. cart.count, auth.loggedIn) the same way `check` does,
  // so build and check never disagree. Without this, build rejected pages that check passed.
  const storeIRs = findStores(join(appRoot, 'src'));
  // ONE assembly of the store facts validate + compile need — shared with `check` (lint.ts) and the Vite
  // plugin, so they never disagree: storeMembers (cross-store refs like cart.count), storesMeta (so codegen
  // emits `import * as __store_...`, not a bare undefined ref), storeEntities (cross-store aggregates),
  // storeSelfMut (the effect->store loop guard). All four used to be re-derived here and drifted.
  const storeCtx = storeContext(storeIRs);
  const { stores, storeMembers, storeFns, storeActions, storeSelfMut, storeEntities, storesMeta } = storeCtx;
  const iconExists = getIconChecker(appRoot);
  const translations = readTranslations(appRoot);
  const themeKit = readThemeKit(appRoot);   // theme.muten: its values (`theme.colors.primary`) and its providers
  const themeValues = themeKit?.values;   // src/lang/*.lang: each page carries only the texts it names
  const iconResolver = makeIconResolver(appRoot); // so `Icon "set:name"` renders real SVG in the static HTML (was empty)

  // .store bodies + route guards: same validation `check` runs (shared check-app.ts, no drift).
  // Without this, a fix only in `check` silently ships broken from `build`.
  const appDiags = validateStoresAndGuards(appRoot, storeIRs, storeCtx, translations);
  if (appDiags.length) throw new Error(appDiags.map((d) => formatDiagnostic(d, d.file)).join('\n'));

  // Standalone HTML has no virtual modules, so each .store slice must be inlined into the page.
  // Dev resolves stores via virtual:muten/store/*; the static build has no equivalent, so
  // compileStore output is stripped of import/export and wrapped as a self-contained IIFE namespace.
  const appApi = readApi(appRoot);   // app-wide backend config, so a store's relative sources/`post` resolve against the base
  const storeCode = Object.entries(storeIRs).map(([domain, ir]) => {
    const mod = compileStore({ state: ir.state || {}, gets: ir.gets || {}, fns: ir.fns || {}, actions: ir.actions || {}, effects: ir.effects || [], entities: ir.entities || {}, imports: ir.imports || [], domain, api: appApi, stores: storesMeta, translations }, ir.mock || {}, ir.sources || {});
    const exported = [...mod.matchAll(/^[ \t]*export (?:async )?(?:const|let|function) ([\w$]+)/gm)].map((match) => match[1]);   // what the module really exports: state, gets, fns, actions and their status signals
    const body = mod.replace(/^[ \t]*import .*$/gm, '').replace(/^([ \t]*)export /gm, '$1'); // strip imports/exports so the body is inlineable (runtime + __id are already in scope)
    return `const __store_${domain} = (function () {\n${body}\nreturn { ${exported.join(', ')} };\n})();`;
  }).join('\n');

  // The standalone build is ONE self-contained HTML per route, so the app's look must be inlined: the
  // theme (`theme.muten` -> :root CSS vars) + the project stylesheet (`src/styles.css|scss`, which carries
  // the mu-* base + every class()). The dev server injects these via the boot module; the SSG had neither,
  // so its pages rendered structurally correct but UNSTYLED. Inline them ahead of each page's own styles.
  // the SAME stylesheet `muten bundle` builds (esbuild-muten.ts buildCss): sass, the theme and its library, Tailwind.
  // This build used to assemble its own (raw styles.css + the theme), so a Tailwind app shipped `@import "tailwindcss"`
  // unprocessed and a theme's library never came in.
  const model = await loadModel(appRoot);
  const projectCss = await buildCss(appRoot, model);
  const library = themeLibrary(appRoot, model.themeRaw);
  const rootOfTheme = library && model.themeRaw ? themeRoot(library, model.themeRaw) : { classes: [], scheme: '' };   // what the theme puts on <html>
  // muten.config drives the theme adapter (e.g. Tailwind @theme blocks) + the Form class map — the SAME as dev
  // and `muten bundle`. Without this, the SSG emitted generic :root vars and ignored muten.config entirely.
  const cfg = readMutenConfig(appRoot);
  const classes = configClasses(cfg);
  const appCss = projectCss;
  const keepAllCss = cfg.css?.prune === false;          // muten.config `css { prune false }`: every page keeps the whole sheet
  const publicCode = filesText(join(appRoot, 'public'), PUBLIC_CODE);
  let cssRemoved = 0;

  const pages = readRoutes(appRoot); // throws on missing/duplicate/dangling routes
  const routes = pages.map((p) => '/' + p.route);   // declared urls, leading slash restored — a `Link -> "/x"` must match one
  const api = appApi;                // app-wide backend config (base + headers) for source fetches
  const appSources = readSources(appRoot); // app-wide `sources` (in app.muten) — merged into each page's queries
  console.log(`Host app: ${appRoot}`);
  console.log(`Pages: ${pages.map((p) => '/' + p.route).join(', ')}\n`);

  const built: string[] = [];
  // app.map.json: the AI-readable index of the whole app, derived from the build.
  const appMap: AppMap = { app: appRoot.split(/[\\/]/).pop() || '', parts: Object.keys(sharedParts), stores: storesMeta, routes: {} };

  for (const page of pages) {
    if (page.route.includes(':')) { console.log(`• /${page.route} — skipped (route params run in the SPA runtime, not the static build)`); continue; }
    let loaded;
    try {
      loaded = await load(page.screenPath, sharedParts); // parse, compose parts, flatten to Doc, collect data + styles
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      const d: Diagnostic = { code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null };
      throw new Error(`/${page.route}\n   ` + formatDiagnostic(d, rel(page.screenPath)));
    }
    const { doc, data, sources: pageSources, styles, partNames } = loaded;
    const sources = { ...appSources, ...pageSources }; // app.muten sources resolve the page's `query x`; a page-local source overrides

    // (every replace below takes a FUNCTION: a replacement string reads `$&`/`$1` as patterns, and React's own code,
    // a page title or a CSS string can carry them: the page came out rewritten)
    // the page's `use` functions, bundled into its own script (use-bundle.ts): they used to be left out, with a warning,
    // and the page threw «… is not defined» in the browser
    const useCode = await bundleUses(withThemeImports(doc, themeKit).imports || [], page.screenPath, appRoot);   // with what theme.muten's providers call

    const { ok, diagnostics } = validate(doc, { parts: partNames, stores, storeMembers, storeFns, storeActions, storeEntities, storeSelfMut, iconExists, routes, selfRoute: '/' + page.route, translations, themeValues }); // project-aware validation (FULL parity with `check`)
    if (!ok) throw new Error(`/${page.route}\n` + diagnostics.map((d) => '   ' + formatDiagnostic(d, rel(page.screenPath))).join('\n'));

    // the Custom components the page uses: the app's own or a plugin's (the same lookup as `muten bundle`; this build
    // only read src/components, so a library's Custom parts failed here). One with imports of its own is bundled.
    const { components } = customComponents(appRoot, doc);
    const customNames = [...new Set(Object.values(doc.nodes).filter((n) => n.type === Nt.Custom).map((n) => n.props?.component))];
    // `use element|widget|react` (bundled with the uses); `Dialog.Root` comes from the library `Dialog` names
    const fromNpm = new Set((doc.imports || []).filter((def) => def.kind).flatMap((def) => def.names));   // `use element|widget|react`: bundled with the uses
    for (const name of customNames) if (typeof name === 'string' && name && !components[name] && !fromNpm.has(name.split('.')[0])) throw new Error(`/${page.route}: Custom component not found: src/components/${name}.js (nor in a plugin)`);
    const customCode = await bundleCustoms(components, appRoot);

    // Static pages emit zero-JS HTML. Reactive pages emit a CSR shell (empty #app + script);
    // pre-render by executing against the build-time DOM so crawlers and first-paint get real markup.
    // On any SSR failure (stores, exotic Custom), fall back to the CSR shell.
    const pageCss = appCss + '\n' + styles.css; // theme + project stylesheet + this page's colocated styles
    // a guarded route checks its guard as the page loads (the stores are inlined, so their persisted state is there):
    // the others go to its `else` before anything renders. The router does this in `muten bundle`; here it was skipped.
    const routeGuard = page.guard ? { check: guardJs(page.guard, new Set()), redirect: page.redirect || '/' } : undefined;
    const compiled = compile(doc, data, pageCss, components, sources, { api, stores: storesMeta, storeCode, routeGuard, storeEntities, iconResolver, classes, translations, themeValues, themeKit });
    const prelude = [useCode, customCode].filter(Boolean).join('\n');
    const csr = prelude ? compiled.replace('<script type="module">', () => `<script type="module">\n${inlineSafe(prelude, 'script')}\n`) : compiled;
    let html = csr, ssrd = false;
    if (csr.includes('<div id="app"></div>') && !page.guard) {   // a guarded page is never pre-rendered: its markup is not for everyone
      try {
        // fetch remote sources at build time so source-backed lists pre-render with real data, not just mock
        const ssrData = Object.keys(sources).length ? { ...data, ...await fetchSources(sources, api) } : data;
        const body = renderSsrBody(prelude + '\n' + compile(doc, ssrData, pageCss, components, sources, { format: Fmt.Ssr, api, stores: storesMeta, storeCode, storeEntities, iconResolver, classes, translations, themeValues, themeKit }));
        html = csr.replace('<div id="app"></div>', () => `<div id="app">${body}</div>`);
        ssrd = true;
      } catch { /* keep the CSR shell — the client renders it */ }
    }

    // SEO by nature: per-page canonical + og:url/type + JSON-LD WebPage + `<html lang>`, injected into the
    // <head> from the route + the page's `meta {}` — no per-page work. Absolute URLs when --url= is set.
    {
      const m = doc.meta || {};
      const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      const canonical = base ? `${base}/${page.route}` : '';
      const seo = ['<meta property="og:type" content="website">'];
      if (canonical) seo.push(`<link rel="canonical" href="${esc(canonical)}">`, `<meta property="og:url" content="${esc(canonical)}">`);
      const ld: { [k: string]: string } = { '@context': 'https://schema.org', '@type': 'WebPage', name: m.title || doc.screen };
      if (m.description) ld.description = m.description;
      if (canonical) ld.url = canonical;
      seo.push(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
      if (headExtras) html = html.replace('</head>', () => `${headExtras}\n</head>`);
      html = withThemeRoot(html.replace('<html lang="en">', () => `<html lang="${esc(m.lang || appLang)}">`).replace('</head>', () => seo.join('\n') + '\n</head>'), rootOfTheme);
    }
    // CSS PER PAGE: the page carries the app's whole stylesheet inline; it keeps only the rules its own markup and
    // scripts (and public/) can match (css-prune.ts). Read without the stylesheet itself, or every class looks used.
    if (!keepAllCss && html.includes(pageCss)) {
      const { css: pageOwnCss, removed } = pruneCss(pageCss, html.replace(pageCss, () => '') + '\n' + publicCode);
      if (removed > 0) { html = html.replace(pageCss, () => pageOwnCss); cssRemoved += removed; }
    }
    const pageOut = join(outDir, page.route);
    mkdirSync(pageOut, { recursive: true });
    if (csp) html = withCsp(html, csp); // muten.config `security { csp }`: injected scripts do not run (dev-security.ts)
    writeFileSync(join(pageOut, 'index.html'), html);
    console.log(`✓ /${page.route}  →  ${rel(join(pageOut, 'index.html'))}  (${Object.keys(doc.nodes).length} nodes${ssrd ? ', SSR' : csr.includes('<script') ? ', CSR' : ', static'}${styles.from ? ', + ' + styles.from : ''})`);
    built.push(page.route);

    appMap.routes['/' + page.route] = routeEntry(rel(page.screenPath), doc, sources);
  }

  // `muten build` emits static per-route HTML. A stateful multi-page app (shared .store, route guards,
  // persistent shell) needs SPA behavior: each static page reloads from scratch, so store state does NOT
  // persist across navigations and guards aren't enforced. Warn loudly rather than ship a silent lie.
  if (cssRemoved > 0) console.log(`\n✓ styles: ${(cssRemoved / 1024).toFixed(0)} KB of rules a page could not match left out, across ${built.length} pages (css { prune false } keeps them)`);
  if (pages.length > 1 && stores.length) console.log(`\n⚠ This app shares a .store across ${pages.length} pages. The static build renders each page standalone, so store state does NOT persist across page navigations (and a persistent shell isn't wired). For a stateful multi-page SPA, deploy with \`muten bundle\`.`);

  // emit a route index only when no root route ("/") already wrote dist/index.html,
  // so a "/ -> home" build keeps the home page rather than overwriting it with the listing.
  mkdirSync(outDir, { recursive: true });
  if (!built.includes('')) {
    const links = built.map((route) => `<li><a href="./${route}/">/${route}</a></li>`).join('\n      ');
    writeFileSync(join(outDir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>app</title>\n<h1>Routes</h1>\n<ul>\n      ${links}\n</ul>\n`);
    console.log(`\n✓ ${rel(join(outDir, 'index.html'))} → route index`);
  }
  // SEO by nature: a sitemap + robots.txt so every built route is crawlable/discoverable — derived from the
  // routes, no per-page work. Absolute URLs when `--url=` is given (the sitemap spec wants them); relative
  // otherwise (still useful, and a deploy that knows its host can pass --url=https://…).
  const urls = built.map((r) => `  <url><loc>${base}/${r}</loc></url>`).join('\n');
  writeFileSync(join(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  writeFileSync(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  console.log(`✓ ${rel(join(outDir, 'sitemap.xml'))} + robots.txt (${built.length} route${built.length === 1 ? '' : 's'}${base ? '' : ' — pass --url=https://… for absolute URLs'})`);

  // the app graph names every route, guard, store and field: it stays on this machine (.muten/), out of the deployed folder
  console.log(`✓ ${rel(writeAppMap(appRoot, appMap))} → app graph (the root the AI reads; not deployed)`);

  writeSecurityHeaders(appRoot, outDir); // the host's security headers (_headers), unless the app brought its own
  return { routes: built, outDir };
}
