// bundle-graph: what a bundle's outputs need of each other, read from esbuild's metafile. The boot (app.muten's output)
// loads every page with a dynamic import; a page, a layout or the boot loads its own shared chunks with static ones.
// css-routes.ts asks which code a page can run (to know its CSS); route-preload.ts which files a page needs (to ask
// for all of them at once instead of one after another).
import type { Metafile } from 'esbuild';

const PAGE_ENTRY = /(?:^|\/)src\/pages\/([^/]+)\/\1\.muten$/;
const BOOT_ENTRY = /(?:^|\/)src\/app\.muten$/;
const entryOf = (metafile: Metafile, file: string): string => (metafile.outputs[file]?.entryPoint || '').replace(/\\/g, '/');

/** Every output `start` runs: its static imports, and with `later` what it imports on demand too. */
export function closure(metafile: Metafile, start: string, into: Set<string>, later = false): Set<string> {
  if (into.has(start) || !metafile.outputs[start]) return into;
  into.add(start);
  for (const im of metafile.outputs[start].imports) if (im.kind === 'import-statement' || (later && im.kind === 'dynamic-import')) closure(metafile, im.path, into, later);
  return into;
}

/** The boot's output file, if the bundle has one. */
export function bootOutput(metafile: Metafile): string | undefined {
  return Object.keys(metafile.outputs).find((file) => file.endsWith('.js') && BOOT_ENTRY.test(entryOf(metafile, file)));
}

/** What the boot loads on demand, split: each page's chunk by page name, and the rest (layouts, the shell). */
export function bootLoads(metafile: Metafile, boot: string): { pages: Map<string, string>; others: string[] } {
  const pages = new Map<string, string>();
  const others: string[] = [];
  for (const im of metafile.outputs[boot].imports) {
    if (im.kind !== 'dynamic-import') continue;
    const page = PAGE_ENTRY.exec(entryOf(metafile, im.path));
    if (page) pages.set(page[1], im.path);
    else others.push(im.path);
  }
  return { pages, others };
}
