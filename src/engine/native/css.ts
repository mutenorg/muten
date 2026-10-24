// css: the app's stylesheet read into rules, for the native output (styles.ts turns them into React Native styles). Not
// a full CSS parser: the shapes a muten app writes, each rule with the line it starts on (so `muten check` can point at
// it). `:root`/`html`/`@theme` variables are kept to resolve at compile time. Rules inside @media keep their condition
// (media.ts makes it a live condition on the phone); rules inside @layer and @supports are read as if outside (a layer
// only orders the cascade, and the phone supports what the profile says it does). @keyframes are counted for the
// report; @container, @font-face, @page and the like are listed as skipped.
import type { CssFrame, CssRule, CssSheet } from '#engine/shared/types-native.js';

// a comment becomes as many newlines as it held, so every rule keeps its real line
const COMMENT = /\/\*[\s\S]*?\*\//g;
const VARIABLE_HOLDERS = new Set([':root', 'html', ':host', '@theme']);

/** The block that opens at `open` (the index of its `{`): its body and the index after its closing `}`. */
function blockAt(source: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return { body: source.slice(open + 1, index), end: index + 1 };
  }
  return { body: source.slice(open + 1), end: source.length };
}

/** `color: red; padding: 4px 8px` → [['color', 'red'], ['padding', '4px 8px']]. */
export function declarations(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of body.split(/;(?![^(]*\))/)) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).replace(/!important/g, '').trim();
    if (name && value && !name.includes('{')) out.push([name, value]);
  }
  return out;
}

/** The stylesheet's rules, its variables, and what the native output leaves out. */
export function readCss(text: string): CssSheet {
  const source = text.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, ''));
  const sheet: CssSheet = { rules: [], vars: {}, keyframes: {}, skipped: [] };
  const lineAt = (index: number): number => source.slice(0, index).split('\n').length;
  // cascade layers in the order they first appear: a rule outside every layer outranks any layered one (CSS's rule)
  const layers = new Map<string, number>();
  const layerOf = (head: string): number => { const name = head.slice(6).trim() || `#${layers.size}`; if (!layers.has(name)) layers.set(name, layers.size); return layers.get(name) ?? 0; };

  // one level of the sheet, from `from` to `to`, under an optional @media condition and cascade layer
  const read = (from: number, to: number, media?: string, layer?: number): void => {
    let at = from;
    while (at < to) {
      const open = source.indexOf('{', at);
      if (open < 0 || open >= to) break;
      const raw = source.slice(at, open);
      // a statement before the block (`@import "x";`) ends at its semicolon: drop it from the head
      const head = (raw.includes(';') ? raw.slice(raw.lastIndexOf(';') + 1) : raw).trim();
      const line = lineAt(head ? at + raw.lastIndexOf(head) : open);
      const { body, end } = blockAt(source, open);
      at = end;
      const inner = open + 1, close = end - 1;
      if (head.startsWith('@media')) { const condition = head.slice(6).trim(); read(inner, close, media ? `${media} and ${condition}` : condition, layer); continue; }
      if (head.startsWith('@layer')) { read(inner, close, media, layerOf(head)); continue; }
      if (head.startsWith('@supports')) { read(inner, close, media, layer); continue; }
      if (head.startsWith('@keyframes') || head.startsWith('@-webkit-keyframes')) { sheet.keyframes[head.split(/\s+/)[1]] = frames(body); continue; }
      const decls = declarations(body);
      if (VARIABLE_HOLDERS.has(head) && !media) for (const [name, value] of decls) if (name.startsWith('--')) sheet.vars[name] = value;
      if (head.startsWith('@')) { if (head !== '@theme') sheet.skipped.push({ what: head.split(/\s/)[0], line }); continue; }
      const rule: CssRule = { selectors: head.split(/,(?![^(]*\))/).map((selector) => selector.trim()).filter(Boolean), decls: decls.filter(([name]) => !name.startsWith('--')), order: sheet.rules.length, line, media, layer };
      if (rule.decls.length) sheet.rules.push(rule);
    }
  };
  read(0, source.length);
  return sheet;
}

/** A @keyframes body → its steps: `from { … } 50% { … } to { … }`. */
function frames(body: string): CssFrame[] {
  const out: CssFrame[] = [];
  let at = 0;
  while (at < body.length) {
    const open = body.indexOf('{', at);
    if (open < 0) break;
    const { body: inner, end } = blockAt(body, open);
    out.push({ offsets: body.slice(at, open).split(',').map((offset) => offset.trim()).filter(Boolean), decls: declarations(inner) });
    at = end;
  }
  return out;
}

/** `var(--brand)` → its value from the sheet (a fallback when it has one and the variable is not there), repeatedly.
 *  A variable the sheet does not define is left as written: the page may set it while it runs (`style(w: …)`). */
export function resolveVars(value: string, vars: { [name: string]: string }): string {
  let out = value;
  for (let pass = 0; pass < 8 && out.includes('var('); pass++) {
    const next = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name: string, fallback: string | undefined) => vars[name] ?? fallback ?? whole);
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/** The variables a value reads that are live: the ones the page sets while it runs (`style(w: …)`, even when the CSS
 *  gives a fallback), and the ones the sheet does not define. */
export function liveVars(value: string, vars: { [name: string]: string }, page: ReadonlySet<string>): string[] {
  const named = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]).filter((name) => page.has(name));
  return [...named, ...[...resolveVars(value, vars).matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1])];
}
