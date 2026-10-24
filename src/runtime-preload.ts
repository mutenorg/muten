// runtime-preload: a page's files, asked for together (route-preload.ts writes which they are), and the texts of the
// language the reader most likely reads when the page speaks through `muten:texts`. Without the meta (dev, or a bundle
// without pages) this does nothing; a file already asked for is not asked for again.
import { __langLikely } from './runtime-lang.js';

const META = 'muten-route-js';
interface Table { files: string[]; pages: { [page: string]: number[] }; texts: string[]; langs: { [code: string]: string } }
let table: Table | null = null;
const asked = new Set<string>();

const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((item: unknown): item is string => typeof item === 'string') : []);

function read(): Table {
  const out: Table = { files: [], pages: {}, texts: [], langs: {} };
  const meta = document.querySelector(`meta[name="${META}"]`);
  if (!meta) return out;
  try {
    const parsed: unknown = JSON.parse(meta.getAttribute('content') || '{}');
    if (typeof parsed !== 'object' || parsed === null) return out;
    if ('files' in parsed) out.files = strings(parsed.files);
    if ('texts' in parsed) out.texts = strings(parsed.texts);
    if ('pages' in parsed && typeof parsed.pages === 'object' && parsed.pages !== null) {
      for (const [page, list] of Object.entries(parsed.pages)) if (Array.isArray(list)) out.pages[page] = list.filter((index: unknown): index is number => typeof index === 'number');
    }
    if ('langs' in parsed && typeof parsed.langs === 'object' && parsed.langs !== null) {
      for (const [code, href] of Object.entries(parsed.langs)) if (typeof href === 'string') out.langs[code] = href;
    }
  } catch { /* a broken tag: pages still load, one file after another */ }
  return out;
}

function preload(href: string | undefined): void {
  if (!href || asked.has(href)) return;
  asked.add(href);
  const link = document.createElement('link');
  link.rel = 'modulepreload';
  link.href = href;
  document.head.appendChild(link);
}

/** Asks for every file `page` needs beyond the boot's, in parallel, and its likely language's texts. */
export function preloadPage(page?: string): void {
  if (!page || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  if (!table) table = read();
  const known = table;
  for (const index of known.pages[page] || []) preload(known.files[index]);
  if (known.texts.includes(page)) for (const code of __langLikely(Object.keys(known.langs))) preload(known.langs[code]);
}
