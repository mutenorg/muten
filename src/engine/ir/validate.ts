// validate: structured diagnostics over the flat Doc.
// Knows the whole vocabulary (types, tokens, state, ops, parts) and each-item scope, so every
// error is specific and suggests the closest candidate. The same Doc that compiles is validated,
// so the editor and build never disagree. Used by the live linter, `muten lint`, and the runner.

import { diag, closest } from '#engine/shared/diagnostics.js';
import { callDiagnostics, callValues, foreignNames, feedDiagnostics } from '#engine/ir/calls.js';
import { BUILTINS, RESERVED_NAMES } from '#engine/lang/manifest.js';
import { Ek, BOp, LIVE_CHANGE, THEME_REF, URL_STORE, FILE_MEMBERS, DEVICE_STORE, DEVICE_MEMBERS, LANG_STORE, LANG_MEMBERS, LANG_USE, TRANSLATE } from '#engine/shared/vocab.js';
import { exprListType, isKnownHead, getCycle, collectRefs, callReturns, type RefFacts, type KnownHeads } from '#engine/ir/refs.js';
import { leafChildren, reactListNodes } from '#engine/ir/leaf-children.js';
import { themeRefDiagnostics } from '#engine/ir/validate-schema.js';
import { a11yDiagnostics } from '#engine/ir/a11y.js';
import { checkActions } from '#engine/ir/validate-actions.js';
import { schemaDiagnostics, SCALARS } from '#engine/ir/validate-schema.js';
import { nodeWalker } from '#engine/ir/validate-nodes.js';
import type { Doc, FlatNode, ValidateCtx, ValidateResult, Diagnostic, Expr, CallFacts, DataElement, RequestStmt, Loc } from '#engine/shared/types.js';

/** What an async action exposes to a page: whether it is in flight, and how it failed. */
const ACTION_STATUS: ReadonlySet<string> = new Set(['pending', 'error']);
const STRINGY = ['text', 'string', 'email', 'uuid', 'date', 'password', 'textarea']; // string-backed scalars: expose `.length` (a text value's character count) for reactive length gates


// ctx.parts = known part names in the project (to suggest and validate instances)
// state names that hold a secret or a person's data: persisting them is flagged (see persist-sensitive below)
const SENSITIVE_PERSIST = /(token|secret|password|passwd|session|jwt|bearer|apikey|api_key|email|phone|address|postal|card|cvv|iban|dni|cedula|ssn)/i;

export function validate(doc: Doc, ctx: ValidateCtx = {}): ValidateResult {
  const D: Diagnostic[] = [];

  const stateKeys = new Set(Object.keys(doc.state || {}));
  const storeDomains = new Set(ctx.stores || []); // app-global store slices (cart.total, cart.add)
  if (!storeDomains.has(DEVICE_STORE)) storeDomains.add(DEVICE_STORE);   // `device.online`: the browser as a store, unless the app has its own
  const readsUrl = !storeDomains.has(URL_STORE) && !stateKeys.has(URL_STORE);   // `url.s` / `url.set({ s: "x" })`: the address bar, unless the app has its own
  if (readsUrl) storeDomains.add(URL_STORE);
  const readsTheme = !!ctx.themeValues && !storeDomains.has(THEME_REF) && !stateKeys.has(THEME_REF);   // `theme.colors.primary`
  if (readsTheme) storeDomains.add(THEME_REF);
  const speaks = !!ctx.translations && !storeDomains.has(LANG_STORE);      // src/lang/*.lang: `lang.current`, `lang.use("en")`, t("key")
  if (speaks) storeDomains.add(LANG_STORE);
  const constNames = new Set(Object.keys(doc.consts || {})); // compile-time constants
  const paramNames = new Set(doc.params || []);              // route params (`param id`)
  const actionNames = new Set(Object.keys(doc.actions || {})); // needed for `action.pending` / `action.error` refs
  const getNames = new Set(Object.keys(doc.gets || {})); // derived values, referenceable like state (page or store)
  // callable in expressions: the built-in formatting fns, use'd functions (not components from npm) and this file's gets
  // that take parameters (`get initials(name) = …`)
  const fns = doc.fns || {};
  const ownsT = (doc.imports || []).some((def) => def.names.includes(TRANSLATE)) || TRANSLATE in fns;   // a `use t` of its own (Storio's i18n.ts)
  const externs = new Set([...BUILTINS, ...(doc.imports || []).filter((i) => !i.kind).flatMap((i) => i.names), ...Object.keys(fns), ...(ctx.translations ? [TRANSLATE] : [])]);
  // Anchor targets this page declares (`Section id("features")`), so a `Link -> "#features"` can be PROVEN to land.
  const anchorIds = new Set<string>();
  for (const node of Object.values(doc.nodes || {})) { const nodeId = node.props?.id; if (nodeId) anchorIds.add(nodeId); }
  const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;   // http:, mailto:, tel:, protocol-relative — outside the closed world
  // A static href matches a declared route when the segment counts agree and every declared `:param` acts as a
  // wildcard — the same rule the runtime's matchRoute applies, so `-> "/product/42"` satisfies `"/product/:pid"`.
  const routeExists = (href: string): boolean => {
    const parts = href.replace(/^\//, '').split('/').filter(Boolean);
    return (ctx.routes || []).some((url) => {
      const segs = url.replace(/^\//, '').split('/').filter(Boolean);
      return segs.length === parts.length && segs.every((seg, i) => seg[0] === ':' || seg === parts[i]);
    });
  };
  // the SHARED resolver's inputs — the SAME facts the emitter holds, so lint and runtime can't disagree on what resolves.
  const refFacts: RefFacts = { state: doc.state || {}, gets: doc.gets || {}, entities: doc.entities || {}, storeEntities: ctx.storeEntities, fns: doc.fns, calls: callReturns(doc.imports) };
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
    const why = name.startsWith('__') ? 'the `__` prefix is reserved for runtime internals' : `"${name}" is a runtime function`;
    D.push(diag('reserved-name', `${kind} "${name}" collides with a built-in runtime name (${why}) — it compiles to a duplicate declaration and blanks the page. Rename it, e.g. "${name}Value".`, { loc, from: name }));
  };
  for (const [name, def] of Object.entries(doc.state || {})) checkReserved(name, 'state', def.loc ?? null);
  // `persist` writes to localStorage, which EVERY script on the page reads: one XSS anywhere (a library, an analytics tag)
  // takes a token or a customer's details. Not an error (a remembered tab is fine), a warning with the safe way.
  for (const [name, def] of Object.entries(doc.state || {})) {
    if (!def.persist || !SENSITIVE_PERSIST.test(name)) continue;
    D.push(diag('persist-sensitive', `"${name}" is persisted to localStorage, where any script on the page can read it. A session belongs in an httpOnly cookie the backend sets (\`api { credentials "include" }\` sends it, no script ever sees it); personal data (email, phone, address) belongs on the server, fetched when needed.`, { loc: def.loc ?? null, severity: 'warning' }));
  }
  for (const name of Object.keys(doc.gets || {})) checkReserved(name, 'get', null);
  for (const [name, fn] of Object.entries(fns)) checkReserved(name, 'get', fn.loc ?? null);
  for (const [name, a] of Object.entries(doc.actions || {})) checkReserved(name, 'action', a.body?.[0]?.loc ?? null);

  // a call must name something callable (a built-in, a `use`'d function, a `get name(…)` here or in a store) with its arity
  for (const def of doc.imports || []) if (def.server) D.push(diag('server-package', def.server, { loc: def.loc ?? null, from: def.from }));
  const foreign = foreignNames(doc);   // what came from npm: its own methods and chains pass through (calls.ts)
  const callFacts: CallFacts = { externs, foreign, fns, storeFns: ctx.storeFns, stores: storeDomains, arity: Object.assign({}, ...(doc.imports || []).map((def) => def.arity || {})),
    translations: ownsT ? undefined : ctx.translations };
  const checkCalls = (expr: Expr, loc?: Loc | null): void => { D.push(...callDiagnostics(expr, loc ?? null, callFacts)); };

  // Closed member sets catch typos in a dotted ref. A query state exposes {loading,error,data} plus (if
  // entity-typed) its fields; a store exposes its state/gets/actions (threaded in by lintApp, cross-file).
  const queryMembers = new Map<string, Set<string>>();
  for (const [name, def] of Object.entries(doc.state || {})) {
    if (!def.source?.startsWith('query:') || (def.call && !def.type)) continue;   // what a package gave back: its own members
    const allowed = new Set(['loading', 'error', 'data']);
    const entity = doc.entities?.[def.type];
    if (entity) { allowed.add('id'); for (const f of Object.keys(entity)) allowed.add(f); }
    queryMembers.set(name, allowed);
  }
  const storeMemberMap = new Map<string, Set<string>>();
  for (const [d, ms] of Object.entries(ctx.storeMembers || {})) storeMemberMap.set(d, new Set(ms));
  if (!storeMemberMap.has(DEVICE_STORE)) storeMemberMap.set(DEVICE_STORE, new Set(DEVICE_MEMBERS));
  if (speaks) storeMemberMap.set(LANG_STORE, new Set([...LANG_MEMBERS, LANG_USE]));
  const storeActionMap = new Map<string, Set<string>>();
  for (const [d, actions] of Object.entries(ctx.storeActions || {})) storeActionMap.set(d, new Set(actions));
  if (speaks) storeActionMap.set(LANG_STORE, new Set([LANG_USE]));
  const checkMember = (head: string, member: string, loc: Loc | null, status?: string): void => {
    if (readsTheme && head === THEME_REF && ctx.themeValues) { D.push(...themeRefDiagnostics(ctx.themeValues, status === undefined ? [member] : [member, status], loc)); return; }
    // a store action read like a value (`items.add.done`): it exposes only .pending / .error. It compiled and threw
    // «items is not defined» when the page opened, an error that blamed the store, not the property.
    if (status !== undefined && storeActionMap.get(head)?.has(member) && !ACTION_STATUS.has(status)) {
      D.push(diag('unknown-member', `store action "${head}.${member}" exposes only .pending / .error, not "${status}"`, { loc, suggestion: closest(status, [...ACTION_STATUS]), from: status }));
      return;
    }
    const q = queryMembers.get(head);
    if (q) { if (!q.has(member)) D.push(diag('unknown-member', `"${member}" is not a member of query "${head}"`, { loc, suggestion: closest(member, [...q]), from: member })); return; }
    const s = storeMemberMap.get(head);
    if (s && !s.has(member)) {
      // `donors.length` / `donors.count` — a LIST operation aimed at the store instead of its list member (the classic
      // trap when the store and its list share a name, `donors.donors`). Point at the list, not just "unknown member".
      const listOp = ['length', 'count', 'sum', 'avg', 'min', 'max'].includes(member);
      const hint = listOp ? ` — \`${member}\` operates on a LIST, not the store: use \`${head}.<list>.${member}\` (members: ${[...s].join(', ')}), or add a \`get\` in the store (e.g. \`get ${member === 'length' ? 'count' : member} = <list>.${member}\`).` : '';
      D.push(diag('unknown-member', `"${member}" is not a member of store "${head}"${hint}`, { loc, suggestion: closest(member, [...s]), from: member }));
    }
  };

  // the schema: state types, entity field types, constraints that fit their field (validate-schema.ts)
  D.push(...schemaDiagnostics(doc));

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
    // a state's type, or what a `get` (a filter, a sort, a `get name(…)` call, a typed `use`) is a list of: the SAME
    // resolver compile uses. A `get` used to be left untyped here, so its rows' fields went unchecked.
    const t = (name ? doc.state?.[name.split('.')[0]]?.type : '') || exprListType(e, refFacts, new Set());
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
  const dataElement = (d: string): DataElement => {
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
    else if (e.kind === Ek.List) for (const item of e.items) checkArith(item, loc, scope);
    else if (e.kind === Ek.Call) for (const a of callValues(e)) checkArith(a, loc, scope);
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
      else if (e.kind === Ek.List) for (const item of e.items) aggWalk(item);
      else if (e.kind === Ek.Call) for (const a of callValues(e)) aggWalk(a);
    };
    aggWalk(expr);
    checkCalls(expr, loc); // `use`'d function calls must be declared
    for (const ref of collectRefs(expr)) {
      const dot = ref.indexOf('.');
      const head = dot === -1 ? ref : ref.slice(0, dot);
      if (!isKnownHead(head, (x) => scope.has(x), knownHeads) && !foreign.has(head)) {   // a package's value (`defaultConfig`) is its own
        // `auth.signedIn` with no `auth`: a dotted ref reaches into something — a store, a row, a state — so name what exists
        // (a bare word with no close state, `status == todo`, is almost always a text value meant to be quoted)
        const dotted = dot !== -1;
        const near = closest(head, [...stateKeys, ...scope.keys(), ...(dotted ? storeDomains : [])]);
        const why = dotted
          ? `"${head}" is not a store, a state or an item variable here${storeDomains.size ? ` (stores: ${[...storeDomains].join(', ')})` : ' (the app has no .store files)'}`
          : `"${head}" is not a known state or item variable here${near ? '' : ` — if it's a text/enum value, quote it: "${head}"; a literal \`{${head}}\` inside a text (a URL template like a map's tiles) is written \`{{${head}}}\``}`;
        D.push(diag('unknown-ref', why, { loc, suggestion: near, from: head }));
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
        if (t === 'file') { if (!FILE_MEMBERS.includes(member)) D.push(diag('unknown-member', `"${head}" is a file: it tells its ${FILE_MEMBERS.join(', ')}`, { loc, suggestion: closest(member, [...FILE_MEMBERS]), from: member })); }
        else if (!(member === 'length' && STRINGY.includes(t))) D.push(diag('unknown-member', `"${head}" is a ${t} — it has no field "${member}"${STRINGY.includes(t) ? ' (a text value exposes only .length)' : ''}`, { loc }));
      } else if (actionNames.has(head) && !stateKeys.has(head)) {
        if (!ACTION_STATUS.has(member)) D.push(diag('unknown-member', `action "${head}" exposes only .pending / .error, not "${member}"`, { loc, suggestion: closest(member, [...ACTION_STATUS]), from: member }));
      } else if (t.startsWith('list<')) {
        // a list exposes only .length (plus .data/.loading/.error if it's a query), not arbitrary fields.
        // Reading an element's field (`x.price`) is the bug: iterate with `each x as item` instead.
        const isQuery = !!doc.state?.[head]?.source;
        const ok = isQuery ? new Set(['length', 'data', 'loading', 'error']) : new Set(['length']);
        if (!ok.has(member)) D.push(diag('unknown-member', `"${head}" is a list — no member "${member}" (lists expose ${isQuery ? '.length / .data / .loading / .error' : 'only .length'}; use \`each ${head} as item\` to read an element)`, { loc, suggestion: closest(member, [...ok]), from: member }));
      } else {
        checkMember(head, member, loc, ref.slice(dot + 1).split('.')[1]); // typo'd query/store member (and a store action's status)
      }
    }
  };

  // node tree: known type, required props, valid style tokens, resolvable expression refs
  const seen = new Set<string>();
  const walk = nodeWalker({ D, doc, ctx, nodes, stateKeys, storeDomains, anchorIds, seen, EXTERNAL, checkExpr, checkAction, checkRef, dataElement, listElem, routeExists });
  if (doc.rootId) walk(doc.rootId, new Map());
  // a page (has `screen`) needs one root node; a parts/app/empty file has no screen and no page root.
  else if (ctx.kind !== 'store' && doc.screen) D.push(diag('no-root', `page "${doc.screen}" has no root node: a page needs one top-level node, e.g. Page { ... }`));

  // `get` (a derived/computed value) and `effect` (a side-effect that runs on mount and re-runs on its reactive
  // deps) are valid on a PAGE and in a .store alike. Every expression resolves against this file's own state, so
  // a member typo / bad ref in a `get` or `effect {}` is caught here, never shipped as a runtime ReferenceError.
  // (Page effects are the home for on-mount side effects — initializing a 3rd-party SDK, analytics, focus.)
  for (const [name, expr] of Object.entries(doc.gets || {})) checkExpr(expr, doc.getLocs?.[name] ?? null, new Map());

  // a query that comes from a function: the function exists (a `use`, a `get name(…)`), and its args are expressions here
  for (const def of Object.values(doc.state || {})) {
    if (!def.call) continue;
    // `live`: muten hands the function its callback, as the last value it takes
    checkCalls({ ...def.call, args: def.live ? [...def.call.args, { kind: Ek.Lit, value: null }] : def.call.args }, def.loc ?? null);
    for (const arg of callValues(def.call)) checkExpr(arg, def.loc ?? null, new Map());
  }
  for (const def of Object.values(doc.state || {})) if (def.feed) D.push(...feedDiagnostics(def.feed, def.loc ?? null, foreign, (expr) => { checkCalls(expr, def.loc ?? null); checkExpr(expr, def.loc ?? null, new Map([[LIVE_CHANGE, '']])); }));
  // a get with parameters: its body reads its parameters (in scope) and whatever a get may read
  for (const fn of Object.values(fns)) checkExpr(fn.body, fn.loc ?? null, new Map(fn.params.map((param): [string, string] => [param, ''])));
  // gets must not form a cycle: a self/mutual reference can never settle (and `a` reads `b` reads `a` has no order
  // to emit them in). The order itself is the compiler's (getOrder), so a get may read one declared below it.
  {
    const cycle = getCycle(refFacts);
    if (cycle.length) D.push(diag('get-cycle', `get "${cycle[0]}" depends on itself: ${cycle.join(' → ')}. A get can't read itself, directly or through another get.`, { from: cycle[0] }));
  }
  // effects and actions: what each statement may touch, how it is called, what it reads (validate-actions.ts)
  checkActions({ D, doc, ctx, checkExpr, itemPredScope, checkItemShadow, checkReqUrl, stateKeys, storeDomains, storeMemberMap, externs, foreign, actionNames });

  D.push(...a11yDiagnostics(nodes));   // names a screen reader can say, one h1 (a11y.ts)

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

  // `ok` means "nothing here BLOCKS a build" — not "nothing was found". A warning is a real finding the author must
  // see, but it must never fail `muten dev`/`bundle`/`build`. Every consumer keys off this flag, so if severity is not
  // honoured HERE it is decorative everywhere: the first warning validate ever emitted broke the whole showcase.
  D.push(...leafChildren(doc), ...reactListNodes(doc));
  return { ok: !D.some((d) => d.severity === 'error'), diagnostics: D };
}
