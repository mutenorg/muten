// Layout checks for app.muten: every `in name` names a declared `layout`, and each layout holds exactly one `slot`
// (the point where the router mounts the route's page). Shared by `muten check`/build and the live editor lint.

import { Nt } from '#engine/shared/vocab.js';
import { closest, diag } from '#engine/shared/diagnostics.js';
import type { Diagnostic, IR, IRNode } from '#engine/shared/types.js';

const countSlots = (node: IRNode): number =>
  (node.type === Nt.Slot ? 1 : 0) + (node.children || []).reduce((sum, child) => sum + countSlots(child), 0);

export function layoutDiagnostics(appIr: IR): Diagnostic[] {
  const layouts = appIr.layouts || {};
  const names = Object.keys(layouts);
  const used = new Set<string>();
  const out: Diagnostic[] = [];
  for (const route of appIr.routes || []) {
    if (!route.layout) continue;
    used.add(route.layout);
    if (!layouts[route.layout]) {
      out.push(diag('unknown-layout', `route "${route.url}" → layout "${route.layout}" is not declared — add \`layout ${route.layout} { … slot … }\` to app.muten`, { loc: route.loc, suggestion: closest(route.layout, names) }));
    }
  }
  for (const [name, tree] of Object.entries(layouts)) {
    const slots = countSlots(tree);
    if (slots !== 1) {
      out.push(diag('layout-slot', `layout "${name}" has ${slots} \`slot\`s — a layout needs exactly one: the place where the route's page mounts`, { loc: tree.loc }));
    }
    if (!used.has(name)) out.push(diag('unused-layout', `layout "${name}" is declared but no route uses it — mount routes in it with \`"/x" -> page in ${name}\``, { loc: tree.loc, severity: 'warning' }));
  }
  return out;
}
