// texts-modules: the modules behind `muten:texts`, the app's texts for code outside a page (a `use` function, a Custom),
// one language per chunk (esbuild-muten.ts serves them as virtual modules).
import type { Translations } from '#engine/shared/types.js';

const RID = 'virtual:muten/runtime';
/** The virtual path of one language's texts: `virtual:muten/texts-lang/es`. */
export const TEXTS_LANG = 'virtual:muten/texts-lang/';

/** The module behind `muten:texts`: a t() over the app's texts, the runtime's own (__t), one language per chunk. It
 *  shipped every language in one module (Storio's landing: 376 KB on the home, for a reader who reads one); now the
 *  language the first screen will be read in is awaited before any code that imports this runs, and another one is
 *  fetched the first time it is asked for: until it lands t() answers from a loaded language (__t's own fallback) and
 *  the screen re-reads it when it arrives. `texts` keeps its shape (`texts.es["a.b"]`, `"a.b" in texts.en`) over what
 *  is loaded; `has(key)` asks for a key in any language (`muten check` keeps every language's keys the same). */
export function textsModule(translations: Translations | undefined): string {
  const languages = Object.keys(translations || {});
  const loaders = languages.map((code) => `${JSON.stringify(code)}: () => import(${JSON.stringify(TEXTS_LANG + code)})`).join(', ');
  return `import { __t, __langLikely, signal } from '${RID}';
const loaders = { ${loaders} };
const loaded = {};
const pending = {};
const arrived = signal(0);
let count = 0;
function load(code) {
  if (loaded[code] || !loaders[code]) return Promise.resolve();
  return pending[code] || (pending[code] = loaders[code]().then((module) => { loaded[code] = module.default; arrived.set(++count); }));
}
const any = () => Object.values(loaded)[0] || {};
await Promise.all(__langLikely(${JSON.stringify(languages)}).map(load));
export const texts = new Proxy(loaded, { get: (table, code) => { arrived.get(); if (typeof code === 'string' && !table[code]) load(code); return table[code] || any(); } });
export function ready(language) { return load(language); }
export function has(key) { arrived.get(); return Object.values(loaded).some((table) => key in table); }
export function t(language, key, ...values) { arrived.get(); load(language); return __t(language, loaded, key, ...values); }
`;
}

/** One language's texts, the chunk `muten:texts` fetches. */
export function textsLanguageModule(translations: Translations | undefined, code: string): string {
  return `export default ${JSON.stringify(translations?.[code] || {})};\n`;
}
