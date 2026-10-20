// runtime-lang: the language the app speaks, and `t("key", …)`. `lang.current` starts as the reader's choice from last
// time, else the browser's language, else index.html's <html lang>, else the first language the app has; `lang.use("en")`
// changes it, remembers it and sets <html lang> (what a screen reader and a translator read). A page can speak another
// language than the app (`lang from shop.lang`): the compiler hands t that one instead.
import { signal } from './runtime-signals.js';
import type { Signal } from './engine/shared/types.js';

const SAVED = 'muten:lang';
const current: Signal<string> = signal('');
let available: string[] = [];

const stored = (): string => { try { return localStorage.getItem(SAVED) || ''; } catch { return ''; } };

/** Called by every page that speaks: the languages the app has (the first call settles the starting one). */
export function __langInit(languages: string[]): void {
  if (current.get()) return;
  available = languages;
  const browser = typeof navigator !== 'undefined' ? (navigator.language || '').slice(0, 2).toLowerCase() : '';
  const page = typeof document !== 'undefined' && document.documentElement ? (document.documentElement.lang || '').slice(0, 2).toLowerCase() : '';
  const start = [stored(), browser, page].find((code) => languages.includes(code)) || languages[0] || '';
  current.set(start);
  if (typeof document !== 'undefined' && document.documentElement && start) document.documentElement.lang = start;
}

/** `lang.current`. */
export function __lang(): Signal<string> { return current; }

/** `lang.list`: the languages the app has. */
export function __langList(): string[] { return available; }

/** `lang.use("en")`. */
export function __langUse(code: string): void {
  if (available.length && !available.includes(code)) return;
  current.set(code);
  try { localStorage.setItem(SAVED, code); } catch { /* private mode: it still changes, it just is not remembered */ }
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = code;
}

/** The text of `key` in `language`, from the page's own table: `{0}` filled, `a | b` the singular or the plural by the
 *  first value. A key the language lacks falls back to another language, then to the key itself. */
export function __t(language: string, table: { [code: string]: { [key: string]: string } }, key: string, ...values: Array<string | number>): string {
  const raw = table[language]?.[key] ?? Object.values(table).find((texts) => key in texts)?.[key] ?? key;
  const halves = raw.split(' | ');
  const line = halves.length === 2 ? (Number(values[0]) === 1 ? halves[0] : halves[1]) : raw;
  return line.replace(/\{(\d+)\}/g, (whole: string, index: string) => (values[Number(index)] === undefined ? whole : String(values[Number(index)])));
}
