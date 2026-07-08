// grammar: shared foundation for the screen parser.
// Provides: the token cursor (peek/at/next/eat + position lookup), the expression
// grammar (conditions, arithmetic, ternaries, interpolation), and the literal-value
// reader (JSON-ish data for state initials, mock, sources). Parser (parse.ts) extends
// this, so all layers share one cursor and one expression grammar. No magic strings.

import { ParseError } from '#engine/shared/diagnostics.js';
import { tokenize } from '#engine/lang/lexer.js';
import { Tk, Pn, Kw, BOp, UOp, Ek, AGG_OPS, SORT_OPS } from '#engine/shared/vocab.js';
import type { Token, Loc, Expr, Interp, Scalar, Value } from '#engine/shared/types.js';

// Comparison operators as a table: [token kind, optional value] -> binary op.
// Adding an operator is a single new row.
const COMPARISONS: Array<[Tk, string | undefined, BOp]> = [
  [Tk.Eq, undefined, BOp.Eq],
  [Tk.Neq, undefined, BOp.Neq],
  [Tk.Lte, undefined, BOp.Lte],
  [Tk.Gte, undefined, BOp.Gte],
  [Tk.Punct, Pn.Lt, BOp.Lt],
  [Tk.Punct, Pn.Gt, BOp.Gt],
  [Tk.Ident, Kw.Contains, BOp.Contains],
];

// Keyword literals mapped to runtime values, shared by `primary` and `parseScalar`
// so `true`/`false`/`null` mean the same thing in expressions and bare values.
const LITERALS = new Map<string, Scalar>([
  [Kw.True, true], [Kw.False, false], [Kw.Null, null],
]);

export class Grammar {
  // Full token stream + current position. `lineStarts` maps every line's offset
  // so any token resolves to a 1-based line/col in O(log n) for diagnostics.
  protected readonly toks: Token[];
  protected pos = 0;
  private readonly lineStarts: number[] = [0];
  // When this Grammar parses an interpolation sub-expression (`{…}` from a larger string), it rebases its
  // diagnostics onto the OUTER source, so an error inside `{…}` reports the real file line/col — not line 1
  // of the isolated expression substring (the cause of "every interpolation error points at line 1").
  private rebaseBase = 0;
  private rebaseParent: Grammar | null = null;

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
    if (this.rebaseParent) return this.rebaseParent.locOf(this.rebaseBase + index); // an interpolation sub-expr: resolve against the outer file
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.lineStarts[mid] <= index) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: index - this.lineStarts[lo] + 1 };
  }

  // ── expressions ──────────────────────────────────────────────────────────
  // Precedence ladder, lowest-binding first:
  //   ternary < or < and < not < comparison < add < mul < primary
  // Each level folds left while its operator keeps appearing, so `a or b and c`
  // groups as `a or (b and c)` and `a + b * c` as `a + (b * c)`.
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
    let left = this.notExpr();
    while (this.at(Tk.Ident, Kw.And)) { this.next(); left = { kind: Ek.Bin, op: BOp.And, left, right: this.notExpr() }; }
    return left;
  }

  // `not` binds LOOSER than comparison: `not a contains b` == `not (a contains b)`.
  // (Was a unary, so `not a contains b` wrongly parsed as `(not a) contains b` -> __has(!a, b).)
  private notExpr(): Expr {
    if (!this.at(Tk.Ident, Kw.Not)) return this.cmp();
    this.next();
    return { kind: Ek.Un, op: UOp.Not, operand: this.notExpr() };
  }

  // Returns the current token as a comparison op, or null (table-driven lookup).
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
    let left = this.primary();
    while (this.at(Tk.Punct, Pn.Star) || this.at(Tk.Punct, Pn.Slash)) {
      const op = this.peek().v === Pn.Star ? BOp.Mul : BOp.Div;
      this.next();
      left = { kind: Ek.Bin, op, left, right: this.primary() };
    }
    return left;
  }

  // Atoms: parenthesised expr, object literal, literal value, or a (possibly dotted) reference.
  private primary(): Expr {
    if (this.at(Tk.Punct, Pn.ParenL)) {
      this.next(); const inner = this.ternary(); this.eat(Tk.Punct, Pn.ParenR);
      // `(a * 0.8).toFixed(0)` — a JS method on a parenthesized result. muten values have no methods; teach the escape.
      if (this.at(Tk.Punct, Pn.Dot)) throw new ParseError('muten values have no methods (`.toFixed`/`.map`/`.round`…). To format a number use `money(x)`; for list operations use `where` / `sort by` / `sum by`.', this.locOf(this.peek().pos));
      return inner;
    }
    if (this.at(Tk.Punct, Pn.BraceL)) { // inline object literal: `{ title: @t, qty: 1 }` (the one missing value form)
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
    // `if … then … else` is a STATEMENT (action bodies only); in an expression muten uses a ternary. `if`/`then`/`else`
    // are never valid expression atoms, so catching one here teaches the ternary instead of a cryptic "unexpected".
    if (name === 'if' || name === 'then' || name === 'else') throw new ParseError(`muten expressions use a ternary \`cond ? a : b\`, not \`if … then … else\` — e.g. \`status == "done" ? 10000 : 5000\`.`, this.locOf(this.toks[this.pos - 1].pos));
    const literal = LITERALS.get(name);
    if (literal !== undefined) return { kind: Ek.Lit, value: literal }; // true, false, or null
    while (this.at(Tk.Punct, Pn.Dot)) { this.next(); name += '.' + this.eat(Tk.Ident).v; } // user.name, cart.total
    const dot = name.lastIndexOf('.');
    const op = dot === -1 ? '' : name.slice(dot + 1);
    const isAgg = AGG_OPS.has(op) || SORT_OPS.has(op);
    // `list.take(n)` -> the first n items (top-N lists, "load more" pagination). Returns a list, so it reads
    // like `sort` downstream (element type preserved), but takes a parenthesized count, not `by`/`where`.
    if (op === 'take' && this.at(Tk.Punct, Pn.ParenL)) {
      this.next();
      const n = this.parseExpr();
      this.eat(Tk.Punct, Pn.ParenR);
      return { kind: Ek.Agg, op: 'take', list: name.slice(0, dot), body: n };
    }
    // `list.at(n)` -> the element at position n (the dual of `each … , i`): read the highlighted/selected item
    // out of a list by index. Negative indexes count from the end (`.at(-1)` = last); out of range = null.
    if (op === 'at' && this.at(Tk.Punct, Pn.ParenL)) {
      this.next();
      const n = this.parseExpr();
      this.eat(Tk.Punct, Pn.ParenR);
      let member = ''; // a field read off the element: `matches.at(hi).name` -> member = "name" (dotted for nesting)
      while (this.at(Tk.Punct, Pn.Dot)) { this.next(); member += (member ? '.' : '') + this.eat(Tk.Ident).v; }
      return { kind: Ek.Agg, op: 'at', list: name.slice(0, dot), body: n, member: member || undefined };
    }
    // Lambda-free aggregate: `lines.sum by price * qty` (projection) or
    // `tasks.count where not done` (predicate). Item fields are read bare (item-implicit).
    if (isAgg && (this.at(Tk.Ident, Kw.By) || this.at(Tk.Ident, Kw.Where))) {
      this.next();
      const body = this.parseExpr();
      // `list.sort by <f> take(n)` — sort then keep the first n (top-N / "N most recent", a very common need). `take`
      // chains onto the sorted list here, so it reads as one expression instead of forcing two separate `get`s.
      let take: Expr | undefined;
      if ((op === 'sort' || op === 'sortDesc') && this.at(Tk.Ident, 'take')) { this.next(); this.eat(Tk.Punct, Pn.ParenL); take = this.parseExpr(); this.eat(Tk.Punct, Pn.ParenR); }
      return { kind: Ek.Agg, op, list: name.slice(0, dot), body, take };
    }
    if (!isAgg && this.at(Tk.Ident, Kw.Where)) {             // derived list: `tasks where status == "todo"`, item fields read bare
      this.next();
      return { kind: Ek.Filter, list: name, cond: this.parseExpr() };
    }
    if (this.at(Tk.Punct, Pn.ParenL)) {
      if (isAgg) throw new ParseError(`\`${op}\` takes ${op === 'count' ? '`where <cond>`' : '`by <expr>`'} now, not a \`(x => …)\` lambda — write \`${name.slice(0, dot)}.${op} ${op === 'count' ? 'where <cond>' : 'by <expr>'}\` (item fields read bare)`, this.locOf(this.peek().pos));
      // `list.orderBy(…)` / `.limit(…)` / `.filter(…)` — a JS/LINQ method. muten values have no methods (only the
      // built-ins take/at + `by`/`where` aggregates), so a dotted call here is always the model reaching for JS. Teach the vocabulary.
      if (dot !== -1) throw new ParseError(`\`.${op}(…)\`: muten values have no JS methods. Filter with \`${name.slice(0, dot)} where <cond>\`, order with \`${name.slice(0, dot)}.sort by <field>\` (or \`sortDesc by\`), take the first n with \`${name.slice(0, dot)}.take(n)\`, total/average/count with \`${name.slice(0, dot)}.sum|avg|count by <field>\`, membership with \`contains\`. A \`use\`'d function is called \`fn(x)\`, never \`x.fn()\`.`, this.locOf(this.peek().pos));
      this.next();                                            // a call: fmt(a, b) -> a use'd function
      const args: Expr[] = [];
      while (!this.at(Tk.Punct, Pn.ParenR)) { args.push(this.ternary()); if (this.at(Tk.Punct, Pn.Comma)) this.next(); }
      this.eat(Tk.Punct, Pn.ParenR);
      return { kind: Ek.Call, fn: name, args };
    }
    return { kind: Ek.Ref, name };
  }

  // "Hi, {user.name}!" -> interpolation: literal text chunks interleaved with expressions.
  // Plain text with no `{ }` stays a plain string (the caller treats it as constant).
  // `baseOffset` = the source index where `raw` (the string's content) begins, so errors inside `{…}` rebase
  // onto the real file position. Callers pass `stringToken.pos + 1` (the char after the opening quote); 0 falls
  // back to the old behavior (loc relative to the substring).
  protected parseInterpolation(raw: string, baseOffset = 0): string | Interp {
    if (!raw.includes('{')) return raw;
    const parts: Array<string | Expr> = [];
    let cursor = 0;
    while (cursor < raw.length) {
      const open = raw.indexOf('{', cursor);
      if (open < 0) { parts.push(raw.slice(cursor)); break; }
      if (open > cursor) parts.push(raw.slice(cursor, open));
      const close = raw.indexOf('}', open);
      if (close < 0) { parts.push(raw.slice(open)); break; } // unbalanced: keep the rest verbatim
      let sub: Grammar;
      try { sub = new Grammar(raw.slice(open + 1, close)); } // {expr} -> full expression AST
      catch (e) {
        // the lexer runs in the Grammar CONSTRUCTOR, before rebaseParent is set — so a bad char inside `{…}`
        // (e.g. a single quote) throws with a loc relative to the SUBSTRING. Map it back onto the outer file, or the
        // error points at line 1 instead of the real line (what left the model staring at `screen …` 18 lines up).
        if (e instanceof ParseError && e.loc && baseOffset > 0) {
          const s = raw.slice(open + 1, close);
          let i = 0, ln = 1;
          while (ln < e.loc.line && i < s.length) { if (s[i] === '\n') ln++; i++; }
          e.loc = this.locOf(baseOffset + open + 1 + i + (e.loc.col - 1));
        }
        throw e;
      }
      sub.rebaseParent = this; sub.rebaseBase = baseOffset + open + 1; // map its PARSER diagnostics back to the outer file
      parts.push(sub.parseExpr());
      if (!sub.at(Tk.Eof)) { // trailing tokens in `{…}` — almost always a Vue/Angular pipe filter (`{x | money}`)
        const t = sub.peek();
        throw new ParseError(t.v === Pn.Pipe ? `muten has no pipe filters — call the function: \`{money(x)}\`, not \`{x | money}\` (also \`date\`/\`time\`/\`ago\`/\`upper\`/\`truncate(s,n)\`).` : `unexpected "${t.v}" in \`{…}\` — an interpolation holds ONE expression`, sub.locOf(t.pos));
      }
      cursor = close + 1;
    }
    return { kind: Ek.Interp, parts };
  }

  // ── literal values: state initials, mock data, source descriptors (JSON-ish) ──────────
  /** A single scalar: string | number | true | false | null | a bare ident (an enum value). */
  protected parseScalar(): Scalar {
    if (this.at(Tk.String)) return this.next().v;
    if (this.at(Tk.Number)) return Number(this.next().v);
    const word = this.eat(Tk.Ident).v;
    const literal = LITERALS.get(word);
    return literal !== undefined ? literal : word; // keyword literal, or a bare enum value (e.g. admin)
  }

  /** A value: a scalar, an array, or an object. */
  protected parseValue(): Value {
    if (this.at(Tk.Punct, Pn.BrackL)) return this.parseArray();
    if (this.at(Tk.Punct, Pn.BraceL)) return this.parseObject();
    return this.parseScalar();
  }

  protected parseArray(): Value[] {
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
