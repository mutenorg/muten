// budget: `budget { js "150kb"  css "50kb" }` in muten.config fails `muten bundle` when a route ships more than that, so
// weight that creeps in (a library imported on the home, a sheet that keeps growing) stops the build instead of reaching
// readers. What a route ships is what its reader downloads to open it: the boot, the route's own chunk and every chunk
// they import up front, gzipped (what travels); the stylesheet is measured on its own.

import type { Metafile } from 'esbuild';
import { closure, bootOutput, bootLoads } from './bundle-graph.js';
import type { MutenConfig } from '#engine/project/config.js';
import { parseSize } from '#engine/project/sizes.js';

/** The limits, in bytes (gzipped). */
export interface Budget { js?: number; css?: number }

/** The app's budget, from muten.config. */
export function readBudget(config: MutenConfig): Budget {
  const block = config.budget;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {};
  return { js: parseSize(block.js), css: parseSize(block.css) };
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/** What one route ships to open: its JS files (boot, its chunk, what they import up front), gzipped, heaviest first. */
export interface Shipped { url: string; js: number; files: Array<{ file: string; gz: number }> }

/** What each route ships (`gzOf` measures one output file). */
export function routeShipped(metafile: Metafile, routes: Array<{ url: string; page: string }>, gzOf: (file: string) => number): Shipped[] {
  const boot = bootOutput(metafile);
  if (!boot) return [];
  const pages = bootLoads(metafile, boot).pages;
  return routes.map((route) => {
    const files = closure(metafile, boot, new Set());
    const chunk = pages.get(route.page);
    if (chunk) closure(metafile, chunk, files);
    const sized = [...files].filter((file) => file.endsWith('.js')).map((file) => ({ file, gz: gzOf(file) })).sort((x, y) => y.gz - x.gz);
    return { url: route.url, js: sized.reduce((sum, one) => sum + one.gz, 0), files: sized };
  });
}

/** What goes over: one line per route (and the stylesheet) above its limit, with what weighs most. */
export function overBudget(metafile: Metafile, routes: Array<{ url: string; page: string }>, css: string | null, budget: Budget, gzOf: (file: string) => number): string[] {
  const out: string[] = [];
  if (budget.js) for (const route of routeShipped(metafile, routes, gzOf))
    if (route.js > budget.js) out.push(`${route.url} ships ${kb(route.js)} of JS (budget ${kb(budget.js)}); heaviest: ${route.files.slice(0, 3).map((one) => `${one.file.split('/').pop()} ${kb(one.gz)}`).join(', ')}`);
  if (budget.css && css) {
    const gz = gzOf(css);
    if (gz > budget.css) out.push(`the stylesheet is ${kb(gz)} (budget ${kb(budget.css)})`);
  }
  return out;
}
