// theme-library: the CSS library a `theme <name> { … }` connects. Found in node_modules as `@muten/<name>` or `<name>`,
// and read by convention, so a library needs nothing muten-specific to be connected:
//   globals.css (or index.css)   its base stylesheet: tokens + components
//   themes/<preset>.css          its presets (`preset noir`)
//   <extra>.css                  any other stylesheet at its root (`with nova, kit`)
// A `"muten": { "css": […], "presets": {…}, "extras": {…}, "dark": "…", "tailwind": true }` in its package.json
// overrides the guesses. Its tokens are the custom properties its stylesheets declare: what `primary "#…"` may name.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ThemeLibrary, ThemeRaw } from '#engine/shared/types.js';
import { THEME_LIBRARY } from '#engine/shared/vocab.js';

const BASE_CSS = ['globals.css', 'index.css'];
const PRESETS_DIR = 'themes';
const DEFAULT_DARK = '.dark, [data-theme="dark"]';

const isObject = (value: unknown): value is { [key: string]: unknown } => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const stringMap = (value: unknown): { [name: string]: string } => {
  const out: { [name: string]: string } = {};
  if (isObject(value)) for (const [key, item] of Object.entries(value)) if (typeof item === 'string') out[key] = item;
  return out;
};
const cssIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.css')) : []);

// where a package is installed: node_modules/<pkg> from the app up, as Node finds it. (Resolving `<pkg>/package.json`
// fails for a package whose `exports` does not list it, which is most of them.)
export function packageDir(appRoot: string, pkg: string): string {
  for (let dir = appRoot; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', pkg);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return '';
  }
}

/** The library a theme names, or null when it is not installed (or the theme names none). */
export function themeLibrary(appRoot: string, theme: ThemeRaw | undefined): ThemeLibrary | null {
  const name = theme?.[THEME_LIBRARY]?.name;
  if (!name) return null;
  for (const pkg of [`@muten/${name}`, name]) {
    const dir = packageDir(appRoot, pkg);
    if (!dir) continue;
    const manifestFile = join(dir, 'package.json');
    let manifest: unknown = {};
    try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { manifest = {}; }
    const own = isObject(manifest) && isObject(manifest.muten) ? manifest.muten : {};
    const css = strings(own.css).length ? strings(own.css) : BASE_CSS.filter((file) => existsSync(join(dir, file))).slice(0, 1);
    const presets = Object.keys(stringMap(own.presets)).length ? stringMap(own.presets)
      : Object.fromEntries(cssIn(join(dir, PRESETS_DIR)).map((file) => [basename(file, '.css'), `${PRESETS_DIR}/${file}`]));
    const extras = Object.keys(stringMap(own.extras)).length ? stringMap(own.extras)
      : Object.fromEntries(cssIn(dir).filter((file) => !css.includes(file)).map((file) => [basename(file, '.css'), file]));
    const tailwind = typeof own.tailwind === 'boolean' ? own.tailwind : css.some((file) => /@apply|@theme|@source/.test(readFileSync(join(dir, file), 'utf8')));
    return { name, pkg, dir, css, presets, extras, dark: typeof own.dark === 'string' ? own.dark : DEFAULT_DARK, tailwind, hasParts: existsSync(join(dir, 'registry.json')) };
  }
  return null;
}

/** The stylesheets the theme brings in, as import specifiers, in order: base, preset, extras. */
export function libraryImports(lib: ThemeLibrary, theme: ThemeRaw): string[] {
  const chosen = theme[THEME_LIBRARY] || {};
  const files = [...lib.css];
  if (chosen.preset && lib.presets[chosen.preset]) files.push(lib.presets[chosen.preset]);
  for (const extra of (chosen.with || '').split(',').filter(Boolean)) if (lib.extras[extra]) files.push(lib.extras[extra]);
  return files.map((file) => `${lib.pkg}/${file}`);
}

/** Every custom property the library's stylesheets declare (its tokens), without the leading `--`. */
export function libraryTokens(lib: ThemeLibrary): Set<string> {
  return new Set(libraryTokenValues(lib).keys());
}

/** Each custom property the library declares, with the first value it gives it (so a theme override can be told
 *  apart: a color where it has a color, a length where it has a length). */
export function libraryTokenValues(lib: ThemeLibrary): Map<string, string> {
  const out = new Map<string, string>();
  const files = [...lib.css, ...Object.values(lib.presets), ...Object.values(lib.extras)];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(join(lib.dir, file), 'utf8'); } catch { continue; }
    for (const match of text.matchAll(/(?:^|[\s;{])--([a-zA-Z0-9_-]+)\s*:\s*([^;}]*)/g)) if (!out.has(match[1])) out.set(match[1], match[2].trim());
  }
  return out;
}

const TAILWIND_IMPORT = /@import\s+["']tailwindcss(?:\/[^"']*)?["'][^;]*;?/;

/** The app's stylesheet with the library's stylesheets brought in: after Tailwind (added first when the library needs
 *  it and the app did not import it), skipping any the app already imports itself. */
export function withLibraryCss(css: string, lib: ThemeLibrary, theme: ThemeRaw): string {
  const imports = libraryImports(lib, theme).filter((spec) => !css.includes(spec)).map((spec) => `@import "${spec}";`);
  const tailwind = lib.tailwind && !TAILWIND_IMPORT.test(css) ? ['@import "tailwindcss";'] : [];
  if (!imports.length && !tailwind.length) return css;
  const block = [...tailwind, ...imports].join('\n');
  const at = css.match(TAILWIND_IMPORT);
  if (!at || at.index === undefined) return `${block}\n${css}`;
  const end = at.index + at[0].length;
  return `${css.slice(0, end)}\n${block}${css.slice(end)}`;
}

/** What the theme puts on <html>: the classes its chosen stylesheets are scoped to (`with nova` → `style-nova`, when
 *  nova.css hangs its rules on `.style-nova`) and, for `mode dark`, the library's dark class + `data-theme`. */
export function themeRoot(lib: ThemeLibrary, theme: ThemeRaw): { classes: string[]; scheme: string } {
  const chosen = theme[THEME_LIBRARY] || {};
  const classes: string[] = [];
  const picked: Array<[string, string]> = (chosen.with || '').split(',').filter((extra) => lib.extras[extra]).map((extra): [string, string] => [extra, lib.extras[extra]]);
  if (chosen.preset && lib.presets[chosen.preset]) picked.unshift([chosen.preset, lib.presets[chosen.preset]]);
  for (const [name, file] of picked) {
    let text = '';
    try { text = readFileSync(join(lib.dir, file), 'utf8'); } catch { continue; }
    if (text.includes(`.style-${name}`)) classes.push(`style-${name}`);
  }
  const scheme = theme.scheme?.mode === 'dark' ? 'dark' : theme.scheme?.mode === 'light' ? 'light' : '';
  const darkClass = /\.([A-Za-z][\w-]*)/.exec(lib.dark)?.[1];
  if (scheme === 'dark' && darkClass) classes.push(darkClass);
  return { classes, scheme };
}

/** index.html with the theme's root classes and scheme on <html> (kept: whatever the page already set there). */
export function withThemeRoot(html: string, root: { classes: string[]; scheme: string }): string {
  if (!root.classes.length && !root.scheme) return html;
  return html.replace(/<html\b([^>]*)>/i, (_whole: string, attrs: string) => {
    let out = attrs;
    const current = /\sclass="([^"]*)"/i.exec(out);
    const merged = [...new Set([...(current ? current[1].split(/\s+/).filter(Boolean) : []), ...root.classes])].join(' ');
    if (merged) out = current ? out.replace(current[0], ` class="${merged}"`) : `${out} class="${merged}"`;
    if (root.scheme && !/\sdata-theme=/i.test(out)) out += ` data-theme="${root.scheme}"`;
    return `<html${out}>`;
  });
}
