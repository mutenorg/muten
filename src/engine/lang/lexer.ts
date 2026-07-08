// lexer: .muten source text -> flat token stream (each token carries its start index).
// Separate from the parser to keep each file focused. All matched characters and
// operators come from vocab (Tk/Pn): no magic strings. Consumed by grammar.ts.

import { Tk, Pn } from '#engine/shared/vocab.js';
import { ParseError } from '#engine/shared/diagnostics.js';
import type { Token, Loc } from '#engine/shared/types.js';

const PUNCT_CHARS = Object.values(Pn).join(''); // single-char punctuation set

// two-char operators matched as a table, before single-char punctuation.
const OPERATORS: Array<[string, Tk]> = [
  ['->', Tk.Arrow], ['<-', Tk.LArrow], ['==', Tk.Eq], ['=>', Tk.FatArrow],
  ['!=', Tk.Neq], ['<=', Tk.Lte], ['>=', Tk.Gte],
];

// named so the scanners read like prose.
const isSpace = (char: string): boolean => char === ' ' || char === '\t' || char === '\r' || char === '\n';
const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const isWordStart = (char: string): boolean => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';

// JS operators that don't exist in muten — point the writer (often an AI) at the muten word instead of a bare "unexpected character".
const JS_OP_HINT: Record<string, string> = {
  '!': 'muten has no "!" — write "not x" for negation, or "!=" for not-equal',
  '&': 'muten has no "&&" — write "and"',
  "'": 'muten strings and values use "double quotes" — write "completed", not \'completed\' (single quotes are not valid)',
  '\\': 'muten has no backslash escapes — a `"` inside `{…}` is ALREADY a nested string, so write `{on ? "a" : "b"}` (remove the `\\`)',
};
const isWord = (char: string): boolean => isWordStart(char) || isDigit(char);

// 1-based line/col for a source index, used when the lexer hits a bad character.
function locFromIndex(source: string, index: number): Loc {
  let line = 1, col = 1;
  for (let scan = 0; scan < index && scan < source.length; scan++) { if (source[scan] === '\n') { line++; col = 1; } else col++; }
  return { line, col };
}

// One scan method per token shape; the main loop is a flat dispatch, not an inline chain.
class Lexer {
  private index = 0;
  private readonly tokens: Token[] = [];
  constructor(private readonly source: string) {}

  tokenize(): Token[] {
    const { source } = this;
    while (this.index < source.length) {
      const start = this.index;
      const char = source[this.index];
      if (isSpace(char)) { this.index++; continue; }
      if (char === '﻿') { this.index++; continue; }             // BOM — Windows editors / model output prepend it; skip, don't die at 1:1
      if (char === '#') { this.skipLineComment(); continue; }
      // Comments are `#`, but tolerate the JS-isms every model reaches for (`//` line, `/* … */` block) — they carry
      // no meaning, so accepting them costs nothing and spares the AI a landmine. A lone `/` stays division.
      if (char === '/' && source[this.index + 1] === '/') { this.skipLineComment(); continue; }
      if (char === '/' && source[this.index + 1] === '*') { this.skipBlockComment(); continue; }
      if (char === '"') { this.scanString(start); continue; }
      if (char === '@') { this.scanSigil(start, Tk.Ref, '@'); continue; }   // @state ref
      if (char === '$') { this.scanSigil(start, Tk.Param, ''); continue; }  // $partParam
      if (this.scanOperator(start)) continue;                              // ->, <-, ==, =>, !=, <=, >=
      if (isDigit(char) || (char === Pn.Dash && isDigit(source[this.index + 1]))) { this.scanNumber(start); continue; }
      if (PUNCT_CHARS.includes(char)) { this.push(Tk.Punct, char, start); this.index++; continue; }
      if (isWordStart(char)) { this.scanWord(start); continue; }           // ident / keyword
      const hint = JS_OP_HINT[char];                                       // catch JS-isms (! && ||) with the muten word
      throw new ParseError(hint ?? `unexpected character ${JSON.stringify(char)}`, locFromIndex(source, this.index));
    }
    this.push(Tk.Eof, '', this.index);
    return this.tokens;
  }

  private push(kind: Tk, value: string, pos: number): void { this.tokens.push({ t: kind, v: value, pos }); }

  private skipLineComment(): void { while (this.index < this.source.length && this.source[this.index] !== '\n') this.index++; }
  private skipBlockComment(): void { this.index += 2; while (this.index < this.source.length && !(this.source[this.index] === '*' && this.source[this.index + 1] === '/')) this.index++; this.index += 2; } // unterminated → runs to EOF, harmless

  // Read until the closing quote, but a `"` inside `{...}` is a nested string literal,
  // not the end: `"Total ({items.count(i => i.status == "paid")})"` is one string token.
  private scanString(start: number): void {
    const { source } = this; let end = this.index + 1; let value = ''; let depth = 0;
    while (end < source.length && (source[end] !== '"' || depth > 0)) {
      if (source[end] === '\\' && source[end + 1] === '"') { value += '"'; end += 2; continue; } // tolerate `\"` (the universal JS instinct: escaping a quote) → a literal " ; other `\x` (e.g. `\d` in a regex) stay literal
      if (source[end] === '{') depth++;
      else if (source[end] === '}') depth--;
      value += source[end]; end++;
    }
    this.push(Tk.String, value, start); this.index = end + 1;
  }

  // `@` or `$` followed by an identifier -> a ref or part-param token.
  private scanSigil(start: number, kind: Tk, prefix: string): void {
    const { source } = this; let end = this.index + 1; let name = '';
    while (end < source.length && isWord(source[end])) { name += source[end]; end++; }
    this.push(kind, prefix + name, start); this.index = end;
  }

  // Returns false (no advance) if no two-char operator from OPERATORS matches here.
  private scanOperator(start: number): boolean {
    const pair = this.source.slice(this.index, this.index + 2);
    const op = OPERATORS.find(([text]) => text === pair);
    if (!op) return false;
    this.push(op[1], pair, start); this.index += 2;
    return true;
  }

  // Integer or decimal; leading `-` allowed. Consumes digits then an optional `.digits`.
  private scanNumber(start: number): void {
    const { source } = this; let end = this.index + (source[this.index] === Pn.Dash ? 1 : 0);
    while (end < source.length && isDigit(source[end])) end++;
    if (source[end] === Pn.Dot) { end++; while (end < source.length && isDigit(source[end])) end++; }
    this.push(Tk.Number, source.slice(this.index, end), start); this.index = end;
  }

  // Identifier or keyword: letters, digits, and `_`.
  private scanWord(start: number): void {
    const { source } = this; let end = this.index;
    while (end < source.length && isWord(source[end])) end++;
    this.push(Tk.Ident, source.slice(this.index, end), start); this.index = end;
  }
}

export function tokenize(source: string): Token[] { return new Lexer(source).tokenize(); }
