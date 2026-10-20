// theme-check: what `muten check` (and the editor) says about theme.muten. It used to be read only at build: a syntax
// error surfaced there, blamed on `src`, and a misspelled section, token or value produced CSS the browser threw away.
//   · it parses, and a mistake points at theme.muten:line:col
//   · a library it names is installed, and its preset, extras and tokens exist (each with the closest name)
//   · a section close to a known one is probably that one; each known section's values are its kind of value
//   · mode is light or dark
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { tokenize } from '#engine/lang/lexer.js';
import { ParseError, closest, diag } from '#engine/shared/diagnostics.js';
import { Tk, THEME_LIBRARY, THEME_TOKENS } from '#engine/shared/vocab.js';
import { themeLibrary, libraryTokenValues, packageDir } from '#engine/project/theme-library.js';
import type { Diagnostic, Loc, ThemeProvider, ThemeRaw } from '#engine/shared/types.js';

// the CSS named colors (a word that is not one, like `violeta`, is dropped by the browser)
const NAMED_COLORS: ReadonlySet<string> = new Set((
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
  'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
  'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred ' +
  'darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink ' +
  'deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold ' +
  'goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush ' +
  'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey ' +
  'lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow ' +
  'lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
  'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin ' +
  'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise ' +
  'palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue ' +
  'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow ' +
  'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen ' +
  'transparent currentcolor inherit'
).split(' '));
const COLOR_FORM = /^(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color|color-mix|light-dark)\(.+\)|var\(--[\w-]+.*\))$/i;
const isColor = (value: string): boolean => COLOR_FORM.test(value) || NAMED_COLORS.has(value.toLowerCase());
const LENGTH = /^(0|-?\d*\.?\d+(px|rem|em|%|vh|vw|svh|dvh|lvh|vmin|vmax|ch|ex|pt|fr)|(calc|clamp|min|max|var)\(.+\))$/i;
const FAMILY = /^['"\w-][\w\s'",.-]*$/;   // font families: 'Inter', -apple-system, sans-serif
const NUMBER = /^(-?\d*\.?\d+|var\(--[\w-]+.*\))$/;
const NUMBER_OR_LENGTH = (value: string): boolean => NUMBER.test(value) || LENGTH.test(value);
// what each known section holds, and how to tell a value of it
const SECTION_KIND: ReadonlyMap<string, { what: string; ok: (value: string) => boolean }> = new Map([
  ['colors', { what: 'a color (#6B46F2, oklch(…), rgb(…), var(--x))', ok: isColor }],
  ['dark', { what: 'a color', ok: isColor }],
  ['light', { what: 'a color', ok: isColor }],
  ['space', { what: 'a length (16px, 1rem)', ok: (v: string) => LENGTH.test(v) }],
  ['radius', { what: 'a length (8px, 0.5rem)', ok: (v: string) => LENGTH.test(v) }],
  ['size', { what: 'a length', ok: (v: string) => LENGTH.test(v) }],
  ['breakpoints', { what: 'a length (768px)', ok: (v: string) => LENGTH.test(v) }],
  ['font', { what: 'a size (15px, 1rem) or a family (\'Inter\', sans-serif)', ok: (v: string) => LENGTH.test(v) || FAMILY.test(v) }],
  ['weight', { what: 'a number (400, 700)', ok: (v: string) => NUMBER.test(v) }],
  ['leading', { what: 'a number or a length (1.5, 24px)', ok: NUMBER_OR_LENGTH }],
]);
const KNOWN_SECTIONS = [...SECTION_KIND.keys(), 'shadow', 'motion', 'scheme', 'target', THEME_TOKENS, THEME_LIBRARY];
const MODES = ['light', 'dark'];

// where a word first appears in the file, as an identifier or a quoted key (good enough to point at a token or section)
function locate(text: string, word: string): Loc | null {
  for (const token of tokenize(text)) {
    if ((token.t === Tk.Ident || token.t === Tk.String) && token.v === word) {
      const before = text.slice(0, token.pos);
      const line = before.split('\n').length;
      return { line, col: token.pos - before.lastIndexOf('\n') };
    }
  }
  return null;
}

/** The diagnostics of theme.muten, from its text (the editor checks it as it is typed). */
export function checkThemeText(appRoot: string, text: string): Diagnostic[] {
  let theme: ThemeRaw | undefined;
  let providers: ThemeProvider[] = [];
  try { const ir = parse(text); theme = ir.theme; providers = ir.providers || []; }
  catch (e) {
    if (e instanceof ParseError) return [{ code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null }];
    throw e;
  }
  if (!theme) return [diag('theme-empty', 'theme.muten holds one `theme { … }` (or `theme <library> { … }`) block, and there is none.')];
  const out: Diagnostic[] = [];
  const at = (word: string): Loc | null => locate(text, word);
  const chosen = theme[THEME_LIBRARY] || {};
  const libraryName = chosen.name || '';

  if (libraryName) {
    const lib = themeLibrary(appRoot, theme);
    if (!lib) out.push(diag('theme-library-missing', `the theme names the library "${libraryName}", which is not installed: \`npm i @muten/${libraryName}\` (or \`npm i ${libraryName}\`).`, { loc: at(libraryName) }));
    else {
      if (chosen.preset && !lib.presets[chosen.preset]) out.push(diag('theme-preset', `${lib.pkg} has no preset "${chosen.preset}"${Object.keys(lib.presets).length ? ` (it has: ${Object.keys(lib.presets).join(', ')})` : ''}.`, { loc: at(chosen.preset), suggestion: closest(chosen.preset, Object.keys(lib.presets)), from: chosen.preset }));
      for (const extra of (chosen.with || '').split(',').filter(Boolean))
        if (!lib.extras[extra]) out.push(diag('theme-extra', `${lib.pkg} has no stylesheet "${extra}"${Object.keys(lib.extras).length ? ` (it has: ${Object.keys(lib.extras).join(', ')})` : ''}.`, { loc: at(extra), suggestion: closest(extra, Object.keys(lib.extras)), from: extra }));
      if (lib.tailwind && !packageDir(appRoot, '@tailwindcss/node')) out.push(diag('theme-needs-tailwind', `${lib.pkg} is built with Tailwind, which is not installed: \`npm i -D tailwindcss @tailwindcss/node @tailwindcss/oxide\`.`, { loc: at(libraryName) }));
      // a token written by its own name, in the library's mode, must be one the library declares
      const tokens = libraryTokenValues(lib);
      for (const section of [THEME_TOKENS, 'dark', 'light']) for (const [key, value] of Object.entries(theme[section] || {})) {
        const theirs = tokens.get(key);
        const kind = theirs === undefined ? undefined : isColor(theirs) ? SECTION_KIND.get('colors') : LENGTH.test(theirs) ? SECTION_KIND.get('radius') : undefined;   // the kind of value the library gives it
        if (kind && !kind.ok(value.trim())) out.push(diag('theme-value', `${key} is "${value}", but ${lib.pkg} gives --${key} ${theirs}, so it takes ${kind.what}: the browser would drop this one.`, { loc: at(key) }));
        if (theirs === undefined) out.push(diag('theme-unknown-token', `${lib.pkg} has no token "${key}": ${section === THEME_TOKENS ? 'a token here is one of the library\'s own (--' + key + ' is not among them)' : `\`${section} { }\` sets the library's tokens for that scheme`}. For a token of your own, put it in a scale: \`colors { ${key} "…" }\`.`, { loc: at(key), suggestion: closest(key, [...tokens.keys()]), from: key }));
      }
    }
  }

  for (const [section, scale] of Object.entries(theme)) {
    if (section === THEME_LIBRARY || section === THEME_TOKENS) continue;
    const kind = SECTION_KIND.get(section);
    if (!kind && !KNOWN_SECTIONS.includes(section)) {
      const near = closest(section, KNOWN_SECTIONS, 2);
      if (near) out.push(diag('theme-section', `"${section}" is not a theme section muten knows; did you mean \`${near}\`? (Any other name becomes --${section}-<key> variables.)`, { loc: at(section), suggestion: near, from: section, severity: 'warning' }));
      continue;
    }
    if (libraryName && (section === 'dark' || section === 'light')) continue;   // library tokens: checked above
    if (kind) for (const [key, value] of Object.entries(scale))
      if (!kind.ok(value.trim())) out.push(diag('theme-value', `${section}.${key} is "${value}", which is not ${kind.what}: the browser would drop it.`, { loc: at(key) }));
  }
  // `provider ThemeProvider(…) from "@mui/material"`: the library it wraps is installed
  for (const provider of providers) {
    const pkg = provider.from.startsWith('@') ? provider.from.split('/').slice(0, 2).join('/') : provider.from.split('/')[0];
    if (!packageDir(appRoot, pkg)) out.push(diag('theme-provider-missing', `the provider ${provider.component} comes from "${provider.from}", which is not installed: \`npm i ${pkg}\`.`, { loc: provider.loc ?? null }));
  }
  const mode = theme.scheme?.mode;
  if (mode && !MODES.includes(mode)) out.push(diag('theme-mode', `mode is light or dark, not "${mode}".`, { loc: at(mode), suggestion: closest(mode, MODES), from: mode }));
  return out;
}

/** The diagnostics of the app's theme.muten (none when it has none). */
export function checkTheme(appRoot: string): Diagnostic[] {
  const file = join(appRoot, 'theme.muten');
  return existsSync(file) ? checkThemeText(appRoot, readFileSync(file, 'utf8')) : [];
}
