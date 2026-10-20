// theme-ref: theme.muten's values read from a page, `theme.colors.primary` / `theme.radius.md`, and with a library
// connected its own tokens by name, `theme.primary`. They are the values written there, fixed at build: what a React
// library's provider takes (MUI's createTheme, Chakra's createSystem compute shades from a real color, not a var()).
import { THEME_LIBRARY, THEME_TOKENS } from '#engine/shared/vocab.js';
import type { ThemeRaw, ThemeScale } from '#engine/shared/types.js';

const NOT_VALUES = new Set([THEME_LIBRARY]);

/** What `theme.<path>` names: a value, a whole section, or nothing. */
export function themeValue(theme: ThemeRaw, path: string[]): string | ThemeScale | undefined {
  const [first, second] = path;
  if (!first || NOT_VALUES.has(first)) return undefined;
  const section = theme[first];
  if (section) return second === undefined ? section : path.length === 2 ? section[second] : undefined;
  return path.length === 1 ? theme[THEME_TOKENS]?.[first] : undefined;   // `theme.primary`: a library token by its name
}

/** Every name a `theme.` ref may start with: the sections and the library tokens. */
export function themeHeads(theme: ThemeRaw): string[] {
  return [...Object.keys(theme).filter((section) => !NOT_VALUES.has(section) && section !== THEME_TOKENS), ...Object.keys(theme[THEME_TOKENS] || {})];
}
