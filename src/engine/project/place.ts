// place: a finding of `check`, put in the file and at the column a reader (or `--fix`) has to go to. A finding inside a
// part (Loc.in, see ir/places.ts) is the part's when the word at fault is written on that line of the part's file, and
// the call's when it is not: then it came in through an argument, and the call is where it was written. One that names
// no word is about the element itself (its name for a screen reader, its children): the part's, when the part is the
// app's own and the finding holds whoever calls it (check-parts.ts); a self-link, a page's count of headings, are the
// page's, and a plugin's part is not the app's to edit, so those stay at the call. A finding that names its word points at
// it, not at the start of the element it was found in.

import { CALLER_FREE, PAGE_BOUND } from '#engine/project/check-parts.js';
import type { Diagnostic, Loc } from '#engine/shared/types.js';

export interface PartFiles { [part: string]: string }
export type Found = { file: string } & Diagnostic;

const WORD = /[A-Za-z0-9_$@]/;
const PLUGINS = 'node_modules';

/** The column (1-based) of `word` standing alone on `line`: the first at or after `from`, else the first; 0 if absent. */
function columnOf(line: string, word: string, from: number): number {
  let first = 0;
  for (let at = line.indexOf(word); at !== -1; at = line.indexOf(word, at + 1)) {
    const alone = !WORD.test(line[at - 1] || '') && !WORD.test(line[at + word.length] || '');
    if (!alone) continue;
    if (at + 1 >= from) return at + 1;
    if (!first) first = at + 1;
  }
  return first;
}

/** The one place `word` stands alone in `text`, or null when it is nowhere or in more than one (then it is not guessed). */
function onlyPlace(text: string, word: string): Loc | null {
  let at: Loc | null = null;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const column = columnOf(lines[index], word, 1);
    if (!column) continue;
    if (at || columnOf(lines[index], word, column + 1) > column) return null;
    at = { line: index + 1, col: column };
  }
  return at;
}

/** `found`, read in `file`, at its file and line: a part's own file, or the call that reached it. */
export function placeFinding(found: Diagnostic, file: string, partFiles: PartFiles, sourceOf: (file: string) => string): Found {
  const word = found.word ?? found.fix?.from ?? null;
  const lineOf = (where: string, line: number): string => sourceOf(where).split('\n')[line - 1] ?? '';
  const settle = (where: string, loc: Loc): Found => {
    const column = word ? columnOf(lineOf(where, loc.line), word, loc.col) : 0;
    return { ...found, file: where, loc: { line: loc.line, col: column || loc.col } };
  };
  let loc = found.loc;
  while (loc?.in && !PAGE_BOUND.has(found.code)) {
    const partFile = partFiles[loc.in.part];
    if (partFile !== undefined && (word ? columnOf(lineOf(partFile, loc.line), word, 1) > 0 : CALLER_FREE.has(found.code) && !partFile.includes(PLUGINS))) return settle(partFile, loc);
    loc = loc.in.call;
  }
  // a finding with no line (an entity field, a parameter: their types keep no position) is put where its word is, when
  // the word stands in exactly one place of the file
  const only = !loc && word ? onlyPlace(sourceOf(file), word) : null;
  return loc ? settle(file, loc) : { ...found, file, loc: only };
}
