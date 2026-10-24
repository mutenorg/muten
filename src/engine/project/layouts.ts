// Layouts in app.muten: which one each route mounts in (`in name`, else the `default` one unless the route says
// `without name`), and their checks: every name is a declared `layout`, a `without` is not a no-op, and each layout
// holds exactly one `slot` (where the router mounts the route's page). Shared by `muten check`/build, the boot and the
// live editor lint.

import { Nt } from '#engine/shared/vocab.js';
import { closest, diag } from '#engine/shared/diagnostics.js';
import type { Diagnostic, IR, IRNode, Route } from '#engine/shared/types.js';

const countSlots = (node: IRNode): number =>
  (node.type === Nt.Slot ? 1 : 0) + (node.children || []).reduce((sum, child) => sum + countSlots(child), 0);

/** The layout a route mounts in: the one it names with `in`, else the app's `default` one unless the route says
 *  `without` it, else none. The one answer the boot, `muten check`, the routes list and the app map all read. */
export function routeLayout(appIr: IR | undefined, route: Route): string | undefined {
  if (route.layout) return route.layout;
  const fallback = appIr?.defaultLayout;
  return fallback && route.without !== fallback ? fallback : undefined;
}

export function layoutDiagnostics(appIr: IR): Diagnostic[] {
  const layouts = appIr.layouts || {};
  const names = Object.keys(layouts);
  const used = new Set<string>();
  const out: Diagnostic[] = [];
  for (const route of appIr.routes || []) {
    if (route.without) {
      const name = route.without;
      if (!layouts[name]) out.push(diag('unknown-layout', `route "${route.url}" → without "${name}": there is no layout "${name}"`, { loc: route.loc, suggestion: closest(name, names) }));
      else if (route.layout) out.push(diag('without-in', `route "${route.url}" mounts \`in ${route.layout}\`, so it is already without "${name}": drop \`without ${name}\``, { loc: route.loc, severity: 'warning' }));
      else if (appIr.defaultLayout !== name) out.push(diag('without-not-default', `route "${route.url}" → without "${name}": "${name}" is not the default layout, so no route is in it unless it says \`in ${name}\`: drop \`without ${name}\`${appIr.defaultLayout ? ` (the default one is "${appIr.defaultLayout}")` : ''}`, { loc: route.loc, severity: 'warning' }));
    }
    const layout = routeLayout(appIr, route);
    if (!layout) continue;
    used.add(layout);
    if (!layouts[layout]) {
      out.push(diag('unknown-layout', `route "${route.url}" → layout "${layout}" is not declared — add \`layout ${layout} { … slot … }\` to app.muten`, { loc: route.loc, suggestion: closest(layout, names) }));
    }
  }
  for (const [name, tree] of Object.entries(layouts)) {
    const slots = countSlots(tree);
    if (slots !== 1) {
      out.push(diag('layout-slot', `layout "${name}" has ${slots} \`slot\`s — a layout needs exactly one: the place where the route's page mounts`, { loc: tree.loc }));
    }
    if (!used.has(name)) out.push(diag('unused-layout', `layout "${name}" is declared but no route uses it — mount routes in it with \`"/x" -> page in ${name}\`, or make it the one every route gets: \`layout ${name} default { … }\``, { loc: tree.loc, severity: 'warning' }));
  }
  return out;
}
