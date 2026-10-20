// Oracle-side icon existence check — dependency-free (no @iconify/utils). The SVG inlining that needs
// @iconify/utils happens at vite BUILD; here we only answer "does set:name exist" by reading the set's
// own icons.json directly. This closes a lint≠runtime gap: `Icon "lucide:hand-pointer"` (a name that isn't
// in lucide) passed `check` green, then crashed compile ("no icon named …") and blanked the page. Now the
// oracle (and the live editor) catch it first, with the same clear message — before the build ever breaks.

import fs from 'node:fs';
import { join } from 'node:path';

interface IconJson { icons: { [name: string]: unknown }; aliases: { [name: string]: unknown } }
interface LoadedSet { mtime: number; data: IconJson }
const setCache = new Map<string, LoadedSet>();                     // `${appRoot}|${set}` -> the parsed set, with its file's mtime
const checkers = new Map<string, (ref: string) => string | null>(); // memoized per appRoot (live linter rebuilds context every keystroke)

function objectOf(value: unknown): { [name: string]: unknown } {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(Object.entries(value));
}

// A set is read again when its icons.json changes, and a missing set is never remembered as missing: installing one
// (`npm i -D @iconify-json/logos`) used to need an editor and `muten dev` restart before its icons stopped erroring.
function loadSet(appRoot: string, set: string): IconJson | null {
  const file = join(appRoot, 'node_modules', '@iconify-json', set, 'icons.json');
  let mtime: number;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const key = `${appRoot}|${set}`;
  const cached = setCache.get(key);
  if (cached && cached.mtime === mtime) return cached.data;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const root = objectOf(parsed);
    const data: IconJson = { icons: objectOf(root.icons), aliases: objectOf(root.aliases) };
    setCache.set(key, { mtime, data });
    return data;
  } catch { return null; }
}

/** Returns null if the icon resolves (or its shape is validate's job), else a clear, actionable message. */
export function getIconChecker(appRoot: string): (ref: string) => string | null {
  const existing = checkers.get(appRoot);
  if (existing) return existing;
  const fn = (ref: string): string | null => {
    const colon = ref.indexOf(':');
    if (colon < 1) return null;                                  // bad shape — validate already reports it
    const set = ref.slice(0, colon), name = ref.slice(colon + 1);
    const data = loadSet(appRoot, set);
    if (!data) return `the icon set "${set}" isn't installed — run \`npm i -D @iconify-json/${set}\` (or fix the set name).`;
    if (data.icons[name] !== undefined || data.aliases[name] !== undefined) return null;
    return `no icon named "${name}" in set "${set}".`;
  };
  checkers.set(appRoot, fn);
  return fn;
}
