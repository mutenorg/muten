// Build orchestration: compiles a host app (.muten files) to dist/<url>/index.html + app.map.json.
// Throws on any error; the CLI (bin/muten.ts) catches, formats, and exits.

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Nt, Fmt } from '#engine/shared/vocab.js';
import { readRoutes, readApi } from '#engine/project/routes.js';
import { renderSsrBody, fetchSources } from '#engine/project/ssr.js';
import { routeEntry } from '#engine/project/map.js';
import { load, loadAllParts, findStores } from '#engine/project/load.js';
import { validateStoresAndGuards } from '#engine/project/check-app.js';
import { validate } from '#engine/ir/validate.js';
import { compile, compileStore } from '#engine/compile/compile.js';
import { formatDiagnostic, ParseError } from '#engine/shared/diagnostics.js';
import type { Diagnostic, AppMap, StoreSlice } from '#engine/shared/types.js';

export async function buildApp(appRoot: string, outDir = join(appRoot, 'dist'), baseUrl = ''): Promise<{ routes: string[]; outDir: string }> {
  const rel = (p: string) => relative(appRoot, p);
  const base = baseUrl.replace(/\/+$/, ''); // app's deploy origin (from --url=) for canonical / og:url / sitemap; '' → relative
  rmSync(outDir, { recursive: true, force: true }); // wipe first so deleted pages don't leave stale routes

  const sharedParts = await loadAllParts(appRoot); // parts are global: load all up front
  if (Object.keys(sharedParts).length) console.log(`Parts: ${Object.keys(sharedParts).join(', ')}`);

  // Validate cross-page store refs (e.g. cart.count, auth.loggedIn) the same way `check` does,
  // so build and check never disagree. Without this, build rejected pages that check passed.
  const storeIRs = findStores(join(appRoot, 'src'));
  const stores = Object.keys(storeIRs);
  const storeMembers: { [d: string]: string[] } = {};
  for (const [d, ir] of Object.entries(storeIRs)) storeMembers[d] = [...Object.keys(ir.state || {}), ...Object.keys(ir.gets || {}), ...Object.keys(ir.actions || {})];
  // storesMeta: same shape passed to compile() by the Vite plugin; without it codegen emits
  // store refs as bare undefined identifiers (missing `import * as __store_...`) -> runtime ReferenceError.
  const storesMeta: { [d: string]: StoreSlice } = {};
  for (const [d, ir] of Object.entries(storeIRs)) storesMeta[d] = { state: Object.keys(ir.state || {}), gets: Object.keys(ir.gets || {}), actions: Object.keys(ir.actions || {}) };

  // .store bodies + route guards: same validation `check` runs (shared check-app.ts, no drift).
  // Without this, a fix only in `check` silently ships broken from `build`.
  const appDiags = validateStoresAndGuards(appRoot, storeIRs, storeMembers);
  if (appDiags.length) throw new Error(appDiags.map((d) => formatDiagnostic(d, d.file)).join('\n'));

  // Standalone HTML has no virtual modules, so each .store slice must be inlined into the page.
  // Dev resolves stores via virtual:muten/store/*; the static build has no equivalent, so
  // compileStore output is stripped of import/export and wrapped as a self-contained IIFE namespace.
  const storeCode = Object.entries(storeIRs).map(([domain, ir]) => {
    const mod = compileStore({ state: ir.state || {}, gets: ir.gets || {}, actions: ir.actions || {}, effects: ir.effects || [], entities: ir.entities || {}, imports: ir.imports || [] }, ir.mock || {}, ir.sources || {});
    const body = mod.replace(/^[ \t]*import .*$/gm, '').replace(/^([ \t]*)export /gm, '$1'); // strip imports/exports so the body is inlineable (runtime + __id are already in scope)
    return `const __store_${domain} = (function () {\n${body}\nreturn { ${storeMembers[domain].join(', ')} };\n})();`;
  }).join('\n');

  const pages = readRoutes(appRoot); // throws on missing/duplicate/dangling routes
  const api = readApi(appRoot);      // app-wide backend config (base + headers) for source fetches
  console.log(`Host app: ${appRoot}`);
  console.log(`Pages: ${pages.map((p) => '/' + p.route).join(', ')}\n`);

  const built: string[] = [];
  // app.map.json: the AI-readable index of the whole app, derived from the build.
  const appMap: AppMap = { app: appRoot.split(/[\\/]/).pop() || '', parts: Object.keys(sharedParts), routes: {} };

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
    const { doc, data, sources, styles, partNames } = loaded;

    // `use` functions live in external .ts files that the standalone build cannot bundle; the page
    // would compile a call with no definition -> runtime ReferenceError. Warn instead of shipping broken HTML.
    // Use `vite build` for a bundle that includes them.
    const useFns = (doc.imports || []).flatMap((i) => i.names);
    if (useFns.length) console.log(`  ⚠ /${page.route}: \`use\` function(s) ${useFns.join(', ')} are NOT inlined into the standalone build — they'll throw at runtime. Use \`vite build\` for a bundle that includes them.`);

    const { ok, diagnostics } = validate(doc, { parts: partNames, stores, storeMembers }); // project-aware validation (parity with `check`)
    if (!ok) throw new Error(`/${page.route}\n` + diagnostics.map((d) => '   ' + formatDiagnostic(d, rel(page.screenPath))).join('\n'));

    // host-written Custom components referenced in the tree are opaque and inlined into the output
    const customNames = [...new Set(Object.values(doc.nodes).filter((n) => n.type === Nt.Custom).map((n) => n.props?.component))];
    const components: { [name: string]: string } = {};
    for (const name of customNames) {
      if (!name) continue;
      const path = join(appRoot, 'src', 'components', name + '.js');
      if (!existsSync(path)) throw new Error(`/${page.route}: Custom component not found: src/components/${name}.js`);
      components[name] = readFileSync(path, 'utf8');
    }

    // Static pages emit zero-JS HTML. Reactive pages emit a CSR shell (empty #app + script);
    // pre-render by executing against the build-time DOM so crawlers and first-paint get real markup.
    // On any SSR failure (stores, exotic Custom), fall back to the CSR shell.
    const csr = compile(doc, data, styles.css, components, sources, { api, stores: storesMeta, storeCode });
    let html = csr, ssrd = false;
    if (csr.includes('<div id="app"></div>')) {
      try {
        // fetch remote sources at build time so source-backed lists pre-render with real data, not just mock
        const ssrData = Object.keys(sources).length ? { ...data, ...await fetchSources(sources, api) } : data;
        const body = renderSsrBody(compile(doc, ssrData, styles.css, components, sources, { format: Fmt.Ssr, api, stores: storesMeta, storeCode }));
        html = csr.replace('<div id="app"></div>', `<div id="app">${body}</div>`);
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
      html = html.replace('<html lang="en">', `<html lang="${esc(m.lang || 'en')}">`).replace('</head>', seo.join('\n') + '\n</head>');
    }
    const pageOut = join(outDir, page.route);
    mkdirSync(pageOut, { recursive: true });
    writeFileSync(join(pageOut, 'index.html'), html);
    console.log(`✓ /${page.route}  →  ${rel(join(pageOut, 'index.html'))}  (${Object.keys(doc.nodes).length} nodes${ssrd ? ', SSR' : csr.includes('<script') ? ', CSR' : ', static'}${styles.from ? ', + ' + styles.from : ''})`);
    built.push(page.route);

    appMap.routes['/' + page.route] = routeEntry(rel(page.screenPath), doc, sources);
  }

  // `muten build` emits static per-route HTML. A stateful multi-page app (shared .store, route guards,
  // persistent shell) needs SPA behavior: each static page reloads from scratch, so store state does NOT
  // persist across navigations and guards aren't enforced. Warn loudly rather than ship a silent lie.
  if (pages.length > 1 && stores.length) console.log(`\n⚠ This app shares a .store across ${pages.length} pages. The static build renders each page standalone, so store state does NOT persist across page navigations (and route guards / a persistent shell aren't wired). For a stateful multi-page SPA, deploy with \`vite build\`.`);

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

  writeFileSync(join(outDir, 'app.map.json'), JSON.stringify(appMap, null, 2));
  console.log(`✓ ${rel(join(outDir, 'app.map.json'))} → app graph (the root the AI reads)`);

  return { routes: built, outDir };
}
