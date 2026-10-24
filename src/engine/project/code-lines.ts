// code-lines: how much of an app is muten and how much is JavaScript/TypeScript, in non-blank lines under src/. The
// gap between the two is what muten is trying to close (a Custom or a facade is code `check` mostly cannot read), so
// `muten map` measures it instead of guessing: .muten and .store files on one side; .ts/.js on the other, with the
// Customs (src/components/) counted apart. A `fn` block is TypeScript written inside a .muten file: it counts as muten,
// because it lives in the page and is checked with it.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CodeLines } from '#engine/shared/types-tooling.js';

const MUTEN_EXT = /\.(muten|store)$/;
const SCRIPT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.ts$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.muten']);
const CUSTOMS_DIR = 'components';

const nonBlank = (file: string): number => readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length;

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : filesUnder(path);
    return [path];
  });
}

/** The app's lines by kind, and muten's share of them. */
export function codeLines(appRoot: string): CodeLines {
  const src = join(appRoot, 'src');
  const out: CodeLines = { muten: { files: 0, lines: 0 }, script: { files: 0, lines: 0 }, customs: { files: 0, lines: 0 }, mutenShare: 0 };
  for (const file of filesUnder(src)) {
    if (MUTEN_EXT.test(file)) { out.muten.files++; out.muten.lines += nonBlank(file); continue; }
    if (!SCRIPT_EXT.test(file) || DECLARATION.test(file)) continue;
    const lines = nonBlank(file);
    out.script.files++; out.script.lines += lines;
    if (relative(src, file).split(sep)[0] === CUSTOMS_DIR) { out.customs.files++; out.customs.lines += lines; }
  }
  const total = out.muten.lines + out.script.lines;
  out.mutenShare = total ? Math.round((out.muten.lines / total) * 1000) / 10 : 0;
  return out;
}
