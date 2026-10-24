// types-theme: theme.muten and the libraries and adapters it connects, and the app's texts. Split from types.ts (which
// re-exports all of it) so each file stays a size one can read.

import type { ArgMap, ImportDef, Loc } from '#engine/shared/types.js';

/** A theme scale: step name (md/lg/…) → its CSS value ("16px", "1.5", "768px"). */
export interface ThemeScale { [step: string]: string; }
/** The theme.muten file as parsed: section name (space/colors/radius/…) → its scale. Open set:
 *  parseTheme reads any `<section> { <step> "value" }`, so colors/radius come for free. */
export type ThemeRaw = { [section: string]: ThemeScale };

/** The app's texts: language code → key → text (project/lang-files.ts). */
export interface Translations { [code: string]: { [key: string]: string } }

/** theme.muten's `provider ThemeProvider(theme: createTheme({ … })) from "@mui/material"`: what wraps every React
 *  component that comes from that package, so its pages only use the components. */
export interface ThemeProvider { component: string; args: ArgMap; from: string; loc?: Loc; }

/** theme.muten as a page sees it: its values, its providers and the `use` lines they call. */
export interface ThemeKit { values: ThemeRaw; providers: ThemeProvider[]; imports: ImportDef[]; }

/** The CSS library a `theme <name> { … }` connects (project/theme-library.ts). */
export interface ThemeLibrary {
  name: string;                            // as the theme writes it: shadcn
  pkg: string;                             // the package it was found as: @muten/shadcn
  dir: string;
  css: string[];                           // its base stylesheets, always brought in
  presets: { [name: string]: string };     // `preset noir` -> themes/noir.css
  extras: { [name: string]: string };      // `with kit` -> kit.css
  dark: string;                            // the selector its dark scheme hangs on
  tailwind: boolean;                       // its stylesheets need Tailwind to be built
  hasParts: boolean;                       // a muten plugin: its parts become available to every page
}

/** A theme ADAPTER: pure DATA describing how to render theme.muten's values for ANY styling backend.
 *  The engine has zero per-library logic — a new library is just a new adapter (no engine change). */
export interface ThemeBlock {
  open: string;                       // block opener — `:root {` by default, or whatever wrapper a styling plugin supplies
  close: string;                      // usually `}`
  attrs?: { [key: string]: string };  // literal lines inside (e.g. name/default); value `$scheme` -> theme.scheme.mode
  sections: string[];                 // which theme.muten sections render in this block
}
export interface ThemeAdapter {
  prefix: { [section: string]: string };  // section -> CSS var prefix (colors -> `--color-`); fallback `--<section>-`
  blocks: ThemeBlock[];
}

