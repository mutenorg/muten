// theme-values: theme.muten for the pages: its values (`theme.colors.primary`) and its providers (`provider ThemeProvider(…)
// from "@mui/material"`), or undefined when the app has no theme.muten or it does not parse (check reports that one).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import type { ThemeKit, ThemeRaw } from '#engine/shared/types.js';

export function readThemeValues(appRoot: string): ThemeRaw | undefined {
  return readThemeKit(appRoot)?.values;
}

/** theme.muten whole: its values, the providers it puts around a library's components, and the `use` lines they call. */
export function readThemeKit(appRoot: string): ThemeKit | undefined {
  const file = join(appRoot, 'theme.muten');
  if (!existsSync(file)) return undefined;
  try {
    const ir = parse(readFileSync(file, 'utf8'));
    return { values: ir.theme || {}, providers: ir.providers || [], imports: ir.imports || [] };
  } catch { return undefined; }
}
