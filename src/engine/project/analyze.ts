// analyze: project-aware linter and autocomplete engine.
// Knows the whole app (all parts, all stores, theme) so part-name typos, @ref mismatches,
// and bad store refs are caught in context. Runs in both the extension host and Node (uses node:fs).
// Consumed by extension.js and the CLI `muten lint` command.

import { pluginNames } from '#engine/project/plugins.js';
import { layoutDiagnostics } from '#engine/project/layouts.js';
import { anchorImports } from '#engine/project/imports.js';
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { parse } from '#engine/lang/parse.js';
import { composeDoc } from '#engine/ir/compose.js';
import { validate } from '#engine/ir/validate.js';
import { closest, diag, ParseError } from '#engine/shared/diagnostics.js';
import { readApi, apiClientNames, readRoutes } from '#engine/project/routes.js';
import { getIconChecker } from '#engine/project/icon-check.js';
import { findStores } from '#engine/project/load.js';
import { storeContext } from '#engine/project/context.js';
import { PRIMITIVE_NAMES } from '#engine/lang/manifest.js';
import { checkTestFile } from '#engine/project/check-tests.js';
import { checkThemeText } from '#engine/project/theme-check.js';
import { checkConfigText } from '#engine/project/config-check.js';
import { findAppRoot } from '#engine/project/load.js';
import { withUseTypes } from '#engine/project/npm-types.js';
import { readTranslations, LANG_EXT } from '#engine/project/lang-files.js';
import { readThemeValues } from '#engine/project/theme-values.js';
import { checkLangText } from '#engine/project/lang-check.js';
import { storeDiagnostics } from '#engine/project/check-app.js';
import { TEST_EXT } from '#engine/shared/vocab.js';
import type { PartDef, Route, RouteEntry, Diagnostic, ValidateResult, StateDef, CompletionResult, CompletionState } from '#engine/shared/types.js';

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
      parts[name] = { ...def, state: ir.state || {}, entities: ir.entities || {}, imports: anchorImports(join(dir, f), ir.imports || []) };
    }
  }
  return parts;
}

// Loads the parts a muten.config `plugins {}` imports (@muten/<name>), so the linter knows them like local parts.
// Mirrors loadPluginParts (load.ts) but sync + style-free (the linter needs only the part shapes). EVERY registry
// part is loaded - including Custom-backed ones (Chart, …), which are importable now (their .js resolves at compile).
function loadPluginPartsLite(appRoot: string): Parts {
  const parts: Parts = {};
  let req: NodeRequire;
  try { req = createRequire(join(appRoot, 'package.json')); } catch { return parts; }
  for (const name of pluginNames(appRoot)) {
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
  if (basename(filePath) === 'muten.config') {   // the build config: the same checks `muten check` runs (config-check.ts)
    const diagnostics = checkConfigText(dirname(filePath), text);
    return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
  }
  if (filePath.endsWith(LANG_EXT)) {   // src/lang/<code>.lang: the same checks `muten check` runs (lang-check.ts)
    const diagnostics = checkLangText(findAppRoot(filePath) ?? dirname(dirname(dirname(filePath))), filePath, text);
    return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
  }
  if (filePath.endsWith(TEST_EXT)) {   // a .test file (muten test): its steps and the routes it opens
    const appRoot = findAppRoot(filePath);
    let routes: RouteEntry[] = [];
    try { if (appRoot) routes = readRoutes(appRoot); } catch { routes = []; }
    const diagnostics = checkTestFile(filePath, text, routes).filter((found) => routes.length || found.code !== 'test-unknown-route');
    return { ok: !diagnostics.some((found) => found.severity === 'error'), diagnostics };
  }
  let ir;
  try { ir = parse(text); }
  catch (e) {
    if (e instanceof ParseError && e.loc) return { ok: false, diagnostics: [diag('syntax', e.message, { loc: e.loc })] };
    return { ok: true, diagnostics: [] };
  }
  if (ir.routes) { // app.muten: route-level checks + its layouts
    const routeCheck = analyzeRoutes(filePath, ir.routes);
    const diagnostics = [...routeCheck.diagnostics, ...layoutDiagnostics(ir)];
    return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
  }
  if (ir.theme) {   // theme.muten: the same checks `muten check` runs (theme-check.ts)
    const diagnostics = checkThemeText(findAppRoot(filePath) ?? dirname(filePath), text);
    return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
  }
  const appRoot = findAppRoot(filePath);
  const apiClients = appRoot ? apiClientNames(readApi(appRoot)) : undefined; // the app's named api clients, so a `post "client:/x"` prefix is checked
  const iconExists = appRoot ? getIconChecker(appRoot) : undefined;          // `Icon "set:name"` existence, so a typo'd icon lights up live instead of only blanking at build
  // the app's stores, read ONCE and assembled like `check` and `build` do (context.ts), so the editor holds the same
  // facts: it used to walk src/ four times per lint, and never told a .store about the other stores
  const store = appRoot ? storeContext(findStores(join(appRoot, 'src'))) : undefined;
  const translations = appRoot ? readTranslations(appRoot) : undefined;
  const themeValues = appRoot ? readThemeValues(appRoot) : undefined;   // theme.muten: `theme.colors.primary`   // src/lang/*.lang: what t("key") and `lang` speak
  if (filePath.endsWith('.store')) { // .store domain slice: the same checks `muten check` runs (check-app.ts storeDiagnostics)
    const empty = { stores: [], storeMembers: {}, storeFns: {}, storeActions: {}, storeSelfMut: new Set<string>(), storeEntities: {}, storesMeta: {} };
    const diagnostics = storeDiagnostics(basename(filePath, '.store'), ir, store ?? empty, apiClients, translations);
    return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
  }

  const parts = { ...projectParts(filePath) };
  for (const [name, def] of Object.entries(ir.parts || {})) parts[name] = { ...def, state: {}, entities: {}, mock: {}, css: '' }; // the page's OWN inline parts (load() composes these too — without this the IDE falsely flags them unknown)
  const { doc } = composeDoc(appRoot ? withUseTypes(ir, filePath, appRoot) : ir, parts); // resolve parts (typos flagged) + hoist state -> flat doc; a `use` reads its package's types
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
  return validate(doc, { parts: Object.keys(parts), stores: store?.stores ?? [], storeMembers: store?.storeMembers ?? {}, storeFns: store?.storeFns, storeActions: store?.storeActions, apiClients, iconExists, storeSelfMut: store?.storeSelfMut ?? new Set(), storeEntities: store?.storeEntities, routes, selfRoute, translations, themeValues });
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
