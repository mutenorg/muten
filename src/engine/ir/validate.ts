// validate: structured diagnostics over the flat Doc.
// Knows the whole vocabulary (types, tokens, state, ops, parts) and each-item scope, so every
// error is specific and suggests the closest candidate. The same Doc that compiles is validated,
// so the editor and build never disagree. Used by the live linter, `muten lint`, and the runner.

import { diag, closest } from '#engine/shared/diagnostics.js';
import { PRIMITIVE_NAMES, ACTION_OPS, PRIMITIVES, BUILTINS, RESERVED_NAMES } from '#engine/lang/manifest.js';
import { Nt, Ek, StOp, BOp, CHART_KINDS, SVG_PRIMS } from '#engine/shared/vocab.js';
import { exprListType, isKnownHead, selfUpdateTargets, type RefFacts, type KnownHeads } from '#engine/ir/refs.js';
import type { Doc, FlatNode, ValidateCtx, ValidateResult, Diagnostic, Expr, Stmt, RequestStmt, StringPropValue, Loc } from '#engine/shared/types.js';

const KNOWN_TYPES = new Set<string>([...PRIMITIVE_NAMES, Nt.Shell, Nt.Slot]); // manifest primitives + Shell wrapper (app.muten root) + Slot (part children outlet; composed away before flatten)
const REF_PROPS: Array<'bind' | 'data'> = ['bind', 'data']; // props whose value is @state
const KNOWN_OPS = new Set<string>([...ACTION_OPS, StOp.Request]); // Request is parsed + compiled but is not a method op
const SOURCE_OPS = new Set<string>([StOp.Create, StOp.Update, StOp.Delete, StOp.Refetch]); // hit the backend, so the list MUST be query/source-backed
const SCALARS = ['text', 'number', 'bool', 'uuid', 'email', 'string', 'date', 'password', 'textarea'];
const STRINGY = ['text', 'string', 'email', 'uuid', 'date', 'password', 'textarea']; // string-backed scalars: expose `.length` (a text value's character count) for reactive length gates
const DISABLEABLE = new Set<string>([Nt.Button, Nt.RowAction, Nt.SearchField, Nt.Password, Nt.Select, Nt.Checkbox, Nt.Number, Nt.Range, Nt.Date, Nt.Form]); // `disabled` only affects form controls
// native primitives that share a name with common plugin (shadcn) parts → a part-style call resolves to the
// primitive and trips `missing-prop`; the value is the native usage to point the AI at.
const SHADOWED_PRIMITIVE: { readonly [k: string]: string } = { [Nt.Select]: 'Select bind(x) options(a, b)', [Nt.Checkbox]: 'Checkbox bind(ok)', [Nt.Number]: 'Number bind(n)', [Nt.Range]: 'Range bind(v) min(0) max(100)', [Nt.Date]: 'Date bind(d)', [Nt.Chart]: 'Chart @data kind(bar) x(field) y(field)' };
const FIELD_TYPES = ['text', 'string', 'email', 'number', 'bool', 'date', 'password', 'textarea', 'uuid']; // valid entity-field types a Form renders; an unknown one degrades to a text input, so the oracle flags it

// collect the variable names referenced by an expression AST
function collectRefs(e: Expr, acc: string[] = []): string[] {
  switch (e.kind) {
    case Ek.Ref: acc.push(e.name); break;
    case Ek.Un: collectRefs(e.operand, acc); break;
    case Ek.Bin: collectRefs(e.left, acc); collectRefs(e.right, acc); break;
    case Ek.Tern: collectRefs(e.cond, acc); collectRefs(e.then, acc); collectRefs(e.else, acc); break;
    case Ek.Call: for (const a of e.args) collectRefs(a, acc); break; // args' refs; the fn is checked separately
    case Ek.Obj: for (const f of e.fields) collectRefs(f.value, acc); break;
    case Ek.Agg: acc.push(e.list); break;    // outer list ref; body fields are item-implicit, checked separately
    case Ek.Filter: acc.push(e.list); break; // outer list ref; cond's bare fields are item-implicit, checked separately
  }
  return acc;
}

// collect the names of `use`'d functions called in an expression (the fn of each call, recursively)
function collectCalls(e: Expr, acc: string[] = []): string[] {
  switch (e.kind) {
    case Ek.Call: acc.push(e.fn); for (const a of e.args) collectCalls(a, acc); break;
    case Ek.Un: collectCalls(e.operand, acc); break;
    case Ek.Bin: collectCalls(e.left, acc); collectCalls(e.right, acc); break;
    case Ek.Tern: collectCalls(e.cond, acc); collectCalls(e.then, acc); collectCalls(e.else, acc); break;
    case Ek.Obj: for (const f of e.fields) collectCalls(f.value, acc); break;
    case Ek.Filter: collectCalls(e.cond, acc); break; // the cond may call use'd functions too
  }
  return acc;
}

// ctx.parts = known part names in the project (to suggest and validate instances)
export function validate(doc: Doc, ctx: ValidateCtx = {}): ValidateResult {
  const D: Diagnostic[] = [];

  const stateKeys = new Set(Object.keys(doc.state || {}));
  const storeDomains = new Set(ctx.stores || []); // app-global store slices (cart.total, cart.add)
  const constNames = new Set(Object.keys(doc.consts || {})); // compile-time constants
  const paramNames = new Set(doc.params || []);              // route params (`param id`)
  const actionNames = new Set(Object.keys(doc.actions || {})); // needed for `action.pending` / `action.error` refs
  const getNames = new Set(Object.keys(doc.gets || {})); // derived values, referenceable like state (page or store)
  const externs = new Set([...BUILTINS, ...(doc.imports || []).flatMap((i) => i.names)]); // built-in formatting fns + use'd logic functions, callable in exprs
  // the SHARED resolver's inputs — the SAME facts the emitter holds, so lint and runtime can't disagree on what resolves.
  const refFacts: RefFacts = { state: doc.state || {}, gets: doc.gets || {}, entities: doc.entities || {}, storeEntities: ctx.storeEntities };
  const knownHeads: KnownHeads = { stateKeys, gets: getNames, stores: storeDomains, consts: constNames, routeParams: paramNames, actions: actionNames };
  // `post/put/delete "client:/path"` selects a NAMED api client; an unknown prefix silently 404s at runtime
  // (the `post "default:/x"` footgun). Checked only when the app's clients were threaded in (ctx.apiClients).
  const checkReqUrl = (st: RequestStmt & { loc?: Loc }): void => {
    if (!ctx.apiClients) return;
    const lead = typeof st.url === 'string' ? st.url : (typeof st.url.parts[0] === 'string' ? st.url.parts[0] : '');
    const m = lead.match(/^([a-zA-Z][\w-]*):/);
    if (!m || m[1] === 'http' || m[1] === 'https') return;             // no `client:` prefix, or an absolute URL
    const client = m[1];
    if (ctx.apiClients.includes(client)) return;                       // a declared client — fine
    const tip = ctx.apiClients.length
      ? `declared clients are: ${ctx.apiClients.join(', ')}`
      : `the flat \`api { base }\` form has no named clients — drop the \`${client}:\` prefix (write \`${st.method} "${lead.slice(client.length + 1)}…"\`)`;
    D.push(diag('unknown-client', `${st.method} "${lead}…": "${client}" is not a declared api client — ${tip}.`, { loc: st.loc ?? null, suggestion: ctx.apiClients.length ? closest(client, ctx.apiClients) : null, from: client }));
  };
  const nodes = doc.nodes || {};

  // `meta { title "…" }` values are STATIC strings — the runtime `applyMeta` sets them verbatim (no interpolation).
  // A `{expr}` here used to lint clean and then ship literal braces into `<title>` (lint ≠ runtime). Reject it, so
  // the promise holds; a per-item title (`{product.name}`) isn't expressible in meta today (documented in seo.md).
  for (const [key, val] of Object.entries(doc.meta || {}))
    if (typeof val === 'string' && /\{[^}]+\}/.test(val))
      D.push(diag('meta-static', `meta ${key} "${val}" contains \`{…}\` — meta values are STATIC strings and do NOT interpolate (the runtime would ship the literal braces into <head>). Use a fixed string; a per-item/dynamic <title> isn't supported in \`meta\` yet.`, { loc: null, from: val }));

  // Reserved-name collision: a state/get/action named like a runtime / data-layer / builtin identifier compiles
  // to a duplicate `const` in the SAME scope (emit.ts dataLayer injects `query`, the BUILTINS, etc. alongside the
  // state consts) → `SyntaxError: Identifier already declared`, a BLANK page that lints green. Reject with a rename.
  const RESERVED = new Set(RESERVED_NAMES);
  const checkReserved = (name: string, kind: 'state' | 'get' | 'action', loc: Loc | null): void => {
    if (!RESERVED.has(name) && !name.startsWith('__')) return;
    const why = name.startsWith('__') ? 'the `__` prefix is reserved for runtime internals' : BUILTINS.includes(name) ? `"${name}" is a built-in formatting function` : `"${name}" is a runtime function`;
    D.push(diag('reserved-name', `${kind} "${name}" collides with a built-in runtime name (${why}) — it compiles to a duplicate declaration and blanks the page. Rename it, e.g. "${name}Value".`, { loc, from: name }));
  };
  for (const [name, def] of Object.entries(doc.state || {})) checkReserved(name, 'state', def.loc ?? null);
  for (const name of Object.keys(doc.gets || {})) checkReserved(name, 'get', null);
  for (const [name, a] of Object.entries(doc.actions || {})) checkReserved(name, 'action', a.body?.[0]?.loc ?? null);

  // a `use`'d function call must reference a declared import: keeps the JS seam bounded and checkable
  const checkCalls = (expr: Expr, loc?: Loc | null): void => {
    for (const fn of collectCalls(expr)) {
      if (!externs.has(fn)) D.push(diag('unknown-function', `"${fn}" is not a use'd function`, { loc, suggestion: closest(fn, [...externs]), from: fn }));
    }
  };

  // Closed member sets catch typos in a dotted ref. A query state exposes {loading,error,data} plus (if
  // entity-typed) its fields; a store exposes its state/gets/actions (threaded in by lintApp, cross-file).
  const queryMembers = new Map<string, Set<string>>();
  for (const [name, def] of Object.entries(doc.state || {})) {
    if (!def.source?.startsWith('query:')) continue;
    const allowed = new Set(['loading', 'error', 'data']);
    const entity = doc.entities?.[def.type];
    if (entity) { allowed.add('id'); for (const f of Object.keys(entity)) allowed.add(f); }
    queryMembers.set(name, allowed);
  }
  const storeMemberMap = new Map<string, Set<string>>();
  for (const [d, ms] of Object.entries(ctx.storeMembers || {})) storeMemberMap.set(d, new Set(ms));
  const checkMember = (head: string, member: string, loc: Loc | null): void => {
    const q = queryMembers.get(head);
    if (q) { if (!q.has(member)) D.push(diag('unknown-member', `"${member}" is not a member of query "${head}"`, { loc, suggestion: closest(member, [...q]), from: member })); return; }
    const s = storeMemberMap.get(head);
    if (s && !s.has(member)) D.push(diag('unknown-member', `"${member}" is not a member of store "${head}"`, { loc, suggestion: closest(member, [...s]), from: member }));
  };

  // state types: a `list` must declare its element type (always know what's inside)
  const entityNames = Object.keys(doc.entities || {});
  for (const [name, def] of Object.entries(doc.state || {})) {
    const t = def.type;
    if (def.source?.startsWith('query:') && t !== 'list' && !t.startsWith('list<')) {
      // a query's data is always an array: a single-record type silently renders empty (no fetch-one).
      D.push(diag('query-not-list', `state "${name}" is a query but typed "${t}" — a query returns a LIST (the data is an array). Use \`list<${t}>\` and read it with \`each\`. (Single-record fetch isn't supported in muten.)`, { loc: def.loc, suggestion: `list<${t}>` }));
    }
    if (def.refresh != null) D.push(diag('polling-unsupported', `state "${name}" uses \`every …\` polling, which isn't supported — it would compile to a query that never refreshes (a silent no-op). For live data use \`query … live\` (a WebSocket); for periodic refresh call \`refetch()\` from an action.`, { loc: def.loc }));
    if (t === 'list') {
      D.push(diag('untyped-list', `state "${name}" is an untyped "list" — declare the element type, e.g. list<uuid> or list<User>`, { loc: def.loc, suggestion: 'list<uuid>' }));
    } else if (t.startsWith('list<')) {
      const elem = t.slice(5, -1);
      if (!SCALARS.includes(elem) && !entityNames.includes(elem)) {
        D.push(diag('unknown-type', `list element "${elem}" is not a known entity or scalar type`, { loc: def.loc, suggestion: closest(elem, [...entityNames, ...SCALARS]), from: elem }));
      }
      // a list's initial must BE a list. `items = {} : list<X>` (the draft-seed slip) lints clean today and then
      // crashes at runtime ("{} is not iterable"). Catch it: a given initial must be an array.
      if (def.initial != null && !Array.isArray(def.initial)) {
        D.push(diag('type-mismatch', `state "${name}" is a list, but its initial value is not a list — use \`[]\` (or a list of ${elem})`, { loc: def.loc, suggestion: '[]' }));
      }
    } else if (def.initial !== undefined && def.initial !== null) {
      // a scalar state's initial value must match its declared type (e.g. `count = "" : number` is a bug)
      const want = t === 'number' ? 'number' : t === 'bool' ? 'boolean' : (['text', 'string', 'email', 'uuid', 'date'].includes(t) ? 'string' : '');
      if (want && typeof def.initial !== want) {
        D.push(diag('type-mismatch', `state "${name}" is typed "${t}" but its initial value is a ${typeof def.initial}`, { loc: def.loc }));
      }
    }
  }

  // entity field TYPES: an unknown type (a typo like `numbr`, an unsupported input like `url`/`tel`/`file`, or a
  // nested entity) silently renders as a plain TEXT input — the author's intent is lost with no error. Flag it so
  // the oracle catches the slip. (`text`→stored as `string`; `id uuid` is implicit; enums are `enum:a|b`.)
  const FIELD_DISPLAY = ['text', 'email', 'number', 'bool', 'date', 'password', 'textarea'];
  for (const [ent, fields] of Object.entries(doc.entities || {})) {
    for (const [field, ftype] of Object.entries(fields as Record<string, string>)) {
      if (ftype.startsWith('enum:') || FIELD_TYPES.includes(ftype)) continue;
      D.push(diag('unknown-field-type', `entity "${ent}" field "${field}": "${ftype}" isn't a field type — it silently renders as a plain text input. Use one of ${FIELD_DISPLAY.join(' / ')}, an \`a | b\` enum, or a Custom for anything else.`, { from: ftype, suggestion: closest(ftype, FIELD_DISPLAY) }));
    }
  }

  // constraints apply to specific field kinds: a `pattern` on a number, or `min` on a bool, is a guard that
  // silently does nothing — the author thinks they added validation. Reject the mismatch with the reason.
  for (const [ent, fields] of Object.entries(doc.constraints || {})) {
    const edef = (doc.entities?.[ent] || {}) as Record<string, string>;
    for (const [field, c] of Object.entries(fields)) {
      const ft = edef[field] || '', stringy = ft === 'string' || ft === 'email' || ft === 'password' || ft === 'textarea', kind = ft.startsWith('enum:') ? 'enum' : ft === 'string' ? 'text' : ft;
      if (c.pattern != null && !stringy) D.push(diag('constraint-kind', `\`pattern\` on "${ent}.${field}" (a ${kind}) does nothing — \`pattern\` validates text/email fields only.`, { from: field }));
      if ((c.min != null || c.max != null) && ft !== 'number' && !stringy) D.push(diag('constraint-kind', `\`min\`/\`max\` on "${ent}.${field}" (a ${kind}) does nothing — they bound a number's value or text's length only.`, { from: field }));
      if (c.required && ft.startsWith('enum:')) D.push(diag('constraint-kind', `\`required\` on "${ent}.${field}" is redundant — an enum always has a value.`, { from: field }));
    }
  }

  // an `each` item carries the element type of its list, so a field typo on the loop var
  // is caught exactly like one on @state: `each users as u { Text "{u.naem}" }` -> "naem" not a field of User.
  const entityFieldSet = (type: string): Set<string> | null => {
    const ent = doc.entities?.[type];
    return ent ? new Set(['id', ...Object.keys(ent)]) : null;
  };
  // predicate scope for `remove`/`patch`: legacy `=>` binds its var (typed elem); item-implicit
  // `where` binds the element's fields bare (id + entity fields), like the `where`-filter / aggregates.
  const itemPredScope = (base: Map<string, string>, target: string): Map<string, string> => {
    const lt = doc.state?.[target]?.type || '';
    const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
    const m = new Map(base);
    const ent = elem ? doc.entities?.[elem] : undefined;
    if (ent) { m.set('id', 'uuid'); for (const [f, ft] of Object.entries(ent)) m.set(f, ft); }
    return m;
  };
  // Collision rule for item-implicit `where`/`by`/`with`: a bare name that is both an item field and an
  // action param resolves to the field (item wins), silently making the param unreachable.
  // e.g. `remove where id == id` deletes everything. Raise an error with a rename suggestion.
  const checkItemShadow = (target: string, params: Set<string>, exprs: Expr[], loc: Loc | null): void => {
    const lt = doc.state?.[target]?.type || '';
    const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
    const ent = elem ? doc.entities?.[elem] : undefined;
    if (!ent) return;
    const fields = new Set(['id', ...Object.keys(ent)]);
    const seen = new Set<string>();
    for (const expr of exprs) for (const ref of collectRefs(expr)) {
      const head = ref.split('.')[0];
      if (fields.has(head) && params.has(head) && !seen.has(head)) { seen.add(head); D.push(diag('item-shadow', `"${head}" is both a field of ${elem} and a param here — inside \`where\`/\`with\` the item field wins, so the param "${head}" is unreachable. Rename the param (e.g. "${head}Arg").`, { loc, from: head })); }
    }
  };
  // Route-param shadow: inside an item-implicit `where`/`by` (an aggregate or filter), a bare name binds to the
  // element's field, so if it ALSO names a ROUTE PARAM the param is silently shadowed (the field wins) —
  // `count where productId == id` compares each row's OWN id, not the URL's `param id`. Always-wrong, lint-green.
  // (Only fires for item-implicit predicates: an `each … as it where it.id == id` uses `id` as the param, fine.)
  const checkRouteShadow = (elem: string, ent: Record<string, string>, exprs: Expr[], loc: Loc | null): void => {
    const fields = new Set(['id', ...Object.keys(ent)]);
    const seen = new Set<string>();
    for (const expr of exprs) for (const ref of collectRefs(expr)) {
      const head = ref.split('.')[0];
      if (fields.has(head) && paramNames.has(head) && !seen.has(head)) { seen.add(head);
        D.push(diag('item-shadow', `"${head}" is both a field of ${elem} and the route \`param ${head}\` — inside \`where\`/\`by\` the item field wins, so the route param is shadowed (this compares each row's own ${head}, not the URL value). Rename the route param so it differs from the field (e.g. the route \`:${head}Param\` + \`param ${head}Param\`).`, { loc, from: head })); }
    }
  };
  const listElem = (e: Expr | undefined): string => { // element type of `each <list>` (entity or scalar; '' if unresolved)
    if (!e) return '';
    const name = e.kind === Ek.Ref ? e.name
      : (e.kind === Ek.Agg && (e.op === 'sort' || e.op === 'sortDesc' || e.op === 'take')) ? e.list // `each list.sort(…)/take(n) as x`: same element type
      : e.kind === Ek.Filter ? e.list                                            // `each (list where cond) as x`: filtered list's element
      : '';
    if (!name) return '';
    const t = doc.state?.[name.split('.')[0]]?.type || '';
    return t.startsWith('list<') ? t.slice(5, -1) : '';
  };

  const checkRef = (value: string | undefined, node: FlatNode): void => {
    if (typeof value === 'string' && value.startsWith('@')) {
      const name = value.slice(1).split('.')[0];
      // a `@`-ref names a list/value source: a page state, a page `get` (derived list — for Chart/DataTable), or a
      // store (`@store.member`). All three are valid; only a name that is NONE of them is an unknown ref.
      if (!stateKeys.has(name) && !storeDomains.has(name) && !(doc.gets && name in doc.gets)) {
        const near = closest(name, [...stateKeys, ...Object.keys(doc.gets || {})]);
        D.push(diag('unknown-ref', `"@${name}" is not a declared state or get`, { loc: node.loc, suggestion: near ? '@' + near : null, from: '@' + name, related: near ? doc.state?.[near]?.loc ?? null : null }));
      }
    }
  };

  // action ref (`-> action`, `submit action`): a bare name must be a declared action. Dotted (store
  // action, `cart.add`) and $param (part callback) refs resolve elsewhere (cross-file / compose): skip.
  const checkAction = (value: string | undefined, node: FlatNode): void => {
    if (!value || value.startsWith('$')) return;
    if (value.includes('.')) { const dot = value.indexOf('.'); checkMember(value.slice(0, dot), value.slice(dot + 1).split('.')[0], node.loc ?? null); return; } // store action (cart.add)
    if (!actionNames.has(value)) {
      D.push(diag('unknown-action', `"${value}" is not a declared action`, { loc: node.loc, suggestion: closest(value, [...actionNames]), from: value }));
    }
  };

  // the type of an expression when we can resolve it confidently, '' otherwise (so callers never flag on a guess).
  const exprType = (e: Expr, scope: Map<string, string>): string => {
    if (e.kind === Ek.Lit) return typeof e.value === 'number' ? 'number' : typeof e.value === 'boolean' ? 'bool' : 'text';
    if (e.kind === Ek.Ref) {
      const [head, ...rest] = e.name.split('.');
      const t = scope.has(head) ? (scope.get(head) || '') : (doc.state?.[head]?.type || '');
      if (!rest.length) return t;
      if (rest.length === 1 && rest[0] === 'length' && (t === 'list' || t.startsWith('list<') || STRINGY.includes(t))) return 'number'; // `.length` of a list or a text value is a number (typed so a length gate `x.length >= 8` is compare-checked)
      return (rest.length === 1 && doc.entities?.[t]?.[rest[0]]) || ''; // entity field type (deeper or non-entity -> unknown)
    }
    if (e.kind === Ek.Agg) {
      if (e.op === 'at') { // `list.at(n)` -> the element type; `.at(n).field` -> that field's type
        const h = e.list.split('.')[0]; const lt = (scope.get(h) || doc.state?.[h]?.type || getListType(h));
        const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
        if (!e.member) return elem;
        const first = e.member.split('.')[0];
        return first === 'id' ? 'uuid' : (doc.entities?.[elem]?.[first] || '');
      }
      return (e.op === 'sort' || e.op === 'sortDesc' || e.op === 'take') ? '' : 'number'; // aggregates -> number; sort/take -> a list (don't infer)
    }
    return ''; // bin/call/obj/tern/un: don't infer
  };

  // The list type behind a derived `get` (or a chain of them), so an aggregate/filter OVER a get still
  // resolves the element's fields (`get won = opps where … ` then `won.sum by amount`). Delegated to the
  // SHARED resolver (engine/ir/refs.ts) so the linter and the emitter resolve element types IDENTICALLY.
  const getListType = (head: string): string =>
    (doc.gets && head in doc.gets) ? exprListType(doc.gets[head], refFacts, new Set([head])) : '';

  // The element entity behind a `@data` list ref (Chart / DataTable), resolved through the SAME sources the
  // store-centric architecture uses: a page `state`/`query` list, a page `get` list, OR a store member
  // (`orders.items`). Returns the element field→type map (+ its entity name, for the DataTable `row` scope) so
  // x/y and columns stay oracle-checked whatever the source. `known` is false only when the ref is nothing at all.
  const dataElement = (d: string): { name: string; fields: { readonly [f: string]: string } | null; isList: boolean; known: boolean } => {
    const elemName = (t: string): string => t.startsWith('list<') ? t.slice(5, -1) : '';
    const st = doc.state?.[d]?.type;
    if (st !== undefined) { const nm = elemName(st); return { name: nm, fields: doc.entities?.[nm] ?? null, isList: st === 'list' || st.startsWith('list<'), known: true }; }
    const gt = getListType(d);
    if (gt) { const nm = elemName(gt); return { name: nm, fields: doc.entities?.[nm] ?? null, isList: true, known: true }; }
    const se = ctx.storeEntities?.[d]; // a store list member (`orders.items` -> the Order entity's fields)
    if (se) return { name: '', fields: se, isList: true, known: true };
    return { name: '', fields: null, isList: false, known: false };
  };
  // arithmetic `- * /` on a non-number operand produces NaN at runtime. `+` is also string concat, so it's left alone.
  const checkArith = (e: Expr, loc: Loc | null, scope: Map<string, string>): void => {
    if (e.kind === Ek.Bin) {
      if (e.op === BOp.Sub || e.op === BOp.Mul || e.op === BOp.Div) for (const side of [e.left, e.right]) {
        const t = exprType(side, scope);
        if (t && t !== 'number') D.push(diag('arith-type', `arithmetic \`${e.op}\` needs numbers, but an operand is "${t}" — declare it \`: number\`.`, { loc }));
      }
      // comparing two known, incompatible types is always false/true: the classic `when step == "1"` (a number
      // state vs a quoted string) silently never matches. null compares with anything, so it's exempt.
      if ([BOp.Eq, BOp.Neq, BOp.Lt, BOp.Gt, BOp.Lte, BOp.Gte].includes(e.op) && !(e.left.kind === Ek.Lit && e.left.value === null) && !(e.right.kind === Ek.Lit && e.right.value === null)) {
        const norm = (t: string): string => (t === 'number' || t === 'bool') ? t : (t.startsWith('enum:') || ['text', 'string', 'email', 'uuid', 'date'].includes(t)) ? 'text' : t;
        const lt = exprType(e.left, scope), rt = exprType(e.right, scope);
        if (lt && rt && norm(lt) !== norm(rt)) D.push(diag('compare-type', `comparing a ${lt} to a ${rt} — they never match (always ${e.op === BOp.Neq ? 'true' : 'false'}). Likely a quoted number (\`== "1"\` vs \`== 1\`) or a type mismatch.`, { loc }));
        // enum equality against a NON-member is always false — a typo'd status/stage (incl. a `match` arm value) that silently never matches.
        if ((e.op === BOp.Eq || e.op === BOp.Neq)) {
          const et = lt.startsWith('enum:') ? lt : rt.startsWith('enum:') ? rt : '';
          const litV = e.right.kind === Ek.Lit && typeof e.right.value === 'string' ? e.right.value : (e.left.kind === Ek.Lit && typeof e.left.value === 'string' ? e.left.value : null);
          if (et && litV != null) { const members = et.slice(5).split('|'); if (!members.includes(litV)) D.push(diag('enum-member', `"${litV}" is not a value of this enum (${members.join(' | ')}) — \`${e.op === BOp.Neq ? '!=' : '=='}\` is always ${e.op === BOp.Neq ? 'true' : 'false'}. (a \`match\` arm value must be one of the enum's values.)`, { loc, suggestion: closest(litV, members), from: litV })); }
        }
      }
      if (e.op === BOp.Contains) { // `list<Entity> contains <scalar>` -> array.includes(object) is ALWAYS false
        const lt = exprType(e.left, scope);
        const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
        if (elem && doc.entities?.[elem]) D.push(diag('contains-entity', `\`contains\` on a list of "${elem}" objects checks object identity, not a field — it is always false. Use a \`list<scalar>\` (e.g. list<text>), or filter a field with \`each … where field == x\`.`, { loc }));
        else if (elem) { // a scalar list: the searched value's type must match the element type, else `includes` is always false
          const norm = (t: string): string => (t === 'number' || t === 'bool') ? t : (t.startsWith('enum:') || ['text', 'string', 'email', 'uuid', 'date'].includes(t)) ? 'text' : t;
          const rt = exprType(e.right, scope);
          if (rt && norm(elem) !== norm(rt)) D.push(diag('contains-type', `\`contains\` searches a list of ${elem}, but the value is a ${rt} — it never matches (always false).`, { loc }));
        }
      }
      checkArith(e.left, loc, scope); checkArith(e.right, loc, scope);
    } else if (e.kind === Ek.Un) checkArith(e.operand, loc, scope);
    else if (e.kind === Ek.Tern) { checkArith(e.cond, loc, scope); checkArith(e.then, loc, scope); checkArith(e.else, loc, scope); }
    else if (e.kind === Ek.Obj) for (const f of e.fields) checkArith(f.value, loc, scope);
    else if (e.kind === Ek.Call) for (const a of e.args) checkArith(a, loc, scope);
  };

  // validates the variables an expression uses against (item scope + state). `scope` maps an in-scope item
  // variable to its entity type ('' if not an entity list), enabling field-checks on the loop var too.
  const checkExpr = (expr: Expr, loc: Loc | null, scope: Map<string, string>): void => {
    checkArith(expr, loc, scope);
    // list aggregates: the LIST must be a list; the body's bare fields are item-implicit (the element type).
    const aggWalk = (e: Expr): void => {
      if (e.kind === Ek.Agg) {
        const head = e.list.split('.')[0];
        let lt = scope.has(head) ? (scope.get(head) || '') : (doc.state?.[head]?.type || '');
        if (!lt) lt = getListType(head); // a `get` resolving to a derived list (chained aggregate / filter)
        const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
        if (lt && !lt.startsWith('list<') && !storeDomains.has(head)) D.push(diag('agg-not-list', `\`${e.op} …\` needs a list, but "${e.list}" is "${lt}".`, { loc }));
        const bodyScope = new Map(scope);
        const ent = (elem ? doc.entities?.[elem] : undefined) ?? ctx.storeEntities?.[e.list]; // page-local entity, else a CROSS-STORE list's element (orders.items -> Order)
        if (ent) { bodyScope.set('id', 'uuid'); for (const [f, ft] of Object.entries(ent)) bodyScope.set(f, ft); checkRouteShadow(elem || e.list, ent, [e.body], loc); } // `by`/`where`: element fields bound bare (item-implicit)
        // sort KEY: a literal row field sorts statically. A bare ref to a STATE/get/const instead names the column
        // DYNAMICALLY at runtime (`sort by sortCol`, sortCol = "price" -> __it["price"]) — the user-chosen-column case.
        // That dynamic key must hold a field NAME (text); a number/bool key would read __it[5] = undefined (a no-op).
        if ((e.op === 'sort' || e.op === 'sortDesc') && e.body.kind === Ek.Ref && !e.body.name.includes('.')) {
          const h = e.body.name;
          if (!(h === 'id' || (ent && h in ent) || scope.has(h)) && stateKeys.has(h)) {
            const kt = doc.state?.[h]?.type || '';
            if (kt && kt !== 'text' && kt !== 'string') D.push(diag('sort-key-type', `\`${e.op} by ${h}\` uses "${h}" as a dynamic column name, but it is "${kt}" — a dynamic sort key must be a text state holding a field name (e.g. \`sortCol = "${ent ? Object.keys(ent)[0] : 'name'}" : text\`). Sort by a literal row field for a fixed column.`, { loc, from: h }));
          }
        }
        // sum/avg/min/max reduce a number projection (a `min` over text strings -> NaN);
        // count's body is a true/false condition, so it's exempt.
        if (e.op === 'take') { const bt = exprType(e.body, bodyScope); if (bt && bt !== 'number') D.push(diag('take-count', `\`take(n)\` takes a NUMBER count (how many items), but got "${bt}". e.g. \`posts.take(10)\` or \`posts.take(limit)\`.`, { loc })); }
        else if (e.op === 'at') {
          const bt = exprType(e.body, bodyScope); if (bt && bt !== 'number') D.push(diag('at-index', `\`at(n)\` takes a NUMBER index (which position), but got "${bt}". e.g. \`matches.at(hi)\` where hi is a number state.`, { loc }));
          if (e.member) { const first = e.member.split('.')[0]; if (ent && first !== 'id' && !(first in ent)) D.push(diag('unknown-member', `"${first}" is not a field of ${elem} — \`at(n).<field>\` reads a field of the element.`, { loc, suggestion: closest(first, ['id', ...Object.keys(ent)]), from: first })); }
        }
        else if (e.op !== 'count' && e.op !== 'sort' && e.op !== 'sortDesc') { const bt = exprType(e.body, bodyScope); if (bt && bt !== 'number') D.push(diag('agg-type', `\`${e.op} …\` reduces a NUMBER, but the body is "${bt}". Use a number projection (count uses a true/false condition).`, { loc })); }
        checkExpr(e.body, loc, bodyScope);
        return; // collectRefs already skips the body (the item fields aren't in the outer scope)
      }
      if (e.kind === Ek.Filter) { // derived list `<list> where <cond>`: list must be a list; cond's bare fields are the element's
        const head = e.list.split('.')[0];
        let lt = scope.has(head) ? (scope.get(head) || '') : (doc.state?.[head]?.type || '');
        if (!lt) lt = getListType(head); // a `get` resolving to a derived list (chained aggregate / filter)
        const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
        if (lt && !lt.startsWith('list<') && !storeDomains.has(head)) D.push(diag('filter-not-list', `\`${e.list} where …\` needs a list, but "${e.list}" is "${lt}".`, { loc }));
        // bind each element field as a bare in-scope name so the cond's `status == "todo"` field- and type-checks
        const ent = (elem ? doc.entities?.[elem] : undefined) ?? ctx.storeEntities?.[e.list]; // cross-store list filter resolves its element fields too
        const condScope = new Map(scope);
        if (ent) { condScope.set('id', 'uuid'); for (const [f, ft] of Object.entries(ent)) condScope.set(f, ft); checkRouteShadow(elem || e.list, ent, [e.cond], loc); }
        checkExpr(e.cond, loc, condScope);
        return; // collectRefs skips the cond (its bare fields aren't in the outer scope)
      }
      if (e.kind === Ek.Bin) { aggWalk(e.left); aggWalk(e.right); }
      else if (e.kind === Ek.Un) aggWalk(e.operand);
      else if (e.kind === Ek.Tern) { aggWalk(e.cond); aggWalk(e.then); aggWalk(e.else); }
      else if (e.kind === Ek.Obj) for (const f of e.fields) aggWalk(f.value);
      else if (e.kind === Ek.Call) for (const a of e.args) aggWalk(a);
    };
    aggWalk(expr);
    checkCalls(expr, loc); // `use`'d function calls must be declared
    for (const ref of collectRefs(expr)) {
      const dot = ref.indexOf('.');
      const head = dot === -1 ? ref : ref.slice(0, dot);
      if (!isKnownHead(head, (x) => scope.has(x), knownHeads)) {
        const near = closest(head, [...stateKeys, ...scope.keys()]);
        // a bare word with no close state is almost always a meant-to-be-quoted text/enum value (`status == todo`)
        D.push(diag('unknown-ref', `"${head}" is not a known state or item variable here${near ? '' : ` — if it's a text/enum value, quote it: "${head}"`}`, { loc, suggestion: near, from: head }));
        continue;
      }
      if (dot === -1) continue;
      const member = ref.slice(dot + 1).split('.')[0];
      // head's element/value type: an `each` item (scope) or a state cell. Field-check entities; a scalar
      // has no fields; everything else (query / store / list) falls back to the closed member-set check.
      const t = scope.has(head) ? (scope.get(head) || '') : (doc.state?.[head]?.type || '');
      const fields = entityFieldSet(t);
      if (fields) {
        if (!fields.has(member)) D.push(diag('unknown-member', `"${member}" is not a field of ${t} (${scope.has(head) ? 'item' : 'state'} "${head}")`, { loc, suggestion: closest(member, [...fields]), from: member }));
        else { // depth-2+ chain `c.field.sub`: entity fields are scalars/enums (no sub-fields), so `.sub` is invalid unless the field is itself an entity — EXCEPT `.length` on a text/list field (its character/item count)
          const sub = ref.slice(dot + 1).split('.')[1];
          const ft = doc.entities?.[t]?.[member] || '';
          const lengthOk = sub === 'length' && (STRINGY.includes(ft) || ft === 'list' || ft.startsWith('list<'));
          if (sub && !doc.entities?.[ft] && !lengthOk) D.push(diag('unknown-member', `"${member}" is ${ft.startsWith('enum:') ? 'an enum' : `a ${ft}`} — it has no field "${sub}"`, { loc, from: sub }));
        }
      } else if (SCALARS.includes(t)) {
        // a text value exposes `.length` (its character count); any other member is a typo. numbers/bools have none.
        if (!(member === 'length' && STRINGY.includes(t))) D.push(diag('unknown-member', `"${head}" is a ${t} — it has no field "${member}"${STRINGY.includes(t) ? ' (a text value exposes only .length)' : ''}`, { loc }));
      } else if (actionNames.has(head) && !stateKeys.has(head)) {
        const am = new Set(['pending', 'error']); // async action exposes only .pending / .error
        if (!am.has(member)) D.push(diag('unknown-member', `action "${head}" exposes only .pending / .error, not "${member}"`, { loc, suggestion: closest(member, [...am]), from: member }));
      } else if (t.startsWith('list<')) {
        // a list exposes only .length (plus .data/.loading/.error if it's a query), not arbitrary fields.
        // Reading an element's field (`x.price`) is the bug: iterate with `each x as item` instead.
        const isQuery = !!doc.state?.[head]?.source;
        const ok = isQuery ? new Set(['length', 'data', 'loading', 'error']) : new Set(['length']);
        if (!ok.has(member)) D.push(diag('unknown-member', `"${head}" is a list — no member "${member}" (lists expose ${isQuery ? '.length / .data / .loading / .error' : 'only .length'}; use \`each ${head} as item\` to read an element)`, { loc, suggestion: closest(member, [...ok]), from: member }));
      } else {
        checkMember(head, member, loc); // typo'd query/store member
      }
    }
  };

  // node tree: known type, required props, valid style tokens, resolvable expression refs
  const seen = new Set<string>();
  const walk = (id: string, scope: Map<string, string>, inTable = false): void => {
    const n = nodes[id];
    if (!n) { D.push(diag('missing-node', `node ${id} does not exist`)); return; }
    if (seen.has(id)) { D.push(diag('dup-node', `${id} is referenced twice`, { loc: n.loc })); return; }
    seen.add(id);
    if (n.type === 'RowAction' && !inTable) D.push(diag('rowaction-context', 'RowAction only works inside a DataTable (it renders a button per row). Use Button for a standalone action.', { loc: n.loc })); // compile throws "unsupported primitive" otherwise

    if (!KNOWN_TYPES.has(n.type)) {
      if (n.args) {
        D.push(diag('unknown-part', `"${n.type}" is not a known part`, { loc: n.loc, suggestion: closest(n.type, [...(ctx.parts || [])]), from: n.type }));
      } else {
        D.push(diag('unknown-type', `"${n.type}" is not a known primitive`, { loc: n.loc, suggestion: closest(n.type, [...KNOWN_TYPES]), from: n.type }));
      }
    } else {
      // required props: those NOT ending in "?" in the manifest
      const prim = PRIMITIVES[n.type];
      const spec = prim ? prim.props : {};
      for (const [pname, hint] of Object.entries(spec)) {
        if (!hint.endsWith('?') && !(pname in (n.props || {}))) {
          // Select/Checkbox/Number/Range/Date/Chart are native primitives that share a name with common plugin
          // (shadcn) parts — a part-style call (`Select(value: …)`) resolves to the primitive and trips this. Say so.
          const tip = SHADOWED_PRIMITIVE[n.type] ? ` — "${n.type}" is a native primitive (it shadows any same-named plugin part); use its API, e.g. \`${SHADOWED_PRIMITIVE[n.type]}\`` : '';
          D.push(diag('missing-prop', `${n.type} is missing the required "${pname}"${tip}`, { loc: n.loc }));
        }
      }
    }

    const props = n.props || {};
    for (const rp of REF_PROPS) if (rp in props) checkRef(props[rp], n);
    if (props.action) {
      checkAction(props.action, n);
      // `-> action()` where the action declares `<- input`: the call passes nothing, so the body
      // reads undefined (e.g. `p.id` -> TypeError). Require the arg. Store actions: input unknown here, skip.
      if (typeof props.action === 'string' && !props.action.includes('.') && (doc.actions?.[props.action]?.input || doc.actions?.[props.action]?.params?.length) && props.arg === undefined)
        D.push(diag('action-arity', `action "${props.action}" takes an argument (it reads "${doc.actions[props.action].params?.length ? doc.actions[props.action].params!.map((p) => p.name).join(', ') : doc.actions[props.action].input}") — pass it, e.g. \`-> ${props.action}(row)\``, { loc: n.loc }));
    }
    if (props.submit) checkAction(props.submit, n);
    if (Array.isArray(props.where)) for (const clause of props.where) if (typeof clause === 'string' && clause.trim()) { // where() compiles only `==`/`contains`, comma-separated; anything else throws or silently miscompiles
      if (!/(?:==|\bcontains\b)/.test(clause)) D.push(diag('unsupported-where', `where clause "${clause.trim()}" — where() supports only \`==\` and \`contains\` (e.g. where(role == admin, name contains @q)).`, { loc: n.loc, from: clause.trim() }));
      else if (/\b(?:and|or)\b/.test(clause)) D.push(diag('unsupported-where', `where clause "${clause.trim()}" — combine conditions with a COMMA, not \`and\`/\`or\`: where(role == admin, name contains @q).`, { loc: n.loc, from: clause.trim() }));
    }
    if (n.type === 'Form') { // Form auto-renders one input per entity field: must bind a page-local draft; anything else crashes the compiler (editableFields(undefined))
      const raw = String(props.bind ?? '').replace(/^@/, '');
      const b = raw.split('.')[0];
      const bt = b ? doc.state?.[b]?.type : undefined;
      if (bt === undefined) D.push(diag('form-bind', `Form must bind a page-local draft (a state typed as an entity)${raw ? `, but "${raw}" is not a state on this page` : ''}${raw.includes('.') ? ' — a Form cannot bind a store field; declare a local `draft = {} : Entity` and submit the store action' : ''}.`, { loc: n.loc }));
      else if (!doc.entities?.[bt]) D.push(diag('form-bind', `Form must bind a state typed as an entity (a draft): "${b}" is "${bt}". Declare \`entity X { … }\` + \`${b} = {} : X\`, or use SearchField for a single text input.`, { loc: n.loc }));
    }
    if (n.type === 'DataTable') { // columns + where fields must be real fields of the row entity (else blank column / dead filter / @ref crash)
      const d = String(props.data ?? '').replace(/^@/, '');
      const de = dataElement(d); // page state / query / get / store member
      // the data must be a LIST — a scalar/record here lints clean today, then crashes at runtime ("not iterable").
      if (d && de.known && !de.isList)
        D.push(diag('datatable-not-list', `DataTable shows a list, but "${d}" is not a list — bind a \`list<…>\` state, query, get, or store list.`, { loc: n.loc, from: d }));
      const rowFields = de.fields ? new Set(['id', ...Object.keys(de.fields)]) : null;
      if (rowFields) {
        const elem = de.name || 'the data';
        for (const col of (props.columns || [])) if (typeof col === 'string' && !rowFields.has(col)) D.push(diag('unknown-column', `column "${col}" is not a field of ${elem}`, { loc: n.loc, suggestion: closest(col, [...rowFields]), from: col }));
        for (const clause of (props.where || [])) if (typeof clause === 'string') {
          const field = clause.trim().split(/\s+/)[0];
          if (field && !rowFields.has(field)) D.push(diag('unknown-where-field', `where "${clause.trim()}": "${field}" is not a field of ${elem}`, { loc: n.loc, suggestion: closest(field, [...rowFields]), from: field }));
          for (const m of clause.matchAll(/@(\w+)/g)) if (!stateKeys.has(m[1])) D.push(diag('unknown-ref', `where "${clause.trim()}": "@${m[1]}" is not a declared state`, { loc: n.loc, from: '@' + m[1] }));
        }
      }
    }
    if (n.type === Nt.SearchField || n.type === Nt.Password || n.type === Nt.Select || n.type === Nt.Checkbox || n.type === Nt.Number || n.type === Nt.Range || n.type === Nt.Date) {
      // A bound input carries one scalar. It binds a page STATE (`bind(q)`), OR — inside an `each` — a FIELD of the
      // row entity (`bind(row.value)`), which two-way-edits that list element. Either way the type must match.
      const raw = String(props.bind ?? '').replace(/^@/, '');
      const head = raw.split('.')[0], sub = raw.split('.')[1];
      const isBool = n.type === Nt.Checkbox;
      const isNum = n.type === Nt.Number || n.type === Nt.Range;
      const isDate = n.type === Nt.Date;
      const want = isNum ? ['number'] : isBool ? ['bool'] : isDate ? ['date', 'text', 'string'] : ['text', 'string', 'email'];
      const kindWord = isNum ? 'a number' : isBool ? 'a bool' : isDate ? 'a date' : 'a single text value';
      const hint = isNum ? 'a number state (e.g. `qty = 0 : number`)' : isBool ? 'a bool state (e.g. `agree = false : bool`)' : isDate ? 'a date state (e.g. `due = "" : date`)' : 'a text state (e.g. `role = "" : text`)';
      const eachElem = head && scope.has(head) ? (scope.get(head) || '') : ''; // an `each` row var -> its element entity
      if (eachElem && doc.entities?.[eachElem]) {
        const ft = sub ? (doc.entities[eachElem][sub] || (sub === 'id' ? 'uuid' : '')) : '';
        if (!sub) D.push(diag('bind-type', `${n.type} inside \`each\` edits a list item — bind one of its FIELDS: \`bind(${head}.<field>)\`.`, { loc: n.loc, from: head }));
        else if (!ft) D.push(diag('bind-type', `"${sub}" is not a field of ${eachElem}`, { loc: n.loc, suggestion: closest(sub, Object.keys(doc.entities[eachElem])), from: sub }));
        else if (isNum ? ft !== 'number' : isBool ? ft !== 'bool' : (!want.includes(ft) && !ft.startsWith('enum:'))) D.push(diag('bind-type', `${n.type} binds ${kindWord}, but ${eachElem}.${sub} is "${ft}".`, { loc: n.loc, from: sub }));
      } else if (scope.has(head) && sub) {
        // `head` is an `each` row var, but its element entity didn't resolve — the list is a STORE/query list (or an
        // unknown element type). Its rows are NOT editable through a direct input bind (write-back only works on a
        // settable page list state). Don't say "declare a state" (impossible per-row) — point at the action pattern.
        D.push(diag('bind-type', `${n.type} binds a field of the \`each\` row "${head}", but rows of a store/query list can't be edited through a direct input bind — change the value with an action (a store \`patch where id == ${head}.id with { ${sub}: … }\`, fired by a Button), or iterate a settable page \`state\` list to bind fields directly.`, { loc: n.loc, from: head }));
      } else {
        const bt = head ? doc.state?.[head]?.type : undefined;
        // SearchField stays lenient about existence (legacy); the newer inputs require a real state.
        if (n.type !== Nt.SearchField && head && bt === undefined) D.push(diag('bind-type', `${n.type} binds "${head}", which is not a state on this page — declare ${hint}.`, { loc: n.loc, suggestion: closest(head, [...stateKeys]), from: head }));
        else if (bt !== undefined && !want.includes(bt)) D.push(diag('bind-type', `${n.type} binds ${kindWord}, but "${head}" is "${bt}" — bind ${hint}.`, { loc: n.loc }));
      }
    }
    if (n.type === 'Custom') { // inputs(@state) + on(action) were unvalidated: undefined refs / missing actions crash at runtime
      for (const v of Object.values(props.inputs || {})) if (typeof v === 'string') checkRef(v, n);
      for (const v of Object.values(props.on || {})) if (typeof v === 'string') checkAction(v, n);
    }
    if (n.type === Nt.Chart) { // data must be a list; x/y/color must be real fields; y must be numeric; kind bounded
      const d = String(props.data ?? '').replace(/^@/, '');
      const de = dataElement(d); // page state / query / get / store member — the store-centric pattern derives via get
      if (d && de.known && !de.isList)
        D.push(diag('chart-not-list', `Chart plots a list, but "${d}" is not a list — bind a \`list<…>\` state, query, get, or store list.`, { loc: n.loc, from: d }));
      if (typeof props.kind === 'string' && !CHART_KINDS.has(props.kind))
        D.push(diag('chart-kind', `Chart kind "${props.kind}" is not one of bar / line / area / point / scatter / pie / donut.`, { loc: n.loc, suggestion: closest(props.kind, [...CHART_KINDS]), from: props.kind }));
      const elem = de.name || 'the data';
      const rowFields = de.fields ? new Set(['id', ...Object.keys(de.fields)]) : null;
      // Chart reads x/y as bare FIELD refs (not coordinate expressions); '' when absent, null when a non-ref expr.
      const chartField = (e: Expr | undefined): string | null => e === undefined ? '' : (e.kind === Ek.Ref && !e.name.includes('.') ? e.name : null);
      const xf = chartField(props.x), yf = chartField(props.y);
      if (xf === null) D.push(diag('chart-field', `Chart x must be a field of ${elem} (e.g. \`x(month)\`), not an expression.`, { loc: n.loc }));
      if (yf === null) D.push(diag('chart-field', `Chart y must be a numeric field (e.g. \`y(revenue)\`), not an expression.`, { loc: n.loc }));
      if (rowFields) {
        for (const [enc, f] of [['x', xf], ['y', yf], ['color', props.color ?? '']] as const)
          if (typeof f === 'string' && f && !rowFields.has(f)) D.push(diag('chart-field', `Chart ${enc}(${f}): "${f}" is not a field of ${elem}`, { loc: n.loc, suggestion: closest(f, [...rowFields]), from: f }));
        const yt = typeof yf === 'string' && yf ? (de.fields?.[yf] || '') : '';
        if (yt && yt !== 'number') D.push(diag('chart-field', `Chart y(${yf}): "${yf}" is "${yt}", but y must be a number field (it is the value axis).`, { loc: n.loc, from: yf }));
      }
    }
    if (SVG_PRIMS.has(n.type)) { // SVG mark geometry are EXPRESSIONS — validate their refs (e.g. `map(unknownState, …)`)
      for (const g of ['x', 'y', 'w', 'h', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'rx', 'start', 'end', 'inner'] as const) { const e = props[g]; if (e) checkExpr(e, n.loc ?? null, scope); }
      for (const s of [props.d, props.transform]) if (s && typeof s === 'object' && 'kind' in s) for (const part of s.parts) if (typeof part !== 'string') checkExpr(part, n.loc ?? null, scope);
    }
    // target restrictions: kind/color = Chart-only; SVG geometry = mark-only; x/y = Chart OR SVG; viewBox = Svg-only.
    if ((props.kind || props.color) && n.type !== Nt.Chart) D.push(diag('encoding-target', `kind / color only apply to Chart, not ${n.type}.`, { loc: n.loc, from: n.type }));
    if ((props.w || props.h || props.cx || props.cy || props.r || props.x1 || props.y1 || props.x2 || props.y2 || props.rx || props.start || props.end || props.inner || props.d || props.transform) && !SVG_PRIMS.has(n.type))
      D.push(diag('encoding-target', `SVG geometry (w/h/cx/cy/r/start/end/inner/d/transform) only applies to Svg marks (Rect/Line/Circle/Arc/Path/Group), not ${n.type}.`, { loc: n.loc, from: n.type }));
    if ((props.x || props.y) && n.type !== Nt.Chart && !SVG_PRIMS.has(n.type)) D.push(diag('encoding-target', `x / y only apply to Chart or an SVG mark, not ${n.type}.`, { loc: n.loc, from: n.type }));
    if (props.viewBox && n.type !== Nt.Svg) D.push(diag('encoding-target', `viewBox only applies to Svg, not ${n.type}.`, { loc: n.loc, from: n.type }));
    // Icon resolves to inline SVG at BUILD, so its name must be a static `set:name` literal. A data-driven name
    // (`Icon "{m.icon}"`) parses to an Interp, NOT a string — so the old `typeof === 'string'` check missed exactly
    // the case it claimed to catch (a per-row icon from data). Catch BOTH: the interpolated form and the missing set.
    if (n.type === Nt.Icon) {
      const nm = props.name;
      if (typeof nm === 'string') { // Icon's name is a RAW string (not interp-parsed): `{x}` stays literal text
        if (nm.includes('{') || !nm.includes(':'))
          D.push(diag('icon-name', `Icon "${nm}" must be a static "set:name" literal — icons inline as SVG at build (tree-shaken), so the name can't come from data. Two ways to get a data-driven icon: (1) per-VALUE (status/type/category) → \`match\`: \`match item.status { active -> Icon "lucide:check"  paused -> Icon "lucide:pause" }\` (each arm inlines + tree-shakes); (2) an icon/image whose URL is in your data → use \`Image "{item.iconUrl}"\` instead.`, { loc: n.loc, from: nm }));
        else if (ctx.iconExists) { // shape is fine — does the name actually exist in the set? (a build-only check until now: a typo'd name lints green, then blanks the page)
          const err = ctx.iconExists(nm);
          if (err) D.push(diag('icon-name', `Icon "${nm}": ${err}`, { loc: n.loc, from: nm }));
        }
      } else if (nm && 'kind' in nm && nm.kind === Ek.Interp) // defensive: should an Icon name ever be interp-parsed
        D.push(diag('icon-name', `Icon's name is data-driven — it must be a static "set:name" literal (icons inline at build). For a per-VALUE icon use \`match item.status { active -> Icon "lucide:check"  … }\` (each arm tree-shakes); for an icon/image whose URL is in your data, use \`Image "{item.iconUrl}"\`.`, { loc: n.loc }));
    }
    // expression references: when condition, each list, reactive Text/Image interpolation
    if (n.type === Nt.When && props.cond) {
      checkExpr(props.cond, n.loc ?? null, scope);
      // `when <list>` is ALWAYS truthy (an empty array is truthy) — the obvious reading ("if it has items") is wrong.
      if (props.cond.kind === Ek.Ref) { const ct = (doc.state || {})[props.cond.name]?.type; if (ct && (ct === 'list' || ct.startsWith('list<'))) D.push(diag('when-list', `\`when ${props.cond.name}\` tests a list, which is ALWAYS truthy (even when empty). Use \`when ${props.cond.name}.length > 0\` to render only when it has items.`, { loc: n.loc, suggestion: `${props.cond.name}.length > 0`, from: props.cond.name })); }
    }
    if (n.type === Nt.Each && props.list) {
      checkExpr(props.list, n.loc ?? null, scope);
      // the iterated head must be a LIST — a scalar/record state here lints clean and then crashes at runtime
      // ("not iterable"). Catch the common case: a bare ref to a non-list page state.
      if (props.list.kind === Ek.Ref) {
        const lt = (doc.state || {})[props.list.name]?.type;
        if (lt && lt !== 'list' && !lt.startsWith('list<')) D.push(diag('each-not-list', `each iterates a list, but "${props.list.name}" is "${lt}" — use a \`list<…>\` state (or a query/list)`, { loc: n.loc, from: props.list.name }));
      }
    }
    if (props.arg && typeof props.arg === 'object' && 'kind' in props.arg) checkExpr(props.arg as Expr, n.loc ?? null, scope); // `-> action(arg)` on Button/Link/RowAction: arg was previously unchecked
    if (props.argRest) for (const a of props.argRest) checkExpr(a, n.loc ?? null, scope);                                     // 2nd+ args of a multi-arg call `-> f(a, b)`
    if (Array.isArray(props.class)) for (const c of props.class) if (typeof c !== 'string') { // reactive class: cond / interpolated refs were unchecked → a stale state ref passed lint but shipped a runtime ReferenceError
      if ('cond' in c) checkExpr(c.cond, n.loc ?? null, scope);
      else if ('interp' in c) for (const pt of c.interp.parts) if (typeof pt !== 'string') checkExpr(pt, n.loc ?? null, scope);
    }
    if (props.disabled) { // `disabled when <cond>`: the condition is a real expression, and it only affects form controls
      checkExpr(props.disabled, n.loc ?? null, scope);
      if (!DISABLEABLE.has(n.type)) D.push(diag('disabled-target', `\`disabled\` does nothing on ${n.type} — it applies to form controls (Button, RowAction, SearchField, Password, Select, Checkbox, Form).`, { loc: n.loc, from: n.type }));
    }
    if (props.draggable) checkExpr(props.draggable, n.loc ?? null, scope); // `draggable(item.id)` — the id expression is real
    for (const v of Object.values(props.on || {})) if (typeof v === 'string' && n.type !== 'Custom') checkAction(v, n); // on(event: action) on any element — the action must exist (Custom's on() is checked above)
    if (props.aria) for (const expr of Object.values(props.aria)) checkExpr(expr, n.loc ?? null, scope);  // `aria(key: expr)` values are real expressions: an unknown/renamed state ref is caught here, not at runtime
    if (props.styleVars) for (const sv of Object.values(props.styleVars)) if (typeof sv !== 'string') for (const pt of sv.parts) if (typeof pt !== 'string') checkExpr(pt, n.loc ?? null, scope);  // `style(w: "{ref}")` interpolations: an unknown state ref is caught here, not at runtime
    const interps: StringPropValue[] = [];
    if ((n.type === Nt.Text || n.type === Nt.Title || n.type === Nt.Span) && props.value) interps.push(props.value);
    if (n.type === Nt.Image) { if (props.src) interps.push(props.src); if (props.alt) interps.push(props.alt); }
    if (n.type === Nt.Link && props.to) interps.push(props.to);
    if (n.type === Nt.SearchField && props.placeholder) interps.push(props.placeholder); // placeholder interpolates ("Message #{channel}")
    if (props.label) interps.push(props.label); // Link/Button/RowAction labels interpolate too
    for (const ip of interps) {
      if (typeof ip === 'object' && 'kind' in ip && ip.kind === Ek.Interp) {
        for (const part of ip.parts) if (typeof part !== 'string') checkExpr(part, n.loc ?? null, scope);
      }
    }

    // children inherit the scope; `each` adds its item variable and DataTable adds the implicit `row`
    // (its RowActions read `row.id`), both typed with the list's element entity.
    let childScope = scope;
    if (n.type === Nt.Each && props.as) {
      childScope = new Map([...scope, [props.as, listElem(props.list)] as [string, string]]);
      if (props.index) { // `as item, i`: i is a number (position). Same name as the item shadows it → the item ref would read a number at runtime, lint-clean — catch it.
        if (props.index === props.as) D.push(diag('each-index-name', `the index variable "${props.index}" must differ from the item variable "${props.as}" (it shadows the item)`, { loc: n.loc, from: props.index }));
        childScope = new Map([...childScope, [props.index, 'number'] as [string, string]]);
      }
      if (props.filter) checkExpr(props.filter, n.loc ?? null, childScope); // `where <cond>` reads the item var
    }
    else if (n.type === 'DataTable') {
      const d = String(props.data || '').replace(/^@/, '');
      childScope = new Map([...scope, ['row', dataElement(d).name] as [string, string]]); // RowActions read `row.id` — bind `row` to the element entity (state / get / store)
    }
    for (const c of n.children || []) walk(c, childScope, n.type === 'DataTable');
  };
  if (doc.rootId) walk(doc.rootId, new Map());
  // a page (has `screen`) needs one root node; a parts/app/empty file has no screen and no page root.
  else if (ctx.kind !== 'store' && doc.screen) D.push(diag('no-root', `page "${doc.screen}" has no root node: a page needs one top-level node, e.g. Page { ... }`));

  // `get` (a derived/computed value) and `effect` (a side-effect that runs on mount and re-runs on its reactive
  // deps) are valid on a PAGE and in a .store alike. Every expression resolves against this file's own state, so
  // a member typo / bad ref in a `get` or `effect {}` is caught here, never shipped as a runtime ReferenceError.
  // (Page effects are the home for on-mount side effects — initializing a 3rd-party SDK, analytics, focus.)
  for (const expr of Object.values(doc.gets || {})) checkExpr(expr, null, new Map());
  // gets must not form a cycle: a self/mutual reference compiles to `const g = computed(() => g.get()…)`,
  // a "cannot access 'g' before initialization" crash. Catch it (DFS over the get→get dependency graph).
  {
    const gdeps: { [g: string]: string[] } = {};
    for (const [g, e] of Object.entries(doc.gets || {})) gdeps[g] = collectRefs(e).map((r) => r.split('.')[0]).filter((h) => h in (doc.gets || {}));
    const onPath = (g: string, seen: Set<string>): boolean => seen.has(g) ? true : (seen.add(g), (gdeps[g] || []).some((d) => onPath(d, new Set(seen))));
    for (const g of Object.keys(doc.gets || {})) if (onPath(g, new Set())) { D.push(diag('get-cycle', `get "${g}" depends on itself (directly or via another get) — that compiles to a "cannot access before initialization" crash. A get can't reference itself.`, { from: g })); break; }
  }
  const checkEff = (st: Stmt): void => {
    if (st.op === StOp.If) { checkExpr(st.cond, null, new Map()); for (const s of (st.then || [])) checkEff(s); for (const s of (st.else || [])) checkEff(s); return; }
    if (st.op === StOp.Call) { // an effect composing a STORE action (`ui.setSection("x")` on mount) — the target is a store domain, not a local mutation. (compile already emits this via stmtLines; only validate rejected it.)
      if (!storeDomains.has(st.target)) D.push(diag('unknown-action', `"${st.target}.${st.method}(…)": "${st.target}" is not a store — an effect can set local state (set/push/…) or call a STORE action.`, { suggestion: closest(st.target, [...storeDomains]), from: st.target }));
      else if (!storeMemberMap.get(st.target)?.has(st.method)) D.push(diag('unknown-action', `store "${st.target}" has no member "${st.method}".`, { suggestion: closest(st.method, [...(storeMemberMap.get(st.target) || [])]), from: st.method }));
      for (const a of st.args) checkExpr(a, null, new Map());
      return;
    }
    if ('target' in st && st.target && !stateKeys.has(st.target)) D.push(diag('undeclared-mutation', `effect mutates "${st.target}" — not a declared state`, { suggestion: closest(st.target, [...stateKeys]), from: st.target }));
    if (st.op === StOp.Remove) checkExpr(st.pred, null, itemPredScope(new Map(), st.target));
    else if (st.op === StOp.Patch) { const inner = itemPredScope(new Map(), st.target); checkExpr(st.pred, null, inner); checkExpr(st.patch, null, inner); }
    else if (st.op === StOp.Refetch) { for (const v of Object.values(st.params)) checkExpr(v, null, new Map()); }
    else if (st.op === StOp.Request) { if (st.body) checkExpr(st.body, null, new Map()); if (st.into && !stateKeys.has(st.into)) D.push(diag('undeclared-mutation', `effect captures the response into "${st.into}" — not a declared state`, { suggestion: closest(st.into, [...stateKeys]), from: st.into })); checkReqUrl(st); }
    else if (st.op === StOp.Extern) { if (!externs.has(st.fn)) D.push(diag('unknown-function', `"${st.fn}" is not a use'd function`, { suggestion: closest(st.fn, [...externs]), from: st.fn })); for (const a of st.args) checkExpr(a, null, new Map()); }
    else if ('arg' in st && st.arg) checkExpr(st.arg, null, new Map());
  };
  for (const eff of doc.effects || []) {
    // self-referential effect = INFINITE LOOP: an effect re-runs on every signal it reads, so a TOP-LEVEL
    // write of a signal it reads (directly, or via a store action that does) self-triggers forever — the
    // page hangs silently (no error). The single nastiest effect footgun; catch it at lint.
    for (const t of selfUpdateTargets(eff))
      D.push(diag('effect-loop', `effect updates "${t}" from its own value (e.g. \`${t}.set(${t} + …)\`) — an effect re-runs on every signal it reads, so writing a signal it reads loops forever (the page hangs). Set "${t}" to a value that doesn't read it, guard it with \`if <terminal condition>\`, or update it from an event (a Button) instead.`, { from: t }));
    for (const st of eff) {
      if (st.op === StOp.Call && ctx.storeSelfMut?.has(`${st.target}.${st.method}`))
        D.push(diag('effect-loop', `effect calls "${st.target}.${st.method}()", which updates a signal from its own value — an effect re-runs on every signal it reads, so a store action that reads AND writes the same state loops forever here (the page hangs). Call it from an event (a Button), or make the action set a value that doesn't depend on the old one.`, { from: st.method }));
      checkEff(st);
    }
  }

  // actions: a body may only mutate what `mutates` declares, using known ops
  for (const [name, a] of Object.entries(doc.actions || {})) {
    const declared = new Set(a.mutates || []);
    for (const t of a.mutates || []) if (!stateKeys.has(t) && !storeDomains.has(t)) D.push(diag('undeclared-mutation', `action "${name}" declares \`mutates ${t}\` but "${t}" is not a declared state`, { suggestion: closest(t, [...stateKeys]), from: t })); // mutates targets were unchecked → renaming/typo'ing a state left `mutates oldName` lint-clean but a runtime ReferenceError
    const actionScope = new Map<string, string>(a.params?.length ? a.params.map((p) => [p.name, p.type] as [string, string]) : (a.input ? [[a.input, ''] as [string, string]] : [])); // typed params (or legacy `<- input` var) are in scope
    const paramNames = new Set((a.params || []).map((p) => p.name)); // for the item-shadow collision rule
    const checkStmtInner = (st: Stmt): void => {
      // full ref-check on every expression in the body (was checkCalls-only before: undeclared refs/typos
      // shipped silently and crashed at runtime). Covers `if` conds, set/push args, remove predicates, refetch params.
      if (st.op === StOp.If) { checkExpr(st.cond, null, actionScope); for (const s of (st.then || [])) checkStmt(s); for (const s of (st.else || [])) checkStmt(s); return; }
      if (st.op === StOp.Call) { // composing a store action: target is a store domain, method is one of its actions
        if (!storeDomains.has(st.target)) D.push(diag('unknown-action', `"${st.target}.${st.method}(…)": "${st.target}" is not a store. A page action mutates LOCAL state with push/set/patch/…; only a STORE action can be called like this.`, { suggestion: closest(st.target, [...storeDomains]), from: st.target }));
        else if (!storeMemberMap.get(st.target)?.has(st.method)) D.push(diag('unknown-action', `store "${st.target}" has no member "${st.method}".`, { suggestion: closest(st.method, [...(storeMemberMap.get(st.target) || [])]), from: st.method }));
        for (const a of st.args) checkExpr(a, null, actionScope);
        return;
      }
      if (st.op === StOp.Extern) { // calling a use'd function as a side-effect: `persist(messages)` (no muten state mutated)
        if (!externs.has(st.fn)) D.push(diag('unknown-function', `"${st.fn}" is not a use'd function`, { suggestion: closest(st.fn, [...externs]), from: st.fn }));
        for (const a of st.args) checkExpr(a, null, actionScope);
        return;
      }
      if (!KNOWN_OPS.has(st.op)) {
        D.push(diag('unknown-op', `action "${name}" uses unknown op "${st.op}"`, { suggestion: closest(st.op, [...KNOWN_OPS]), from: st.op }));
      }
      if ('target' in st && st.target && !declared.has(st.target)) {
        D.push(diag('undeclared-mutation', `action "${name}" mutates "${st.target}" but only declares mutates(${[...declared].join(', ') || '∅'})`, { suggestion: closest(st.target, [...declared]), from: st.target }));
      }
      if (SOURCE_OPS.has(st.op) && 'target' in st && st.target) {            // create/update/delete/refetch hit the backend, so a source is required
        const def = doc.state?.[st.target];
        if (def && !def.source) D.push(diag('missing-source', `action "${name}": "${st.target}.${st.op}(…)" needs a query/source-backed list, but "${st.target}" is local (no source). Use \`= query <name>\` + a \`sources\` entry, or local ops (push/set/reset/remove).`, { from: st.target }));
      }
      if (st.op === StOp.Toggle) { // `favs.toggle(x)` toggles membership in a list<scalar>; `open.toggle()` flips a bool — the wrong shape silently corrupts state (e.g. `list.toggle()` does `set(![])` = false)
        const tt = doc.state?.[st.target]?.type || '';
        const elem = tt.startsWith('list<') ? tt.slice(5, -1) : '';
        if (st.arg !== undefined) {
          if (tt && !tt.startsWith('list<')) D.push(diag('toggle-arg', `action "${name}": \`${st.target}.toggle(x)\` toggles membership in a list, but "${st.target}" is "${tt}" — drop the arg to flip a bool, or target a \`list<scalar>\`.`, { from: st.target }));
          else if (elem && doc.entities?.[elem]) D.push(diag('toggle-arg', `action "${name}": \`${st.target}.toggle(x)\` works on a list of SCALARS (e.g. list<text>), not "${elem}" objects — for an entity list use \`push\` + \`remove where …\`.`, { from: st.target }));
        } else if (tt && tt !== 'bool') D.push(diag('toggle-arg', `action "${name}": \`${st.target}.toggle()\` flips a bool, but "${st.target}" is "${tt}" — pass a value to toggle list membership (\`${st.target}.toggle(x)\`), or use a bool state.`, { from: st.target }));
      }
      if ((st.op === StOp.Push || st.op === StOp.Create || st.op === StOp.Set) && st.arg) {
        // wrong type into an entity slot ships garbage: push/create a non-entity into list<Entity> gives `{...42}={}`
        // set an entity draft to a scalar: `d["name"]` on a string -> undefined (silent field corruption).
        const tt = doc.state?.[st.target]?.type || '';
        const slot = st.op === StOp.Set ? tt : (tt.startsWith('list<') ? tt.slice(5, -1) : '');
        if (slot && doc.entities?.[slot]) {
          const a = st.arg;
          if (a.kind === Ek.Obj) { // inline object literal: every key must be a real field of the entity
            const ent = doc.entities[slot];
            for (const f of a.fields) if (!(f.key in ent)) D.push(diag('unknown-field', `action "${name}": "${f.key}" is not a field of ${slot}`, { suggestion: closest(f.key, Object.keys(ent)), from: f.key }));
          } else {
            const at = a.kind === Ek.Lit ? (typeof a.value === 'number' ? 'number' : typeof a.value === 'boolean' ? 'bool' : 'text') : (a.kind === Ek.Ref && !a.name.includes('.') ? (doc.state?.[a.name]?.type || '') : '');
            if (at && at !== slot) D.push(diag(st.op === StOp.Set ? 'set-type' : 'push-type', st.op === StOp.Set
              ? `action "${name}": setting "${st.target}" (a ${slot} draft) to a ${at} — assign a ${slot} (a draft/state of that entity).`
              : `action "${name}": pushing a ${at} into list<${slot}> "${st.target}" — push a ${slot} (a draft/state of that entity).`));
          }
        }
      }
      if (st.op === StOp.Remove) { checkExpr(st.pred, null, itemPredScope(actionScope, st.target)); checkItemShadow(st.target, paramNames, [st.pred], null); } // `remove where id == x`: item fields bound bare
      else if (st.op === StOp.Patch) { // `patch where id == x with { field: val }`: fields read bare
        const lt = doc.state?.[st.target]?.type || '';
        const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
        const inner = itemPredScope(actionScope, st.target);
        checkExpr(st.pred, null, inner);
        checkExpr(st.patch, null, inner);
        checkItemShadow(st.target, paramNames, [st.pred, st.patch], null);
        if (elem && doc.entities?.[elem] && st.patch.kind === Ek.Obj) { const ent = doc.entities[elem]; for (const f of st.patch.fields) if (!(f.key in ent)) D.push(diag('unknown-field', `action "${name}": "${f.key}" is not a field of ${elem}`, { suggestion: closest(f.key, Object.keys(ent)), from: f.key })); }
      }
      else if (st.op === StOp.Refetch) { for (const v of Object.values(st.params)) checkExpr(v, null, actionScope); }
      else if (st.op === StOp.Request) {
        if (st.body) checkExpr(st.body, null, actionScope);
        if (st.into) { // `into <state>` captures the response: the target must be a declared + mutated state
          if (!stateKeys.has(st.into)) D.push(diag('undeclared-mutation', `action "${name}": \`into ${st.into}\` captures the response into "${st.into}" — not a declared state`, { suggestion: closest(st.into, [...stateKeys]), from: st.into }));
          else if (!declared.has(st.into)) D.push(diag('undeclared-mutation', `action "${name}" writes the response into "${st.into}" but only declares mutates(${[...declared].join(', ') || '∅'})`, { suggestion: closest(st.into, [...declared]), from: st.into }));
        }
        checkReqUrl(st);
      }
      else if ('arg' in st && st.arg) checkExpr(st.arg, null, actionScope);
    };
    // Pin every diagnostic to the statement's line. Inner checks push messages without a loc of their own
    // (they describe a whole op); backfilling here ensures the IDE/CLI points at `orders.create(...)`,
    // not at `screen home`. Nested if-branches resolve to their own line.
    const checkStmt = (st: Stmt): void => {
      const before = D.length;
      checkStmtInner(st);
      for (let i = before; i < D.length; i++) if (!D[i].loc) D[i].loc = st.loc ?? null;
    };
    for (const st of a.body || []) checkStmt(st);
  }

  // styling under the oracle: validate every class() name against the styling plugin's RESOLVED theme
  // (a class validator the plugin supplies, loaded by the orchestrator). Catches typos on theme tokens
  // and utilities (`bg-primaryy`) + suggests the closest. Only runs when a styling plugin is connected;
  // base apps leave class() as the raw escape (no validator to check against).
  if (ctx.classValidator?.available) {
    for (const n of Object.values(nodes)) {
      if (!Array.isArray(n.props.class)) continue;
      for (const c of n.props.class) {
        const cls = typeof c === 'string' ? c : 'name' in c ? c.name : null; // an interpolated token (`status-{x}`) has a dynamic value — can't validate statically
        if (cls === null) continue;
        for (const issue of ctx.classValidator.check(cls)) {
          D.push(diag('unknown-class', `class "${issue.cls}" is not a known class or theme token (define it in your stylesheet/theme, or fix the typo)`, { loc: n.loc, suggestion: issue.suggestion, from: issue.cls }));
        }
      }
    }
  }

  return { ok: D.length === 0, diagnostics: D };
}
