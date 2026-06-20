// The PROJECT's stylesheet for a screen — the escape hatch / bring-your-own-theme.
//
// Convention: COLOCATED next to the page.screen, same name, different extension.
//   .../users/users.screen  →  .../users/users.scss  (or .css)
//
// The engine imposes no theme: this is injected AFTER the engine CSS and wins via cascade.
//   .css  → zero-dependency (read and injected as-is)
//   .scss → needs the `sass` package (OPTIONAL dependency: only if you use .scss)

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

export async function resolveStyles(screenPath) {
  const scss = screenPath.replace(/\.muten$/, '.scss');
  const css = screenPath.replace(/\.muten$/, '.css');

  if (existsSync(scss)) {
    let sass;
    try { sass = await import('sass'); }
    catch { throw new Error(`To compile ${basename(scss)} install sass:  npm i -D sass`); }
    return { css: sass.compile(scss).css, from: basename(scss) };
  }
  if (existsSync(css)) return { css: readFileSync(css, 'utf8'), from: basename(css) };
  return { css: '', from: null };
}
