// dev-errors: an error thrown in the browser during `muten dev`, at the line of the .muten file that holds it. The page's
// overlay used to print the browser's stack as it is: `/assets/home-3f2a.js:1:20981`, a line nobody wrote. The page sends
// the stack here; each frame is read back through the source maps the dev server keeps in memory, and the answer is told
// the way `check` tells a finding: the file, the line, the code under it. When the error is born in muten's own code
// (the runtime) and no line of the app is on the way, it says so: that is a muten bug, and it is not the app's to fix.

import { SourceMap } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, dirname, basename } from 'node:path';
import { codeFrame } from '#engine/shared/diagnostics.js';
import { runtimeHint } from './runtime-hints.js';

const FRAME = /(?:https?:\/\/[^\s/]+)?\/(assets\/[^\s):]+\.js):(\d+):(\d+)/g;
const APP_FILE = /\.(muten|store|ts|js)$/;
const MUTEN_OWN = /(@muten[\\/]core|muten[\\/]dist|virtual:muten)/;

/** One frame, read back to where it was written. */
interface Place { file: string; line: number; col: number; mine: boolean }

/** What the overlay shows: the error at the app's line, or a muten bug. */
export interface RuntimeReport { text: string; file: string | null; line: number | null; mutenBug: boolean; hint: string }

interface MapShape { version: number; sources: string[]; names: string[]; mappings: string; sourceRoot?: string; sourcesContent?: string[]; file?: string }
const isMap = (value: unknown): value is MapShape => Boolean(value) && typeof value === 'object' && value !== null && 'mappings' in value && 'sources' in value;

/** The frames of `stack`, each at its file and line (the frames source maps cannot read are left out). */
function places(stack: string, files: Map<string, Uint8Array>, root: string, outdir: string): Place[] {
  const maps = new Map<string, SourceMap | null>();
  const out: Place[] = [];
  for (const m of stack.matchAll(FRAME)) {
    const asset = '/' + m[1];
    if (!maps.has(asset)) {
      const bytes = files.get(asset + '.map');
      let map: SourceMap | null = null;
      try { const json: unknown = bytes ? JSON.parse(Buffer.from(bytes).toString('utf8')) : null; if (isMap(json)) map = new SourceMap({ version: json.version, sources: json.sources, names: json.names, mappings: json.mappings, file: json.file ?? '', sourceRoot: json.sourceRoot ?? '', sourcesContent: json.sourcesContent ?? [] }); } catch { map = null; }
      maps.set(asset, map);
    }
    const map = maps.get(asset);
    const entry = map?.findEntry(Number(m[2]) - 1, Number(m[3]) - 1);
    if (!entry || !('originalSource' in entry) || !entry.originalSource) continue;
    const source = entry.originalSource.replace(/^file:\/\//, '');
    const abs = isAbsolute(source) ? source : resolve(dirname(join(outdir, asset)), source);   // a map's sources are relative to its own file
    const mine = MUTEN_OWN.test(source) || !APP_FILE.test(source) || !abs.startsWith(root);
    out.push({ file: mine ? 'muten/' + basename(source).replace(/^runtime$/, 'runtime.js') : relative(root, abs), line: entry.originalLine + 1, col: entry.originalColumn + 1, mine });
  }
  return out;
}

/** The overlay's text for `stack`: the message, the app's first line with its code, and the frames read back. */
export function placeRuntimeError(stack: string, files: Map<string, Uint8Array>, root: string, outdir: string): RuntimeReport {
  const message = stack.split('\n')[0] || 'error';
  const found = places(stack, files, root, outdir);
  const first = found.find((place) => !place.mine) ?? null;
  const mutenBug = !first && found.length > 0;
  let frame = '';
  if (first) { try { frame = codeFrame(readFileSync(join(root, first.file), 'utf8'), { line: first.line, col: first.col }); } catch { frame = ''; } }
  const head = first ? `${first.file}:${first.line}:${first.col}  ${message}${frame}` : message;
  const hint = mutenBug ? '' : runtimeHint(message);   // what the usual errors mean in a muten app (runtime-hints.ts)
  const note = mutenBug ? '\n\nThis error is born inside muten itself, with no line of your app on the way: it looks like a muten bug, not yours to fix. `muten report` writes what to send.' : hint ? `\n\n${hint}` : '';
  const trail = found.length ? '\n\n' + found.map((place) => `  at ${place.file}:${place.line}:${place.col}${place.mine ? '  (muten)' : ''}`).join('\n') : '';
  return { text: head + note + trail, file: first?.file ?? null, line: first?.line ?? null, mutenBug, hint };
}
