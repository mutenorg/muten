// The PROJECT's stylesheet for a page — the bring-your-own-look escape hatch.
//
// Convention: COLOCATED next to the page, same name, different extension:
//   .../home/home.muten  →  .../home/home.css  (or home.scss)
//
// muten imposes no theme. This CSS is injected AFTER the engine's token CSS, so it wins via the
// cascade. `.css` is zero-dependency; `.scss` needs the OPTIONAL `sass` package (only if you use it).

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ResolvedStyles } from '#engine/shared/types.js';

export async function resolveStyles(screenPath: string): Promise<ResolvedStyles> {
  const scss = screenPath.replace(/\.muten$/, '.scss');
  const css = screenPath.replace(/\.muten$/, '.css');

  if (existsSync(scss)) {
    const sass = await import('sass').catch(() => {
      throw new Error(`To compile ${basename(scss)} install sass:  npm i -D sass`);
    });
    return { css: sass.compile(scss).css, from: basename(scss) };
  }
  if (existsSync(css)) return { css: readFileSync(css, 'utf8'), from: basename(css) };
  return { css: '', from: null };
}
