// check-app: app-level validation (not per-page): every .store body + every route guard.
// Shared by lint.ts and build.ts so they can never disagree (a fix in one path alone silently ships broken code).
// Returns located diagnostics ready to report (lint) or throw (build).
import { layoutDiagnostics } from '#engine/project/layouts.js';
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import type { Diagnostic, IR } from '#engine/shared/types.js';

export function validateStoresAndGuards(appRoot: string, storeIRs: { [domain: string]: IR }, storeMembers: { [domain: string]: string[] }): Array<{ file: string } & Diagnostic> {
  const rel = (p: string) => relative(appRoot, p);
  const stores = Object.keys(storeIRs);
  const out: Array<{ file: string } & Diagnostic> = [];

  // .store bodies: gets/actions/effects ref-checked against the slice's own state.
  // kind:'store' skips the no-root check and runs the store-specific get validation.
  for (const [domain, ir] of Object.entries(storeIRs)) {
    const file = rel(join(appRoot, 'src', domain + '.store'));
    try { for (const d of validate(toDoc(ir), { stores, storeMembers, kind: 'store' }).diagnostics) out.push({ file, ...d }); }
    catch { /* a store that won't flatten surfaces via its consumers */ }
  }

  // route guards: the store boolean and the redirect route must both exist.
  // A typo'd guard reads `undefined` and locks the route forever; a bad redirect lands nowhere.
  const appFile = join(appRoot, 'src', 'app.muten');
  if (existsSync(appFile)) {
    try {
      const appIr: IR = parse(readFileSync(appFile, 'utf8'));
      const routeUrls = new Set((appIr.routes || []).map((r) => r.url));
      const file = rel(appFile);
      for (const r of (appIr.routes || [])) {
        const add = (message: string): void => { out.push({ file, code: 'guard-error', severity: 'error', message, loc: r.loc ?? null, suggestion: null }); };
        if (r.guard) {
          const dot = r.guard.indexOf('.');
          const dom = dot === -1 ? r.guard : r.guard.slice(0, dot);
          const member = dot === -1 ? '' : r.guard.slice(dot + 1).split('.')[0];
          if (!storeMembers[dom]) add(`route guard "${r.guard}": "${dom}" is not a store — a guard reads a store boolean (e.g. \`guard auth.loggedIn else /login\`)`);
          else if (member && !storeMembers[dom].includes(member)) add(`route guard "${r.guard}": "${member}" is not a member of store "${dom}"`);
        }
        if (r.redirect && !routeUrls.has(r.redirect)) add(`route guard redirect "${r.redirect}" is not a declared route`);
      }
      for (const d of layoutDiagnostics(appIr)) out.push({ file, ...d });
    } catch { /* a parse error in app.muten surfaces via readRoutes */ }
  }
  return out;
}
