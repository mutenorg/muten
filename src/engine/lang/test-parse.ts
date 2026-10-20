// test-parse: a `.test` file -> its tests. A test is the steps a person takes, in muten's own words:
//
//   test "adding a product shows the total" {
//     see "Total: $0"
//     press "Add"
//     fill "Coupon" with "HALF"
//     see "Total: $5"
//     see no "Invalid coupon"
//   }
//
// `muten test` runs them in a real browser against the app's `mock` data (test-runner.ts); `muten check` parses
// them, so a typo'd step is an error with the right word suggested, like any other.
import { tokenize } from '#engine/lang/lexer.js';
import { Tk, Pn, TestKw } from '#engine/shared/vocab.js';
import { ParseError, closest } from '#engine/shared/diagnostics.js';
import type { Loc, TestCase, TestFile, TestStep, Token } from '#engine/shared/types.js';

const STEP_WORDS = [TestKw.Open, TestKw.Press, TestKw.Fill, TestKw.See, TestKw.Wait];

class TestParser {
  private index = 0;
  private readonly tokens: Token[];
  private readonly lineStarts: number[] = [0];

  constructor(source: string) {
    this.tokens = tokenize(source);
    for (let at = 0; at < source.length; at++) if (source[at] === '\n') this.lineStarts.push(at + 1);
  }

  // ── tokens ──
  private peek(): Token { return this.tokens[this.index]; }
  private next(): Token { return this.tokens[this.index++]; }
  private at(kind: Tk, value?: string): boolean { const token = this.peek(); return token.t === kind && (value === undefined || token.v === value); }
  private locOf(pos: number): Loc {
    let line = 0;
    while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= pos) line++;
    return { line: line + 1, col: pos - this.lineStarts[line] + 1 };
  }
  private fail(message: string, token: Token = this.peek()): never { throw new ParseError(message, this.locOf(token.pos)); }
  private text(what: string): string {
    if (!this.at(Tk.String)) this.fail(`${what} is a "quoted text"`);
    return this.next().v;
  }
  private word(word: TestKw): void {
    if (!this.at(Tk.Ident, word)) this.fail(`expected \`${word}\``);
    this.next();
  }

  // ── file ──
  parse(): TestFile {
    const tests: TestCase[] = [];
    while (!this.at(Tk.Eof)) tests.push(this.parseTest());
    return { tests };
  }

  private parseTest(): TestCase {
    const head = this.peek();
    if (!this.at(Tk.Ident, TestKw.Test)) this.fail('a .test file holds `test "what it proves" { … }` blocks');
    this.next();
    const name = this.text('a test\'s name');
    if (!this.at(Tk.Punct, Pn.BraceL)) this.fail('expected `{` after the test\'s name');
    this.next();
    const steps: TestStep[] = [];
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      if (this.at(Tk.Eof)) this.fail(`test "${name}" is never closed with \`}\``, head);
      steps.push(this.parseStep());
    }
    this.next();
    return { name, steps, loc: this.locOf(head.pos) };
  }

  private parseStep(): TestStep {
    const token = this.peek();
    const loc = this.locOf(token.pos);
    if (token.t !== Tk.Ident) this.fail(`a step starts with one of: ${STEP_WORDS.join(', ')}`);
    this.next();
    switch (token.v) {
      case TestKw.Open: return { kind: TestKw.Open, route: this.text('`open` takes a route, like "/cart", which'), loc };
      case TestKw.Press: return { kind: TestKw.Press, target: this.text('what to press (its text or label)'), loc };
      case TestKw.Fill: {
        const target = this.text('the field to fill (its label, placeholder or name)');
        this.word(TestKw.With);
        return { kind: TestKw.Fill, target, value: this.text('what to type'), loc };
      }
      case TestKw.See: {
        const absent = this.at(Tk.Ident, TestKw.No);
        if (absent) this.next();
        return { kind: TestKw.See, text: this.text('the text to see'), absent, loc };
      }
      case TestKw.Wait: {
        if (!this.at(Tk.Number)) this.fail('`wait` takes milliseconds: `wait 300`');
        return { kind: TestKw.Wait, ms: Number(this.next().v), loc };
      }
      default: {
        const near = closest(token.v, STEP_WORDS);
        return this.fail(`unknown step "${token.v}"${near ? ` — did you mean \`${near}\`?` : ''} (steps: ${STEP_WORDS.join(', ')})`, token);
      }
    }
  }
}

/** The tests of a `.test` file; a ParseError (with its line) when it is not one. */
export function parseTests(source: string): TestFile {
  return new TestParser(source).parse();
}
