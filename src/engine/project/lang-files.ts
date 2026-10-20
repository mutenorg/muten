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
import type { Loc, Translations } from '#engine/shared/types.js';

export const LANG_DIR = 'lang';
export const LANG_EXT = '.lang';

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
    while (tokens[i].t === Tk.Punct && tokens[i].v === Pn.Dot && tokens[i + 1]?.t === Tk.Ident) { key += '.' + tokens[i + 1].v; i += 2; }
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

/** Every language's texts, or undefined for an app with no src/lang (then `t` and `lang` are free names). A file that
 *  does not parse contributes nothing here: `check` reports it. */
export function readTranslations(appRoot: string): Translations | undefined {
  const files = Object.entries(langFiles(appRoot));
  if (!files.length) return undefined;
  const out: Translations = {};
  for (const [code, file] of files) {
    try { out[code] = parseLang(readFileSync(file, 'utf8')).texts; } catch { out[code] = {}; }
  }
  return out;
}
