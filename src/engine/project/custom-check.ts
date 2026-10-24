// custom-check: every `Custom Name` has something to mount. A Custom is a host file the app writes (src/components/Name.ts or .js),
// one a plugin ships, or a component a `use element|widget|react` brings from npm. One that is none of those used to
// pass `check`, be skipped by `bundle` without a word, and leave an empty box on the page; only `build` stopped, with no
// line. Now it is a finding at the Custom, with the nearest component that does exist. Shared by check, bundle and build.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Nt, HOST_EXTS } from '#engine/shared/vocab.js';
import { closest, diag } from '#engine/shared/diagnostics.js';
import { loadPluginComponents } from '#engine/project/load.js';
import type { Diagnostic, Doc } from '#engine/shared/types.js';

export const UNKNOWN_COMPONENT = 'unknown-component';

/** The app's own host components: src/components/<Name>.ts or .js. */
function ownComponents(root: string): string[] {
  const dir = join(root, 'src', 'components');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((file) => HOST_EXTS.filter((ext) => file.endsWith(ext)).map((ext) => file.slice(0, -ext.length)));
}

/** A finding for each Custom in `doc` with nothing to mount, at its place (a part's own line, when it is in a part). */
export function missingComponents(root: string, doc: Doc): Diagnostic[] {
  const customs = Object.values(doc.nodes).filter((node) => node.type === Nt.Custom && typeof node.props?.component === 'string' && node.props.component);
  if (!customs.length) return [];
  const known = [...ownComponents(root), ...Object.keys(loadPluginComponents(root))];
  const fromNpm = new Set((doc.imports || []).filter((def) => def.kind).flatMap((def) => def.names));   // `use element|widget|react`
  const out: Diagnostic[] = [];
  for (const node of customs) {
    const name = node.props.component || '';
    if (known.includes(name) || fromNpm.has(name.split('.')[0])) continue;
    out.push(diag(UNKNOWN_COMPONENT, `\`Custom ${name}\` has nothing to mount: there is no src/components/${name}.ts or .js, no plugin ships one, and no \`use element|widget|react ${name}\` brings it from npm.`, { loc: node.place ?? node.loc ?? null, suggestion: closest(name, known), from: name }));
  }
  return out;
}
