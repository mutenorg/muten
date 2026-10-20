// check-app: app-level validation (not per-page): every .store body + every route guard.
// Shared by lint.ts and build.ts so they can never disagree (a fix in one path alone silently ships broken code).
// Returns located diagnostics ready to report (lint) or throw (build).
import { layoutDiagnostics } from '#engine/project/layouts.js';
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { collectRefs } from '#engine/ir/refs.js';
import type { Diagnostic, IR, Expr, Translations } from '#engine/shared/types.js';
import type { StoreContext } from '#engine/project/context.js';
import { storeFiles } from '#engine/project/load.js';
import { diag } from '#engine/shared/diagnostics.js';
import { Ek, BOp } from '#engine/shared/vocab.js';

// A guard runs on every navigation, before any page exists: only comparisons and logic over store values.
function plainGuard(e: Expr): boolean {
  if (e.kind === Ek.Lit || e.kind === Ek.Ref) return true;
  if (e.kind === Ek.Un) return plainGuard(e.operand);
  if (e.kind === Ek.Bin) return e.op !== BOp.Contains && plainGuard(e.left) && plainGuard(e.right);
  if (e.kind === Ek.Tern) return plainGuard(e.cond) && plainGuard(e.then) && plainGuard(e.else);
  return false;
}

/** A store's name is how pages reach it (`cart.count`), so it must be a name an expression can spell. */
const STORE_NAME = /^[a-z][A-Za-z0-9]*$/;

/** Everything `check` (and the editor) says about one store: the shared validation plus what only a store can get wrong. */
export function storeDiagnostics(domain: string, ir: IR, store: StoreContext, apiClients?: string[], translations?: Translations): Diagnostic[] {
  const out: Diagnostic[] = [];
  try {
    out.push(...validate(toDoc(ir), { kind: 'store', apiClients, stores: store.stores, storeMembers: store.storeMembers, storeFns: store.storeFns, storeActions: store.storeActions, storeSelfMut: store.storeSelfMut, storeEntities: store.storeEntities, translations }).diagnostics);
  } catch { /* a store that will not flatten is reported by the rules below and by its consumers */ }
  if (!STORE_NAME.test(domain)) out.push(diag('store-name', `a store is reached by its file name, and "${domain}" cannot be written in an expression (\`${domain}.x\` reads as a subtraction). Rename the file to a name like \`${domain.replace(/[-_ ]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase())}.store\`.`));
  if (ir.screen || ir.tree) out.push(diag('store-has-ui', 'a store holds app-wide state and logic, not a screen: `screen` and a node tree are ignored here. Put the UI in a page (src/pages/…) or a part, and read the store from it.', { loc: ir.tree?.loc ?? null }));
  for (const [name, def] of Object.entries(ir.state || {})) {
    const source = def.source?.startsWith('query:') ? def.source.slice('query:'.length) : '';
    if (source && !def.call && !ir.sources?.[source] && !ir.mock?.[source]) out.push(diag('query-no-source', `"${name}" is a query of "${source}", but this store has no \`sources { ${source}: "…" }\` (nor a \`mock\`): it would ask nothing and stay empty forever.`, { loc: def.loc ?? null, from: source }));
  }
  return out;
}

export function validateStoresAndGuards(appRoot: string, storeIRs: { [domain: string]: IR }, store: StoreContext, translations?: Translations): Array<{ file: string } & Diagnostic> {
  const rel = (p: string) => relative(appRoot, p);
  const storeMembers = store.storeMembers;
  const out: Array<{ file: string } & Diagnostic> = [];
  const files = storeFiles(join(appRoot, 'src'));

  // every .store: the shared validation + the store rules, reported in the file it is written in
  for (const [domain, ir] of Object.entries(storeIRs)) {
    const paths = files[domain];
    if (!paths) continue;   // a store muten adds itself (`env`, from muten.config) has no file of its own
    const file = rel(paths[0]);
    for (const d of storeDiagnostics(domain, ir, store, undefined, translations)) out.push({ file, ...d });
    for (const extra of paths.slice(1)) out.push({ file: rel(extra), ...diag('store-duplicate', `two stores are called "${domain}" (${paths.map(rel).join(' and ')}): one of them is silently ignored. Rename one.`) });
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
        if (r.guard && !plainGuard(r.guard)) add('a route guard compares and combines store values (`and`, `or`, `not`, `==`…); a function call or a list operation belongs in a store `get` the guard reads');
        if (r.guard) for (const ref of collectRefs(r.guard)) {   // every name a guard reads is a store member
          const [dom, member = ''] = ref.split('.');
          if (!storeMembers[dom]) add(`route guard reads "${ref}": "${dom}" is not a store — a guard reads store values (e.g. \`guard auth.loggedIn and not auth.blocked else "/login"\`)`);
          else if (!member) add(`route guard reads the store "${dom}" itself — name one of its members (${storeMembers[dom].join(', ')})`);
          else if (!storeMembers[dom].includes(member)) add(`route guard reads "${ref}": "${member}" is not a member of store "${dom}"`);
        }
        if (r.redirect && !routeUrls.has(r.redirect)) add(`route guard redirect "${r.redirect}" is not a declared route`);
      }
      for (const d of layoutDiagnostics(appIr)) out.push({ file, ...d });
    } catch { /* a parse error in app.muten surfaces via readRoutes */ }
  }
  return out;
}
