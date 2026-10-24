// fmt: `muten fmt`, one shape for every .muten and .store file (yours and the AI's). It only moves whitespace: each line
// indented two spaces per open brace, no spaces at line ends, one blank line at most between blocks, one newline at the
// end. Comments stay, word for word (a printer of the parsed file would drop them). What it does not touch: a `fn`'s
// TypeScript body, a string that runs over several lines, and a line that continues an open `(` or `[` (an argument
// list laid out by hand). And it proves it: the file's tokens before and after must be the same, or it is left as it was.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tokenize } from '#engine/lang/lexer.js';
import { Tk, Pn, Kw } from '#engine/shared/vocab.js';

const INDENT = '  ';
const SOURCE = /\.(muten|store)$/;
const PLUGINS = 'node_modules';
/** Words that only continue the line above (an action's `mutates` on the next line): kept where the author put them. */
const CONTINUES: ReadonlySet<string> = new Set([Kw.Mutates]);

/** The tokens of `text` as a reader sees them (positions left out): what formatting must never change. */
const meaning = (text: string): string => JSON.stringify(tokenize(text).map((token) => [token.t, token.v]));

/** `text` in muten's shape (or `text` itself when it cannot be read). */
export function format(text: string): string {
  let tokens;
  try { tokens = tokenize(text); } catch { return text; }   // a file that does not read is check's to report
  // where each line begins, and what is open there (braces for the indent; a paren, a bracket, a raw body or a string
  // that crosses the line break mean "leave this line as it is")
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) { starts.push(at); at += line.length + 1; }
  const keep = new Set<number>();
  const indentAt: number[] = new Array(lines.length).fill(0);
  // each open brace remembers the indent of the line it opened on: what is inside goes ONE level in, however many braces
  // that line opened (`when x { Group(…) {` is one level, closed by `} }` on one line), and a line that starts by
  // closing sits where its opener's line sat
  // a brace with something after it on its own line (`entity Shop { id text …`, the rest aligned under it by hand) is the
  // author's layout until it closes: those lines are kept as written
  const opened: Array<{ indent: number; inline: boolean }> = [];
  let groups = 0, token = 0;
  for (let line = 0; line < lines.length; line++) {
    const begin = starts[line], end = begin + lines[line].length;
    let indent = opened.length ? opened[opened.length - 1].indent + 1 : 0;
    if (opened.length && opened[opened.length - 1].inline) keep.add(line);
    let first = true;
    if (groups > 0) keep.add(line);
    while (token < tokens.length && tokens[token].pos < end + 1) {
      const current = tokens[token];
      if (current.pos < begin && current.end > begin) keep.add(line);   // a string or a fn body crossing into this line
      if ((current.t === Tk.Raw || current.t === Tk.String) && current.end > end + 1) for (let next = line + 1; next < lines.length && starts[next] < current.end; next++) keep.add(next);
      if (first && current.t === Tk.Punct && current.v === Pn.BraceR) indent = opened.length ? opened[opened.length - 1].indent : 0;
      if (first && current.t === Tk.Ident && CONTINUES.has(current.v)) keep.add(line);   // `mutates …` under its `action`, aligned by hand
      first = false;
      if (current.t === Tk.Punct) {
        if (current.v === Pn.BraceL) { const after = tokens[token + 1]; opened.push({ indent, inline: Boolean(after) && after.t !== Tk.Eof && after.pos < end && !(after.t === Tk.Punct && after.v === Pn.BraceR) }); }
        else if (current.v === Pn.BraceR) opened.pop();
        else if (current.v === Pn.ParenL || current.v === Pn.BrackL) groups++;
        else if (current.v === Pn.ParenR || current.v === Pn.BrackR) groups = Math.max(0, groups - 1);
      }
      token++;
    }
    indentAt[line] = indent;
  }
  const out: string[] = [];
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];
    if (keep.has(line)) { out.push(raw.replace(/[ \t]+$/, '')); continue; }
    const body = raw.trim();
    if (!body) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    out.push(INDENT.repeat(indentAt[line]) + body);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const result = out.join('\n') + '\n';
  return meaning(result) === meaning(text) ? result : text;   // only whitespace moved, or nothing does
}

/** The app's own source files. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === PLUGINS ? [] : sources(full);
    return SOURCE.test(entry.name) ? [full] : [];
  });
}

/** `muten fmt [--check]`: formats every file (or, with --check, only says which would change). True when none had to. */
export function fmtCommand(root: string, onlyCheck: boolean): boolean {
  const changed: string[] = [];
  for (const file of sources(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const shaped = format(text);
    if (shaped === text) continue;
    changed.push(relative(root, file));
    if (!onlyCheck) writeFileSync(file, shaped);
  }
  for (const file of changed) console.log(`  ${onlyCheck ? '·' : '✓'} ${file}`);
  console.log(changed.length ? `${changed.length} file(s) ${onlyCheck ? 'would change' : 'formatted'}` : 'every file is in shape');
  return changed.length === 0;
}
