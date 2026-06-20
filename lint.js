// Lint orchestration: parse + validate every page of a HOST APP, without compiling.
// Returns the problem count (the CLI in bin/muten.js exits non-zero if > 0).

import { join, relative } from 'node:path';

import { readRoutes } from './engine/routes.js';
import { load, loadParts } from './engine/load.js';
import { validate } from './engine/validate.js';
import { formatDiagnostic, ParseError } from './engine/diagnostics.js';

export async function lintApp(appRoot) {
  const rel = (p) => relative(appRoot, p);
  const sharedParts = await loadParts(join(appRoot, 'src', 'parts'));
  const pages = readRoutes(appRoot);

  let problems = 0;
  for (const page of pages) {
    let diagnostics = [];
    try {
      const { doc, partNames } = await load(page.screenPath, sharedParts);
      diagnostics = validate(doc, { parts: partNames }).diagnostics;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      diagnostics = [{ code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null }];
    }
    for (const d of diagnostics) { console.log(formatDiagnostic(d, rel(page.screenPath))); problems++; }
  }
  console.log(problems ? `\n✖ ${problems} problem(s)` : '✓ no problems');
  return problems;
}
