// readers: the small token readers every part of the screen grammar shares: a type (`list<User>`), a dotted name,
// a parenthesized ident, a `where` clause rebuilt as text, a path, call args and their values, aria/style args, a
// class name, a duration, an entity's constraints. Parser builds on these (readers → actions → declarations → tree).
import { ParseError } from '#engine/shared/diagnostics.js';
import { Grammar } from '#engine/lang/grammar.js';
import { Tk, Pn, Kw } from '#engine/shared/vocab.js';
import type { Expr, Interp, Value, FieldConstraint, ArgValue, ArgMap } from '#engine/shared/types.js';

export class Readers extends Grammar {


  // Validation suffix on an entity field: `required`, `min:N`, `max:N`, `pattern:"<regex>"` (any order, all optional).
  protected parseConstraints(): FieldConstraint {
    const constraint: FieldConstraint = {};
    while (this.at(Tk.Ident, Kw.Required) || this.at(Tk.Ident, Kw.Min) || this.at(Tk.Ident, Kw.Max) || this.at(Tk.Ident, Kw.Pattern)) {
      const key = this.next().v;
      if (key === Kw.Required) { constraint.required = true; continue; }
      // accept BOTH `min:8` (muten) and `min(8)` (the function-call style every model reaches for) — same meaning.
      const paren = this.at(Tk.Punct, Pn.ParenL);
      if (paren) this.next(); else this.eat(Tk.Punct, Pn.Colon);
      if (key === Kw.Pattern) { constraint.pattern = this.eat(Tk.String).v; if (paren) this.eat(Tk.Punct, Pn.ParenR); continue; } // `pattern:"^\d{5}$"` — a regex string
      const num = Number(this.eat(Tk.Number).v);
      if (paren) this.eat(Tk.Punct, Pn.ParenR);
      if (key === Kw.Min) constraint.min = num; else constraint.max = num;
    }
    return constraint;
  }


  // The scalar type a literal initial reveals, for an untyped state (`= false` → bool). '' when it can't be inferred
  // (an object draft or `= null` — those still need an explicit `: type`). An array → 'list' (element synthesized in toDoc).
  protected inferType(v: Value | undefined): string {
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'text';
    if (Array.isArray(v)) return 'list';
    return '';
  }


  // `every 5s | 500ms | 2m` -> poll interval in milliseconds (for `query x every ...`).
  protected parseDuration(): number {
    const start = this.peek();
    const n = Number(this.eat(Tk.Number).v);
    const unit = this.eat(Tk.Ident).v;
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 0;
    if (!mult || !(n > 0)) throw new ParseError('`every` expects a positive duration like `5s`, `500ms`, or `2m`', this.locOf(start.pos));
    return n * mult;
  }


  // A bare class name, kebab-case included: `class(is-us when mine)`. CSS names its classes with hyphens, so stopping
  // at the first `-` («expected ident, got punct "-"») sent everyone to quote it. Only TOUCHING pieces join, so
  // nothing written with spaces changes meaning.
  protected className(): string {
    const first = this.eat(Tk.Ident);
    let end = first.end;
    while (this.peek().pos === end && (this.at(Tk.Ident) || this.at(Tk.Number) || this.at(Tk.Punct, Pn.Dash))) end = this.next().end;
    return this.source.slice(first.pos, end);
  }


  // IDENT optionally parameterized: `text` or `list<User>`.
  protected parseType(): string {
    let type = this.eat(Tk.Ident).v;
    if (this.at(Tk.Punct, Pn.Lt)) { this.next(); type += '<' + this.eat(Tk.Ident).v + '>'; this.eat(Tk.Punct, Pn.Gt); }
    if (this.at(Tk.Punct, Pn.Question)) throw new ParseError(`\`${type}?\` — muten has no nullable types and no \`null\`. Model "absent / nothing selected" with a bool flag + scalars instead: \`loggedIn = false : bool persist\` + \`userName = "" : text\`, shown with \`when loggedIn { … }\`.`, this.locOf(this.peek().pos));
    return type;
  }


  // `(ident)` — one identifier in parens (Chart kind/x/y/color); bare `ident` also accepted.
  protected parenIdent(): string {
    const paren = this.at(Tk.Punct, Pn.ParenL); if (paren) this.next();
    const v = this.eat(Tk.Ident).v;
    if (paren) this.eat(Tk.Punct, Pn.ParenR);
    return v;
  }


  // IDENT(.IDENT)* -> "cart.total". A `$param` head resolves at compose time.
  protected parseDotted(): string {
    let path = this.at(Tk.Param) ? '$' + this.next().v : this.eat(Tk.Ident).v;
    while (this.at(Tk.Punct, Pn.Dot)) { this.next(); path += '.' + this.eat(Tk.Ident).v; }
    return path;
  }


  // `where()` clause: raw tokens up to the next `,` or `)`, re-joined -> "role == admin".
  protected rebuildClause(): string {
    const parts: string[] = [];
    while (!this.at(Tk.Punct, Pn.Comma) && !this.at(Tk.Punct, Pn.ParenR)) parts.push(this.next().v);
    return parts.join(' ');
  }


  // `{ key: <read>, ... }`: keyed block; the reader handles each value (shared by mock/sources).
  protected parseEntries(read: (name: string) => void): void {
    this.eat(Tk.Punct, Pn.BraceL);
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const name = this.eat(Tk.Ident).v;
      this.eat(Tk.Punct, Pn.Colon);
      read(name);
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.BraceR);
  }


  // A URL path is a quoted string literal, interpolated like any other: `-> "/blog/{post.id}"`.
  // No path sub-grammar: any path (numbers, `:id` params, dashes) is just the string's text.
  protected parsePath(): string | Interp {
    return this.parseInterpolation(this.eat(Tk.String).v);
  }


  // `( key: value, ... )`: the args of a part instance or Custom inputs/on.
  // modifiers attach to the node, never inside another modifier's () — turn the JSX-props slip (`class("x" aria(…))`) into a message that teaches, not a cryptic "expected ident".
  protected nestGuard(name: string): void {
    if (this.at(Tk.Punct, Pn.ParenL)) throw new ParseError(`modifiers don't nest: \`${name}(…)\` attaches to the node, not inside another modifier's (). Write each as a sibling — e.g. \`Stack class(…) ${name}(…) { … }\`.`, this.locOf(this.peek().pos));
  }


  protected parseArgs(kebabKeys = false): ArgMap {
    this.eat(Tk.Punct, Pn.ParenL);
    const args: ArgMap = {};
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const key = kebabKeys ? this.className() : this.eat(Tk.Ident).v;   // `on(sl-change: rate)`: a DOM event name
      this.nestGuard(key);
      this.eat(Tk.Punct, Pn.Colon);
      args[key] = this.parseArgValue();
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return args;
  }


  // a component from npm takes any expression as a prop (`bg: on ? "brand" : "gray.300"`): kept in the plain forms when
  // it is one (a literal, a ref), so everything that reads args reads it as before, and as an expression otherwise
  protected parseForeignArgs(): ArgMap {
    this.eat(Tk.Punct, Pn.ParenL);
    const args: ArgMap = {};
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const key = this.eat(Tk.Ident).v;
      this.nestGuard(key);
      this.eat(Tk.Punct, Pn.Colon);
      const start = this.pos;
      const value = this.parseExpr();
      const simple = this.pos === start + 1;   // one token: a literal or a bare ref, read the plain way
      if (simple) { this.pos = start; args[key] = this.parseArgValue(); } else args[key] = { $expr: value };
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return args;
  }

  protected atBool(): boolean { return this.at(Tk.Ident, Kw.True) || this.at(Tk.Ident, Kw.False); }


  protected parseArgValue(): ArgValue {
    if (this.at(Tk.String)) {                                // quoted: literal, not a ref (compose keeps it as text)
      const t = this.next();                                 // …but `{…}` must interpolate here as in every other string
      const parsed = this.parseInterpolation(t.v, t.pos + 1);
      return typeof parsed === 'string' ? { $lit: parsed } : { $lit: t.v, $interp: parsed };
    }
    if (this.at(Tk.Number)) return Number(this.next().v);
    if (this.at(Tk.Punct, Pn.BraceL)) return { $expr: this.parseExpr() };   // `animate: { opacity: 1 }`: an object, for a component from npm
    if (this.atBool()) return this.next().v === Kw.True;     // `disabled: true` / `= false`: a literal, never a ref named «true»
    if (this.at(Tk.Ref)) return this.next().v;               // @state
    if (this.at(Tk.Param)) {                                 // $param (nested parts)
      const name = this.next().v;
      if (!this.at(Tk.Punct, Pn.Dot)) return { $param: name };
      // `Badge(label: $item.name)`: a field of a row param, forwarded as a path compose resolves (`$item.name` -> `r.name`).
      // It was a syntax error, so every part ended up taking the whole row just to show one field of it.
      let path = '$' + name;
      while (this.at(Tk.Punct, Pn.Dot)) { this.next(); path += '.' + this.eat(Tk.Ident).v; }
      return path;
    }
    return this.parseDotted();                                // bare ref / store action (cart.add) / enum
  }


  // `aria( key: <expr>, ... )`: each value is a full expression — a literal compiles to a static attribute,
  // a value that reads state compiles to a reactive effect (e.g. `aria(expanded: menuOpen)`).
  protected parseAriaArgs(): { [key: string]: Expr } {
    this.eat(Tk.Punct, Pn.ParenL);
    const out: { [key: string]: Expr } = {};
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const key = this.eat(Tk.Ident).v;
      this.nestGuard(key);
      this.eat(Tk.Punct, Pn.Colon);
      out[key] = this.parseExpr();
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return out;
  }


  // style(name: "value") — each key becomes a CSS custom property `--name`; the value is an interpolated string
  // (e.g. "{pct}%", "translateX({x}px)"). Only CSS variables: muten prepends `--`, so it can't set an arbitrary
  // property and compete with class()/Tailwind. The CSS reads it with `var(--name)`. Reactive when interpolated.
  protected parseStyleArgs(): { [name: string]: string | Interp } {
    this.eat(Tk.Punct, Pn.ParenL);
    const out: { [name: string]: string | Interp } = {};
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      const key = this.eat(Tk.Ident).v;
      this.nestGuard(key);
      this.eat(Tk.Punct, Pn.Colon);
      const t = this.eat(Tk.String);
      out[key] = this.parseInterpolation(t.v, t.pos + 1);
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return out;
  }

  // `( item, item, ... )` with a caller-supplied item reader (used by class/columns/where).
  protected parseParenList<T>(readItem: () => T): T[] {
    this.eat(Tk.Punct, Pn.ParenL);
    const items: T[] = [];
    while (!this.at(Tk.Punct, Pn.ParenR)) {
      items.push(readItem());
      if (this.at(Tk.Punct, Pn.Comma)) this.next();
    }
    this.eat(Tk.Punct, Pn.ParenR);
    return items;
  }
}
