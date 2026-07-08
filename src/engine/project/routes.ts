// routes: reads src/app.muten and returns typed route + api entries.
// Uses the real engine parser (same path as the linter) so the CLI and editor never disagree.
// Throws with a formatted message on missing app.muten or bad input. Consumed by build.ts and map.ts.
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { ParseError } from '#engine/shared/diagnostics.js';
import type { RouteEntry, Value } from '#engine/shared/types.js';

export function readRoutes(appRoot: string): RouteEntry[] {
  const rel = (p: string) => relative(appRoot, p);
  const root = join(appRoot, 'src', 'app.muten');
  if (!existsSync(root)) {
    throw new Error(`No app.muten at ${rel(root)}\n   Every app needs a root. Create src/app.muten with:\n     routes {\n       / -> home\n     }`);
  }
  let ir;
  try { ir = parse(readFileSync(root, 'utf8')); }
  catch (e) { if (e instanceof ParseError && !e.file) e.file = root; throw e; } // keep file:line:col for the CLI, don't flatten to a bare message
  const pagesDir = join(appRoot, 'src', 'pages');
  const routes: RouteEntry[] = (ir.routes || []).map((r) => ({
    route: r.url.replace(/^\//, ''), page: r.page, screenPath: join(pagesDir, r.page, r.page + '.muten'),
  }));
  if (!routes.length) throw new Error(`${rel(root)} has no routes. Add:  routes { /url -> page }`);
  for (const r of routes) {
    if (!existsSync(r.screenPath)) throw new Error(`route /${r.route} -> ${r.page}: page not found at ${rel(r.screenPath)}`);
  }
  return routes;
}

// App-wide backend config from app.muten `api { base, headers }` ({} if none), applied to every `sources`.
export function readApi(appRoot: string): { [name: string]: Value } {
  const root = join(appRoot, 'src', 'app.muten');
  if (!existsSync(root)) return {};
  try { return parse(readFileSync(root, 'utf8')).api || {}; }
  catch { return {}; }
}

/** The NAMED api clients a `post "client:/path"` can target. The flat `api { base }` form registers NONE
 *  (its keys are base/headers, not clients), so `post "default:/x"` is the classic silent-404 footgun. */
export function apiClientNames(api: { [name: string]: Value }): string[] {
  return ('base' in api || 'headers' in api) ? [] : Object.keys(api);
}

// app-wide `sources { … }` (defined in app.muten next to `api`); a page's `query x` resolves against these.
export function readSources(appRoot: string): { [name: string]: Value } {
  const root = join(appRoot, 'src', 'app.muten');
  if (!existsSync(root)) return {};
  try { return parse(readFileSync(root, 'utf8')).sources || {}; }
  catch { return {}; }
}
