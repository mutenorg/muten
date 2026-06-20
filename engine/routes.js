// The app's routes — src/app.muten `routes { /url -> page }`. Single source of truth the AI reads.
// REQUIRED: no app.muten, no app. Throws on bad input (the CLI formats + exits).
// Parsed by the real engine parser (same as the editor lints) — no regex hack.
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from './parse.js';

export function readRoutes(appRoot) {
  const rel = (p) => relative(appRoot, p);
  const root = join(appRoot, 'src', 'app.muten');
  if (!existsSync(root)) {
    throw new Error(`No app.muten at ${rel(root)}\n   Every app needs a root. Create src/app.muten with:\n     routes {\n       / -> home\n     }`);
  }
  let ir;
  try { ir = parse(readFileSync(root, 'utf8')); }
  catch (e) { throw new Error(`${rel(root)}: ${e.message}`); }
  const pagesDir = join(appRoot, 'src', 'pages');
  const routes = (ir.routes || []).map((r) => ({
    route: r.url.replace(/^\//, ''), page: r.page, screenPath: join(pagesDir, r.page, r.page + '.muten'),
  }));
  if (!routes.length) throw new Error(`${rel(root)} has no routes. Add:  routes { /url -> page }`);
  for (const r of routes) {
    if (!existsSync(r.screenPath)) throw new Error(`route /${r.route} -> ${r.page}: page not found at ${rel(r.screenPath)}`);
  }
  return routes;
}
