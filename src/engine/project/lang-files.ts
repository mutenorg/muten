// lang-files: the app's texts, one data file per language (src/lang/es.lang, src/lang/en.lang), one text per line:
//   login.email   "Correo"
//   plan.left     "Te quedan {0} de {1}"
//   cart.items    "Un producto | {0} productos"      ← singular | plural, chosen by the first value
// Read by the compiler (each page carries only the texts it uses) and checked by `muten check`: a key every language
// has, values that fill the same {0} {1}. Data, not code: the i18n.ts files of 5,000 lines this replaces were code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tokenize } from '#engine/lang/lexer.js';
import { ParseError } from '#engine/shared/diagnostics.js';
import { Tk, Pn } from '#engine/shared/vocab.js';
import type { Loc, Translations, Token } from '#engine/shared/types.js';
import { readMutenConfig, type ConfigBlock } from '#engine/project/config.js';

export const LANG_DIR = 'lang';
export const LANG_EXT = '.lang';

const KEY_JOINS = new Set<string>([Pn.Dot, Pn.Dash]);
/** The next piece of a key: a word, a number or a `.` / `-`, touching the piece before (`hm.steps.1d`, `who.small-business`). */
function continuesKey(before: Token, next: Token): boolean {
  return before.end === next.pos && (next.t === Tk.Ident || next.t === Tk.Number || (next.t === Tk.Punct && KEY_JOINS.has(next.v)));
}

/** One .lang file's texts, by key, with where each is written. A mistake is a located ParseError. */
export function parseLang(source: string): { texts: { [key: string]: string }; locs: { [key: string]: Loc } } {
  const tokens = tokenize(source);
  const texts: { [key: string]: string } = {};
  const locs: { [key: string]: Loc } = {};
  const locOf = (pos: number): Loc => { const before = source.slice(0, pos); return { line: before.split('\n').length, col: pos - before.lastIndexOf('\n') }; };
  let i = 0;
  while (tokens[i].t !== Tk.Eof) {
    const start = tokens[i];
    if (start.t !== Tk.Ident) throw new ParseError(`a line of a .lang file is \`key "text"\`, like \`login.email "Correo"\``, locOf(start.pos));
    let key = tokens[i++].v;
    // a key is dotted, and a segment may be kebab or carry a number (`who.small-business.h1`, `hm.steps.1d`): only pieces
    // that touch join, so `a - b` is never one key
    while (continuesKey(tokens[i - 1], tokens[i])) key += tokens[i++].v;
    if (KEY_JOINS.has(key.slice(-1))) throw new ParseError(`"${key}" ends in «${key.slice(-1)}»: a key's last piece is a word or a number`, locOf(start.pos));
    if (tokens[i].t !== Tk.String) throw new ParseError(`"${key}" needs its text in quotes: \`${key} "…"\``, locOf(tokens[i].pos));
    if (key in texts) throw new ParseError(`"${key}" is written twice in this file (line ${locs[key].line} and here)`, locOf(start.pos));
    texts[key] = tokens[i++].v;
    locs[key] = locOf(start.pos);
  }
  return { texts, locs };
}

/** The app's languages, by code, from src/lang/*.lang (none: the app has no texts of its own). */
export function langFiles(appRoot: string): { [code: string]: string } {
  const dir = join(appRoot, 'src', LANG_DIR);
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((file) => file.endsWith(LANG_EXT)).sort().map((file) => [basename(file, LANG_EXT), join(dir, file)]));
}

/** muten.config's `i18n { languages [...]  default "es"  detect false }`: which languages ship, the one a reader
 *  starts in when nothing else says (and the first a missing text falls back to), and whether the browser's language
 *  counts. Without the block: every .lang file, the first one by name as the default, the browser counts. */
export interface I18n { languages: string[] | null; fallback: string; detect: boolean }

/** The app's i18n settings (a muten.config that does not parse is check's to report: the defaults then). */
export function readI18n(appRoot: string): I18n {
  let block: ConfigBlock = {};
  try { const read = readMutenConfig(appRoot).i18n; if (read && typeof read === 'object' && !Array.isArray(read)) block = read; } catch { /* reported by check */ }
  const languages = Array.isArray(block.languages) ? block.languages.filter((code): code is string => typeof code === 'string') : null;
  return { languages, fallback: typeof block.default === 'string' ? block.default : '', detect: block.detect !== false };
}

/** The meta tag a page carries when the browser's language must not count (`i18n { detect false }`; runtime-lang.ts). */
export const LANG_DETECT_META = 'muten-lang-detect';
export function langDetectTag(appRoot: string): string {
  return readI18n(appRoot).detect ? '' : `<meta name="${LANG_DETECT_META}" content="off">`;
}

/** Every language's texts, or undefined for an app with no src/lang (then `t` and `lang` are free names). A file that
 *  does not parse contributes nothing here: `check` reports it. */
export function readTranslations(appRoot: string): Translations | undefined {
  const { languages, fallback } = readI18n(appRoot);
  // only the languages i18n lists (a draft .lang stays out), and the default first: it is where a reader starts when
  // nothing else matches, and the first place a missing text is looked for (runtime-lang.ts reads them in this order)
  const files = Object.entries(langFiles(appRoot)).filter(([code]) => !languages || languages.includes(code)).sort(([a], [b]) => Number(b === fallback) - Number(a === fallback));
  if (!files.length) return undefined;
  const out: Translations = {};
  for (const [code, file] of files) {
    try { out[code] = parseLang(readFileSync(file, 'utf8')).texts; } catch { out[code] = {}; }
  }
  return out;
}
