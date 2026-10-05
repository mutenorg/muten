// Layout modules for the runner. Each `layout name { … slot … }` in app.muten compiles to its own virtual module,
// like the shell, but composed with the app's parts (a layout may call `Tabbar()`), and the boot hands the router
// one lazy loader per layout. The router mounts a layout once and swaps only the page inside its `slot` while the
// user moves between routes declared `in` it — the chrome is never rebuilt on navigation.

import { composeDoc } from '#engine/ir/compose.js';
import type { Doc, IR, PartDef } from '#engine/shared/types.js';

export const LAYOUT_PREFIX = 'virtual:muten/layout/';

/** The composed Doc of one layout (its `slot` kept as the page outlet) and the CSS of the parts it uses. */
export function layoutDoc(appIr: IR | undefined, parts: { [name: string]: PartDef }, name: string): { doc: Doc; css: string } | null {
  const tree = appIr?.layouts?.[name];
  if (!appIr || !tree) return null;
  const { doc, used } = composeDoc({ ...appIr, screen: `layout-${name}`, entities: {}, state: {}, actions: {}, tree }, parts, true);
  const css = used.map((part) => parts[part]?.css).filter(Boolean).join('\n\n');
  return { doc, css };
}

/** The boot's `layouts` map: layout name -> lazy import of its virtual module. Empty when the app declares none. */
export function layoutLoaders(appIr: IR | undefined): string {
  const names = Object.keys(appIr?.layouts || {});
  const rows = names.map((name) => `  ${JSON.stringify(name)}: () => import(${JSON.stringify(LAYOUT_PREFIX + name)}),`);
  return `const layouts = {\n${rows.join('\n')}\n};`;
}
