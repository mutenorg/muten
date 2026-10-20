// plugins: which muten plugins an app uses. Two ways to say it, one answer: a `plugins { shadcn {} }` block in
// muten.config, or a theme that names the library (`theme shadcn { … }` in theme.muten), which connects its parts
// with its look. Every place that loads plugin parts, plugin Customs or dev-boot hooks asks here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { readMutenConfig } from '#engine/project/config.js';
import { THEME_LIBRARY } from '#engine/shared/vocab.js';

/** The library theme.muten names, or '' (a theme.muten that does not parse names none: `check` reports it). */
export function themeLibraryName(appRoot: string): string {
  const file = join(appRoot, 'theme.muten');
  if (!existsSync(file)) return '';
  try { return parse(readFileSync(file, 'utf8')).theme?.[THEME_LIBRARY]?.name ?? ''; } catch { return ''; }
}

/** The plugin names the app uses: muten.config `plugins {}` and the theme's library, once each. */
export function pluginNames(appRoot: string): string[] {
  let configured: string[] = [];
  try {
    const plugins = readMutenConfig(appRoot).plugins;
    if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) configured = Object.keys(plugins);
  } catch { configured = []; }   // a muten.config that does not parse: `check` reports it
  const library = themeLibraryName(appRoot);
  return [...new Set([...configured, ...(library ? [library] : [])])];
}
