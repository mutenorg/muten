// lang-check: what `muten check` (and the editor) says about src/lang/*.lang, the app's texts.
//   a line that is not `key "text"`             lang-syntax, where it is
//   a key another language has and this lacks   lang-missing (the reader of this language would see the key)
//   "Hola, {0}" here but "Hello" there          lang-values: the same t() call cannot fill both
//   a file named spanish.lang                   lang-code: lang.use() and <html lang> speak codes (es, en, pt-BR)
import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { langFiles, parseLang, LANG_EXT } from '#engine/project/lang-files.js';
import { valuesNeeded } from '#engine/ir/translate-check.js';
import { diag, ParseError } from '#engine/shared/diagnostics.js';
import type { Diagnostic, Loc } from '#engine/shared/types.js';

const LANG_CODE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const LISTED = 8;   // a language that lacks hundreds of keys names the first ones, then counts

interface Parsed { texts: { [key: string]: string }; locs: { [key: string]: Loc } }

function parseOr(source: string, out: Diagnostic[]): Parsed | null {
  try { return parseLang(source); }
  catch (e) { if (e instanceof ParseError) { out.push(diag('lang-syntax', e.message, { loc: e.loc })); return null; } throw e; }
}

// one language against the others: what it lacks, and texts that fill other values than theirs
function compare(code: string, own: Parsed, others: { [code: string]: Parsed }): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!LANG_CODE.test(code)) out.push(diag('lang-code', `"${code}${LANG_EXT}" names a language by its file, so lang.use("${code}") and <html lang="${code}"> would carry it: name it by its code, like es.lang, en.lang or pt-BR.lang`, { severity: 'warning' }));
  const missing = new Map<string, string>();
  for (const [otherCode, other] of Object.entries(others)) {
    for (const key of Object.keys(other.texts)) if (!(key in own.texts) && !missing.has(key)) missing.set(key, otherCode);
  }
  if (missing.size) {
    const keys = [...missing.keys()];
    const named = keys.slice(0, LISTED).map((key) => `${key} (in ${missing.get(key)})`).join(', ');
    out.push(diag('lang-missing', `${code} lacks ${keys.length} text${keys.length === 1 ? '' : 's'} another language has, so its reader would see the bare key: ${named}${keys.length > LISTED ? `, and ${keys.length - LISTED} more` : ''}`, { loc: { line: 1, col: 1 } }));
  }
  for (const [key, text] of Object.entries(own.texts)) {
    for (const [otherCode, other] of Object.entries(others)) {
      const theirs = other.texts[key];
      if (theirs === undefined || valuesNeeded(theirs) === valuesNeeded(text)) continue;
      out.push(diag('lang-values', `"${key}" fills ${valuesNeeded(text)} value(s) here and ${valuesNeeded(theirs)} in ${otherCode} ("${theirs}"): one t("${key}", …) call passes the same values to both`, { loc: own.locs[key], severity: 'warning' }));
      break;
    }
  }
  return out;
}

function parsedAll(appRoot: string, skip?: string): { [code: string]: Parsed } {
  const out: { [code: string]: Parsed } = {};
  for (const [code, file] of Object.entries(langFiles(appRoot))) {
    if (file === skip) continue;
    try { out[code] = parseLang(readFileSync(file, 'utf8')); } catch { /* reported on its own file */ }
  }
  return out;
}

/** Every .lang file's diagnostics, for `muten check`. */
export function checkLang(appRoot: string): Array<{ file: string } & Diagnostic> {
  const out: Array<{ file: string } & Diagnostic> = [];
  const files = langFiles(appRoot);
  const all = parsedAll(appRoot);
  for (const [code, file] of Object.entries(files)) {
    const found: Diagnostic[] = [];
    const own = parseOr(readFileSync(file, 'utf8'), found);
    if (own) found.push(...compare(code, own, Object.fromEntries(Object.entries(all).filter(([other]) => other !== code))));
    for (const d of found) out.push({ file: relative(appRoot, file), ...d });
  }
  return out;
}

/** One .lang file as the editor holds it (unsaved text), against the others on disk. */
export function checkLangText(appRoot: string, filePath: string, text: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  const own = parseOr(text, found);
  if (own) found.push(...compare(basename(filePath, LANG_EXT), own, parsedAll(appRoot, filePath)));
  return found;
}

