// ship-report: what `muten bundle` prints when it is done. Each route, with its own chunk and what a reader downloads
// to open it (boot + chunk + what they import up front, gzipped); then every other file, said by who loads it: every
// route, some routes, or later (on demand: a React/Vue island waking, a lazy Custom). It used to call all of those
// «shared», so Vue loaded by one island on one page read as weight on every page.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Metafile } from 'esbuild';
import { closure, bootOutput, bootLoads } from './bundle-graph.js';
import { routeShipped } from './budget.js';

interface Size { raw: number; gz: number }

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`.padStart(9);
const sizeOf = (file: string): Size => { const buf = readFileSync(file); return { raw: buf.length, gz: gzipSync(buf).length }; };
const LABEL = 30;

/** Prints the report through `say`. `css` is the stylesheet's file, when there is one. */
export function shipReport(metafile: Metafile, routes: Array<{ url: string; page: string }>, css: string | null, say: (line: string) => void): void {
  const sizes = new Map<string, Size>();
  const size = (file: string): Size => { const known = sizes.get(file); if (known) return known; const measured = sizeOf(file); sizes.set(file, measured); return measured; };
  const row = (label: string, of: Size, note = ''): void => say('  ' + label.padEnd(LABEL) + kb(of.raw) + '  ' + kb(of.gz).trim() + ' gz' + (note ? '   ' + note : ''));
  const boot = bootOutput(metafile);
  const pages = boot ? bootLoads(metafile, boot).pages : new Map<string, string>();
  const shipped = new Map(routeShipped(metafile, routes, (file) => size(file).gz).map((one) => [one.url, one]));
  const urlOf = (url: string): string => '/' + url.replace(/^\//, '');
  const claimed = new Set<string>();
  let total: Size = { raw: 0, gz: 0 };
  const count = (of: Size): void => { total = { raw: total.raw + of.raw, gz: total.gz + of.gz }; };

  for (const route of routes) {
    const chunk = pages.get(route.page);
    if (!chunk || claimed.has(chunk)) continue;
    claimed.add(chunk); count(size(chunk));
    row(urlOf(route.url), size(chunk), `opens with ${kb(shipped.get(route.url)?.js ?? 0).trim()} gz`);
  }

  // who loads each other file: up front (in a route's opening set) or later (only through an on-demand import)
  const upFront = new Map<string, string[]>();
  const later = new Map<string, string[]>();
  for (const route of routes) {
    const chunk = pages.get(route.page);
    const now = new Set((shipped.get(route.url)?.files || []).map((one) => one.file));
    const eventually = boot ? closure(metafile, boot, new Set()) : new Set<string>();
    if (chunk) closure(metafile, chunk, eventually, true);
    for (const file of now) upFront.set(file, [...(upFront.get(file) || []), urlOf(route.url)]);
    for (const file of eventually) if (!now.has(file)) later.set(file, [...(later.get(file) || []), urlOf(route.url)]);
  }
  const who = (file: string): string => {
    const now = upFront.get(file) || [];
    if (now.length && now.length === routes.length) return 'every route';
    if (now.length) return now.join(', ');
    const on = later.get(file) || [];
    return on.length ? `later, on ${on.join(', ')} (when it is needed)` : 'later';
  };
  for (const file of Object.keys(metafile.outputs)) {
    if (claimed.has(file) || !file.endsWith('.js')) continue;
    claimed.add(file); count(size(file));
    row('· ' + basename(file).replace(/-[A-Z0-9]+\.js$/, ''), size(file), who(file));
  }
  if (css) { count(size(css)); row('· styles.css', size(css), 'every route'); }
  say('  ' + '─'.repeat(LABEL + 20));
  row('total', total);
}
