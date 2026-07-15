// analyze: project-aware linter and autocomplete engine.
// Knows the whole app (all parts, all stores, theme) so part-name typos, @ref mismatches,
// and bad store refs are caught in context. Runs in both the extension host and Node (uses node:fs).
// Consumed by extension.js and the CLI `muten lint` command.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { parse } from '#engine/lang/parse.js';
import { readMutenConfig } from '#engine/project/config.js';
import { composeDoc } from '#engine/ir/compose.js';
import { validate } from '#engine/ir/validate.js';
import { closest, diag, ParseError } from '#engine/shared/diagnostics.js';
import { readApi, apiClientNames, readRoutes } from '#engine/project/routes.js';
import { getIconChecker } from '#engine/project/icon-check.js';
import { findStores, storeListEntities } from '#engine/project/load.js';
import { selfUpdateTargets } from '#engine/ir/refs.js';
import { PRIMITIVE_NAMES } from '#engine/lang/manifest.js';
import type { PartDef, Route, Diagnostic, ValidateResult, StateDef, CompletionResult, CompletionState } from '#engine/shared/types.js';

type Parts = { [name: string]: PartDef };

// Loads parts from a folder without resolving styles (the linter doesn't need them).
function loadPartsLite(dir: string): Parts {
  const parts: Parts = {};
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return parts; }
  for (const f of files) {
    if (!f.endsWith('.muten')) continue;
    let ir;
    try { ir = parse(fs.readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const [name, def] of Object.entries(ir.parts || {})) {
      parts[name] = { ...def, state: ir.state || {}, entities: ir.entities || {} };
    }
  }
  return parts;
}

// Loads the parts a muten.config `plugins {}` imports (@muten/<name>), so the linter knows them like local parts.
// Mirrors loadPluginParts (load.ts) but sync + style-free (the linter needs only the part shapes). EVERY registry
// part is loaded - including Custom-backed ones (Chart, …), which are importable now (their .js resolves at compile).
function loadPluginPartsLite(appRoot: string): Parts {
  const parts: Parts = {};
  const plugins = readMutenConfig(appRoot).plugins;
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return parts;
  let req: NodeRequire;
  try { req = createRequire(join(appRoot, 'package.json')); } catch { return parts; }
  for (const name of Object.keys(plugins)) {
    let registryPath: string;
    try { registryPath = req.resolve(`@muten/${name}/registry.json`); } catch { continue; }
    let registry: { components?: Array<{ file: string; component?: string }> };
    try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { continue; }
    const base = dirname(registryPath);
    for (const entry of registry.components || []) {
      let ir;
      try { ir = parse(fs.readFileSync(join(base, entry.file), 'utf8')); } catch { continue; }
      for (const [pname, def] of Object.entries(ir.parts || {})) parts[pname] = { ...def, state: ir.state || {}, entities: ir.entities || {} };
    }
  }
  return parts;
}

// Walks up the directory tree to find the app root (identified by src/pages).
function findAppRoot(filePath: string): string | null {
  let dir = dirname(filePath);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(join(dir, 'src', 'pages'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// Returns every `parts/` folder under src/ (parts are app-global, so all must be scanned).
function allPartsDirs(root: string): string[] {
  const dirs: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(d, e.name);
      if (e.name === 'parts') dirs.push(full);
      else walk(full);
    }
  };
  walk(join(root, 'src'));
  return dirs;
}

// App-global store domains (every *.store under src/) so .muten store refs like cart.total validate.
export function projectStores(filePath: string): string[] {
  const appRoot = findAppRoot(filePath);
  if (!appRoot) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.store')) out.push(e.name.slice(0, -'.store'.length));
    }
  };
  walk(join(appRoot, 'src'));
  return out;
}

// domain -> member names (state + gets + actions) so validate can allow `cart.count` refs
// and page-to-store action calls like `cart.add(d)`. Same walk as projectStores but parses each file.
export function projectStoreMembers(filePath: string): { [domain: string]: string[] } {
  const appRoot = findAppRoot(filePath);
  if (!appRoot) return {};
  const out: { [domain: string]: string[] } = {};
  const walk = (d: string): void => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.store')) {
        const domain = e.name.slice(0, -'.store'.length);
        try {
          const ir = parse(fs.readFileSync(full, 'utf8'));
          out[domain] = [...Object.keys(ir.state || {}), ...Object.keys(ir.gets || {}), ...Object.keys(ir.actions || {})];
        } catch { out[domain] = []; }
      }
    }
  };
  walk(join(appRoot, 'src'));
  return out;
}

// "domain.action" of every store action that updates a signal from its own value — so an `effect { domain.action() }`
// on a PAGE can be flagged as an infinite loop (the effect re-runs on every read, re-triggering the write).
export function projectStoreSelfMut(filePath: string): string[] {
  const appRoot = findAppRoot(filePath);
  if (!appRoot) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.store')) {
        const domain = e.name.slice(0, -'.store'.length);
        try { const ir = parse(fs.readFileSync(full, 'utf8')); for (const [an, a] of Object.entries(ir.actions || {})) if (selfUpdateTargets(a.body || []).length) out.push(`${domain}.${an}`); } catch { /* unparseable store: skip */ }
      }
    }
  };
  walk(join(appRoot, 'src'));
  return out;
}

export function projectParts(filePath: string): Parts {
  const appRoot = findAppRoot(filePath);
  if (!appRoot) return loadPartsLite(join(dirname(filePath), 'parts'));
  const parts: Parts = {};
  Object.assign(parts, loadPluginPartsLite(appRoot));                        // plugin parts (overridable by local)
  for (const d of allPartsDirs(appRoot)) Object.assign(parts, loadPartsLite(d));
  return parts;
}

// Lint the root file (app.muten): every route must point to an existing page, no duplicate URLs.
function analyzeRoutes(filePath: string, routes: Route[]): ValidateResult {
  const appRoot = findAppRoot(filePath);
  const pagesDir = appRoot ? join(appRoot, 'src', 'pages') : null;
  let pageNames: string[] = [];
  if (pagesDir) { try { pageNames = fs.readdirSync(pagesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no pages dir */ } }
  const D: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const r of routes) {
    if (seen.has(r.url)) D.push(diag('dup-route', `duplicate route "${r.url}"`, { loc: r.loc }));
    seen.add(r.url);
    if (pagesDir && !pageNames.includes(r.page)) {
      D.push(diag('unknown-page', `route "${r.url}" → page "${r.page}" not found in src/pages/`, { loc: r.loc, suggestion: closest(r.page, pageNames) }));
    }
  }
  return { ok: D.length === 0, diagnostics: D };
}

// Diagnostics for a file, dispatched by file type (app.muten, theme.muten, .store, or page).
export function analyze(filePath: string, text: string): ValidateResult {
  let ir;
  try { ir = parse(text); }
  catch (e) {
    if (e instanceof ParseError && e.loc) return { ok: false, diagnostics: [diag('syntax', e.message, { loc: e.loc })] };
    return { ok: true, diagnostics: [] };
  }
  if (ir.routes) return analyzeRoutes(filePath, ir.routes); // app.muten: route-level checks only
  if (ir.theme) return { ok: true, diagnostics: [] };       // theme.muten: config only, nothing to validate
  const appRoot = findAppRoot(filePath);
  const apiClients = appRoot ? apiClientNames(readApi(appRoot)) : undefined; // the app's named api clients, so a `post "client:/x"` prefix is checked
  const iconExists = appRoot ? getIconChecker(appRoot) : undefined;          // `Icon "set:name"` existence, so a typo'd icon lights up live instead of only blanking at build
  if (filePath.endsWith('.store')) { // .store domain slice (state + get + action + effect)
    return validate({ screen: 'store', state: ir.state || {}, actions: ir.actions || {}, entities: ir.entities || {}, gets: ir.gets || {}, effects: ir.effects || [], consts: {}, constraints: {}, rootId: undefined, nodes: {} }, { kind: 'store', apiClients });
  }
  const parts = { ...projectParts(filePath) };
  for (const [name, def] of Object.entries(ir.parts || {})) parts[name] = { ...def, state: {}, entities: {}, mock: {}, css: '' }; // the page's OWN inline parts (load() composes these too — without this the IDE falsely flags them unknown)
  const { doc } = composeDoc(ir, parts); // resolve parts (typos flagged) + hoist state -> flat doc
  const storeEntities = appRoot ? storeListEntities(findStores(join(appRoot, 'src'))) : undefined; // element entity of each store list -> cross-store aggregates resolve in the live editor too
  // `readRoutes` throws on a missing/broken app.muten — in the editor that must not blind the page's own linting,
  // so a failure just leaves the route list unthreaded and the link check silently skips.
  let routes: string[] | undefined;
  let selfRoute: string | undefined;
  try {
    if (appRoot) {
      const entries = readRoutes(appRoot);
      routes = entries.map((p) => '/' + p.route);
      const pageName = filePath.replace(/\\/g, '/').split('/').slice(-2)[0];   // src/pages/<name>/<name>.muten
      const own = entries.find((p) => p.page === pageName);
      selfRoute = own ? '/' + own.route : undefined;
    }
  } catch { routes = undefined; selfRoute = undefined; }
  return validate(doc, { parts: Object.keys(parts), stores: projectStores(filePath), storeMembers: projectStoreMembers(filePath), apiClients, iconExists, storeSelfMut: new Set(projectStoreSelfMut(filePath)), storeEntities, routes, selfRoute });
}

// Autocomplete context: parts, state, and actions visible to this file across the whole app.
export function completion(filePath: string, text: string): CompletionResult {
  let ir = null;
  try { ir = parse(text); } catch { /* whatever could be parsed */ }
  const parts = projectParts(filePath);

  const partList = Object.entries(parts).map(([name, def]) => ({ name, params: def.params || [] }));

  const stateList: CompletionState[] = [];
  const addState = (name: string, d: StateDef): void => {
    stateList.push({ name, type: d.type || '', query: typeof d.source === 'string' && d.source.startsWith('query:') });
  };
  for (const [n, d] of Object.entries(ir?.state || {})) addState(n, d);
  for (const def of Object.values(parts)) for (const [n, d] of Object.entries(def.state || {})) addState(n, d); // from used parts

  return { parts: partList, state: stateList, actions: Object.keys(ir?.actions || {}), primitives: PRIMITIVE_NAMES };
}
