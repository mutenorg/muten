// diagnostics: structured error/suggestion types for the compile pipeline.
// Knows the whole vocabulary (types, tokens, state, ops), so errors are specific and
// propose the closest candidate. Shaped for editors (squiggles) and AI (auto-fix).
// Consumed by validate, the linter, `muten lint`, and the runner.

import type { Loc, Diagnostic, DiagOpts } from '#engine/shared/types.js';

export class ParseError extends Error {
  code: string;
  loc: Loc | null;
  file?: string;   // tagged at the parse site so a syntax error that escapes validate still prints file:line:col
  suggestion: string | null = null;   // with `from`: the fix, as a diagnostic's (diag below)
  from: string | null = null;
  word: string | null = null;   // the text at fault, when there is no fix to name it (diag's `word`)
  constructor(message: string, loc?: Loc | null) {
    super(message);
    this.name = 'ParseError';
    this.code = 'syntax';
    this.loc = loc || null;
  }
}

/** A ParseError as a finding: its code, place, word and fix travel with it. */
export function parseErrorDiag(error: ParseError): Diagnostic {
  return diag(error.code, error.message, { loc: error.loc, suggestion: error.suggestion, from: error.from, word: error.word ?? error.from });
}

// `from` + `suggestion` together auto-build the `fix` (deterministic replacement an AI can apply).
/** A dotted call on a value (`items.orderBy(…)`): muten values have no JS methods, so teach its list vocabulary. */
export function noMethodsMessage(list: string, method: string): string {
  return `\`.${method}(…)\`: muten values have no JS methods. Filter with \`${list} where <cond>\`, order with \`${list}.sort by <field>\` (or \`sortDesc by\`), take the first n with \`${list}.take(n)\`, total/average/count with \`${list}.sum|avg|count by <field>\`, membership with \`contains\`. A \`use\`'d function is called \`fn(x)\`, never \`x.fn()\`; a store's \`get name(…)\` is called \`store.name(x)\`.`;
}

/** A part's argument (or a Custom's input) that is not a literal or a name: `items: [ … ]`, a call, a sum. */
export function argNotANameMessage(found: string): string {
  return `an argument here is a literal ("text", 3, true) or a name (a state, a \`get\`, a \`$param\`), not \`${found}\`. `
    + `If the component comes from npm (React, a web component), declare it in THIS file — \`use react Name from "…"\` — and its props take any expression, a list included. `
    + `For a part or a Custom, give the value a name first (\`state { items = [ … ] : list }\` or a \`get\`) and pass the name.`;
}

export function diag(code: string, message: string, opts: DiagOpts = {}): Diagnostic {
  const { loc = null, suggestion = null, severity = 'error', from = null, related = null, word = from } = opts;
  return { code, severity, message, loc, suggestion, fix: (from && suggestion) ? { from, to: suggestion } : null, word, related };
}

// Closest candidate by edit distance, used to populate `suggestion`. How far a candidate may be grows with the word: three
// edits away from a four-letter word is another word (`aira` → `Card`, `ture` → `quiet`), and a fix that turns a
// slip into another name is worse than none.
const reach = (word: string): number => Math.min(3, Math.max(1, Math.floor(word.replace(/^[$@]/, '').length / 3)));

export function closest(target: string, candidates: Iterable<string>, maxDist = reach(target)): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = lev(target, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxDist ? best : null;
}

// Edit distance where swapping two neighbours is ONE edit (optimal string alignment): the commonest slip at a keyboard is
// a transposition (`Tilte`), and counted as two it lost to a different word one letter away (`srTilte` → `srList`).
/** How many slips apart two words are (a swapped pair of letters is one). */
export function slips(a: string, b: string): number { return lev(a, b); }

function lev(a: string, b: string): number {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, before[j - 2] + 1);
      current.push(best);
    }
    before = previous;
    previous = current;
  }
  return previous[b.length];
}

// A TS/esbuild-style code frame: the offending source line + a caret under the exact column, so you SEE
// where the error is (a `file:line:col` alone reads exact but you still have to go count the character).
export function codeFrame(source: string, loc: Loc): string {
  const line = source.split('\n')[loc.line - 1];
  if (line === undefined) return '';
  const gutter = String(loc.line);
  const bar = ' '.repeat(gutter.length);
  const caret = ' '.repeat(Math.max(0, loc.col - 1)) + '^';
  return `\n  ${gutter} │ ${line}\n  ${bar} │ ${caret}\n`;
}

// CLI format: file:line:col  severity  [code]  message  -> did you mean "x"?  (+ a code frame when the source is on hand)
export function formatDiagnostic(d: Diagnostic, file: string, source?: string): string {
  const where = d.loc ? `${file}:${d.loc.line}:${d.loc.col}` : file;
  const hint = d.suggestion ? `  → did you mean "${d.suggestion}"?` : '';
  const frame = source && d.loc ? codeFrame(source, d.loc) : '';
  return `${where}  ${d.severity}  [${d.code}]  ${d.message}${hint}${frame}`;
}
