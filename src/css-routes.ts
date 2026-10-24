// css-routes: one stylesheet per route. The whole app's CSS used to load on every page: Storio's app sent 1.2 MB of it
// to the login screen, which needs 200 KB, and matching all of those rules was the biggest cost a phone paid to show a
// page. Now `muten bundle` writes:
//   · the COMMON sheet, linked in index.html: the rules the boot, the shell, the layouts and the stores can match;
//   · one sheet per page: every rule that page (with the common code) can match, linked by the router before the page
//     shows (runtime-styles.ts), and moved last on every visit so the page on screen always has its own rules last,
//     in their original order.
//   · the WHOLE sheet (pruned), asked for in idle time once the first page is up: every later page finds its rules
//     there, so moving between pages downloads no CSS (listed under "*").
// Which rules a set of code can match is css-prune.ts's test, unchanged. `css { routes false }` in muten.config keeps
// one stylesheet for the whole app; `css { prune false }` keeps every rule (and so one sheet).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Metafile } from 'esbuild';
import { pruneCss } from './css-prune.js';
import { closure, bootOutput, bootLoads } from './bundle-graph.js';

/** What the build links: the common sheet's href, and each page's own sheet by page name. */
export interface StyleSheets { href: string; routes: { [page: string]: string } }
interface Options { outDir: string; css: string; metafile: Metafile; html: string; publicCode: string; perRoute: boolean; prune: boolean; say: (line: string) => void }

// the meta tag the router reads the sheets from (a <meta> and not a script, so no Content-Security-Policy is involved)
export const ROUTE_STYLES_META = 'muten-route-css';

const hashed = (outDir: string, name: string, css: string): string => {
  const hash = createHash('sha256').update(css).digest('hex').slice(0, 8).toUpperCase();
  writeFileSync(join(outDir, 'assets', `${name}-${hash}.css`), css);
  return `/assets/${name}-${hash}.css`;
};

/** Writes the stylesheet(s) of a bundle and says what to link. */
export function writeStyles(o: Options): StyleSheets {
  const code = (files: Set<string>): string => [...files].filter((file) => file.endsWith('.js')).map((file) => readFileSync(resolve(file), 'utf8')).join('\n');
  const outputs = Object.keys(o.metafile.outputs);
  const allJs = new Set(outputs.filter((file) => file.endsWith('.js')));
  const whole = (): StyleSheets => {
    if (!o.prune) return { href: hashed(o.outDir, 'boot', o.css), routes: {} };
    const { css, removed } = pruneCss(o.css, [o.html, code(allJs), o.publicCode].join('\n'));
    if (removed > 0) o.say(`  styles: ${(removed / 1024).toFixed(0)} KB of rules no page can match left out (css { prune false } keeps them)`);
    return { href: hashed(o.outDir, 'boot', css), routes: {} };
  };
  const boot = bootOutput(o.metafile);
  if (!o.perRoute || !o.prune || !boot) return whole();
  // the common code: the boot and what it needs, and every chunk it loads that is not a page (layouts, the shell). A
  // page's sheet follows what it loads later too (a component it imports on demand, a React island): a sheet without
  // their rules showed them unstyled (Storio's agenda on the login)
  const common = closure(o.metafile, boot, new Set());
  const { pages, others } = bootLoads(o.metafile, boot);
  for (const other of others) closure(o.metafile, other, common, true);
  if (!pages.size) return whole();
  const base = [o.html, o.publicCode].join('\n');
  const commonCss = pruneCss(o.css, `${base}\n${code(common)}`).css;
  const routes: { [page: string]: string } = {};
  let largest = 0;
  for (const [page, chunk] of pages) {
    const css = pruneCss(o.css, `${base}\n${code(closure(o.metafile, chunk, new Set(common), true))}`).css;
    largest = Math.max(largest, css.length);
    routes[page] = hashed(o.outDir, `${page}.route`, css);
  }
  // THE WHOLE SHEET, FOR EVERYTHING AFTER THE FIRST PAGE. Each route's sheet repeats every rule the pages share (the
  // bar, the footer, the components): moving from one page to the next downloaded 45 KB of rules already there. So
  // once the first page is up, the router asks, in idle time, for one sheet with every rule (pruned, in its original
  // order, so the cascade is the one the author wrote) and no move downloads CSS again (runtime-styles.ts).
  routes['*'] = hashed(o.outDir, 'all', pruneCss(o.css, [o.html, code(allJs), o.publicCode].join('\n')).css);
  o.say(`  styles: one sheet per route for the first page, ${(largest / 1024).toFixed(0)} KB at most instead of ${(o.css.length / 1024).toFixed(0)} KB, and the whole one after it (css { routes false } keeps one)`);
  return { href: hashed(o.outDir, 'boot', commonCss), routes };
}

/** The tag that tells the router each page's sheet. */
export function routeStylesTag(routes: { [page: string]: string }): string {
  if (!Object.keys(routes).length) return '';
  return `<meta name="${ROUTE_STYLES_META}" content="${JSON.stringify(routes).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
}
