// Build orchestration: a host app (.muten files) → <app>/dist/<url>/index.html + app.map.json.
// A pure-ish library function: it throws on any error; the CLI (bin/muten.ts) formats + exits.

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
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

export async function buildApp(appRoot: string, outDir = join(appRoot, 'dist')): Promise<{ routes: string[]; outDir: string }> {
  const rel = (p: string) => relative(appRoot, p);
  rmSync(outDir, { recursive: true, force: true }); // clean: no stale routes left from deleted pages

  const sharedParts = await loadAllParts(appRoot); // every part in the app (parts are global)
  if (Object.keys(sharedParts).length) console.log(`Parts: ${Object.keys(sharedParts).join(', ')}`);

  // Store domains + members → validate cross-page store refs (cart.count, auth.loggedIn) the SAME way `check`
  // does (lint.ts). Without this, `build` REJECTED every store-using page that `check` passed (check≠build).
  const storeIRs = findStores(join(appRoot, 'src'));
  const stores = Object.keys(storeIRs);
  const storeMembers: { [d: string]: string[] } = {};
  for (const [d, ir] of Object.entries(storeIRs)) storeMembers[d] = [...Object.keys(ir.state || {}), ...Object.keys(ir.gets || {}), ...Object.keys(ir.actions || {})];
  // storesMeta = the same shape the Vite plugin passes to compile() — WITHOUT it, codegen emits store refs
  // as bare undefined identifiers (no `import * as __store_…`) → runtime ReferenceError. The other half of A1.
  const storesMeta: { [d: string]: StoreSlice } = {};
  for (const [d, ir] of Object.entries(storeIRs)) storesMeta[d] = { state: Object.keys(ir.state || {}), gets: Object.keys(ir.gets || {}), actions: Object.keys(ir.actions || {}) };

  // store bodies + route guards — the SAME validation `check` runs (shared check-app.ts, no drift). Without
  // this, a fix that lives only in `check` silently ships broken from `build` (the check≠build class).
  const appDiags = validateStoresAndGuards(appRoot, storeIRs, storeMembers);
  if (appDiags.length) throw new Error(appDiags.map((d) => formatDiagnostic(d, d.file)).join('\n'));

  // The CLI build emits STANDALONE HTML (no virtual modules), so each `.store` slice must be INLINED into the
  // page — else `__store_X` is referenced but never defined → runtime ReferenceError (the dev/vite path
  // resolves them via `virtual:muten/store/*`; the SSG had no equivalent). `compileStore` gives an ESM module;
  // strip its import/export and wrap it as a self-contained `const __store_X = (function(){…})()` namespace.
  const storeCode = Object.entries(storeIRs).map(([domain, ir]) => {
    const mod = compileStore({ state: ir.state || {}, gets: ir.gets || {}, actions: ir.actions || {}, effects: ir.effects || [], entities: ir.entities || {}, imports: ir.imports || [] }, ir.mock || {}, ir.sources || {});
    const body = mod.replace(/^[ \t]*import .*$/gm, '').replace(/^([ \t]*)export /gm, '$1'); // module → inline-able (runtime + __id are already in the page scope)
    return `const __store_${domain} = (function () {\n${body}\nreturn { ${storeMembers[domain].join(', ')} };\n})();`;
  }).join('\n');

  const pages = readRoutes(appRoot); // throws on a missing/duplicate/dangling route
  const api = readApi(appRoot);      // app-wide backend config (base + headers) for every page's sources
  console.log(`Host app: ${appRoot}`);
  console.log(`Pages: ${pages.map((p) => '/' + p.route).join(', ')}\n`);

  const built: string[] = [];
  // the "root that knows everything" (north star): an index of the app, derived from the build.
  const appMap: AppMap = { app: appRoot.split(/[\\/]/).pop() || '', parts: Object.keys(sharedParts), routes: {} };

  for (const page of pages) {
    if (page.route.includes(':')) { console.log(`• /${page.route} — skipped (route params run in the SPA runtime, not the static build)`); continue; }
    let loaded;
    try {
      loaded = await load(page.screenPath, sharedParts); // parse + compose + flatten + data + styles
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      const d: Diagnostic = { code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null };
      throw new Error(`/${page.route}\n   ` + formatDiagnostic(d, rel(page.screenPath)));
    }
    const { doc, data, sources, styles, partNames } = loaded;

    // `use` logic functions live in external .ts files that the standalone build CANNOT inline (no bundler).
    // The page compiles a CALL to them with no definition → runtime ReferenceError. Warn loudly instead of
    // shipping silently-broken HTML (the deploy path for `use` is `vite build`, which bundles them).
    const useFns = (doc.imports || []).flatMap((i) => i.names);
    if (useFns.length) console.log(`  ⚠ /${page.route}: \`use\` function(s) ${useFns.join(', ')} are NOT inlined into the standalone build — they'll throw at runtime. Use \`vite build\` for a bundle that includes them.`);

    const { ok, diagnostics } = validate(doc, { parts: partNames, stores, storeMembers }); // project-aware: parts + stores (parity with `check`)
    if (!ok) throw new Error(`/${page.route}\n` + diagnostics.map((d) => '   ' + formatDiagnostic(d, rel(page.screenPath))).join('\n'));

    // host-written Custom components referenced in the tree (opaque, inlined into the output)
    const customNames = [...new Set(Object.values(doc.nodes).filter((n) => n.type === Nt.Custom).map((n) => n.props?.component))];
    const components: { [name: string]: string } = {};
    for (const name of customNames) {
      if (!name) continue;
      const path = join(appRoot, 'src', 'components', name + '.js');
      if (!existsSync(path)) throw new Error(`/${page.route}: Custom component not found: src/components/${name}.js`);
      components[name] = readFileSync(path, 'utf8');
    }

    // A static page already comes out as zero-JS HTML. A reactive page comes out as a CSR shell (empty
    // #app + script); pre-render its content by executing it against the build-time DOM and injecting the
    // result, so crawlers/first-paint get real markup. On any failure (stores, exotic Custom) keep the shell.
    const csr = compile(doc, data, styles.css, components, sources, { api, stores: storesMeta, storeCode });
    let html = csr, ssrd = false;
    if (csr.includes('<div id="app"></div>')) {
      try {
        // bake remote sources into the build-time data so source-backed lists pre-render too (not just mock)
        const ssrData = Object.keys(sources).length ? { ...data, ...await fetchSources(sources, api) } : data;
        const body = renderSsrBody(compile(doc, ssrData, styles.css, components, sources, { format: Fmt.Ssr, api, stores: storesMeta, storeCode }));
        html = csr.replace('<div id="app"></div>', `<div id="app">${body}</div>`);
        ssrd = true;
      } catch { /* keep the CSR shell — the client renders it */ }
    }

    const pageOut = join(outDir, page.route);
    mkdirSync(pageOut, { recursive: true });
    writeFileSync(join(pageOut, 'index.html'), html);
    console.log(`✓ /${page.route}  →  ${rel(join(pageOut, 'index.html'))}  (${Object.keys(doc.nodes).length} nodes${ssrd ? ', SSR' : csr.includes('<script') ? ', CSR' : ', static'}${styles.from ? ', + ' + styles.from : ''})`);
    built.push(page.route);

    appMap.routes['/' + page.route] = routeEntry(rel(page.screenPath), doc, sources);
  }

  // `muten build` emits STATIC per-route HTML (great for content/landing). A stateful multi-page app — a shared
  // .store across pages, route guards, a persistent shell — is an SPA: each static page reloads from scratch, so
  // store state does NOT persist across navigations and guards aren't enforced. Warn instead of shipping a silent lie.
  if (pages.length > 1 && stores.length) console.log(`\n⚠ This app shares a .store across ${pages.length} pages. The static build renders each page standalone, so store state does NOT persist across page navigations (and route guards / a persistent shell aren't wired). For a stateful multi-page SPA, deploy with \`vite build\`.`);

  // the app graph + a route index — but only when no root route ("/") already wrote dist/index.html,
  // so a `/ -> home` build keeps the home page there instead of clobbering it with the listing.
  mkdirSync(outDir, { recursive: true });
  if (!built.includes('')) {
    const links = built.map((route) => `<li><a href="./${route}/">/${route}</a></li>`).join('\n      ');
    writeFileSync(join(outDir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>app</title>\n<h1>Routes</h1>\n<ul>\n      ${links}\n</ul>\n`);
    console.log(`\n✓ ${rel(join(outDir, 'index.html'))} → route index`);
  }
  writeFileSync(join(outDir, 'app.map.json'), JSON.stringify(appMap, null, 2));
  console.log(`✓ ${rel(join(outDir, 'app.map.json'))} → app graph (the root the AI reads)`);

  return { routes: built, outDir };
}
