// Anchors a part file's relative `use` paths to the app root (`/src/…`), so they resolve from whichever page or
// layout inlines the part. `~/…` and package imports already resolve from anywhere and pass through untouched.

import { dirname, join, sep } from 'node:path';
import type { ImportDef } from '#engine/shared/types.js';

const SRC_SEGMENT = `${sep}src${sep}`;

export function anchorImports(filePath: string, imports: ImportDef[]): ImportDef[] {
  return imports.map((im) => {
    if (!im.from.startsWith('.')) return im;
    const absolute = join(dirname(filePath), im.from);
    const at = absolute.lastIndexOf(SRC_SEGMENT);
    return at < 0 ? im : { ...im, from: absolute.slice(at).split(sep).join('/') };
  });
}
