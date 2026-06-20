// Build orchestration: a HOST APP (.screen files) → <app>/dist/<url>/index.html + app.map.json.
// Pure-ish library function: throws on any error (the CLI in bin/muten.js formats + exits).

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import { readRoutes } from './engine/routes.js';
import { load, loadAllParts } from './engine/load.js';
import { validate } from './engine/validate.js';
import { compile } from './engine/compile.js';
import { formatDiagnostic, ParseError } from './engine/diagnostics.js';

export async function buildApp(appRoot, outDir = join(appRoot, 'dist')) {
  const rel = (p) => relative(appRoot, p);
  rmSync(outDir, { recursive: true, force: true }); // clean: no stale routes from deleted pages

  const sharedParts = await loadAllParts(appRoot); // ALL parts in the app (global)
  if (Object.keys(sharedParts).length) console.log(`Parts: ${Object.keys(sharedParts).join(', ')}`);

  const pages = readRoutes(appRoot); // throws on bad routes
  console.log(`Host app: ${appRoot}`);
  console.log(`Pages: ${pages.map((p) => '/' + p.route).join(', ')}\n`);

  const built = [];
  // the "root that knows everything" (north star) = a generated index, derived from the build.
  const appMap = { app: appRoot.split(/[\\/]/).pop(), parts: Object.keys(sharedParts), routes: {} };

  for (const page of pages) {
    let loaded;
    try {
      loaded = await load(page.screenPath, sharedParts); // parse + compose + doc + data + styles
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      throw new Error(`/${page.route}\n   ` + formatDiagnostic({ code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null }, rel(page.screenPath)));
    }
    const { doc, data, sources, styles, partNames } = loaded;

    const { ok, diagnostics } = validate(doc, { parts: partNames }); // project-aware: catches part typos too
    if (!ok) throw new Error(`/${page.route}\n` + diagnostics.map((d) => '   ' + formatDiagnostic(d, rel(page.screenPath))).join('\n'));

    // load host-written Custom components referenced in the tree (opaque, inlined into the output)
    const customNames = [...new Set(Object.values(doc.nodes).filter((n) => n.type === 'Custom').map((n) => n.props?.component).filter(Boolean))];
    const components = {};
    for (const name of customNames) {
      const cp = join(appRoot, 'src', 'components', name + '.js');
      if (!existsSync(cp)) throw new Error(`/${page.route}: Custom component not found: src/components/${name}.js`);
      components[name] = readFileSync(cp, 'utf8');
    }

    const pageOut = join(outDir, page.route);
    mkdirSync(pageOut, { recursive: true });
    writeFileSync(join(pageOut, 'index.html'), compile(doc, data, styles.css, components, sources));
    console.log(`✓ /${page.route}  →  ${rel(join(pageOut, 'index.html'))}  (${Object.keys(doc.nodes).length} nodes${styles.from ? ', + ' + styles.from : ''})`);
    built.push(page.route);

    appMap.routes['/' + page.route] = {
      file: rel(page.screenPath),
      models: Object.keys(doc.entities),
      state: Object.fromEntries(Object.entries(doc.state).map(([k, d]) =>
        [k, typeof d.source === 'string' ? d.source : (d.initial ?? null)])),
      sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, typeof v === 'string' ? v : v.url])),
    };
  }

  // route index (minimal app shell) + the generated app graph
  mkdirSync(outDir, { recursive: true });
  const links = built.map((r) => `<li><a href="./${r}/">/${r}</a></li>`).join('\n      ');
  writeFileSync(join(outDir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>app</title>\n<h1>Routes</h1>\n<ul>\n      ${links}\n</ul>\n`);
  writeFileSync(join(outDir, 'app.map.json'), JSON.stringify(appMap, null, 2));
  console.log(`\n✓ ${rel(join(outDir, 'index.html'))} → route index`);
  console.log(`✓ ${rel(join(outDir, 'app.map.json'))} → app graph (the root the AI reads)`);

  return { routes: built, outDir };
}
