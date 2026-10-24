// route-preload: every file a page needs, asked for at once. A page's chunk imports shared chunks, which import
// others; the browser found each only after the one before it had downloaded and parsed (Storio's landing home, on a
// phone: boot → 2 chunks → the page → 8 chunks, five round trips before the first word). The build knows the whole
// graph, so it writes it down:
//   · <link rel="modulepreload"> in index.html for what the boot itself imports (every page needs it);
//   · <meta name="muten-route-js"> with each page's files beyond the boot's, which the router asks for the moment it
//     starts loading that page, or the moment the reader shows they may open it (runtime-preload.ts).
// The meta is compact: the file names once, each page a list of their positions. A page whose code reads `muten:texts`
// is marked: its language's texts are a chunk of their own that the texts module asks for only once it runs, so the
// router asks for the language the reader most likely reads with the rest (`langs`: each language's file).
import { relative } from 'node:path';
import type { Metafile } from 'esbuild';
import { closure, bootOutput, bootLoads } from './bundle-graph.js';

export const ROUTE_JS_META = 'muten-route-js';

const TEXTS_LANG = /virtual:muten\/texts-lang\/([a-z]{2,3})$/;

const escapeAttr = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Every file each page needs: the boot and what it imports, then per page what it adds; and the texts' languages. */
export interface RouteFiles { boot: string; bootDeps: string[]; pages: { [page: string]: string[] }; texts: string[]; langs: { [code: string]: string } }

/** What the bundle's pages need, as the addresses the browser asks for (null when there is no boot). */
export function routeFiles(metafile: Metafile, outDir: string): RouteFiles | null {
  const boot = bootOutput(metafile);
  if (!boot) return null;
  const href = (file: string): string => '/' + relative(outDir, file).replace(/\\/g, '/');
  const booted = closure(metafile, boot, new Set());
  const langs: { [code: string]: string } = {};
  for (const [file, output] of Object.entries(metafile.outputs)) {
    const inputs = Object.keys(output.inputs);
    const lang = TEXTS_LANG.exec(inputs[0] || '');
    if (lang && inputs.length === 1) langs[lang[1]] = href(file);
  }
  const langFiles = new Set(Object.values(langs));
  const readsTexts = (file: string): boolean => metafile.outputs[file].imports.some((im) => im.kind === 'dynamic-import' && langFiles.has(href(im.path)));
  const pages: { [page: string]: string[] } = {};
  const texts: string[] = [];
  for (const [page, chunk] of bootLoads(metafile, boot).pages) {
    const needs = [...closure(metafile, chunk, new Set(booted))].filter((file) => !booted.has(file) && file.endsWith('.js'));
    if (needs.some(readsTexts)) texts.push(page);
    pages[page] = needs.map(href);
  }
  const bootDeps = [...booted].filter((file) => file !== boot && file.endsWith('.js')).map(href);
  return { boot: href(boot), bootDeps, pages, texts, langs };
}

/** The tags to put in <head>: the boot's own imports, preloaded, and the meta naming each page's files. */
export function routePreloadTags(files: RouteFiles | null): string {
  if (!files) return '';
  const tags = files.bootDeps.map((href) => `<link rel="modulepreload" href="${href}">`);
  const list: string[] = [];
  const position = new Map<string, number>();
  const pages: { [page: string]: number[] } = {};
  for (const [page, hrefs] of Object.entries(files.pages)) {
    pages[page] = hrefs.map((href) => {
      if (!position.has(href)) { position.set(href, list.length); list.push(href); }
      return position.get(href) ?? 0;
    });
  }
  if (list.length) tags.push(`<meta name="${ROUTE_JS_META}" content="${escapeAttr(JSON.stringify({ files: list, pages, texts: files.texts, langs: files.langs }))}">`);
  return tags.join('\n  ');
}
