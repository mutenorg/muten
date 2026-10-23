// css-prune: drop the style rules that can never match, before the production stylesheet is hashed and written.
//
// A muten app's stylesheet is the app's CSS + its component library + Tailwind, which generates a utility for every
// word that looks like one anywhere in the source (comments included). On the Storio landing 2,350 of 7,927 rules
// named a class no page, part, library script or HTML file ever contains: 476 KB of 1,097, and two thirds of the
// time the browser spent matching styles on a phone. Removing exactly those rules changed no pixel on any page.
//
// The test is the one PurgeCSS made standard, kept conservative:
//   · a rule goes only if EVERY selector of it NEEDS a class the shipped code never contains;
//   · a class a selector needs is one outside any parentheses: in `.a:not(.b)` or `:is(.b, .c)` the rule can match
//     without `.b`, so only `.a` is needed;
//   · the shipped code is every word of the built JS and HTML; a word ending in `-` (`"status-" + x`, `` `cx-${k}` ``)
//     keeps every class that starts with it, so a class name built at run time is never dropped;
//   · a class is also built from a name and an ending kept apart (`const NS = 'cx-stb'` … `` `${NS}-bar` ``): it stays
//     when the code holds both the name (`cx-stb`) and the ending (`-bar`). Without this, @muten/shadcn's StackedBars
//     lost every `cx-stb-*` rule in a production build and drew its months as one line of text (23-10-2026).
// At-rules that hold rules (@media, @supports, @layer, @container…) are walked; one left empty goes too. Everything
// else (@font-face, @keyframes, @property, declarations, :root) is kept as written.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GROUPING_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'scope', 'document', 'starting-style']);
const MIN_PREFIX = 3;   // `a-` keeps too much to mean anything; `cx-` / `status-` is a real prefix
const ENDING = /^-[A-Za-z][\w-]*$/;   // `-bar`, `-legend-dot`: what a template or a `+` adds to a name

/** The words the shipped code contains, and the prefixes a class may be built from. */
export interface ShippedWords { words: Set<string>; prefixes: string[]; endings: Set<string> }

export function shippedWords(code: string): ShippedWords {
  const words = new Set<string>();
  for (const raw of code.match(/[^\s"'`<>=,;{}()\\]+/g) ?? []) {
    const word = raw.replace(/\$+$/, '');                   // `cx-${k}` reads as `cx-$`: the prefix is `cx-`
    if (word) words.add(word);
    for (const part of word.split(/[.#]/)) if (part) words.add(part);   // a selector string in a script (`'.cx-row'`)
  }
  // a Tailwind class with an arbitrary variant or value carries `=`, `>`, parentheses: `group-data-[size=default]/switch:size-4`,
  // `has-[>svg]:px-3`, `translate-x-[calc(100%-2px)]`. Read once more cut only at spaces and quotes, so those stay whole.
  for (const whole of code.match(/[^\s"'`]+/g) ?? []) words.add(whole);
  const prefixes = [...words].filter((word) => word.endsWith('-') && word.length >= MIN_PREFIX);
  const endings = new Set([...words].filter((word) => ENDING.test(word)));
  return { words, prefixes, endings };
}

function known(className: string, shipped: ShippedWords): boolean {
  return shipped.words.has(className) || shipped.prefixes.some((prefix) => className.startsWith(prefix)) || joined(className, shipped);
}

/** A class the code writes as a name and an ending apart: `cx-stb-bar` from `cx-stb` and `-bar`, at any of its dashes. */
function joined(className: string, shipped: ShippedWords): boolean {
  for (let dash = className.indexOf('-', MIN_PREFIX); dash > 0; dash = className.indexOf('-', dash + 1)) {
    if (shipped.words.has(className.slice(0, dash)) && shipped.endings.has(className.slice(dash))) return true;
  }
  return false;
}

// `\:` -> `:`, `\31 ` -> `1`: the class as the markup spells it
function unescapeClass(escaped: string): string {
  return escaped.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (match, code: string) => (/^[0-9a-fA-F]/.test(code) && match.length > 2 ? String.fromCodePoint(parseInt(code, 16)) : code));
}

/** The classes a selector needs: those outside any parentheses (and outside attribute brackets and strings). */
function neededClasses(selector: string): string[] {
  let outside = '';
  let depth = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (char === '\\') { if (!depth) outside += char + (selector[index + 1] ?? ''); index++; continue; }
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (!depth) outside += char;
  }
  return [...outside.matchAll(/\.((?:\\[\s\S]|[A-Za-z0-9_-]|[^\x00-\x7F])+)/g)].map((match) => unescapeClass(match[1]));
}

// Split at top-level commas (not inside parentheses, brackets or strings).
function splitList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0; let quote = ''; let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === '\\') index++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\') index++;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === ',' && !depth) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

// From `open` (a `{`), the index of the `}` that closes it, skipping strings, comments and escapes; -1 if never.
function closing(css: string, open: number): number {
  let depth = 0; let quote = '';
  for (let index = open; index < css.length; index++) {
    const char = css[index];
    if (quote) { if (char === '\\') index++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\') index++;
    else if (char === '/' && css[index + 1] === '*') { const end = css.indexOf('*/', index + 2); index = end < 0 ? css.length : end + 1; }
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index;
  }
  return -1;
}

// The next `{` or `;` at the top level of a statement, skipping strings, comments and escapes.
function statementEnd(css: string, from: number): number {
  let depth = 0; let quote = '';
  for (let index = from; index < css.length; index++) {
    const char = css[index];
    if (quote) { if (char === '\\') index++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\') index++;
    else if (char === '/' && css[index + 1] === '*') { const end = css.indexOf('*/', index + 2); index = end < 0 ? css.length : end + 1; }
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (!depth && (char === '{' || char === ';')) return index;
  }
  return css.length;
}

/** A list of rules with the never-matching ones taken out. */
function pruneRules(css: string, shipped: ShippedWords): string {
  let out = '';
  let index = 0;
  while (index < css.length) {
    const end = statementEnd(css, index);
    if (end >= css.length) { out += css.slice(index); break; }
    if (css[end] === ';') { out += css.slice(index, end + 1); index = end + 1; continue; }   // @import / @charset / @layer a, b;
    const close = closing(css, end);
    if (close < 0) { out += css.slice(index); break; }                                       // unbalanced: keep the rest as is
    const prelude = css.slice(index, end);
    const body = css.slice(end + 1, close);
    const at = /^\s*@([\w-]+)/.exec(prelude);
    if (at) {
      if (GROUPING_AT_RULES.has(at[1].toLowerCase())) {
        const inner = pruneRules(body, shipped);
        if (inner.trim()) out += `${prelude}{${inner}}`;                                     // an @media left empty goes
      } else out += css.slice(index, close + 1);                                             // @font-face, @keyframes, @property…
    } else {
      const selectors = splitList(prelude);
      const kept = selectors.filter((selector) => neededClasses(selector).every((name) => known(name, shipped)));
      if (kept.length === selectors.length) out += css.slice(index, close + 1);
      else if (kept.length) out += `${kept.join(',')}{${body}}`;
    }
    index = close + 1;
  }
  return out;
}

/** The stylesheet without the rules that name a class the shipped code never contains; and how many bytes went. */
export function pruneCss(css: string, shippedCode: string): { css: string; removed: number } {
  const pruned = pruneRules(css, shippedWords(shippedCode));
  return { css: pruned, removed: css.length - pruned.length };
}

/** The files in public/ whose words are real class names: served as they are, so a class they name exists. */
export const PUBLIC_CODE = /\.(html|js|mjs)$/;

/** Every file under `dir` whose name matches, read and joined (nothing when the folder does not exist). */
export function filesText(dir: string, names: RegExp): string {
  if (!existsSync(dir)) return '';
  const texts: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) texts.push(filesText(full, names));
    else if (names.test(entry.name)) texts.push(readFileSync(full, 'utf8'));
  }
  return texts.join('\n');
}
