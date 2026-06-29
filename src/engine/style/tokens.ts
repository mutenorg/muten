// theme emission: turns theme.muten's VALUES into CSS, AGNOSTICALLY. The core knows NO styling library.
// Styling itself is `class()` (Tailwind utilities, or your own CSS in styles.css). This module only emits the
// theme values as :root CSS custom properties (the default) or, via a plugin adapter, a library's own format.

import type { ThemeRaw, ThemeAdapter } from '#engine/shared/types.js';

// ── theme.muten -> CSS, AGNOSTICALLY ──────────────────────────────────────────────────────────────
// theme.muten holds the VALUES (agnostic). By default the engine emits them as plain CSS custom
// properties on :root — universal, any CSS setup (your styles.css / Tailwind) consumes them via var(--…).
// A muten styling PLUGIN may pass an `adapter` (pure data) to render a library's own format; the engine
// ships none and never expects a specific library.
const GENERIC_PREFIX: { [section: string]: string } = {
  colors: '--color-', space: '--space-', radius: '--radius-', font: '--font-',
  weight: '--weight-', leading: '--leading-', breakpoints: '--breakpoint-', size: '--size-',
};
const META_SECTIONS = new Set(['scheme', 'target']); // config, not CSS vars
// `dark {}` / `light {}` are COLOR-SCHEME blocks: the same color tokens (ink/fg/panel/…) per scheme. They
// emit as --color-* under [data-theme="<scheme>"] so one theme.muten drives BOTH modes (the default scheme,
// theme.scheme.mode, is also inlined into :root). An adapter handles schemes via its own blocks instead.
const SCHEME_SECTIONS = ['dark', 'light'];

export function emitTheme(theme: ThemeRaw = {}, adapter?: ThemeAdapter): string {
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
    .flatMap(([s, scale]) => Object.entries(scale).map(([k, v]) => `  ${GENERIC_PREFIX[s] ?? `--${s}-`}${k}: ${v};`));
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
