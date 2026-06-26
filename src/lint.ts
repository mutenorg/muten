// lint: parse + validate every page of a host app without compiling.
// The deterministic oracle for AI agents: `--json` returns structured diagnostics
// (code, loc, suggestion) in milliseconds. Returns problem count; CLI exits non-zero if > 0.

import { join, relative } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { readRoutes, readApi, apiClientNames } from '#engine/project/routes.js';
import { load, loadParts, findStores } from '#engine/project/load.js';
import { validateStoresAndGuards } from '#engine/project/check-app.js';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { formatDiagnostic, ParseError } from '#engine/shared/diagnostics.js';
import type { Diagnostic } from '#engine/shared/types.js';

export async function lintApp(appRoot: string, json = false): Promise<number> {
  const rel = (p: string) => relative(appRoot, p);
  const sharedParts = await loadParts(join(appRoot, 'src', 'parts'));
  const storeIRs = findStores(join(appRoot, 'src'));             // store domains + members needed to validate cross-page refs like cart.add / cart.count
  const stores = Object.keys(storeIRs);
  const storeMembers: { [d: string]: string[] } = {};
  for (const [d, ir] of Object.entries(storeIRs)) storeMembers[d] = [...Object.keys(ir.state || {}), ...Object.keys(ir.gets || {}), ...Object.keys(ir.actions || {})];
  const apiClients = apiClientNames(readApi(appRoot));           // the app's named api clients, so a `post "client:/x"` prefix is checked
  const pages = readRoutes(appRoot);

  const found: Array<{ file: string } & Diagnostic> = [];
  for (const page of pages) {
    let diagnostics: Diagnostic[] = [];
    try {
      const { doc, partNames } = await load(page.screenPath, sharedParts);
      diagnostics = validate(doc, { parts: partNames, stores, storeMembers, apiClients }).diagnostics;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;             // a syntax error becomes one diagnostic; anything else is a real bug
      diagnostics = [{ code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null }];
    }
    for (const d of diagnostics) {
      if (!json) console.log(formatDiagnostic(d, rel(page.screenPath)));
      found.push({ file: rel(page.screenPath), ...d });
    }
  }
  // app.muten wraps every route, so validate its store refs too (e.g. the navbar's cart count)
  const appFile = join(appRoot, 'src', 'app.muten');
  if (existsSync(appFile)) {
    try {
      const appIr = parse(readFileSync(appFile, 'utf8'));
      if (appIr.shell) {
        for (const d of validate(toDoc({ ...appIr, tree: appIr.shell }), { stores, storeMembers, apiClients }).diagnostics) {
          if (!json) console.log(formatDiagnostic(d, rel(appFile)));
          found.push({ file: rel(appFile), ...d });
        }
      }
    } catch (e) { if (!(e instanceof ParseError)) throw e; } // a parse error surfaces via the page load; rethrow real errors
  }

  // .store bodies + route guards: shared with `build` via check-app.ts so check and build never disagree.
  for (const d of validateStoresAndGuards(appRoot, storeIRs, storeMembers)) {
    if (!json) console.log(formatDiagnostic(d, d.file));
    found.push(d);
  }

  if (json) console.log(JSON.stringify(found, null, 2));
  else console.log(found.length ? `\n✖ ${found.length} problem(s)` : '✓ no problems');
  return found.length;
}
