// fix: `muten check --fix` applies the fixes it can be sure of, and says why it left the others. A fix is a word to swap
// for another at one place; it is applied only when that word is exactly at that place, in a file of the app (never a
// plugin's), and when it cannot be the wrong way round: if the name it would write appears ONCE in the whole app, it is
// only declared and never used, so the slip may be the declaration (`part Drawer(oepn: bool)` against every correct
// `$open`, in the part and in every page that calls it).
// Then the fix would spread the slip; it is left for a person, with the other way named. After each pass it checks again
// (a fixed name can reveal the next finding) until nothing sure is left.
//
// And only one slip away: a letter more, less, wrong, or two swapped, as a finger slips. A fix two edits away may name a
// different thing that also exists (`mNyame` → `pName`, while `myName` was meant), and it would compile with no word.
// Those stay suggestions; and a fix that undoes one this run applied is never applied (two names trading places).

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findings } from './lint.js';
import { slips } from '#engine/shared/diagnostics.js';
import type { Found } from '#engine/project/place.js';

const PASSES = 5;
const PLUGINS = 'node_modules';
const SOURCE = /\.(muten|store)$/;
const WORD = /[A-Za-z0-9_]/;
const bare = (word: string): string => word.replace(/^[$@]/, '');

/** How many times `word` stands alone in `text` (a `$`/`@` before it is part of the same name). */
function count(text: string, word: string): number {
  let n = 0;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1))
    if (!WORD.test(text[at - 1] || '') && !WORD.test(text[at + word.length] || '')) n++;
  return n;
}

/** The app's own source files (pages, parts, stores, its layouts in app.muten). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === PLUGINS ? [] : sources(full);
    return SOURCE.test(entry.name) ? [full] : [];
  });
}

export interface FixReport { applied: Found[]; left: Array<{ found: Found; why: string }> }

/** Why `found`'s fix is not sure in `text`, or null when it is. */
function doubt(found: Found, text: string, app: string): string | null {
  const fix = found.fix;
  if (!fix || !found.loc) return 'no fix';
  if (found.file.includes(PLUGINS)) return 'in a plugin';
  const line = text.split('\n')[found.loc.line - 1] ?? '';
  if (!line.startsWith(fix.from, found.loc.col - 1)) return 'the word is not at its place';
  if (slips(bare(fix.from), bare(fix.to)) > 1) return `\`${fix.to}\` is more than one slip from \`${fix.from}\`: it may be another name that exists`;
  if (count(app, bare(fix.to)) === 1) return `\`${bare(fix.to)}\` is declared and used nowhere else: the slip may be that declaration (rename it to \`${bare(fix.from)}\` instead)`;
  return null;
}

/** Applies every sure fix (several passes), and reports what it did and what it left. */
export async function fixApp(appRoot: string): Promise<FixReport> {
  const applied: Found[] = [];
  let left: Array<{ found: Found; why: string }> = [];
  const undone = new Set<string>();   // file|from|to of each fix applied, so its inverse is never applied after it
  for (let pass = 0; pass < PASSES; pass++) {
    const found = await findings(appRoot);
    const app = sources(join(appRoot, 'src')).map((file) => readFileSync(file, 'utf8')).join('\n');   // every word of the app, for the declaration test
    const byFile = new Map<string, Found[]>();
    left = [];
    for (const one of found) {
      if (!one.fix) continue;
      const text = readFileSync(join(appRoot, one.file), 'utf8');
      const why = undone.has(`${one.file}|${one.fix.to}|${one.fix.from}`) ? 'it would undo a fix this run applied' : doubt(one, text, app);
      if (why) { left.push({ found: one, why }); continue; }
      byFile.set(one.file, [...(byFile.get(one.file) || []), one]);
    }
    if (!byFile.size) break;
    for (const [file, sure] of byFile) {
      const lines = readFileSync(join(appRoot, file), 'utf8').split('\n');
      // last place first, so an earlier swap never moves a later one; one swap per place
      const seen = new Set<string>();
      for (const one of [...sure].sort((a, b) => (b.loc?.line ?? 0) - (a.loc?.line ?? 0) || (b.loc?.col ?? 0) - (a.loc?.col ?? 0))) {
        if (!one.loc || !one.fix) continue;
        const key = `${one.loc.line}:${one.loc.col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const index = one.loc.line - 1, at = one.loc.col - 1, line = lines[index];
        lines[index] = line.slice(0, at) + one.fix.to + line.slice(at + one.fix.from.length);
        applied.push(one);
        undone.add(`${file}|${one.fix.from}|${one.fix.to}`);
      }
      writeFileSync(join(appRoot, file), lines.join('\n'));
    }
  }
  return { applied, left };
}
