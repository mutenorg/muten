// validate-actions: the statements of effects and actions. What each may change (its `mutates`, a page state, never a
// store directly), whether its calls name something real, whether a list op fits the list (a source for create/
// update/delete/refetch, a live query for send), and the failure handling that can never run (an `else` after a
// `post`, which throws on any non-2xx: `failed { }` is where that goes).
import { diag, closest } from '#engine/shared/diagnostics.js';
import { ACTION_OPS } from '#engine/lang/manifest.js';
import { StOp, Ek, URL_STORE } from '#engine/shared/vocab.js';
import { collectRefs, selfUpdateTargets } from '#engine/ir/refs.js';
import { callValues } from '#engine/ir/calls.js';
import type { ActionCheck, Expr, Stmt } from '#engine/shared/types.js';

const KNOWN_OPS = new Set<string>([...ACTION_OPS, StOp.Request]); // Request is parsed + compiled but is not a method op
const SOURCE_OPS = new Set<string>([StOp.Create, StOp.Update, StOp.Delete, StOp.Refetch]); // hit the backend, so the list MUST be query/source-backed
const LOCAL_MUT_OPS = new Set<string>([StOp.Push, StOp.Set, StOp.Reset, StOp.Toggle, StOp.Patch, StOp.Remove]); // mutate a PAGE-LOCAL state — never a store

/** Every effect and action of the page, checked; diagnostics go to `facts.D`. */
export function checkActions(facts: ActionCheck): void {
  const { D, doc, ctx, checkExpr, itemPredScope, checkItemShadow, checkReqUrl, stateKeys, storeDomains, storeMemberMap, externs, foreign, actionNames } = facts;
  // a call that names something real: a `use`d function, an action of this file, or a package's own API (`posthog.capture`)
  // `url.set({ s: "pagos" })`: the address bar, a builtin store (unless the app has its own `url`): no `mutates` needed
  const urlSet = (st: Stmt): boolean => st.op === StOp.Set && st.target === URL_STORE && storeDomains.has(URL_STORE) && !stateKeys.has(URL_STORE) && !(ctx.stores || []).includes(URL_STORE);
  const callable = (fn: string): boolean => externs.has(fn) || actionNames.has(fn) || foreign.has(fn.split('.')[0]);
  const externArgs = (st: Stmt): Expr[] => ('args' in st ? callValues(st) : []);
  // a statement inside an `if` reports at its own line, not at the `if`'s
  const checkEffAt = (st: Stmt): void => {
    const before = D.length;
    checkEff(st);
    for (let at = before; at < D.length; at++) if (!D[at].loc) D[at].loc = st.loc ?? null;
  };
  const checkEff = (st: Stmt): void => {
    if (st.op === StOp.If) { checkExpr(st.cond, null, new Map()); for (const s of [...(st.then || []), ...(st.else || [])]) checkEffAt(s); return; }
    if (st.op === StOp.Call && foreign.has(st.target)) { for (const a of st.args) checkExpr(a, null, new Map()); return; }   // `posthog.capture("x")`
    if (urlSet(st) && 'arg' in st) { if (st.arg) checkExpr(st.arg, null, new Map()); return; }
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
    else if (st.op === StOp.Extern) { if (!callable(st.fn)) D.push(diag('unknown-function', `"${st.fn}" is not a use'd function or an action of this file`, { suggestion: closest(st.fn, [...externs, ...actionNames]), from: st.fn })); for (const a of externArgs(st)) checkExpr(a, null, new Map()); }
    else if ('arg' in st && st.arg) checkExpr(st.arg, null, new Map());
  };
  for (const eff of doc.effects || []) {
    // self-referential effect = INFINITE LOOP: an effect re-runs on every signal it reads, so a TOP-LEVEL
    // write of a signal it reads (directly, or via a store action that does) self-triggers forever — the
    // page hangs silently (no error). The single nastiest effect footgun; catch it at lint.
    for (const t of selfUpdateTargets(eff))
      D.push(diag('effect-loop', `effect updates "${t}" from its own value (e.g. \`${t}.set(${t} + …)\`) — an effect re-runs on every signal it reads, so writing a signal it reads loops forever (the page hangs). Set "${t}" to a value that doesn't read it, guard it with \`if <terminal condition>\`, or update it from an event (a Button) instead.`, { from: t }));
    for (const st of eff) {
      const before = D.length;   // whatever this statement adds is reported at its line (they used to come with none)
      if (st.op === StOp.Call && ctx.storeSelfMut?.has(`${st.target}.${st.method}`))
        D.push(diag('effect-loop', `effect calls "${st.target}.${st.method}()", which updates a signal from its own value — an effect re-runs on every signal it reads, so a store action that reads AND writes the same state loops forever here (the page hangs). Call it from an event (a Button), or make the action set a value that doesn't depend on the old one.`, { from: st.method }));
      checkEff(st);
      for (let at = before; at < D.length; at++) if (!D[at].loc) D[at].loc = st.loc ?? null;
    }
  }

  // actions: a body may only mutate what `mutates` declares, using known ops
  for (const [name, a] of Object.entries(doc.actions || {})) {
    const declared = new Set(a.mutates || []);
    for (const t of a.mutates || []) if (!stateKeys.has(t) && !storeDomains.has(t)) D.push(diag('undeclared-mutation', `action "${name}" declares \`mutates ${t}\` but "${t}" is not a declared state`, { suggestion: closest(t, [...stateKeys]), from: t })); // mutates targets were unchecked → renaming/typo'ing a state left `mutates oldName` lint-clean but a runtime ReferenceError
    const actionScope = new Map<string, string>(a.params?.length ? a.params.map((p): [string, string] => [p.name, p.type]) : (a.input ? [[a.input, '']] : [])); // typed params (or legacy `<- input` var) are in scope
    const paramNames = new Set((a.params || []).map((p) => p.name)); // for the item-shadow collision rule
    const checkStmtInner = (st: Stmt): void => {
      // full ref-check on every expression in the body (was checkCalls-only before: undeclared refs/typos
      // shipped silently and crashed at runtime). Covers `if` conds, set/push args, remove predicates, refetch params.
      if (st.op === StOp.If) { checkExpr(st.cond, null, actionScope); for (const s of (st.then || [])) checkStmt(s); for (const s of (st.else || [])) checkStmt(s); return; }
      if (st.op === StOp.Call && foreign.has(st.target)) { for (const a of st.args) checkExpr(a, null, actionScope); return; }   // `posthog.capture("x")`
      if (urlSet(st) && 'arg' in st) { if (st.arg) checkExpr(st.arg, null, actionScope); return; }
      if (st.op === StOp.Call) { // composing a store action: target is a store domain, method is one of its actions
        if (!storeDomains.has(st.target)) D.push(diag('unknown-action', `"${st.target}.${st.method}(…)": "${st.target}" is not a store. A page action mutates LOCAL state with push/set/patch/…; only a STORE action can be called like this.`, { suggestion: closest(st.target, [...storeDomains]), from: st.target }));
        else if (!storeMemberMap.get(st.target)?.has(st.method)) D.push(diag('unknown-action', `store "${st.target}" has no member "${st.method}".`, { suggestion: closest(st.method, [...(storeMemberMap.get(st.target) || [])]), from: st.method }));
        for (const a of st.args) checkExpr(a, null, actionScope);
        return;
      }
      if (st.op === StOp.Extern) { // a use'd function as a side-effect (`persist(messages)`), or another action of this file
        // `bumpTwice { bump()  bump() }`: an action may call its siblings (in a store too), instead of copying their body.
        // Calling itself never ends.
        if (st.fn === name) D.push(diag('action-recursion', `action "${name}" calls itself — that never ends. Move the repeated part into another action and call that.`, { from: st.fn }));
        else if (!callable(st.fn)) D.push(diag('unknown-function', `"${st.fn}" is not a use'd function or an action of this file`, { suggestion: closest(st.fn, [...externs, ...actionNames]), from: st.fn }));
        for (const a of externArgs(st)) checkExpr(a, null, actionScope);
        return;
      }
      if (!KNOWN_OPS.has(st.op)) {
        D.push(diag('unknown-op', `action "${name}" uses unknown op "${st.op}"`, { suggestion: closest(st.op, [...KNOWN_OPS]), from: st.op }));
      }
      if ('target' in st && st.target && st.op !== StOp.Send && !declared.has(st.target)) {   // sending changes nothing here: no `mutates`
        D.push(diag('undeclared-mutation', `action "${name}" mutates "${st.target}" but only declares mutates(${[...declared].join(', ') || '∅'})`, { suggestion: closest(st.target, [...declared]), from: st.target }));
      }
      // LOCAL mutation ops (push/set/reset/toggle/patch/remove) mutate a PAGE-LOCAL state — the compiler reads doc.state[target].
      // A STORE can't be mutated this way from a page (compile would crash on `ctx.state[store]` = undefined). Call a store action.
      if (LOCAL_MUT_OPS.has(st.op) && 'target' in st && st.target && !doc.state?.[st.target]) {
        if (storeDomains.has(st.target)) D.push(diag('store-local-mutation', `action "${name}": \`${st.target}.${st.op}(…)\` — "${st.target}" is a STORE. A page action can't ${st.op} into a store directly; call a store action (e.g. \`${st.target}.add(…)\`), or ${st.op} into a page-local \`list<…>\`/state.`, { loc: st.loc ?? null, suggestion: closest(`${st.target}.add`, [...(storeMemberMap.get(st.target) || [])].map((m) => `${st.target}.${m}`)), from: st.target }));
        else D.push(diag('undeclared-mutation', `action "${name}": \`${st.op}\` targets "${st.target}", which is not a declared page state.`, { loc: st.loc ?? null, suggestion: closest(st.target, [...stateKeys]), from: st.target }));
      }
      if (SOURCE_OPS.has(st.op) && 'target' in st && st.target) {            // create/update/delete/refetch hit the backend, so a source is required
        const def = doc.state?.[st.target];
        if (def && !def.source) D.push(diag('missing-source', `action "${name}": "${st.target}.${st.op}(…)" needs a query/source-backed list, but "${st.target}" is local (no source). Use \`= query <name>\` + a \`sources\` entry, or local ops (push/set/reset/remove).`, { from: st.target }));
      }
      if (st.op === StOp.Send && !doc.state?.[st.target]?.live) D.push(diag('send-not-live', `action "${name}": \`${st.target}.send(…)\` goes up a live socket, but "${st.target}" is not a \`query … live\`. Declare it \`${st.target} = query <source> live : list<…>\`, or send with \`post\`.`, { loc: st.loc ?? null, from: st.target }));
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
    for (const st of a.failed || []) checkStmt(st);   // `} failed { … }` is checked like the body

    // DEAD FAILURE-HANDLER after a `post`: `post … into X` then `if X.id { … } else { … }`. The `else` LOOKS
    // like the error branch but is UNREACHABLE on a failed request. A `post` THROWS on any non-2xx (the
    // runtime's __send does `if (!r.ok) throw`), so the action jumps straight to its catch — setting
    // `<name>.error` — and NOTHING after the `post` runs on a failure. The `if X.id`/`else` therefore only
    // ever tells apart shapes of a SUCCESSFUL body (which always carries an id): the `else` never fires for a
    // 503/500/timeout/offline. The failure-handling the author wrote in that `else` silently never runs, so
    // the screen has no error to show and often hangs on its pending state — a footgun precisely because the
    // `else` reads like the natural place for it. Point them at the one place the error actually lands:
    // `<name>.error`. Sibling-scoped (per statement array) so a reachable `else` in another block isn't flagged.
    // Every expression a statement carries (so we can tell whether an `else` re-inspects the response).
    const stmtExprs = (s: Stmt): Expr[] => {
      if (s.op === StOp.If) return [s.cond];
      if (s.op === StOp.Remove) return [s.pred];
      if (s.op === StOp.Patch) return [s.pred, s.patch];
      if (s.op === StOp.Call || s.op === StOp.Extern) return s.args;
      if (s.op === StOp.Request) return s.body ? [s.body] : [];
      if (s.op === StOp.Refetch) return Object.values(s.params);
      return 'arg' in s && s.arg ? [s.arg] : [];
    };
    // Does this statement subtree read any of the `post` targets? A legitimate `else` after a 2xx (e.g. an
    // auth call that answers 200 with a token OR 200 with an email-to-continue) branches by RE-READING the
    // response; a dead failure-handler `else` ignores the response and just reports an error.
    const readsPosted = (sts: Stmt[], posted: Set<string>): boolean => sts.some((s) =>
      stmtExprs(s).some((e) => collectRefs(e).some((r) => posted.has(r.split('.')[0]))) ||
      (s.op === StOp.If && (readsPosted(s.then || [], posted) || readsPosted(s.else || [], posted))));
    const flagDeadPostElse = (stmts: Stmt[]): void => {
      const posted = new Set<string>(); // into-targets of a `post` seen earlier in THIS array
      for (const st of stmts) {
        if (st.op === StOp.Request && st.into) posted.add(st.into);
        else if (st.op === StOp.If) {
          // Flag ONLY a dead FAILURE-handler: the `if` guards on the response (`X`/`X.field`), there IS an
          // `else`, and that `else` does NOT re-read the response — so it can only be meant for the request
          // failing, which it can never catch (the `post` threw). An `else` that re-inspects the response
          // (a 200-token-vs-200-email branch) is legitimate alternate-success handling and is left alone.
          const guardsPostTarget = (st.else?.length ?? 0) > 0 &&
            collectRefs(st.cond).some((r) => posted.has(r.split('.')[0])) &&
            !readsPosted(st.else || [], posted);
          if (guardsPostTarget)
            D.push(diag('post-else-dead', `action "${name}": this \`else\` never runs on a failed request. A \`post\`/\`put\` THROWS on any non-2xx response, so the action jumps to \`${name}.error\` and NOTHING after the request runs on a failure — an \`if\` on the response and its \`else\` only tell apart shapes of a SUCCESSFUL body, never a 503/500/timeout/offline (the very failures this \`else\` looks written for). Handle the failure where it actually lands: after the action's body, \`} failed { … }\` runs when the request fails; or read \`${name}.error\` in the view with \`when ${name}.error { … }\`. (The button already recovers: \`${name}.pending\` clears on error.)`, { loc: st.loc ?? null, severity: 'warning' }));
          flagDeadPostElse(st.then || []);
          flagDeadPostElse(st.else || []);
        }
      }
    };
    flagDeadPostElse(a.body || []);
  }
}
