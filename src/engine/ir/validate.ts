// validate — structured diagnostics over the flat Doc (the validation stage of the pipeline).
//
// Because it knows the WHOLE vocabulary (types, tokens, state, ops, parts) and the scope of each
// `each` item, every error is specific and proposes the closest candidate ("did you mean …?"). The
// same Doc that compiles is the one validated, so the editor and the build never disagree. Consumed
// by the live linter, the CLI's `muten lint`, and the Vite plugin.

import { resolveToken, SUGGESTED, defaultTheme, isKnownTokenShape } from '#engine/style/tokens.js';
import { diag, closest } from '#engine/shared/diagnostics.js';
import { PRIMITIVE_NAMES, ACTION_OPS, PRIMITIVES } from '#engine/lang/manifest.js';
import { Nt, Ek, StOp, BOp } from '#engine/shared/vocab.js';
import type { Doc, FlatNode, ValidateCtx, ValidateResult, Diagnostic, Expr, Stmt, StringPropValue, Loc } from '#engine/shared/types.js';

const KNOWN_TYPES = new Set<string>([...PRIMITIVE_NAMES, Nt.Shell]); // manifest primitives + the Shell wrapper (app.muten root)
const REF_PROPS: Array<'bind' | 'data'> = ['bind', 'data']; // props whose value is @state
const KNOWN_OPS = new Set<string>(ACTION_OPS);
const SOURCE_OPS = new Set<string>([StOp.Create, StOp.Update, StOp.Delete, StOp.Refetch]); // these talk to a backend → the list MUST be query/source-backed
const SCALARS = ['text', 'number', 'bool', 'uuid', 'email', 'string'];

// collect the variable names referenced by an expression AST
function collectRefs(e: Expr, acc: string[] = []): string[] {
  if (e.kind === Ek.Ref) acc.push(e.name);
  else if (e.kind === Ek.Un) collectRefs(e.operand, acc);
  else if (e.kind === Ek.Bin) { collectRefs(e.left, acc); collectRefs(e.right, acc); }
  else if (e.kind === Ek.Tern) { collectRefs(e.cond, acc); collectRefs(e.then, acc); collectRefs(e.else, acc); }
  else if (e.kind === Ek.Call) { for (const a of e.args) collectRefs(a, acc); } // args' refs; the fn is checked separately
  else if (e.kind === Ek.Obj) { for (const f of e.fields) collectRefs(f.value, acc); }
  else if (e.kind === Ek.Agg) acc.push(e.list); // the LIST is an outer ref; the body's refs use the lambda var → checked separately
  else if (e.kind === Ek.Filter) acc.push(e.list); // the LIST is an outer ref; the cond's bare fields are item-implicit → checked separately
  return acc;
}

// collect the names of `use`'d functions called in an expression (the fn of each call, recursively)
function collectCalls(e: Expr, acc: string[] = []): string[] {
  if (e.kind === Ek.Call) { acc.push(e.fn); for (const a of e.args) collectCalls(a, acc); }
  else if (e.kind === Ek.Un) collectCalls(e.operand, acc);
  else if (e.kind === Ek.Bin) { collectCalls(e.left, acc); collectCalls(e.right, acc); }
  else if (e.kind === Ek.Tern) { collectCalls(e.cond, acc); collectCalls(e.then, acc); collectCalls(e.else, acc); }
  else if (e.kind === Ek.Obj) { for (const f of e.fields) collectCalls(f.value, acc); }
  else if (e.kind === Ek.Filter) collectCalls(e.cond, acc); // the cond may call use'd functions too
  return acc;
}

// ctx.parts = known part names in the project (to suggest and validate instances)
export function validate(doc: Doc, ctx: ValidateCtx = {}): ValidateResult {
  const D: Diagnostic[] = [];

  const stateKeys = new Set(Object.keys(doc.state || {}));
  const storeDomains = new Set(ctx.stores || []); // app-global store slices (cart.total, cart.add)
  const constNames = new Set(Object.keys(doc.consts || {})); // compile-time constants
  const paramNames = new Set(doc.params || []);              // route params (`param id`)
  const actionNames = new Set(Object.keys(doc.actions || {})); // for `action.pending` / `action.error` refs
  const getNames = new Set(Object.keys(doc.gets || {})); // derived values — referenceable like state (page or store)
  const externs = new Set((doc.imports || []).flatMap((i) => i.names)); // logic functions callable in exprs
  const nodes = doc.nodes || {};

  // a `use`'d function call must reference a declared import (the seam to JS stays bounded + checkable)
  const checkCalls = (expr: Expr, loc?: Loc | null): void => {
    for (const fn of collectCalls(expr)) {
      if (!externs.has(fn)) D.push(diag('unknown-function', `"${fn}" is not a use'd function`, { loc, suggestion: closest(fn, [...externs]), from: fn }));
    }
  };

  // CLOSED member sets → catch typos in a dotted ref. A query state exposes {loading,error,data} + (if it's
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

  // ── state types: a `list` must declare its element (the north star — always know what's inside) ──
  const entityNames = Object.keys(doc.entities || {});
  for (const [name, def] of Object.entries(doc.state || {})) {
    const t = def.type;
    if (def.source?.startsWith('query:') && t !== 'list' && !t.startsWith('list<')) {
      // a query's data is ALWAYS an array — a single-record type silently renders empty (no fetch-one).
      D.push(diag('query-not-list', `state "${name}" is a query but typed "${t}" — a query returns a LIST (the data is an array). Use \`list<${t}>\` and read it with \`each\`. (Single-record fetch isn't supported in muten.)`, { loc: def.loc, suggestion: `list<${t}>` }));
    }
    if (t === 'list') {
      D.push(diag('untyped-list', `state "${name}" is an untyped "list" — declare the element type, e.g. list<uuid> or list<User>`, { loc: def.loc, suggestion: 'list<uuid>' }));
    } else if (t.startsWith('list<')) {
      const elem = t.slice(5, -1);
      if (!SCALARS.includes(elem) && !entityNames.includes(elem)) {
        D.push(diag('unknown-type', `list element "${elem}" is not a known entity or scalar type`, { loc: def.loc, suggestion: closest(elem, [...entityNames, ...SCALARS]), from: elem }));
      }
    } else if (def.initial !== undefined && def.initial !== null) {
      // a scalar state's initial value must match its declared type (e.g. `count = "" : number` is wrong)
      const want = t === 'number' ? 'number' : t === 'bool' ? 'boolean' : (['text', 'string', 'email', 'uuid'].includes(t) ? 'string' : '');
      if (want && typeof def.initial !== want) {
        D.push(diag('type-mismatch', `state "${name}" is typed "${t}" but its initial value is a ${typeof def.initial}`, { loc: def.loc }));
      }
    }
  }

  // an `each` item carries the element type of its list (an entity name), so a field typo on the loop var
  // is caught exactly like one on @state — `each users as u { Text "{u.naem}" }` → "naem" not a field of User.
  const entityFieldSet = (type: string): Set<string> | null => {
    const ent = doc.entities?.[type];
    return ent ? new Set(['id', ...Object.keys(ent)]) : null;
  };
  // the predicate scope for `remove`/`patch`: legacy `=>` binds its var (typed elem); the item-implicit
  // `where` form binds the element's fields BARE (id + entity fields), like the `where`-filter / aggregates.
  const itemPredScope = (base: Map<string, string>, target: string): Map<string, string> => {
    const lt = doc.state?.[target]?.type || '';
    const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
    const m = new Map(base);
    const ent = elem ? doc.entities?.[elem] : undefined;
    if (ent) { m.set('id', 'uuid'); for (const [f, ft] of Object.entries(ent)) m.set(f, ft); }
    return m;
  };
  // THE COLLISION RULE for item-implicit `where`/`by`/`with`: a bare name that is BOTH an item field AND an
  // action param resolves to the FIELD (item wins), silently making the param unreachable — e.g.
  // `remove where id == id` deletes everything. Make it an error with a rename fix, so the intent stays explicit.
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
  const listElem = (e: Expr | undefined): string => { // the element TYPE of `each <list>` (entity or scalar; '' if unresolved)
    if (!e) return '';
    const name = e.kind === Ek.Ref ? e.name
      : (e.kind === Ek.Agg && (e.op === 'sort' || e.op === 'sortDesc')) ? e.list // `each list.sort(…) as x` → the sorted list's element
      : e.kind === Ek.Filter ? e.list                                            // `each (list where cond) as x` → the filtered list's element
      : '';
    if (!name) return '';
    const t = doc.state?.[name.split('.')[0]]?.type || '';
    return t.startsWith('list<') ? t.slice(5, -1) : '';
  };

  const checkRef = (value: string | undefined, node: FlatNode): void => {
    if (typeof value === 'string' && value.startsWith('@')) {
      const name = value.slice(1).split('.')[0];
      if (!stateKeys.has(name) && !storeDomains.has(name)) { // `@store.member` is a valid bind target too
        const near = closest(name, [...stateKeys]);
        D.push(diag('unknown-ref', `"@${name}" is not a declared state`, { loc: node.loc, suggestion: near ? '@' + near : null, from: '@' + name, related: near ? doc.state?.[near]?.loc ?? null : null }));
      }
    }
  };

  // an action ref (`-> action`, `submit action`): a bare name must be a declared action. Dotted (store
  // action, `cart.add`) and $param (part callback) refs resolve elsewhere (cross-file / compose) — skip.
  const checkAction = (value: string | undefined, node: FlatNode): void => {
    if (!value || value.startsWith('$')) return;
    if (value.includes('.')) { const dot = value.indexOf('.'); checkMember(value.slice(0, dot), value.slice(dot + 1).split('.')[0], node.loc ?? null); return; } // store action (cart.add)
    if (!actionNames.has(value)) {
      D.push(diag('unknown-action', `"${value}" is not a declared action`, { loc: node.loc, suggestion: closest(value, [...actionNames]), from: value }));
    }
  };

  // the type of an expression WHEN we can resolve it confidently — '' otherwise (so callers never flag on a guess).
  const exprType = (e: Expr, scope: Map<string, string>): string => {
    if (e.kind === Ek.Lit) return typeof e.value === 'number' ? 'number' : typeof e.value === 'boolean' ? 'bool' : 'text';
    if (e.kind === Ek.Ref) {
      const [head, ...rest] = e.name.split('.');
      const t = scope.has(head) ? (scope.get(head) || '') : (doc.state?.[head]?.type || '');
      if (!rest.length) return t;
      return (rest.length === 1 && doc.entities?.[t]?.[rest[0]]) || ''; // an entity field's type (deeper / non-entity → unknown)
    }
    if (e.kind === Ek.Agg) return (e.op === 'sort' || e.op === 'sortDesc') ? '' : 'number'; // aggregates → number; sort → a list (don't infer)
    return ''; // bin/call/obj/tern/un → don't infer
  };
  // arithmetic `- * /` on a NON-number operand → NaN at runtime. `+` is also string concat, so it's left alone.
  const checkArith = (e: Expr, loc: Loc | null, scope: Map<string, string>): void => {
    if (e.kind === Ek.Bin) {
      if (e.op === BOp.Sub || e.op === BOp.Mul || e.op === BOp.Div) for (const side of [e.left, e.right]) {
        const t = exprType(side, scope);
        if (t && t !== 'number') D.push(diag('arith-type', `arithmetic \`${e.op}\` needs numbers, but an operand is "${t}" — declare it \`: number\`.`, { loc }));
      }
      // comparing two KNOWN, incompatible types is always false/true — the classic `when step == "1"` (a number
      // state vs a quoted string) silently never matches. null compares with anything, so it's exempt.
      if ([BOp.Eq, BOp.Neq, BOp.Lt, BOp.Gt, BOp.Lte, BOp.Gte].includes(e.op) && !(e.left.kind === Ek.Lit && e.left.value === null) && !(e.right.kind === Ek.Lit && e.right.value === null)) {
        const norm = (t: string): string => (t === 'number' || t === 'bool') ? t : (t.startsWith('enum:') || ['text', 'string', 'email', 'uuid'].includes(t)) ? 'text' : t;
        const lt = exprType(e.left, scope), rt = exprType(e.right, scope);
        if (lt && rt && norm(lt) !== norm(rt)) D.push(diag('compare-type', `comparing a ${lt} to a ${rt} — they never match (always ${e.op === BOp.Neq ? 'true' : 'false'}). Likely a quoted number (\`== "1"\` vs \`== 1\`) or a type mismatch.`, { loc }));
      }
      checkArith(e.left, loc, scope); checkArith(e.right, loc, scope);
    } else if (e.kind === Ek.Un) checkArith(e.operand, loc, scope);
    else if (e.kind === Ek.Tern) { checkArith(e.cond, loc, scope); checkArith(e.then, loc, scope); checkArith(e.else, loc, scope); }
    else if (e.kind === Ek.Obj) for (const f of e.fields) checkArith(f.value, loc, scope);
    else if (e.kind === Ek.Call) for (const a of e.args) checkArith(a, loc, scope);
  };

  // validate the variables an expression uses against (item scope ∪ state). `scope` maps an in-scope item
  // variable to its entity type ('' if not an entity list), so we can field-check the loop var too.
  const checkExpr = (expr: Expr, loc: Loc | null, scope: Map<string, string>): void => {
    checkArith(expr, loc, scope);
    // list aggregates: the LIST must be a list; the body resolves with the lambda var bound to the element type.
    const aggWalk = (e: Expr): void => {
      if (e.kind === Ek.Agg) {
        const head = e.list.split('.')[0];
        const lt = scope.has(head) ? (scope.get(head) || '') : (doc.state?.[head]?.type || '');
        const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
        if (lt && !lt.startsWith('list<') && !storeDomains.has(head)) D.push(diag('agg-not-list', `\`${e.op} …\` needs a list, but "${e.list}" is "${lt}".`, { loc }));
        const bodyScope = new Map(scope);
        const ent = elem ? doc.entities?.[elem] : undefined;
        if (ent) { bodyScope.set('id', 'uuid'); for (const [f, ft] of Object.entries(ent)) bodyScope.set(f, ft); } // `by`/`where`: bind element fields bare (item-implicit)
        // sum/avg/min/max reduce a NUMBER projection (a `min` over text strings → Math.min(…,"2026-07") = NaN);
        // count's body is a true/false condition, so it's exempt.
        if (e.op !== 'count' && e.op !== 'sort' && e.op !== 'sortDesc') { const bt = exprType(e.body, bodyScope); if (bt && bt !== 'number') D.push(diag('agg-type', `\`${e.op} …\` reduces a NUMBER, but the body is "${bt}". Use a number projection (count uses a true/false condition).`, { loc })); }
        checkExpr(e.body, loc, bodyScope);
        return; // collectRefs already skips the body (the item fields aren't in the outer scope)
      }
      if (e.kind === Ek.Filter) { // derived list `<list> where <cond>`: the LIST must be a list; the cond's bare fields are the element's
        const head = e.list.split('.')[0];
        const lt = scope.has(head) ? (scope.get(head) || '') : (doc.state?.[head]?.type || '');
        const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
        if (lt && !lt.startsWith('list<') && !storeDomains.has(head)) D.push(diag('filter-not-list', `\`${e.list} where …\` needs a list, but "${e.list}" is "${lt}".`, { loc }));
        // bind each element field as a bare in-scope name (typed), so the cond's `status == "todo"` field-/type-checks
        const ent = elem ? doc.entities?.[elem] : undefined;
        const condScope = new Map(scope);
        if (ent) { condScope.set('id', 'uuid'); for (const [f, ft] of Object.entries(ent)) condScope.set(f, ft); }
        checkExpr(e.cond, loc, condScope);
        return; // collectRefs already skips the cond (its bare fields aren't in the outer scope)
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
      if (!(scope.has(head) || stateKeys.has(head) || getNames.has(head) || storeDomains.has(head) || constNames.has(head) || paramNames.has(head) || actionNames.has(head))) {
        const near = closest(head, [...stateKeys, ...scope.keys()]);
        // a bare word with no close state is almost always a meant-to-be-quoted text/enum value (`status == todo`)
        D.push(diag('unknown-ref', `"${head}" is not a known state or item variable here${near ? '' : ` — if it's a text/enum value, quote it: "${head}"`}`, { loc, suggestion: near, from: head }));
        continue;
      }
      if (dot === -1) continue;
      const member = ref.slice(dot + 1).split('.')[0];
      // the head's element/value type: an `each` item (scope) or a state cell. Field-check entities; a scalar
      // has no fields at all; everything else (query / store / list) falls back to the closed member-set check.
      const t = scope.has(head) ? (scope.get(head) || '') : (doc.state?.[head]?.type || '');
      const fields = entityFieldSet(t);
      if (fields) {
        if (!fields.has(member)) D.push(diag('unknown-member', `"${member}" is not a field of ${t} (${scope.has(head) ? 'item' : 'state'} "${head}")`, { loc, suggestion: closest(member, [...fields]), from: member }));
        else { // depth-2+ chain `c.field.sub`: entity fields are scalars/enums (no sub-fields), so `.sub` is invalid unless the field is ITSELF an entity
          const sub = ref.slice(dot + 1).split('.')[1];
          const ft = doc.entities?.[t]?.[member] || '';
          if (sub && !doc.entities?.[ft]) D.push(diag('unknown-member', `"${member}" is ${ft.startsWith('enum:') ? 'an enum' : `a ${ft}`} — it has no field "${sub}"`, { loc, from: sub }));
        }
      } else if (SCALARS.includes(t)) {
        D.push(diag('unknown-member', `"${head}" is a ${t} — it has no field "${member}"`, { loc }));
      } else if (actionNames.has(head) && !stateKeys.has(head)) {
        const am = new Set(['pending', 'error']); // an async action exposes only .pending / .error
        if (!am.has(member)) D.push(diag('unknown-member', `action "${head}" exposes only .pending / .error, not "${member}"`, { loc, suggestion: closest(member, [...am]), from: member }));
      } else if (t.startsWith('list<')) {
        // a list exposes only .length (and .data/.loading/.error if it's a query) — NOT arbitrary fields.
        // Reading an element's field (`x.price`) is the bug we catch: iterate with `each x as item` instead.
        const isQuery = !!doc.state?.[head]?.source;
        const ok = isQuery ? new Set(['length', 'data', 'loading', 'error']) : new Set(['length']);
        if (!ok.has(member)) D.push(diag('unknown-member', `"${head}" is a list — no member "${member}" (lists expose ${isQuery ? '.length / .data / .loading / .error' : 'only .length'}; use \`each ${head} as item\` to read an element)`, { loc, suggestion: closest(member, [...ok]), from: member }));
      } else {
        checkMember(head, member, loc); // typo'd query/store member
      }
    }
  };

  // ── the node tree: known type · required props · valid style tokens · resolvable expression refs ──
  const seen = new Set<string>();
  const walk = (id: string, scope: Map<string, string>, inTable = false): void => {
    const n = nodes[id];
    if (!n) { D.push(diag('missing-node', `node ${id} does not exist`)); return; }
    if (seen.has(id)) { D.push(diag('dup-node', `${id} is referenced twice`, { loc: n.loc })); return; }
    seen.add(id);
    if (n.type === 'RowAction' && !inTable) D.push(diag('rowaction-context', 'RowAction only works inside a DataTable (it renders a button per row). Use Button for a standalone action.', { loc: n.loc })); // else compile throws "unsupported primitive"

    if (!KNOWN_TYPES.has(n.type)) {
      if (n.args) {
        D.push(diag('unknown-part', `"${n.type}" is not a known part`, { loc: n.loc, suggestion: closest(n.type, [...(ctx.parts || [])]), from: n.type }));
      } else {
        D.push(diag('unknown-type', `"${n.type}" is not a known primitive`, { loc: n.loc, suggestion: closest(n.type, [...KNOWN_TYPES]), from: n.type }));
      }
    } else {
      // required props from the manifest (the ones NOT ending in "?")
      const prim = PRIMITIVES[n.type];
      const spec = prim ? prim.props : {};
      for (const [pname, hint] of Object.entries(spec)) {
        if (!hint.endsWith('?') && !(pname in (n.props || {}))) {
          D.push(diag('missing-prop', `${n.type} is missing the required "${pname}"`, { loc: n.loc }));
        }
      }
    }

    const props = n.props || {};
    for (const rp of REF_PROPS) if (rp in props) checkRef(props[rp], n);
    if (props.action) {
      checkAction(props.action, n);
      // `-> action` / `-> action()` where the action declares `<- input` → the call passes nothing → the body
      // reads `undefined` (e.g. `p.id` → TypeError). Require the arg. (store actions: input unknown here → skip.)
      if (typeof props.action === 'string' && !props.action.includes('.') && (doc.actions?.[props.action]?.input || doc.actions?.[props.action]?.params?.length) && props.arg === undefined)
        D.push(diag('action-arity', `action "${props.action}" takes an argument (it reads "${doc.actions[props.action].params?.length ? doc.actions[props.action].params!.map((p) => p.name).join(', ') : doc.actions[props.action].input}") — pass it, e.g. \`-> ${props.action}(row)\``, { loc: n.loc }));
    }
    if (props.submit) checkAction(props.submit, n);
    if (Array.isArray(props.class)) for (const c of props.class) if (typeof c === 'string' && c.includes('{')) // class() does NOT interpolate — it would ship the literal braces into the DOM class
      D.push(diag('class-interp', `class() does not interpolate "{…}": "${c}" would ship the braces literally. For a dynamic class use \`class(name when cond)\` (e.g. \`class(stage-applied when status == "applied")\`).`, { loc: n.loc, from: c }));
    if (Array.isArray(props.where)) for (const clause of props.where) if (typeof clause === 'string' && clause.trim()) { // where() compiles ONLY `==`/`contains`, comma-separated; anything else THROWS or silently miscompiles → catch in check
      if (!/(?:==|\bcontains\b)/.test(clause)) D.push(diag('unsupported-where', `where clause "${clause.trim()}" — where() supports only \`==\` and \`contains\` (e.g. where(role == admin, name contains @q)).`, { loc: n.loc, from: clause.trim() }));
      else if (/\b(?:and|or)\b/.test(clause)) D.push(diag('unsupported-where', `where clause "${clause.trim()}" — combine conditions with a COMMA, not \`and\`/\`or\`: where(role == admin, name contains @q).`, { loc: n.loc, from: clause.trim() }));
    }
    if (n.type === 'Form') { // a Form auto-renders one input per ENTITY field → it MUST bind a PAGE-LOCAL entity draft; anything else crashes the compiler (editableFields(undefined) / state[sig] undefined)
      const raw = String(props.bind ?? '').replace(/^@/, '');
      const b = raw.split('.')[0];
      const bt = b ? doc.state?.[b]?.type : undefined;
      if (bt === undefined) D.push(diag('form-bind', `Form must bind a page-local draft (a state typed as an entity)${raw ? `, but "${raw}" is not a state on this page` : ''}${raw.includes('.') ? ' — a Form cannot bind a store field; declare a local `draft = {} : Entity` and submit the store action' : ''}.`, { loc: n.loc }));
      else if (!doc.entities?.[bt]) D.push(diag('form-bind', `Form must bind a state typed as an entity (a draft): "${b}" is "${bt}". Declare \`entity X { … }\` + \`${b} = {} : X\`, or use SearchField for a single text input.`, { loc: n.loc }));
    }
    if (n.type === 'DataTable') { // columns + where fields must be REAL fields of the row entity (else blank column / dead filter / @ref crash)
      const d = String(props.data ?? '').replace(/^@/, '');
      const dt = doc.state?.[d]?.type || '';
      const elem = dt.startsWith('list<') ? dt.slice(5, -1) : '';
      const rowFields = entityFieldSet(elem);
      if (rowFields) {
        for (const col of (props.columns || [])) if (typeof col === 'string' && !rowFields.has(col)) D.push(diag('unknown-column', `column "${col}" is not a field of ${elem}`, { loc: n.loc, suggestion: closest(col, [...rowFields]), from: col }));
        for (const clause of (props.where || [])) if (typeof clause === 'string') {
          const field = clause.trim().split(/\s+/)[0];
          if (field && !rowFields.has(field)) D.push(diag('unknown-where-field', `where "${clause.trim()}": "${field}" is not a field of ${elem}`, { loc: n.loc, suggestion: closest(field, [...rowFields]), from: field }));
          for (const m of clause.matchAll(/@(\w+)/g)) if (!stateKeys.has(m[1])) D.push(diag('unknown-ref', `where "${clause.trim()}": "@${m[1]}" is not a declared state`, { loc: n.loc, from: '@' + m[1] }));
        }
      }
    }
    if (n.type === 'SearchField') { // a SearchField writes a single text string → binding a number/bool/list/entity silently corrupts it
      const b = String(props.bind ?? '').replace(/^@/, '').split('.')[0];
      const bt = b ? doc.state?.[b]?.type : undefined;
      if (bt !== undefined && !['text', 'string', 'email'].includes(bt)) D.push(diag('bind-type', `SearchField binds a single text value, but "${b}" is "${bt}" — bind a text state (e.g. \`q = "" : text\`).`, { loc: n.loc }));
    }
    if (n.type === 'Custom') { // inputs(@state) + on(action) were NEVER validated → undefined refs / missing actions crash at runtime
      for (const v of Object.values(props.inputs || {})) if (typeof v === 'string') checkRef(v, n);
      for (const v of Object.values(props.on || {})) if (typeof v === 'string') checkAction(v, n);
    }
    if (Array.isArray(props.style)) {
      const theme = ctx.theme || defaultTheme;
      const hasValues = Object.keys(theme.space || {}).length > 0; // a real project theme is present
      for (const t of props.style) {
        if (!isKnownTokenShape(t)) {
          // STRICT vocabulary: the family/atom must be one Muten accepts (engine = source of truth)
          D.push(diag('unknown-token', `"${t}" is not an accepted style token`, { loc: n.loc, suggestion: closest(t, SUGGESTED), from: t }));
        } else if (hasValues && resolveToken(t, theme) === null) {
          // family is valid but the scale step isn't defined in THIS project's theme
          D.push(diag('unknown-token', `"${t}": that step isn't in your theme scale`, { loc: n.loc, suggestion: closest(t, SUGGESTED), from: t }));
        }
      }
    }
    // expression references (when condition, each list, reactive Text/Image interpolation)
    if (n.type === Nt.When && props.cond) checkExpr(props.cond, n.loc ?? null, scope);
    if (n.type === Nt.Each && props.list) checkExpr(props.list, n.loc ?? null, scope);
    if (props.arg && typeof props.arg === 'object' && 'kind' in props.arg) checkExpr(props.arg as Expr, n.loc ?? null, scope); // `-> action(arg)` on Button/Link/RowAction — the arg was never ref-checked
    if (props.argRest) for (const a of props.argRest) checkExpr(a, n.loc ?? null, scope);                                     // 2nd+ args of a multi-arg call `-> f(a, b)`
    const interps: StringPropValue[] = [];
    if ((n.type === Nt.Text || n.type === Nt.Title || n.type === Nt.Span) && props.value) interps.push(props.value);
    if (n.type === Nt.Image) { if (props.src) interps.push(props.src); if (props.alt) interps.push(props.alt); }
    if (n.type === Nt.Link && props.to) interps.push(props.to);
    if (props.label) interps.push(props.label); // Link/Button/RowAction labels interpolate too
    for (const ip of interps) {
      if (typeof ip === 'object' && 'kind' in ip && ip.kind === Ek.Interp) {
        for (const part of ip.parts) if (typeof part !== 'string') checkExpr(part, n.loc ?? null, scope);
      }
    }

    // children inherit the scope; an `each` adds its item variable + a DataTable adds the implicit `row`
    // (its RowActions read `row.id`), both typed with the list's element entity.
    let childScope = scope;
    if (n.type === Nt.Each && props.as) {
      childScope = new Map([...scope, [props.as, listElem(props.list)] as [string, string]]);
      if (props.filter) checkExpr(props.filter, n.loc ?? null, childScope); // `where <cond>` reads the item var
    }
    else if (n.type === 'DataTable') {
      const d = String(props.data || '').replace(/^@/, '');
      const dt = doc.state?.[d]?.type || '';
      childScope = new Map([...scope, ['row', dt.startsWith('list<') ? dt.slice(5, -1) : ''] as [string, string]]);
    }
    for (const c of n.children || []) walk(c, childScope, n.type === 'DataTable');
  };
  if (doc.rootId) walk(doc.rootId, new Map());
  else if (ctx.kind !== 'store') D.push(diag('no-root', 'the doc is missing a rootId'));

  // `get` is a derived value (a computed signal) — valid on a PAGE and in a .store alike (the trinity:
  // state / get / action). `effect` stays store-ONLY: a page reacts through `when`/`each`, not side-effects.
  if (ctx.kind !== 'store') {
    for (const expr of Object.values(doc.gets || {})) checkExpr(expr, null, new Map()); // every page get resolves against page state
    if ((doc.effects || []).length) D.push(diag('store-only', '`effect { }` is only valid in a .store — a page reacts through `when`/`each`, not effects.'));
  }

  // ── .store gets + effects: every expression resolves against the slice's own state (was head-only, so
  // member typos `n.foo` and bad refs in `effect { }` shipped silently → runtime ReferenceError) ──
  if (ctx.kind === 'store') {
    for (const expr of Object.values(doc.gets || {})) checkExpr(expr, null, new Map());
    const checkEff = (st: Stmt): void => {
      if (st.op === StOp.If) { checkExpr(st.cond, null, new Map()); for (const s of (st.then || [])) checkEff(s); for (const s of (st.else || [])) checkEff(s); return; }
      if ('target' in st && st.target && !stateKeys.has(st.target)) D.push(diag('undeclared-mutation', `effect mutates "${st.target}" — not a state of this store`, { suggestion: closest(st.target, [...stateKeys]), from: st.target })); // the TARGET was never checked → a typo'd effect target shipped a runtime ReferenceError
      if (st.op === StOp.Remove) checkExpr(st.pred, null, itemPredScope(new Map(), st.target));
      else if (st.op === StOp.Patch) { const inner = itemPredScope(new Map(), st.target); checkExpr(st.pred, null, inner); checkExpr(st.patch, null, inner); }
      else if (st.op === StOp.Refetch) { for (const v of Object.values(st.params)) checkExpr(v, null, new Map()); }
      else if (st.op === StOp.Request) { if (st.body) checkExpr(st.body, null, new Map()); }
      else if ('arg' in st && st.arg) checkExpr(st.arg, null, new Map());
    };
    for (const eff of doc.effects || []) for (const st of eff) checkEff(st);
  }

  // ── actions: a body may only mutate what `mutates` declares, with known ops ──
  for (const [name, a] of Object.entries(doc.actions || {})) {
    const declared = new Set(a.mutates || []);
    const actionScope = new Map<string, string>(a.params?.length ? a.params.map((p) => [p.name, p.type] as [string, string]) : (a.input ? [[a.input, ''] as [string, string]] : [])); // the typed params (or the legacy `<- input` var) are in scope
    const paramNames = new Set((a.params || []).map((p) => p.name)); // for the item-shadow collision rule
    const checkStmtInner = (st: Stmt): void => {
      // FULL ref-check on every expression in the body (was checkCalls-only → undeclared refs/typos shipped
      // silently and crashed at runtime). Covers `if` conds, set/push args, remove predicates, refetch params.
      if (st.op === StOp.If) { checkExpr(st.cond, null, actionScope); for (const s of (st.then || [])) checkStmt(s); for (const s of (st.else || [])) checkStmt(s); return; }
      if (st.op === StOp.Call) { // composing a STORE action — target is a store domain, method one of its actions
        if (!storeDomains.has(st.target)) D.push(diag('unknown-action', `"${st.target}.${st.method}(…)": "${st.target}" is not a store. A page action mutates LOCAL state with push/set/patch/…; only a STORE action can be called like this.`, { suggestion: closest(st.target, [...storeDomains]), from: st.target }));
        else if (!storeMemberMap.get(st.target)?.has(st.method)) D.push(diag('unknown-action', `store "${st.target}" has no member "${st.method}".`, { suggestion: closest(st.method, [...(storeMemberMap.get(st.target) || [])]), from: st.method }));
        for (const a of st.args) checkExpr(a, null, actionScope);
        return;
      }
      if (!KNOWN_OPS.has(st.op)) {
        D.push(diag('unknown-op', `action "${name}" uses unknown op "${st.op}"`, { suggestion: closest(st.op, [...KNOWN_OPS]), from: st.op }));
      }
      if ('target' in st && st.target && !declared.has(st.target)) {
        D.push(diag('undeclared-mutation', `action "${name}" mutates "${st.target}" but only declares mutates(${[...declared].join(', ') || '∅'})`, { suggestion: closest(st.target, [...declared]), from: st.target }));
      }
      if (SOURCE_OPS.has(st.op) && 'target' in st && st.target) {            // create/update/delete/refetch hit the backend → require a source
        const def = doc.state?.[st.target];
        if (def && !def.source) D.push(diag('missing-source', `action "${name}": "${st.target}.${st.op}(…)" needs a query/source-backed list, but "${st.target}" is local (no source). Use \`= query <name>\` + a \`sources\` entry, or local ops (push/set/reset/remove).`, { from: st.target }));
      }
      if ((st.op === StOp.Push || st.op === StOp.Create || st.op === StOp.Set) && st.arg) {
        // wrong TYPE into an entity slot ships garbage: push/create a non-entity into list<Entity> → `{...42}`={};
        // set an entity draft to a scalar → `d["name"]` on a string → undefined (silent field corruption).
        const tt = doc.state?.[st.target]?.type || '';
        const slot = st.op === StOp.Set ? tt : (tt.startsWith('list<') ? tt.slice(5, -1) : '');
        if (slot && doc.entities?.[slot]) {
          const a = st.arg;
          if (a.kind === Ek.Obj) { // an inline object literal: every key must be a real field of the entity
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
      if (st.op === StOp.Remove) { checkExpr(st.pred, null, itemPredScope(actionScope, st.target)); checkItemShadow(st.target, paramNames, [st.pred], null); } // `remove where id == x` — item fields bare
      else if (st.op === StOp.Patch) { // `patch where id == x with { field: val }` — fields read bare
        const lt = doc.state?.[st.target]?.type || '';
        const elem = lt.startsWith('list<') ? lt.slice(5, -1) : '';
        const inner = itemPredScope(actionScope, st.target);
        checkExpr(st.pred, null, inner);
        checkExpr(st.patch, null, inner);
        checkItemShadow(st.target, paramNames, [st.pred, st.patch], null);
        if (elem && doc.entities?.[elem] && st.patch.kind === Ek.Obj) { const ent = doc.entities[elem]; for (const f of st.patch.fields) if (!(f.key in ent)) D.push(diag('unknown-field', `action "${name}": "${f.key}" is not a field of ${elem}`, { suggestion: closest(f.key, Object.keys(ent)), from: f.key })); }
      }
      else if (st.op === StOp.Refetch) { for (const v of Object.values(st.params)) checkExpr(v, null, actionScope); }
      else if (st.op === StOp.Request) { if (st.body) checkExpr(st.body, null, actionScope); }
      else if ('arg' in st && st.arg) checkExpr(st.arg, null, actionScope);
    };
    // Pin every diagnostic a statement emits to THAT statement's line. The inner checks push messages
    // with no loc of their own (they describe a whole op); here we backfill the statement's loc so the
    // IDE/CLI point at `orders.create(…)`, not at `screen home`. Nested if-branches resolve to their own line.
    const checkStmt = (st: Stmt): void => {
      const before = D.length;
      checkStmtInner(st);
      for (let i = before; i < D.length; i++) if (!D[i].loc) D[i].loc = st.loc ?? null;
    };
    for (const st of a.body || []) checkStmt(st);
  }

  return { ok: D.length === 0, diagnostics: D };
}
