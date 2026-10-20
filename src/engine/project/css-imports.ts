// css-imports: a stylesheet's `@import "leaflet/dist/leaflet.css"` brought into the build. The browser cannot reach
// node_modules, so an import left as written asked for a file the server does not have (a 404, and the component
// showed without its styles). Each import of a package or a relative file is replaced by the file itself, its own
// imports too; a url (`http…`, `//…`) or a `url(…)` stays for the browser, and a file is brought in once.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/g;
const REMOTE = /^(?:[a-z]+:)?\/\//i;

/** The stylesheet with every local or package `@import` replaced by its content (Tailwind does this itself). */
export function inlineCssImports(css: string, fromDir: string, appRoot: string, seen: Set<string> = new Set()): string {
  let req;
  try { req = createRequire(join(appRoot, 'package.json')); } catch { return css; }
  return css.replace(IMPORT, (whole: string, spec: string, media: string) => {
    if (REMOTE.test(spec) || spec.startsWith('data:')) return whole;
    let file = '';
    try { file = spec.startsWith('.') || spec.startsWith('/') ? resolve(fromDir, spec) : req.resolve(spec); } catch { return whole; }
    if (seen.has(file)) return '';
    seen.add(file);
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return whole; }
    const inner = inlineCssImports(text, dirname(file), appRoot, seen);
    return media.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
  });
}
