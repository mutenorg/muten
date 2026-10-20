// theme emission: turns theme.muten's VALUES into CSS, AGNOSTICALLY. The core knows NO styling library.
// Styling itself is `class()` (Tailwind utilities, or your own CSS in styles.css). This module only emits the
// theme values as :root CSS custom properties (the default) or, via a plugin adapter, a library's own format.

import type { ThemeRaw, ThemeAdapter } from '#engine/shared/types.js';
import { THEME_LIBRARY, THEME_TOKENS } from '#engine/shared/vocab.js';

// ── theme.muten -> CSS, AGNOSTICALLY ──────────────────────────────────────────────────────────────
// theme.muten holds the VALUES (agnostic). By default the engine emits them as plain CSS custom
// properties on :root — universal, any CSS setup (your styles.css / Tailwind) consumes them via var(--…).
// A muten styling PLUGIN may pass an `adapter` (pure data) to render a library's own format; the engine
// ships none and never expects a specific library.
const GENERIC_PREFIX: { [section: string]: string } = {
  colors: '--color-', space: '--space-', radius: '--radius-', font: '--font-',
  weight: '--weight-', leading: '--leading-', breakpoints: '--breakpoint-', size: '--size-',
};
const META_SECTIONS = new Set(['scheme', 'target', THEME_LIBRARY]); // config, not CSS vars
// `dark {}` / `light {}` are COLOR-SCHEME blocks: the same color tokens (ink/fg/panel/…) per scheme. They
// emit as --color-* under [data-theme="<scheme>"] so one theme.muten drives BOTH modes (the default scheme,
// theme.scheme.mode, is also inlined into :root). An adapter handles schemes via its own blocks instead.
const SCHEME_SECTIONS = ['dark', 'light'];

// A theme that names a library (`theme shadcn { … }`) writes the library's OWN tokens: `primary "#…"` is `--primary`
// on :root, after the library's stylesheet so it wins, and `dark { primary "…" }` hangs on the library's dark selector.
// The library already says what the default scheme looks like, so nothing is inlined for it.
function libraryLines(theme: ThemeRaw, darkSelector: string): string[] {
  const out: string[] = [];
  const tokens = Object.entries(theme[THEME_TOKENS] || {}).map(([k, v]) => `  --${k}: ${v};`);
  if (tokens.length) out.push(`:root {\n${tokens.join('\n')}\n}`);
  const dark = Object.entries(theme.dark || {}).map(([k, v]) => `  --${k}: ${v};`);
  if (dark.length) out.push(`${darkSelector} {\n${dark.join('\n')}\n}`);
  const light = Object.entries(theme.light || {}).map(([k, v]) => `  --${k}: ${v};`);
  if (light.length) out.push(`[data-theme="light"] {\n${light.join('\n')}\n}`);
  return out;
}

/** theme.muten as CSS. `librarySelector` is the dark selector of the library the theme names, when it names one. */
export function emitTheme(theme: ThemeRaw = {}, adapter?: ThemeAdapter, libraryDark?: string): string {
  if (libraryDark !== undefined) {   // the library owns the format: its tokens by name + the app's own scales
    const own: ThemeRaw = Object.fromEntries(Object.entries(theme).filter(([section]) => section !== 'dark' && section !== 'light' && section !== THEME_TOKENS));
    const lines = [emitTheme(own, adapter).trim(), ...libraryLines(theme, libraryDark)].filter(Boolean);
    return lines.length ? lines.join('\n\n') + '\n' : '';
  }
  if (adapter) { // a plugin's library-specific format: walk its blocks, map values × prefix (still no library name here)
    const out: string[] = [];
    for (const block of adapter.blocks) {
      const lines: string[] = [];
      for (const [k, v] of Object.entries(block.attrs || {})) lines.push(`  ${k}: ${v === '$scheme' ? (theme.scheme?.mode ?? 'light') : v};`);
      for (const section of block.sections) {
        const prefix = adapter.prefix[section] ?? `--${section}-`;
        for (const [key, val] of Object.entries(theme[section] || {})) lines.push(`  ${prefix}${key}: ${val};`);
      }
      if (lines.length) out.push(`${block.open}\n${lines.join('\n')}\n${block.close}`);
    }
    return out.length ? out.join('\n\n') + '\n' : '';
  }
  // default: plain CSS custom properties, library-neutral, with native light/dark schemes.
  const colorPrefix = GENERIC_PREFIX.colors;
  const schemeLines = (mode: string): string[] =>
    Object.entries(theme[mode] || {}).map(([k, v]) => `  ${colorPrefix}${k}: ${v};`);
  const sharedLines = Object.entries(theme)
    .filter(([s]) => !META_SECTIONS.has(s) && !SCHEME_SECTIONS.includes(s))
    .flatMap(([s, scale]) => Object.entries(scale).map(([k, v]) => `  ${s === THEME_TOKENS ? '--' : GENERIC_PREFIX[s] ?? `--${s}-`}${k}: ${v};`));   // a token by its own name keeps it
  const out: string[] = [];
  const defaultMode = theme.scheme?.mode ?? 'dark';
  const rootLines = [...sharedLines, ...schemeLines(defaultMode)]; // default scheme inlined on :root
  if (rootLines.length) out.push(`:root {\n${rootLines.join('\n')}\n}`);
  for (const mode of SCHEME_SECTIONS) { // explicit per-scheme override blocks, toggled via [data-theme]
    const sl = schemeLines(mode);
    if (sl.length) out.push(`[data-theme="${mode}"] {\n${sl.join('\n')}\n}`);
  }
  return out.length ? out.join('\n\n') + '\n' : '';
}
