// calls: what a call inside an expression may name, and with how many values.
//   fmt(x)            a built-in or a `use`'d function
//   initials(name)    this file's `get initials(name) = …`, which takes exactly its params
//   format.money(x)   a store's `get money(x) = …`; any other dotted call is a JS method muten values don't have
import { diag, closest, noMethodsMessage } from '#engine/shared/diagnostics.js';
import { Ek, StOp, TRANSLATE, LIVE_CHANGE } from '#engine/shared/vocab.js';
import { translateDiagnostic } from '#engine/ir/translate-check.js';
import type { CallExpr, CallFacts, ChainStep, Diagnostic, Expr, ImportDef, Loc, StateDef, Stmt } from '#engine/shared/types.js';

/** The names that hold something from npm, whose own API (methods, properties, chains) muten passes through as is:
 *  what a `use` line brings, a `get` made by calling one (`get db = createClient(url, key)`), and a query of a
 *  function (`stripe = query loadStripe(key)`). A muten value never has methods; these are not muten values. */
export function foreignNames(doc: { imports?: ImportDef[]; gets?: { [name: string]: Expr }; state?: { [name: string]: StateDef } }): Set<string> {
  const out = new Set((doc.imports || []).filter((def) => !def.kind).flatMap((def) => def.names));
  for (const [name, def] of Object.entries(doc.state || {})) if (def.call) out.add(name);
  let grew = true;
  while (grew) {   // a get made from another foreign get (`get orders = db.from("orders")`)
    grew = false;
    // what a get gives: a call into a package, or one of two (`stripe ? stripe.elements(…) : null`)
    const fromPackage = (body: Expr): boolean => body.kind === Ek.Call ? out.has(body.fn.split('.')[0]) : body.kind === Ek.Tern ? fromPackage(body.then) || fromPackage(body.else) : false;
    for (const [name, body] of Object.entries(doc.gets || {})) {
      if (out.has(name) || !fromPackage(body)) continue;
      out.add(name); grew = true;
    }
  }
  return out;
}

/** A `live <feed>`: a package's own subscription (`db.channel("x").on(…, change).subscribe()`, `socket.on("x", change)`),
 *  with muten's `change` where its callback goes. `check` runs over it with `change` in scope. */
export function feedDiagnostics(feed: Expr, loc: Loc | null, foreign: Set<string>, check: (expr: Expr) => void): Diagnostic[] {
  if (feed.kind !== Ek.Call || !foreign.has(feed.fn.split('.')[0]))
    return [diag('live-feed', 'what follows `live` is a package\'s subscription, written as its docs show it, with `change` where its callback goes: `live socket.on("order", change)`, `live db.channel("orders").on("postgres_changes", { event: "*", table: "orders" }, change).subscribe()`', { loc })];
  check(feed);
  const mentions = (expr: Expr): boolean => expr.kind === Ek.Ref ? expr.name === LIVE_CHANGE : expr.kind === Ek.Call ? callValues(expr).some(mentions) : expr.kind === Ek.Obj ? expr.fields.some((field) => mentions(field.value)) : expr.kind === Ek.List ? expr.items.some(mentions) : false;
  return mentions(feed) ? [] : [diag('live-no-change', `nothing would ever arrive: pass \`${LIVE_CHANGE}\` where the package takes its callback (\`socket.on("order", ${LIVE_CHANGE})\`)`, { loc })];
}

/** Every value a call passes, its own and those of the steps after it (`db.from("x").eq("shop", id)` reads `id`). */
export function callValues(call: { args: Expr[]; chain?: ChainStep[] }): Expr[] {
  return [...call.args, ...(call.chain || []).flatMap((step) => step.args || [])];
}

// every call in an expression, nested ones included
export function collectCalls(expr: Expr, acc: CallExpr[] = []): CallExpr[] {
  switch (expr.kind) {
    case Ek.Call: acc.push(expr); for (const arg of callValues(expr)) collectCalls(arg, acc); break;
    case Ek.Agg: collectCalls(expr.body, acc); break;
    case Ek.Un: collectCalls(expr.operand, acc); break;
    case Ek.Bin: collectCalls(expr.left, acc); collectCalls(expr.right, acc); break;
    case Ek.Tern: collectCalls(expr.cond, acc); collectCalls(expr.then, acc); collectCalls(expr.else, acc); break;
    case Ek.Obj: for (const field of expr.fields) collectCalls(field.value, acc); break;
    case Ek.List: for (const item of expr.items) collectCalls(item, acc); break;
    case Ek.Filter: collectCalls(expr.cond, acc); break;
  }
  return acc;
}

/** Every call a statement makes, in its expressions and its branches (an `if`), and the statement itself when it is one. */
export function statementCalls(st: Stmt): string[] {
  const exprs: Expr[] = [];
  if ('arg' in st && st.arg) exprs.push(st.arg);
  if ('args' in st) exprs.push(...st.args);
  if (st.op === StOp.Extern) exprs.push(...callValues(st).slice(st.args.length));
  if (st.op === StOp.If) exprs.push(st.cond);
  if (st.op === StOp.Remove) exprs.push(st.pred);
  if (st.op === StOp.Patch) exprs.push(st.pred, st.patch);
  if (st.op === StOp.Request && st.body) exprs.push(st.body);
  if (st.op === StOp.Refetch) exprs.push(...Object.values(st.params));
  const names = exprs.flatMap((e) => collectCalls(e).map((call) => call.fn));
  if (st.op === StOp.Extern) names.push(st.fn);
  if (st.op === StOp.If) for (const inner of [...(st.then || []), ...(st.else || [])]) names.push(...statementCalls(inner));
  return names;
}

function arity(call: CallExpr, params: string[], loc: Loc | null): Diagnostic | null {
  if (call.args.length === params.length) return null;
  return diag('fn-arity', `"${call.fn}" takes ${params.length} value${params.length === 1 ? '' : 's'} (${params.join(', ')}), not ${call.args.length}`, { loc, from: call.fn });
}

function checkCall(call: CallExpr, loc: Loc | null, facts: CallFacts): Diagnostic | null {
  if (call.fn === TRANSLATE && facts.translations) return translateDiagnostic(call, loc, facts.translations);   // the app's own t()
  const dot = call.fn.indexOf('.');
  const foreign = facts.foreign?.has(call.fn.split('.')[0]);
  if (dot !== -1 && foreign) return null;   // `posthog.capture(…)`, `db.from(…)`: the package's own API, as it documents it
  if (call.ctor && !foreign) return diag('no-methods', `\`new ${call.fn}(…)\`: \`new\` makes a class a package exports (\`use Chart from "chart.js/auto"\`), and "${call.fn}" is not one`, { loc, from: call.fn });
  if (call.ctor) return null;
  if (call.chain && !foreign) return diag('no-methods', noMethodsMessage(call.fn + '(…)', call.chain[0].name), { loc, from: call.fn });
  if (dot === -1) {
    if (!facts.externs.has(call.fn)) return diag('unknown-function', `"${call.fn}" is not a function here: a built-in, a \`use\`d one, a \`fn\`, or a get with parameters`, { loc, suggestion: closest(call.fn, [...facts.externs]), from: call.fn });
    const own = facts.fns[call.fn];
    if (own) return arity(call, own.params, loc);
    const typed = facts.arity?.[call.fn];   // a `use`'d function whose package says how many values it takes
    if (typed && (call.args.length < typed.min || (typed.max >= 0 && call.args.length > typed.max)))
      return diag('fn-arity', `"${call.fn}" takes ${typed.min === typed.max ? typed.min : typed.max < 0 ? `at least ${typed.min}` : `${typed.min} to ${typed.max}`} value${typed.max === 1 ? '' : 's'} (as it is declared), not ${call.args.length}`, { loc, from: call.fn });
    return null;
  }
  const head = call.fn.slice(0, dot);
  const member = call.fn.slice(dot + 1);
  const params = facts.storeFns?.[head]?.[member];
  if (params) return arity(call, params, loc);
  if (!facts.storeFns && facts.stores.has(head)) return null;   // the stores' functions were not threaded: nothing to say
  const suggestion = facts.stores.has(head) ? closest(member, Object.keys(facts.storeFns?.[head] || {})) : null;
  return diag('no-methods', noMethodsMessage(head, member), { loc, suggestion, from: call.fn });
}

/** The diagnostics of every call in an expression. */
export function callDiagnostics(expr: Expr, loc: Loc | null, facts: CallFacts): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const call of collectCalls(expr)) { const found = checkCall(call, loc, facts); if (found) out.push(found); }
  return out;
}
