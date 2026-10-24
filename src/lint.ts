// lint: parse + validate every page of a host app without compiling.
// The deterministic oracle for AI agents: `--json` returns structured diagnostics
// (code, loc, suggestion) in milliseconds. Returns problem count; CLI exits non-zero if > 0.

import { join, relative, isAbsolute } from 'node:path';
import { readFileSync, existsSync, watch } from 'node:fs';
import { readRoutes, readApi, apiClientNames } from '#engine/project/routes.js';
import { load, loadAllParts, findStores, storeFiles, pluginFileErrors } from '#engine/project/load.js';
import { checkTests } from '#engine/project/check-tests.js';
import { checkTheme } from '#engine/project/theme-check.js';
import { checkConfig } from '#engine/project/config-check.js';
import { readTranslations } from '#engine/project/lang-files.js';
import { readThemeValues } from '#engine/project/theme-values.js';
import { checkLang } from '#engine/project/lang-check.js';
import { storeContext } from '#engine/project/context.js';
import { validateStoresAndGuards } from '#engine/project/check-app.js';
import { lintComponents } from '#engine/project/js-antipatterns.js';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { composeDoc } from '#engine/ir/compose.js';
import { validate } from '#engine/ir/validate.js';
import { getIconChecker } from '#engine/project/icon-check.js';
import { formatDiagnostic, ParseError, diag, parseErrorDiag } from '#engine/shared/diagnostics.js';
import type { Diagnostic, Doc } from '#engine/shared/types.js';
import { packageTypeDiagnostics } from '#engine/project/ts-check.js';
import { placeFinding } from '#engine/project/place.js';
import { readMutenConfig } from '#engine/project/config.js';
import { execFileSync } from 'node:child_process';
import { partAlone, CALLER_FREE } from '#engine/project/check-parts.js';
import { missingComponents } from '#engine/project/custom-check.js';
import { paramTypeDiagnostics } from '#engine/project/param-types.js';
import type { ParamOwner } from '#engine/project/param-types.js';
import type { Found, PartFiles } from '#engine/project/place.js';


/** The app's files git sees changed or new (relative to the app), or null when the app is in no repository. */
function changedFiles(appRoot: string): Set<string> | null {
  let said: string;
  try { said = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: appRoot, encoding: 'utf8' }).trim();
  return new Set(said.split('\n').filter(Boolean).map((line) => relative(appRoot, join(top, line.slice(3).replace(/^.* -> /, '')))));
}

/** The findings at the levels muten.config's `lint { code off|warning|error }` sets: off ones gone, the rest re-leveled. */
function leveled(found: Found[], appRoot: string): Found[] {
  const block = readMutenConfig(appRoot).lint;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return found;
  return found.flatMap((d) => {
    const level = block[d.code];
    if (level === 'off') return [];
    return level === 'warning' || level === 'error' ? [{ ...d, severity: level }] : [d];
  });
}

/** One finding per place: a part's own problem is met once per page that calls it, and said once. */
function unique(found: Found[]): Found[] {
  const seen = new Set<string>();
  // the same mistake met through two callers can carry two suggestions (each page's names): the place and the word decide
  return found.filter((d) => { const key = `${d.file}|${d.code}|${d.loc?.line}|${d.loc?.col}|${d.word ?? d.message}`; return !seen.has(key) && Boolean(seen.add(key)); });
}

/** The ids every one of these pages declares (an in-page link of the layout around them lands on each). */
function idsOnEveryPage(docs: Array<Doc | undefined>): string[] {
  const sets = docs.map((doc) => new Set(Object.values(doc?.nodes || {}).flatMap((node) => (node.props?.id ? [node.props.id] : []))));
  if (!sets.length) return [];
  return [...sets[0]].filter((id) => sets.every((ids) => ids.has(id)));
}

async function collect(appRoot: string): Promise<Found[]> {
  const rel = (p: string) => relative(appRoot, p);
  const iconExists = getIconChecker(appRoot);                    // `Icon "set:name"` existence, so a typo'd icon fails `check` instead of only the build
  const sharedParts = await loadAllParts(appRoot);               // all src/**/parts + parts imported from plugins (muten.config)
  const storeIRs = findStores(join(appRoot, 'src'));             // store domains + members needed to validate cross-page refs like cart.add / cart.count
  const storeCtx = storeContext(storeIRs);
  const { stores, storeMembers, storeFns, storeActions, storeSelfMut, storeEntities } = storeCtx; // ONE assembly, shared with build + plugin (no drift)
  const translations = readTranslations(appRoot);
  const themeValues = readThemeValues(appRoot);                  // theme.muten: what `theme.colors.primary` reads                // src/lang/*.lang: t("key") and `lang` speak them
  const apiClients = apiClientNames(readApi(appRoot));           // the app's named api clients, so a `post "client:/x"` prefix is checked
  const pages = readRoutes(appRoot);
  const routes = pages.map((p) => '/' + p.route);                // declared urls, leading slash restored ("/", "/product/:pid")

  const found: Found[] = [];
  const loaded: Array<{ file: string; doc: Doc }> = [];   // for TypeScript's word on their calls into packages (ts-check.ts)
  // each of the app's own parts on its own, called or not (check-parts.ts): first, so its findings are the ones kept
  const alone: Found[] = [];
  for (const [name, part] of Object.entries(sharedParts)) {
    if (!part.file || part.file.includes('node_modules')) continue;   // a plugin's parts are not the app's to fix
    let diagnostics: Diagnostic[];
    try {
      const doc = partAlone(name, part, sharedParts);
      diagnostics = validate(doc, { parts: Object.keys(sharedParts), stores, storeMembers, storeFns, storeActions, apiClients, iconExists, storeSelfMut, storeEntities, routes, translations, themeValues, places: true }).diagnostics.filter((d) => CALLER_FREE.has(d.code) && d.loc);   // no place: about the made-up page itself (its states are the parameters, whose types param-types.ts checks against every entity of the app)
    }
    catch (e) {   // a `$name` that is no parameter, a cycle: the part's own, whoever calls it
      if (!(e instanceof ParseError)) throw e;
      diagnostics = [parseErrorDiag(e)];
    }
    for (const d of diagnostics) alone.push({ file: rel(part.file), ...d });
  }
  for (const page of pages) {
    let diagnostics: Diagnostic[] = [];
    let file = page.screenPath;
    try {
      const { doc, partNames } = await load(page.screenPath, sharedParts);
      loaded.push({ file: page.screenPath, doc });
      diagnostics = [...validate(doc, { parts: partNames, stores, storeMembers, storeFns, storeActions, apiClients, iconExists, storeSelfMut, storeEntities, routes, selfRoute: '/' + page.route, translations, themeValues, places: true }).diagnostics, ...missingComponents(appRoot, doc)];
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;             // a syntax error becomes one diagnostic; anything else is a real bug
      if (e.file) file = e.file;                            // raised inside a part: its own file, not every page that calls it
      diagnostics = [parseErrorDiag(e)];
    }
    for (const d of diagnostics) found.push({ file: rel(file), ...d });
  }
  // the types parameters say they take (param-types.ts): pages' and stores' actions, and the app's own parts
  const entityNames = new Set([...loaded, ...Object.values(storeIRs).map((ir) => ({ doc: ir }))].flatMap(({ doc }) => Object.keys(doc.entities || {})));
  for (const part of Object.values(sharedParts)) for (const name of Object.keys(part.entities || {})) entityNames.add(name);
  const storeFileOf = storeFiles(join(appRoot, 'src'));
  const owners: ParamOwner[] = [
    ...loaded.flatMap(({ file, doc }) => Object.entries(doc.actions || {}).map(([name, action]) => ({ file: rel(file), where: `action ${name}`, params: action.params || [] }))),
    ...Object.entries(storeIRs).flatMap(([domain, ir]) => Object.entries(ir.actions || {}).map(([name, action]) => ({ file: rel(storeFileOf[domain]?.[0] ?? join(appRoot, 'src', domain + '.store')), where: `action ${domain}.${name}`, params: action.params || [] }))),
    ...Object.entries(sharedParts).filter(([, part]) => part.file && !part.file.includes('node_modules')).map(([name, part]) => ({ file: rel(part.file ?? ''), where: `part ${name}`, params: part.params })),
  ];
  found.push(...paramTypeDiagnostics(owners, entityNames));
  for (const [file, diagnostics] of packageTypeDiagnostics(loaded, appRoot, themeValues)) {
    for (const d of diagnostics) {
      found.push({ file: rel(file), ...d });
    }
  }
  // app.muten wraps every route, so validate its store refs too (e.g. the navbar's cart count)
  const appFile = join(appRoot, 'src', 'app.muten');
  if (existsSync(appFile)) {
    try {
      const appIr = parse(readFileSync(appFile, 'utf8'));
      if (appIr.shell) {
        const shell = toDoc({ ...appIr, tree: appIr.shell });
        for (const d of [...validate(shell, { stores, storeMembers, storeFns, storeActions, apiClients, iconExists, storeSelfMut, storeEntities, routes, translations, themeValues, places: true }).diagnostics, ...missingComponents(appRoot, shell)]) {
          found.push({ file: rel(appFile), ...d });
        }
      }
      // each layout composes like a page (it may call parts), keeping its `slot` as the page outlet
      for (const [name, tree] of Object.entries(appIr.layouts || {})) {
        const { doc } = composeDoc({ ...appIr, tree }, sharedParts, true);
        const around = { ids: idsOnEveryPage(pages.filter((page) => page.layout === name).map((page) => loaded.find((one) => one.file === page.screenPath)?.doc)), where: `layout "${name}"` };
        for (const d of [...validate(doc, { parts: Object.keys(sharedParts), stores, storeMembers, storeFns, storeActions, apiClients, iconExists, storeSelfMut, storeEntities, routes, translations, themeValues, around, places: true }).diagnostics, ...missingComponents(appRoot, doc)]) {
          found.push({ file: rel(appFile), ...d });
        }
      }
    } catch (e) { if (!(e instanceof ParseError)) throw e; } // a parse error surfaces via the page load; rethrow real errors
  }

  // .store bodies + route guards: shared with `build` via check-app.ts so check and build never disagree.
  for (const d of validateStoresAndGuards(appRoot, storeIRs, storeCtx, translations)) {
    found.push(d);
  }
  // the oracle reaches INTO Custom host .js files: warn (never fail) when they hand-roll UI muten already owns
  for (const d of lintComponents(appRoot)) {
    found.push(d);
  }

  // muten.config: it parses, its blocks and keys exist, its values fit, its plugins are installed (config-check.ts)
  for (const d of checkConfig(appRoot)) {
    found.push({ file: 'muten.config', ...d });
  }
  // theme.muten: it parses, its library and tokens exist, its values are values (theme-check.ts)
  for (const d of checkTheme(appRoot)) {
    found.push({ file: 'theme.muten', ...d });
  }
  // src/lang/*.lang: each parses, every language has every key, a text fills the same values in all (lang-check.ts)
  for (const d of checkLang(appRoot)) {
    found.push(d);
  }
  // the .test files: a step that does not parse, an `open` to a route that does not exist (check-tests.ts, shared with `muten test`)
  for (const d of checkTests(appRoot, pages)) {
    found.push(d);
  }
  // a plugin file that does not parse is skipped (the app still runs) - but never silently: its parts vanish, and
  // without this every caller only learns «not a known part»
  for (const f of pluginFileErrors) {
    const d = { file: f.file, ...diag('plugin-file', `this plugin file could not be read, so its parts are missing: ${f.message}`, { loc: f.loc, severity: 'warning' }) };
    found.push(d);
  }
  // each finding in its file and at its word: a part's own problem in the part, an argument's at the call (place.ts)
  const partFiles: PartFiles = {};
  for (const [name, part] of Object.entries(sharedParts)) if (part.file) partFiles[name] = rel(part.file);
  const sources = new Map<string, string>();
  const sourceOf = (file: string): string => {
    if (!sources.has(file)) { try { sources.set(file, readFileSync(isAbsolute(file) ? file : join(appRoot, file), 'utf8')); } catch { sources.set(file, ''); } }
    return sources.get(file) ?? '';
  };
  // a part alone answers only for the part's own lines: what resolves to its made-up call is about arguments it never got
  // and for its own lines only: a part it calls has its own check, and entities are each file's own description (Avatar's
  // `Person` is not PostCard's `Post`), so the lines of a part inside another are not this part's to answer for
  const own = alone.flatMap((d) => { const placed = placeFinding(d, d.file, partFiles, sourceOf); return placed.loc && placed.file === d.file ? [placed] : []; });
  return [...own, ...found.map((d) => placeFinding(d, d.file, partFiles, sourceOf))];
}

/** `muten check`: every finding, printed for a reader or (`--json`) as data. A file that does not parse (a page, a part,
 *  a store) is a finding like any other: it used to escape as text on stderr, so `--json` answered with nothing. */
/** Every finding of the app, each once, in its file and at its word (what `check` prints and `--fix` reads). */
export async function findings(appRoot: string): Promise<Found[]> {
  try { return leveled(unique(await collect(appRoot)), appRoot); }
  catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return [{ file: e.file ? relative(appRoot, e.file) : 'src', ...parseErrorDiag(e) }];
  }
}

export async function lintApp(appRoot: string, json = false, changedOnly = false): Promise<number> {
  const all = await findings(appRoot);
  const changed = changedOnly ? changedFiles(appRoot) : null;   // --changed: what git says changed (all, outside a repo)
  const found = changed ? all.filter((d) => changed.has(d.file)) : all;
  const errors = found.filter((d) => d.severity === 'error').length;
  const warnings = found.length - errors;
  if (json) { console.log(JSON.stringify(found, null, 2)); return errors; }
  // a code frame under each finding: each file read once
  const sources = new Map<string, string>();
  const sourceOf = (file: string): string | undefined => {
    const abs = isAbsolute(file) ? file : join(appRoot, file);
    if (!sources.has(abs)) { try { sources.set(abs, readFileSync(abs, 'utf8')); } catch { sources.set(abs, ''); } }
    return sources.get(abs) || undefined;
  };
  for (const d of found) console.log(formatDiagnostic(d, d.file, sourceOf(d.file)));
  if (errors) console.log(`\n✖ ${errors} problem(s)${warnings ? ` · ${warnings} warning(s)` : ''}`);
  else console.log(`✓ no problems${warnings ? ` · ${warnings} warning(s)` : ''}`);
  return errors;   // exit code = ERRORS only; warnings inform (e.g. a Custom hand-rolling a socket) but never block the build
}

// `muten check --watch`: the oracle as a standing gate (CI, agents) without the dev server. Re-lints the whole
// app on any .muten/.store/theme/muten.config change, debounced, clearing the screen each pass.
export async function lintWatch(appRoot: string, json: boolean): Promise<void> {
  const run = async (): Promise<void> => {
    if (!json) console.clear();
    await lintApp(appRoot, json);
    if (!json) console.log('\n  watching for changes — Ctrl+C to stop');
  };
  await run();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onChange = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(run, 100); };
  watch(join(appRoot, 'src'), { recursive: true }, onChange);
  for (const f of ['theme.muten', 'muten.config']) { const p = join(appRoot, f); if (existsSync(p)) watch(p, onChange); }
}
