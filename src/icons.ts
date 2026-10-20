// `Icon "set:name"` -> inline SVG, resolved at BUILD via Iconify. Build-time only: nothing of Iconify
// reaches the browser (the page gets a plain <svg>). muten ships NO icons (agnostic) — the set data comes
// from the app's own `@iconify-json/<set>` package (tree-shaken: only the icons you reference are inlined).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getIconData, iconToSVG, iconToHTML } from '@iconify/utils';
import type { IconifyJSON } from '@iconify/types';

/** A memoized `ref -> <svg>` resolver. Throws a clear, actionable error on a missing set or unknown name. */
export function makeIconResolver(appRoot: string): (ref: string) => string {
  const req = createRequire(join(appRoot, 'package.json'));
  const sets: { [set: string]: IconifyJSON } = {};
  const cache: { [ref: string]: string } = {};
  return (ref: string): string => {
    if (ref in cache) return cache[ref];
    const colon = ref.indexOf(':');
    if (colon < 1) throw new Error(`Icon "${ref}" must be "set:name" — e.g. Icon "lucide:settings".`);
    const set = ref.slice(0, colon), name = ref.slice(colon + 1);
    if (!(set in sets)) {
      try { const json: IconifyJSON = req(`@iconify-json/${set}/icons.json`); sets[set] = json; }   // an installed set's own icons.json
      catch { throw new Error(`Icon "${ref}": the icon set isn't installed — run \`npm i -D @iconify-json/${set}\`.`); }
    }
    const data = getIconData(sets[set], name);
    if (!data) throw new Error(`Icon "${ref}": no icon named "${name}" in set "${set}".`);
    const { attributes, body } = iconToSVG(data, { width: '1em', height: '1em' });
    const attrs: { [name: string]: string } = {};
    for (const [name, value] of Object.entries(attributes)) if (typeof value === 'string') attrs[name] = value;
    return cache[ref] = iconToHTML(body, attrs);
  };
}
