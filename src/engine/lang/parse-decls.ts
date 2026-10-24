// parse-decls: the top-level declarations of a screen that are data, not tree: `entity` (fields + constraints),
// `state`/`store` (types inferred from a literal when left out), `mock`, `sources`, `api`, `meta`, `routes`
// (paths, guards, layouts), `const`, `theme`, and `use element|widget|react` (a component from npm).
import { ParseError } from '#engine/shared/diagnostics.js';
import { ActionParser } from '#engine/lang/parse-actions.js';
import { Tk, Pn, Kw, Ek, UseKind, THEME_PRESET, THEME_WITH, THEME_MODE, THEME_TOKENS, THEME_LIBRARY } from '#engine/shared/vocab.js';
import type { IR, Value, Entity, FieldType, EntityConstraints, StateDef, Route, ThemeScale, CallExpr, Expr, ImportDef } from '#engine/shared/types.js';

const mapFieldType = (raw: string): FieldType => (raw === 'text' ? 'string' : raw); // `text` is the user-facing alias for `string`
/** Where the parameter list that opens `raw` closes. */
function closingParen(raw: string): number {
  let depth = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === Pn.ParenL) depth++;
    else if (raw[index] === Pn.ParenR && !--depth) return index;
  }
  return raw.length;
}

/** `p: Product, rate?: number, n = 1`: each parameter's name, and whether it may be left out. */
function splitParams(list: string): Array<{ name: string; optional: boolean }> {
  const out: Array<{ name: string; optional: boolean }> = [];
  let depth = 0, piece = '';
  for (const char of list + ',') {
    if ('(<[{'.includes(char)) depth++;
    else if (')>]}'.includes(char)) depth--;
    if (char === ',' && !depth) {
      const match = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(\?)?/.exec(piece);
      if (match) out.push({ name: match[1], optional: Boolean(match[2]) || piece.includes('=') || piece.trim().startsWith('...') });
      piece = '';
    } else piece += char;
  }
  return out;
}

// the word after `use` -> the kind of component it brings in (a table, so no string is ever cast to the enum)
const USE_KIND = new Map<string, UseKind>(Object.values(UseKind).map((kind) => [kind, kind]));

export class DeclParser extends ActionParser {
  protected readonly foreign = new Set<string>();                         // components a `use element|widget|react` brought in
  // what a plain `use` brought in, by name: one written where an element goes (`HeldAccordion(…)`) is a component
  protected readonly plainUses = new Map<string, { def: ImportDef; list: ImportDef[] }>();

  /** `use HeldAccordion from "…"` with no kind, then `HeldAccordion(…)` where an element goes: a React component, told
   *  by how it is used. (By its name alone it cannot be: `use Chart from "chart.js/auto"` is a class, `new Chart(…)`.)
   *  Its name moves to an import of its own with that kind; the rest of the line stays functions. */
  protected adoptComponent(name: string): boolean {
    const plain = this.plainUses.get(name);
    if (!plain) return false;
    this.plainUses.delete(name);
    plain.def.names = plain.def.names.filter((one) => one !== name);
    if (!plain.def.names.length) plain.list.splice(plain.list.indexOf(plain.def), 1);
    plain.list.push({ names: [name], from: plain.def.from, kind: UseKind.React, ...(plain.def.loc ? { loc: plain.def.loc } : {}) });
    this.foreign.add(name);
    return true;
  }



  // ── declarations ─────────────────────────────────────────────────────────────

  // entity User { name text required  role admin | member  password text min:8 }
  // A data shape + its validation contract. Every entity gets an implicit `id uuid`.
  // `use element Rating "sl-rating" from "…"` · `use widget Map from "…"` · `use react DayPicker from "…"`: a UI component
  // from npm, used like a part (`Rating(value: stars) on(sl-change: rate)`). False when this `use` imports functions.
  protected parseForeignUse(ir: IR): boolean {
    const word = this.peek(); const next = this.toks[this.pos + 1];
    const kind = word.t === Tk.Ident ? USE_KIND.get(word.v) : undefined;
    if (!kind || !next || next.t !== Tk.Ident || next.v === Kw.From) return false;
    this.next();
    const names = [this.eat(Tk.Ident).v];
    // `use react LineChart, Line, XAxis from "recharts"`: a library's parts, composed together
    while (kind === UseKind.React && this.at(Tk.Punct, Pn.Comma)) { this.next(); names.push(this.eat(Tk.Ident).v); }
    const tag = kind === UseKind.Element ? this.eat(Tk.String).v : undefined;
    this.eat(Tk.Ident, Kw.From);
    const from = this.eat(Tk.String).v;
    (ir.imports = ir.imports || []).push(tag ? { names, from, kind, tag } : { names, from, kind });
    for (const name of names) this.foreign.add(name);
    return true;
  }


  // `fn finalPrice(p: Product, rate?: number): number { … }`: the lexer hands the signature and body over as one raw
  // token (lexer.ts); what muten needs of it is the name and how it is called, the rest is TypeScript's.
  protected parseFn(ir: IR): void {
    const loc = this.locOf(this.next().pos);
    const name = this.eat(Tk.Ident).v;
    const raw = this.eat(Tk.Raw).v;
    const params = splitParams(raw.slice(1, closingParen(raw)));
    (ir.tsFns = ir.tsFns || {})[name] = { params: params.map((param) => param.name), required: params.filter((param) => !param.optional).length, source: `function ${name}${raw}`, loc };
  }

  protected parseEntity(ir: IR): void {
    this.eat(Tk.Ident, Kw.Entity);
    const name = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.BraceL);
    const fields: Entity = { id: 'uuid' };
    const constraints: EntityConstraints = {};
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const fieldName = this.eat(Tk.Ident).v;
      let head = this.eat(Tk.Ident).v;
      // `features list<text>` — a field holding a list of scalars (feature bullets, tags, categories). muten values
      // already support list<scalar>; letting an entity FIELD be one spares the model the cryptic `expected ident, got "<"`.
      if (head === 'list' && this.at(Tk.Punct, Pn.Lt)) { this.next(); const elem = this.eat(Tk.Ident).v; this.eat(Tk.Punct, Pn.Gt); head = `list<${mapFieldType(elem)}>`; }
      const options = [head];                                                  // type, then any `| enum` alternatives
      // `today "Hoy" | tomorrow "Mañana"`: an enum value with the words it shows. Labelled when the first one is (a string
      // then `|`), so `delivery today | tomorrow "Entrega"` still reads "Entrega" as the FIELD's label, not tomorrow's.
      const choices: { [value: string]: string } = {};
      const labelled = this.at(Tk.String) && this.toks[this.pos + 1]?.t === Tk.Punct && this.toks[this.pos + 1]?.v === Pn.Pipe;
      if (labelled) choices[head] = this.next().v;
      while (this.at(Tk.Punct, Pn.Pipe)) { this.next(); const value = this.eat(Tk.Ident).v; options.push(value); if (labelled && this.at(Tk.String)) choices[value] = this.next().v; }
      fields[fieldName] = options.length > 1 ? 'enum:' + options.join('|') : (head.startsWith('list<') ? head : mapFieldType(options[0]));
      const constraint = this.parseConstraints();                              // optional constraints: required, min:N, max:N
      if (this.at(Tk.String)) constraint.label = this.next().v;                // `customer text required "Nombre"`: what a Form calls it
      if (Object.keys(choices).length) constraint.choices = choices;
      if (Object.keys(constraint).length) constraints[fieldName] = constraint;
    }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.entities[name] = fields;
    if (Object.keys(constraints).length) (ir.constraints = ir.constraints || {})[name] = constraints;
  }


  // state { } (page-local) and store { } (app-global) share one grammar: `name = <initial|query> : <type>`
  // `live db.channel("x").on("postgres_changes", {…}, change).subscribe()`: what keeps a state up to date, written as the
  // package documents it, with `change` where its callback goes. A bare `live` (a socket, a callback-last function) is
  // not a feed: after it comes the next state (`name =`), the type, or the end.
  private liveFeed(): Expr | undefined {
    const after = this.toks[this.pos + 2];
    if (!this.at(Tk.Ident, Kw.Live) || this.toks[this.pos + 1]?.t !== Tk.Ident || !after || after.t !== Tk.Punct || (after.v !== Pn.Dot && after.v !== Pn.ParenL)) return undefined;
    this.next();
    return this.parseExpr();
  }

  protected parseState(keyword: Kw, target: { [name: string]: StateDef }): void {
    this.eat(Tk.Ident, keyword);
    this.eat(Tk.Punct, Pn.BraceL);
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const nameTok = this.eat(Tk.Ident);
      this.eat(Tk.Punct, Pn.Assign);
      let source: string | undefined;
      let refresh: number | undefined;
      let live: boolean | undefined;
      let call: CallExpr | undefined;
      let feed: Expr | undefined;
      let initial: Value | undefined;
      let hasInitial = false;
      if (this.at(Tk.Ident, Kw.Query)) { this.next(); let from = this.eat(Tk.Ident).v; while (this.at(Tk.Punct, Pn.Dot)) { this.next(); from += '.' + this.eat(Tk.Ident).v; } source = 'query:' + from; if (this.at(Tk.Punct, Pn.ParenL)) { this.next(); const args = this.callArgs(); const chain = this.chainSteps(); call = chain.length ? { kind: Ek.Call, fn: from, args, chain } : { kind: Ek.Call, fn: from, args }; } feed = this.liveFeed(); if (!feed && this.at(Tk.Ident, Kw.Live)) { this.next(); live = true; } else if (this.at(Tk.Ident, Kw.Every)) { this.next(); refresh = this.parseDuration(); } } // `query x live` -> WebSocket; `every Ns` -> poll
      else if (this.at(Tk.Punct, Pn.BraceL) || this.at(Tk.Punct, Pn.BrackL)) { initial = this.parseValue(); hasInitial = true; }
      else if (this.at(Tk.String)) { initial = this.next().v; hasInitial = true; }
      else if (this.at(Tk.Number)) { initial = Number(this.next().v); hasInitial = true; }
      else if (this.at(Tk.Ident, Kw.True) || this.at(Tk.Ident, Kw.False)) { initial = this.next().v === Kw.True; hasInitial = true; }
      else if (this.at(Tk.Ident, 'null')) { this.next(); hasInitial = true; }                    // `= null` → initial stays undefined → genState emits signal(null), NOT the string "null"
      else { initial = this.next().v; hasInitial = true; }                                       // bare enum value
      // `: type` is OPTIONAL when a literal initial reveals it (`x = false` → bool, `q = ""` → text, `n = 0` → number,
      // `cards = [ … ]` → list). Only a query / `= null` / an object draft still needs the annotation. Same "infer, don't
      // demand a redundant declaration" as list shapes — spares the model the cryptic `expected ":", got "}"`.
      let type: string;
      if (this.at(Tk.Punct, Pn.Colon)) { this.next(); type = this.parseType(); }
      else {
        const inferred = source ? '' : this.inferType(hasInitial ? initial : undefined);
        if (call) type = '';   // `query lookup(q)`: the function's own types say what it gives back (npm-types.ts)
        else if (!inferred) throw new ParseError(`state "${nameTok.v}" needs a type — write \`${nameTok.v} = <value> : text|number|bool|list<T>\`${source ? ' (a query returns a list: `: list<T>`)' : ''}.`, this.locOf(this.peek().pos));
        else type = inferred;
      }
      feed = feed ?? this.liveFeed();   // `messages = [] : list<Msg> live socket.on("message", change)`
      const persist = this.at(Tk.Ident, Kw.Persist) ? (this.next(), true) : undefined; // `: T persist` -> localStorage-backed
      const loc = this.locOf(nameTok.pos);
      const fed = feed ? { feed } : {};
      target[nameTok.v] = source ? { type, source, refresh, live, persist, loc, ...(call ? { call } : {}), ...fed } : { type, initial: hasInitial ? initial : null, persist, loc, ...fed };
    }
    this.eat(Tk.Punct, Pn.BraceR);
  }


  // mock { query: <value>, ... }: inline test data. sources { query: "url" | { url, at } }: real endpoints.
  protected parseMock(ir: IR): void {
    this.eat(Tk.Ident, Kw.Mock);
    const mock: { [name: string]: Value } = ir.mock || {};
    this.parseEntries((name) => { mock[name] = this.parseValue(); });
    ir.mock = mock;
  }

  protected parseSources(ir: IR): void {
    this.eat(Tk.Ident, Kw.Sources);
    const sources: { [name: string]: Value } = ir.sources || {};
    this.parseEntries((name) => { sources[name] = this.parseValue(); });
    ir.sources = sources;
  }

  // App-wide backend config: `api { base: "..." headers: { ... } }` (in app.muten). Applied to every `sources`.
  protected parseApi(ir: IR): void {
    this.eat(Tk.Ident, Kw.Api);
    const api: { [name: string]: Value } = ir.api || {};
    this.parseEntries((name) => { api[name] = this.parseValue(); });
    ir.api = api;
  }

  // `meta { title "..." description "..." }` -> `<title>` + `<meta>` tags (og:* auto-derived).
  protected parseMeta(ir: IR): void {
    this.eat(Tk.Ident, Kw.Meta);
    this.eat(Tk.Punct, Pn.BraceL);
    const meta: { [k: string]: string } = ir.meta || {};
    while (!this.at(Tk.Punct, Pn.BraceR)) { const key = this.eat(Tk.Ident).v; meta[key] = this.eat(Tk.String).v; }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.meta = meta;
  }


  // `routes { "/url" -> page [in layout | without layout] [guard [not] store.flag else "/redirect"] }`: the app root.
  protected parseRoutes(ir: IR): void {
    this.eat(Tk.Ident, Kw.Routes);
    this.eat(Tk.Punct, Pn.BraceL);
    const routes: Route[] = ir.routes || [];
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const start = this.peek();
      const url = this.eat(Tk.String).v;             // path is a quoted string literal (no path sub-grammar)
      this.eat(Tk.Arrow);
      const route: Route = { url, page: this.eat(Tk.Ident).v, loc: this.locOf(start.pos) };
      if (this.at(Tk.Ident, Kw.In)) { this.next(); route.layout = this.eat(Tk.Ident).v; } // `in pro`: mount inside that layout
      if (this.at(Tk.Ident, Kw.Without)) { this.next(); route.without = this.eat(Tk.Ident).v; } // `without site`: not in the default layout
      if (this.at(Tk.Ident, Kw.Guard)) {             // `guard <expr> else "/redirect"`
        this.next();
        route.guard = this.parseExpr();              // `auth.signedIn and not auth.blocked` (it was ONE ref: a second flag needed a get)
        this.eat(Tk.Ident, Kw.Else);
        route.redirect = this.eat(Tk.String).v;
      }
      routes.push(route);
    }
    this.eat(Tk.Punct, Pn.BraceR);
    ir.routes = routes;
  }


  // `const NAME = <scalar>`: compile-time immutable, inlined at build. Scalars only: structured
  // config uses a block (e.g. `theme { ... }`), so Muten never needs a JS-style object literal.
  protected parseConst(ir: IR): void {
    this.eat(Tk.Ident, Kw.Const);
    const name = this.eat(Tk.Ident).v;
    this.eat(Tk.Punct, Pn.Assign);
    if (this.at(Tk.Punct, Pn.BraceL) || this.at(Tk.Punct, Pn.BrackL)) {
      throw new ParseError('const holds a single value (string/number/bool) — use a block like `theme { … }` for structured data', this.locOf(this.peek().pos));
    }
    (ir.consts = ir.consts || {})[name] = this.parseScalar();
  }


  // `theme { space { md "16px" ... }  breakpoints { md "768px" ... } }`: project token scale.
  // No CSS here (that lives in the stylesheet); the build plugin reads this for token values.
  // `theme [library] { … }`. Named after a library (`theme shadcn { … }`), the theme connects it: its stylesheet, its
  // parts and its token names, so one file says the whole look. Inside:
  //   preset noir · with nova, kit · mode light|dark       which of the library's looks, extras and default scheme
  //   primary "#6B46F2"                                     a token by its own name (the library's, or a CSS var of yours)
  //   colors { sec1 "#BFDCF7" }  dark { primary "…" }       a scale of tokens, or the tokens of one scheme
  // a theme key as the library names it: `primary-foreground`, `chart-1`, `shadow-2xs` (the pieces written together,
  // no space between them, are one name), or quoted, `"base-100"`
  private themeKey(): string {
    if (this.at(Tk.String)) return this.next().v;
    let key = this.eat(Tk.Ident).v;
    let end = this.toks[this.pos - 1].pos + key.length;
    const glued = (): boolean => { const token = this.peek(); return token.pos === end && (token.t === Tk.Ident || token.t === Tk.Number || (token.t === Tk.Punct && token.v === Pn.Dash)); };
    while (glued()) { const piece = this.next(); key += piece.v; end = piece.pos + piece.v.length; }
    return key;
  }

  protected parseTheme(ir: IR): void {
    this.eat(Tk.Ident, Kw.Theme);
    const theme: { [scale: string]: ThemeScale } = {};
    const library: ThemeScale = {};
    if (this.at(Tk.Ident)) library.name = this.next().v;
    this.eat(Tk.Punct, Pn.BraceL);
    const word = (): string => (this.at(Tk.String) ? this.next().v : this.eat(Tk.Ident).v);
    const tokens: ThemeScale = {};
    while (!this.at(Tk.Punct, Pn.BraceR)) {
      const key = this.themeKey();
      if (key === THEME_PRESET) library.preset = word();
      else if (key === THEME_WITH) { const extras = [word()]; while (this.at(Tk.Punct, Pn.Comma)) { this.next(); extras.push(word()); } library.with = extras.join(','); }
      else if (key === THEME_MODE) (theme.scheme ||= {}).mode = word();
      else if (this.at(Tk.Punct, Pn.BraceL)) {                                     // a scale: space { md "16px" }
        this.next();
        const steps: ThemeScale = {};
        while (!this.at(Tk.Punct, Pn.BraceR)) steps[this.themeKey()] = this.eat(Tk.String).v;
        this.eat(Tk.Punct, Pn.BraceR);
        theme[key] = { ...(theme[key] || {}), ...steps };
      } else tokens[key] = this.eat(Tk.String).v;                                  // a token by its own name
    }
    this.eat(Tk.Punct, Pn.BraceR);
    if (Object.keys(tokens).length) theme[THEME_TOKENS] = tokens;
    if (Object.keys(library).length) theme[THEME_LIBRARY] = library;
    ir.theme = theme;
  }

}
