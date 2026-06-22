// Lint / check: parse + validate every page of a host app, WITHOUT compiling. The deterministic ORACLE
// an AI consults instead of running a browser — `--json` returns the structured diagnostics (code + loc +
// "did you mean…?" suggestion) in milliseconds. Returns the problem count (the CLI exits non-zero if > 0).

import { join, relative } from 'node:path';
import { readRoutes } from '#engine/project/routes.js';
import { load, loadParts, findStores } from '#engine/project/load.js';
import { validate } from '#engine/ir/validate.js';
import { formatDiagnostic, ParseError } from '#engine/shared/diagnostics.js';
import type { Diagnostic } from '#engine/shared/types.js';

export async function lintApp(appRoot: string, json = false): Promise<number> {
  const rel = (p: string) => relative(appRoot, p);
  const sharedParts = await loadParts(join(appRoot, 'src', 'parts'));
  const stores = Object.keys(findStores(join(appRoot, 'src')));  // store domains → store refs (cart.add…) validate
  const pages = readRoutes(appRoot);

  const found: Array<{ file: string } & Diagnostic> = [];
  for (const page of pages) {
    let diagnostics: Diagnostic[] = [];
    try {
      const { doc, partNames } = await load(page.screenPath, sharedParts);
      diagnostics = validate(doc, { parts: partNames, stores }).diagnostics;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;             // a syntax error is one diagnostic; anything else is a bug
      diagnostics = [{ code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null }];
    }
    for (const d of diagnostics) {
      if (!json) console.log(formatDiagnostic(d, rel(page.screenPath)));
      found.push({ file: rel(page.screenPath), ...d });
    }
  }
  if (json) console.log(JSON.stringify(found, null, 2));
  else console.log(found.length ? `\n✖ ${found.length} problem(s)` : '✓ no problems');
  return found.length;
}
