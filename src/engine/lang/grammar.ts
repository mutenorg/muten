// ============================================================================
// Grammar — the reading foundation the screen parser stands on
// ============================================================================
// Three things every layer of the parser shares live here, so nothing is duplicated:
//   1. the CURSOR over the token stream — peek/at/next/eat + source-position lookup;
//   2. the EXPRESSION grammar (conditions, arithmetic, ternaries, { } interpolation);
//   3. the LITERAL-VALUE reader (the JSON-ish data in state initials, mock, sources).
//
// The high-level Parser (parse.ts) `extends Grammar`, so a declaration, a node and a
// `when` condition all walk ONE cursor and reuse the SAME expression grammar — which is
// why `x > 0` parses identically in a condition and inside a "total: {x * 2}". Every
// token it matches comes from vocab (Tk/Pn/Kw/BOp/UOp/Ek): there are no magic strings.

import { ParseError } from '#engine/shared/diagnostics.js';
import { tokenize } from '#engine/lang/lexer.js';
import { Tk, Pn, Kw, BOp, UOp, Ek, AGG_OPS, SORT_OPS } from '#engine/shared/vocab.js';
import type { Token, Loc, Expr, Interp, Scalar, Value } from '#engine/shared/types.js';

// Comparison operators expressed as data: [token kind, optional token value] → the binary op
// it yields. A table (not an if-chain) means adding an operator is a single new row.
const COMPARISONS: Array<[Tk, string | undefined, BOp]> = [
  [Tk.Eq, undefined, BOp.Eq],
  [Tk.Neq, undefined, BOp.Neq],
  [Tk.Lte, undefined, BOp.Lte],
  [Tk.Gte, undefined, BOp.Gte],
  [Tk.Punct, Pn.Lt, BOp.Lt],
  [Tk.Punct, Pn.Gt, BOp.Gt],
  [Tk.Ident, Kw.Contains, BOp.Contains],
];

// The three keyword literals, mapped to their runtime values. Shared by `primary` (inside an
// expression) and `parseScalar` (a bare value), so `true`/`false`/`null` mean the same everywhere.
const LITERALS = new Map<string, Scalar>([
  [Kw.True, true], [Kw.False, false], [Kw.Null, null],
]);

export class Grammar {
  // The cursor: the full token stream and where we are in it. `lineStarts` records the offset of
  // every line so any token's index resolves to a 1-based line/col in O(log n) for diagnostics.
  protected readonly toks: Token[];
  protected pos = 0;
  private readonly lineStarts: number[] = [0];

  constructor(source: string) {
    this.toks = tokenize(source);
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') this.lineStarts.push(i + 1);
  }

  // ── cursor primitives ────────────────────────────────────────────────────
  protected peek(): Token { return this.toks[this.pos]; }

  /** True if the current token is `kind` (and, when given, has value `value`). Never consumes. */
  protected at(kind: Tk, value?: string): boolean {
    const tok = this.peek();
    return tok.t === kind && (value === undefined || tok.v === value);
  }

  protected next(): Token { return this.toks[this.pos++]; }

  /** Consume the expected token, or throw a LOCATED error naming what we actually found. */
  protected eat(kind: Tk, value?: string): Token {
    if (!this.at(kind, value)) {
      const tok = this.peek();
      throw new ParseError(`expected ${kind}${value ? ' "' + value + '"' : ''}, got ${tok.t} "${tok.v}"`, this.locOf(tok.pos));
    }
    return this.next();
  }

  /** A source index → { line, col }, by binary search over the recorded line offsets. */
  protected locOf(index: number): Loc {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.lineStarts[mid] <= index) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: index - this.lineStarts[lo] + 1 };
  }

  // ── expressions ──────────────────────────────────────────────────────────
  // A precedence ladder, lowest-binding first:
  //   ternary < or < and < comparison < add < mul < unary < primary
  // Each level parses the level above it, then folds left while its own operator keeps appearing,
  // so `a or b and c` groups as `a or (b and c)` and `a + b * c` as `a + (b * c)`.
  parseExpr(): Expr { return this.ternary(); }

  private ternary(): Expr {
    const cond = this.or();
    if (!this.at(Tk.Punct, Pn.Question)) return cond;
    this.next();
    const then = this.ternary();
    this.eat(Tk.Punct, Pn.Colon);
    return { kind: Ek.Tern, cond, then, else: this.ternary() };
  }

  private or(): Expr {
    let left = this.and();
    while (this.at(Tk.Ident, Kw.Or)) { this.next(); left = { kind: Ek.Bin, op: BOp.Or, left, right: this.and() }; }
    return left;
  }

  private and(): Expr {
    let left = this.cmp();
    while (this.at(Tk.Ident, Kw.And)) { this.next(); left = { kind: Ek.Bin, op: BOp.And, left, right: this.cmp() }; }
    return left;
  }

  // the current token as a comparison op, or null if it isn't one (table-driven lookup).
  private comparison(): BOp | null {
    for (const [kind, value, op] of COMPARISONS) if (this.at(kind, value)) return op;
    return null;
  }

  private cmp(): Expr {
    let left = this.add();
    for (let op = this.comparison(); op; op = this.comparison()) { this.next(); left = { kind: Ek.Bin, op, left, right: this.add() }; }
    return left;
  }

  private add(): Expr {
    let left = this.mul();
    while (this.at(Tk.Punct, Pn.Plus) || this.at(Tk.Punct, Pn.Dash)) {
      const op = this.peek().v === Pn.Plus ? BOp.Add : BOp.Sub;
      this.next();
      left = { kind: Ek.Bin, op, left, right: this.mul() };
    }
    return left;
  }

  private mul(): Expr {
    let left = this.unary();
    while (this.at(Tk.Punct, Pn.Star) || this.at(Tk.Punct, Pn.Slash)) {
      const op = this.peek().v === Pn.Star ? BOp.Mul : BOp.Div;
      this.next();
      left = { kind: Ek.Bin, op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Expr {
    if (!this.at(Tk.Ident, Kw.Not)) return this.primary();
    this.next();
    return { kind: Ek.Un, op: UOp.Not, operand: this.unary() };
  }

  // the atoms: a parenthesised expression, an object literal, a literal, or a (possibly dotted) reference.
  private primary(): Expr {
    if (this.at(Tk.Punct, Pn.ParenL)) { this.next(); const inner = this.ternary(); this.eat(Tk.Punct, Pn.ParenR); return inner; }
    if (this.at(Tk.Punct, Pn.BraceL)) { // inline object literal: `{ title: @t, qty: 1 }` — the one missing value form
      this.next();
      const fields: Array<{ key: string; value: Expr }> = [];
      while (!this.at(Tk.Punct, Pn.BraceR)) {
        const key = this.eat(Tk.Ident).v;
        this.eat(Tk.Punct, Pn.Colon);
        fields.push({ key, value: this.ternary() });
        if (this.at(Tk.Punct, Pn.Comma)) this.next();
      }
      this.eat(Tk.Punct, Pn.BraceR);
      return { kind: Ek.Obj, fields };
    }
    if (this.at(Tk.String)) return { kind: Ek.Lit, value: this.next().v };
    if (this.at(Tk.Number)) return { kind: Ek.Lit, value: Number(this.next().v) };
    let name = this.at(Tk.Param) ? '$' + this.next().v : this.eat(Tk.Ident).v; // $param resolves at compose time
    const literal = LITERALS.get(name);
    if (literal !== undefined) return { kind: Ek.Lit, value: literal }; // true | false | null
    while (this.at(Tk.Punct, Pn.Dot)) { this.next(); name += '.' + this.eat(Tk.Ident).v; } // user.name, cart.total
    const dot = name.lastIndexOf('.');
    const op = dot === -1 ? '' : name.slice(dot + 1);
    const isAgg = AGG_OPS.has(op) || SORT_OPS.has(op);
    // canonical lambda-free aggregate: `lines.sum by price * qty` (projection) / `tasks.count where not done` (predicate);
    // item fields are read BARE (item-implicit), exactly like the `where`-filter and `each`.
    if (isAgg && (this.at(Tk.Ident, Kw.By) || this.at(Tk.Ident, Kw.Where))) {
      this.next();
      return { kind: Ek.Agg, op, list: name.slice(0, dot), body: this.parseExpr() };
    }
    if (!isAgg && this.at(Tk.Ident, Kw.Where)) {             // derived list: `tasks where status == "todo"` — item fields read bare
      this.next();
      return { kind: Ek.Filter, list: name, cond: this.parseExpr() };
    }
    if (this.at(Tk.Punct, Pn.ParenL)) {
      if (isAgg) throw new ParseError(`\`${op}\` takes ${op === 'count' ? '`where <cond>`' : '`by <expr>`'} now, not a \`(x => …)\` lambda — write \`${name.slice(0, dot)}.${op} ${op === 'count' ? 'where <cond>' : 'by <expr>'}\` (item fields read bare)`, this.locOf(this.peek().pos));
      this.next();                                            // a call: fmt(a, b) → a use'd function
      const args: Expr[] = [];
      while (!this.at(Tk.Punct, Pn.ParenR)) { args.push(this.ternary()); if (this.at(Tk.Punct, Pn.Comma)) this.next(); }
      this.eat(Tk.Punct, Pn.ParenR);
      return { kind: Ek.Call, fn: name, args };
    }
    return { kind: Ek.Ref, name };
  }

  // "Hi, {user.name}!" → an interpolation: literal text chunks interleaved with embedded
  // expressions. Plain text with no `{ }` stays a plain string (the caller treats it as constant).
  protected parseInterpolation(raw: string): string | Interp {
    if (!raw.includes('{')) return raw;
    const parts: Array<string | Expr> = [];
    let cursor = 0;
    while (cursor < raw.length) {
      const open = raw.indexOf('{', cursor);
      if (open < 0) { parts.push(raw.slice(cursor)); break; }
      if (open > cursor) parts.push(raw.slice(cursor, open));
      const close = raw.indexOf('}', open);
      if (close < 0) { parts.push(raw.slice(open)); break; } // unbalanced — keep the rest verbatim
      parts.push(new Grammar(raw.slice(open + 1, close)).parseExpr()); // {expr} → a full expression AST
      cursor = close + 1;
    }
    return { kind: Ek.Interp, parts };
  }

  // ── literal values (JSON-ish: state initials, mock data, source descriptors) ──────────
  /** A single scalar: string | number | true | false | null | a bare ident (an enum value). */
  protected parseScalar(): Scalar {
    if (this.at(Tk.String)) return this.next().v;
    if (this.at(Tk.Number)) return Number(this.next().v);
    const word = this.eat(Tk.Ident).v;
    const literal = LITERALS.get(word);
    return literal !== undefined ? literal : word; // keyword literal, else an enum value (e.g. admin)
  }

  /** A value: a scalar, an array, or an object. */
  protected parseValue(): Value {
    if (this.at(Tk.Punct, Pn.BrackL)) return this.parseArray();
    if (this.at(Tk.Punct, Pn.BraceL)) return this.parseObject();
    return this.parseScalar();
  }

  private parseArray(): Value[] {
    this.eat(Tk.Punct, Pn.BrackL);
    const items: Value[] = [];
    while (!this.at(Tk.Punct, Pn.BrackR)) {
      items.push(this.parseValue());
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.BrackR);
    return items;
  }

  private parseObject(): { [key: string]: Value } {
    this.eat(Tk.Punct, Pn.BraceL);
    const obj: { [key: string]: Value } = {};
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const key = this.at(Tk.String) ? this.next().v : this.eat(Tk.Ident).v;
      this.eat(Tk.Punct, Pn.Colon);
      obj[key] = this.parseValue();
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.BraceR);
    return obj;
  }
}
