// devtools-server: what `muten dev` tells its devtools, so the panel shows facts it could not see from inside the page.
//   /_muten/issues?screen=x   the findings of `muten check` on that page and the parts it draws (computed once per build)
//   /_muten/texts             every language of src/lang against the default one: what each lacks, values that differ
//   /_muten/weight            what each route ships, from the last `muten bundle` (the dev server's code is not it)
// Read-only, from this machine: the dev server answers only its own host names (dev-security.ts).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Metafile } from 'esbuild';
import { findings } from './lint.js';
import { load, loadAllParts } from '#engine/project/load.js';
import { readRoutes } from '#engine/project/routes.js';
import { readTranslations } from '#engine/project/lang-files.js';
import { routeShipped } from './budget.js';
import type { Found } from '#engine/project/place.js';

const PLACEHOLDER = /\{(\d+)\}/g;

let cached: Promise<Found[]> | null = null;

/** A build changed the app: the next question reads the findings again. */
export function forgetIssues(): void { cached = null; }

/** The findings of the page `screen` and of the parts it draws. */
async function pageIssues(root: string, screen: string): Promise<{ page: Found[]; elsewhere: number }> {
  cached = cached ?? findings(root);
  const all = await cached;
  const route = readRoutes(root).find((entry) => entry.page === screen);
  if (!route) return { page: [], elsewhere: all.length };
  const files = new Set([relative(root, route.screenPath)]);
  try {
    const parts = await loadAllParts(root);
    const { partNames } = await load(route.screenPath, parts);
    for (const name of partNames) { const file = parts[name]?.file; if (file && !file.includes('node_modules')) files.add(relative(root, file)); }
  } catch { /* a page that does not load: its own file's findings say why */ }
  const page = all.filter((found) => files.has(found.file));
  return { page, elsewhere: all.length - page.length };
}

/** The languages of src/lang against the default (index.html's lang, else the one with most texts). */
function texts(root: string): object {
  const table = readTranslations(root);
  if (!table) return { languages: [] };
  const codes = Object.keys(table);
  const shell = existsSync(join(root, 'index.html')) ? readFileSync(join(root, 'index.html'), 'utf8') : '';
  const declared = /<html[^>]*\blang="([^"]+)"/i.exec(shell)?.[1] ?? '';
  const base = codes.includes(declared) ? declared : [...codes].sort((a, b) => Object.keys(table[b]).length - Object.keys(table[a]).length)[0];
  const keys = Object.keys(table[base]);
  const slots = (text: string): string => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort().join(',');
  return {
    base,
    total: keys.length,
    languages: codes.map((code) => ({
      code,
      missing: keys.filter((key) => table[code][key] === undefined),
      differs: keys.filter((key) => table[code][key] !== undefined && slots(table[code][key]) !== slots(table[base][key])),
      same: code === base ? [] : keys.filter((key) => table[code][key] === table[base][key] && /\p{L}{3,}/u.test(table[base][key])),
    })),
  };
}

/** What each route ships, gzipped, from the last bundle; null when there was none. */
function weight(root: string): object | null {
  const record = join(root, '.muten', 'bundle.json');
  if (!existsSync(record)) return null;
  let metafile: Metafile;
  try { metafile = JSON.parse(readFileSync(record, 'utf8')); } catch { return null; }
  // the bundle is written in dist.building-N and renamed to dist once done: its record names the first
  const gz = (file: string): number => { try { return gzipSync(readFileSync(join(root, file.replace(/\.building-\d+(?=[\\/])/, '')))).length; } catch { return 0; } };
  const routes = readRoutes(root).map((entry) => ({ url: '/' + entry.route, page: entry.page }));
  return { at: statSync(record).mtime.toISOString(), routes: routeShipped(metafile, routes, gz) };
}

/** Answers a devtools question, or false when `url` is not one. */
export async function devtoolsAnswer(root: string, url: string, query: URLSearchParams): Promise<object | null | false> {
  if (url === '/_muten/issues') return pageIssues(root, query.get('screen') || '');
  if (url === '/_muten/texts') return texts(root);
  if (url === '/_muten/weight') return weight(root);
  return false;
}
