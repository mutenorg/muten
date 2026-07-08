// lint: parse + validate every page of a host app without compiling.
// The deterministic oracle for AI agents: `--json` returns structured diagnostics
// (code, loc, suggestion) in milliseconds. Returns problem count; CLI exits non-zero if > 0.

import { join, relative, isAbsolute } from 'node:path';
import { readFileSync, existsSync, watch } from 'node:fs';
import { readRoutes, readApi, apiClientNames } from '#engine/project/routes.js';
import { load, loadAllParts, findStores } from '#engine/project/load.js';
import { storeContext } from '#engine/project/context.js';
import { validateStoresAndGuards } from '#engine/project/check-app.js';
import { lintComponents } from '#engine/project/js-antipatterns.js';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { getIconChecker } from '#engine/project/icon-check.js';
import { formatDiagnostic, ParseError } from '#engine/shared/diagnostics.js';
import type { Diagnostic } from '#engine/shared/types.js';

export async function lintApp(appRoot: string, json = false): Promise<number> {
  const rel = (p: string) => relative(appRoot, p);
  // read a file's source once (memoized) so the terminal can print a code frame under each diagnostic; `--json`
  // stays pure data, so only bother when we're printing. A path is relative-to-appRoot or absolute — resolve both.
  const srcCache = new Map<string, string>();
  const srcOf = (p: string): string | undefined => {
    if (json) return undefined;
    const abs = isAbsolute(p) ? p : join(appRoot, p);
    if (!srcCache.has(abs)) { try { srcCache.set(abs, readFileSync(abs, 'utf8')); } catch { srcCache.set(abs, ''); } }
    return srcCache.get(abs) || undefined;
  };
  const iconExists = getIconChecker(appRoot);                    // `Icon "set:name"` existence, so a typo'd icon fails `check` instead of only the build
  const sharedParts = await loadAllParts(appRoot);               // all src/**/parts + parts imported from plugins (muten.config)
  const storeIRs = findStores(join(appRoot, 'src'));             // store domains + members needed to validate cross-page refs like cart.add / cart.count
  const { stores, storeMembers, storeSelfMut, storeEntities } = storeContext(storeIRs); // ONE assembly, shared with build + plugin (no drift)
  const apiClients = apiClientNames(readApi(appRoot));           // the app's named api clients, so a `post "client:/x"` prefix is checked
  const pages = readRoutes(appRoot);

  const found: Array<{ file: string } & Diagnostic> = [];
  for (const page of pages) {
    let diagnostics: Diagnostic[] = [];
    try {
      const { doc, partNames } = await load(page.screenPath, sharedParts);
      diagnostics = validate(doc, { parts: partNames, stores, storeMembers, apiClients, iconExists, storeSelfMut, storeEntities }).diagnostics;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;             // a syntax error becomes one diagnostic; anything else is a real bug
      diagnostics = [{ code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null }];
    }
    for (const d of diagnostics) {
      if (!json) console.log(formatDiagnostic(d, rel(page.screenPath), srcOf(page.screenPath)));
      found.push({ file: rel(page.screenPath), ...d });
    }
  }
  // app.muten wraps every route, so validate its store refs too (e.g. the navbar's cart count)
  const appFile = join(appRoot, 'src', 'app.muten');
  if (existsSync(appFile)) {
    try {
      const appIr = parse(readFileSync(appFile, 'utf8'));
      if (appIr.shell) {
        for (const d of validate(toDoc({ ...appIr, tree: appIr.shell }), { stores, storeMembers, apiClients, iconExists, storeSelfMut, storeEntities }).diagnostics) {
          if (!json) console.log(formatDiagnostic(d, rel(appFile), srcOf(appFile)));
          found.push({ file: rel(appFile), ...d });
        }
      }
    } catch (e) { if (!(e instanceof ParseError)) throw e; } // a parse error surfaces via the page load; rethrow real errors
  }

  // .store bodies + route guards: shared with `build` via check-app.ts so check and build never disagree.
  for (const d of validateStoresAndGuards(appRoot, storeIRs, storeMembers)) {
    if (!json) console.log(formatDiagnostic(d, d.file, srcOf(d.file)));
    found.push(d);
  }
  // the oracle reaches INTO Custom host .js files: warn (never fail) when they hand-roll UI muten already owns
  for (const d of lintComponents(appRoot)) {
    if (!json) console.log(formatDiagnostic(d, d.file, srcOf(d.file)));
    found.push(d);
  }

  const errors = found.filter((d) => d.severity === 'error').length;
  const warnings = found.length - errors;
  if (json) console.log(JSON.stringify(found, null, 2));
  else if (errors) console.log(`\n✖ ${errors} problem(s)${warnings ? ` · ${warnings} warning(s)` : ''}`);
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
