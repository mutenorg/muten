// parse-actions: the behaviour half of a screen: `get` (a derived value, or one with parameters), `action` (typed
// params, `mutates`, its body, `failed { }`), and the statements a body is made of (list ops by method name, `if`,
// `post`/`put`/`delete` requests, calls to siblings, stores and `use`'d functions). Dispatch is a table.
import { ParseError } from '#engine/shared/diagnostics.js';
import { Readers } from '#engine/lang/readers.js';
import { Tk, Pn, Kw, StOp, Ek, NEW } from '#engine/shared/vocab.js';
import type { IR, Stmt, IfStmt, Expr, PartParam } from '#engine/shared/types.js';

export class ActionParser extends Readers {
  protected readonly statements: Map<string, (target: string) => Stmt>;    // action method -> parse the call into a Stmt

  constructor(source: string) {
    super(source);
    this.statements = new Map([
      [StOp.Push, (target: string): Stmt => ({ op: StOp.Push, target, arg: this.parseExpr() })],
      [StOp.Set, (target: string): Stmt => ({ op: StOp.Set, target, arg: this.parseExpr() })],
      [StOp.Reset, (target: string): Stmt => ({ op: StOp.Reset, target })],
      [StOp.Toggle, (target: string): Stmt => this.at(Tk.Punct, Pn.ParenR) ? { op: StOp.Toggle, target } : { op: StOp.Toggle, target, arg: this.parseExpr() }], // `open.toggle()` flips a bool; `favs.toggle(x)` toggles x's membership in a list<scalar>
      // remove/patch are NOT here: they parse inline as `remove where <cond>` / `patch where <cond> with { ... }` (no parens, item-implicit)
      [StOp.Create, (target: string): Stmt => ({ op: StOp.Create, target, arg: this.parseExpr() })], // POST to source
      [StOp.Update, (target: string): Stmt => ({ op: StOp.Update, target, arg: this.parseExpr() })], // PUT /:id
      [StOp.Delete, (target: string): Stmt => ({ op: StOp.Delete, target, arg: this.parseExpr() })], // DELETE /:id
      [StOp.Send, (target: string): Stmt => ({ op: StOp.Send, target, arg: this.parseExpr() })], // up the socket of a `query x live`
      [StOp.Refetch, (target: string): Stmt => { // refetch with N named query params: refetch(q: x, page: n)
        const params: { [k: string]: Expr } = {};
        while (!this.at(Tk.Punct, Pn.ParenR)) {
          const key = this.eat(Tk.Ident).v; this.eat(Tk.Punct, Pn.Colon); params[key] = this.parseExpr();
          if (this.at(Tk.Punct, Pn.Comma)) this.next();
        }
        return { op: StOp.Refetch, target, params };
      }],
    ]);
  }



  // `get <name> = <expr>`: a store derived/memoized value (compiles to a `computed`).
  protected parseGet(ir: IR): void {
    const head = this.eat(Tk.Ident, Kw.Get);
    const name = this.eat(Tk.Ident).v;
    if (this.at(Tk.Punct, Pn.ParenL)) {           // `get initials(name) = …`: a get that takes parameters
      this.next();
      const params: string[] = [];
      while (!this.at(Tk.Punct, Pn.ParenR)) {
        params.push(this.eat(Tk.Ident).v);
        if (this.at(Tk.Punct, Pn.Colon)) { this.next(); this.parseType(); }   // `name: text`: documentation only
        if (this.at(Tk.Punct, Pn.Comma)) this.next();
      }
      this.eat(Tk.Punct, Pn.ParenR);
      this.eat(Tk.Punct, Pn.Assign);
      (ir.fns = ir.fns || {})[name] = { params, body: this.parseExpr(), loc: this.locOf(head.pos) };
      return;
    }
    this.eat(Tk.Punct, Pn.Assign);
    (ir.gets = ir.gets || {})[name] = this.parseExpr();
    (ir.getLocs = ir.getLocs || {})[name] = this.locOf(head.pos);   // so a mistake in it is reported at its line
  }


  // `action <name>[(a: T, b: T)] mutates <targets> [<- <input>] { <statements> }`.
  // Mutation logic lives in the source, declared and bounded; the compiler only translates it.
  // Two parameter forms: multi-param `(a: T, b: T)` (typed, like a part) and legacy `<- input`.
  // They never combine: a `(...)` action reads its params; a `<- v` action reads its input.
  protected parseAction(ir: IR): void {
    this.eat(Tk.Ident, Kw.Action);
    const name = this.eat(Tk.Ident).v;
    let params: PartParam[] | undefined;   // optional typed params: `action f(a: T, b: T)`
    if (this.at(Tk.Punct, Pn.ParenL)) params = this.parseParenList(() => { const pn = this.eat(Tk.Ident).v; this.eat(Tk.Punct, Pn.Colon); return { name: pn, type: this.parseType() }; });
    if (this.at(Tk.Punct, Pn.Colon)) throw new ParseError(`action \`${name}\` declares a return type (\`: …\`) — muten actions cannot return a value, they only \`mutates\` state. Since \`${name}\` just derives a value from its inputs, make it a \`get\`, not an action — e.g. a detail page reads \`param pid\` then \`get match = store.items where id == pid\`. Drop the \`: Type\` and the \`return\`.`, this.locOf(this.peek().pos));
    const mutates: string[] = []; // a pure command (e.g. explicit `post`) may mutate nothing local
    if (this.at(Tk.Ident, Kw.Mutates)) {
      this.next();
      // `mutates` with no target (`action f mutates { … }`) is the classic slip: teach the two fixes instead of "expected ident".
      if (!this.at(Tk.Ident)) throw new ParseError(`\`mutates\` needs at least one state name (e.g. \`mutates users\`). If \`${name}\` changes no local state, drop \`mutates\` entirely: \`action ${name} { … }\`.`, this.locOf(this.peek().pos));
      mutates.push(this.eat(Tk.Ident).v);
      while (this.at(Tk.Punct, Pn.Comma)) { this.next(); mutates.push(this.eat(Tk.Ident).v); }
    }
    let input = '';               // optional legacy input parameter (`<- item`)
    if (this.at(Tk.LArrow)) { this.next(); input = this.eat(Tk.Ident).v; }
    const body = this.parseActionBody();
    // `} failed { … }`: what the action does when a request in it fails (it used to be only `name.error`, read elsewhere)
    const failed = this.at(Tk.Ident, Kw.Failed) ? (this.next(), this.parseActionBody()) : undefined;
    ir.actions[name] = { mutates, input, params, body, ...(failed ? { failed } : {}) };
  }


  // `{ statement* }`: an action body or an `if` branch; each statement is a declared mutation.
  protected parseActionBody(): Stmt[] {
    this.eat(Tk.Punct, Pn.BraceL);
    const body: Stmt[] = [];
    while (!this.at(Tk.Punct, Pn.BraceR)) body.push(this.parseStatement());
    this.eat(Tk.Punct, Pn.BraceR);
    return body;
  }


  // `if <expr> { ... } [else { ... }]`: the only branching inside an action (toggles, validation, add-or-remove).
  protected parseIf(): IfStmt {
    this.eat(Tk.Ident, Kw.If);
    const cond = this.parseExpr();
    const then = this.parseActionBody();
    const otherwise = this.at(Tk.Ident, Kw.Else) ? (this.next(), this.parseActionBody()) : null;
    return { op: StOp.If, cond, then, else: otherwise };
  }


  // A statement: an `if` block, or `target.method(args)` dispatched through the `statements` table.
  // Explicit non-REST request (escape hatch): `post "client:/path" body expr` or `delete "client:/path"`.
  protected parseRequest(): Stmt {
    const method = this.eat(Tk.Ident).v.toUpperCase();
    const ut = this.eat(Tk.String); const url = this.parseInterpolation(ut.v, ut.pos + 1);
    let body: Expr | null = null;
    if (this.at(Tk.Ident, Kw.Body)) { this.next(); body = this.parseExpr(); }
    // optional `into <state>`: capture the JSON response (e.g. an order id / confirmation code) into a local state.
    let into: string | undefined;
    if (this.at(Tk.Ident, Kw.Into)) { this.next(); into = this.eat(Tk.Ident).v; }
    return { op: StOp.Request, method, url, body, into };
  }


  // does a `.step` come right after the `(…)` being read (the parser stands just inside it)?
  private chainFollows(): boolean {
    let depth = 1;
    for (let at = this.pos; at < this.toks.length; at++) {
      const token = this.toks[at];
      if (token.t !== Tk.Punct) continue;
      if (token.v === Pn.ParenL) depth++;
      else if (token.v === Pn.ParenR && --depth === 0) { const after = this.toks[at + 1]; return !!after && after.t === Tk.Punct && after.v === Pn.Dot; }
    }
    return false;
  }

  // a call made for what it does, with the steps after it: `confetti()`, `db.from("orders").insert(row)`
  private externStatement(fn: string, args: Expr[]): Stmt {
    const chain = this.chainSteps();
    return chain.length ? { op: StOp.Extern, fn, args, chain } : { op: StOp.Extern, fn, args };
  }

  protected parseStatement(): Stmt {
    const pos = this.peek().pos;            // first token's position, so action-body diagnostics land on the right line
    const st = this.parseStatementInner();
    st.loc = this.locOf(pos);
    return st;
  }

  protected parseStatementInner(): Stmt {
    if (this.at(Tk.Ident, Kw.If)) return this.parseIf();
    if (this.at(Tk.Ident, 'post') || this.at(Tk.Ident, 'put') || this.at(Tk.Ident, 'delete')) return this.parseRequest();
    if (this.at(Tk.Ident, 'let') || this.at(Tk.Ident, 'const') || this.at(Tk.Ident, 'var')) { const kw = this.peek().v; const nx = this.toks[this.pos + 1]; const vn = nx ? nx.v : 'x'; throw new ParseError(`\`${kw} ${vn} = …\` — muten actions have no \`${kw}\`/local variables. Make \`${vn}\` a \`get\` (declared outside the action), or inline its value where it's used. To bump-or-add (e.g. a cart): \`if (items.count where id == x) > 0 { items.patch where id == x with { … } } else { items.push({ … }) }\`.`, this.locOf(this.peek().pos)); }
    if (this.at(Tk.Ident, NEW)) {   // `new Chart("sales", { … })`: a package's class, made for what it does
      const made = this.parseExpr();
      if (made.kind !== Ek.Call) throw new ParseError('`new` makes a class a package exports, with its values: `new Chart("sales", { … })`', this.locOf(this.peek().pos));
      return { op: StOp.Extern, fn: made.fn, args: made.args, ...(made.chain ? { chain: made.chain } : {}), ctor: true };
    }
    const target = this.eat(Tk.Ident).v;
    if (this.at(Tk.Punct, Pn.ParenL)) { // `fn(args)`: call a use'd function as a side-effect statement (validate checks fn is declared)
      this.next();
      return this.externStatement(target, this.callArgs());
    }
    this.eat(Tk.Punct, Pn.Dot);
    let method = this.eat(Tk.Ident).v;
    // `posthog.people.set(…)` / `db.from("orders").insert(row)`: a package's own API as a statement (validate checks
    // the head was `use`d). One dot and nothing after the call stays a store action or a built-in op, as always.
    while (this.at(Tk.Punct, Pn.Dot)) { this.next(); method += '.' + this.eat(Tk.Ident).v; }
    if (method.includes('.')) { this.eat(Tk.Punct, Pn.ParenL); return this.externStatement(`${target}.${method}`, this.callArgs()); }
    // Lambda-free predicate mutation (the ONLY form): `tasks.remove where id == x` / `tasks.patch where id == x with { ... }`
    if (method === StOp.Remove || method === StOp.Patch) {
      if (!this.at(Tk.Ident, Kw.Where)) throw new ParseError(`\`${method}\` takes a \`where <cond>\` predicate now, not a \`(x => …)\` lambda — write \`${target}.${method} where <cond>\`${method === StOp.Patch ? ' with { … }' : ''} (item fields read bare)`, this.locOf(this.peek().pos));
      this.next();
      const pred = this.parseExpr();
      if (method === StOp.Patch) { this.eat(Tk.Ident, Kw.With); return { op: StOp.Patch, target, pred, patch: this.parseExpr() }; }
      return { op: StOp.Remove, target, pred };
    }
    this.eat(Tk.Punct, Pn.ParenL);
    // `elements.create("payment").mount("#pay")`: a call followed by more steps is a package's API, even when its name is
    // one of muten's own ops (create, update, delete, set…)
    const build = this.chainFollows() ? undefined : this.statements.get(method);
    if (!build) { // not a built-in op: a store-action call `shop.add(draft)` (validate confirms target is a store)
      const args = this.callArgs();
      if (this.at(Tk.Punct, Pn.Dot)) return this.externStatement(`${target}.${method}`, args);   // `db.from("x").delete()`
      return { op: StOp.Call, target, method, args };
    }
    const stmt = build(target);
    this.eat(Tk.Punct, Pn.ParenR);
    return stmt;
  }
}
