// frozen: page state that nothing ever writes. `kind = "creators" : text` on a page whose actions, effects and inputs
// never touch `kind` holds "creators" for the page's whole life, so the compiler may read it as that value. The first
// use is the texts: `t("who.{kind}.h1")` on such a page needs only who.creators.h1, not every who.*.h1 of every trade
// in every language (each /for/<trade> page of Storio's landing carried 77 kB of the other trades' words).
// A state is NOT frozen when anything can change it: an action's `mutates` or a statement's target (in an action, its
// `failed` block or an effect), an input bound to it, `persist` (localStorage hydrates it), or data that arrives later
// (a query, a live feed, a call).
import { StOp } from '#engine/shared/vocab.js';
import type { CompileCtx, Doc, Stmt } from '#engine/shared/types.js';

const values = new WeakMap<CompileCtx, Map<string, string | number>>();
const head = (path: string): string => path.split('.')[0];

function writtenBy(statements: Stmt[], into: Set<string>): void {
  for (const st of statements) {
    if (st.op === StOp.If) { writtenBy(st.then, into); writtenBy(st.else || [], into); continue; }
    if ('target' in st) into.add(head(st.target));
    if (st.op === StOp.Request && st.into) into.add(head(st.into));
  }
}

/** Every state of `doc` that nothing writes and that starts as a text or a number, with that value. */
export function frozenStates(doc: Doc): Map<string, string | number> {
  const written = new Set<string>();
  for (const action of Object.values(doc.actions || {})) {
    for (const name of action.mutates) written.add(head(name));
    writtenBy(action.body, written);
    writtenBy(action.failed || [], written);
  }
  for (const body of doc.effects || []) writtenBy(body, written);
  for (const node of Object.values(doc.nodes || {})) if (node.props?.bind) written.add(head(node.props.bind));
  const frozen = new Map<string, string | number>();
  for (const [name, def] of Object.entries(doc.state || {})) {
    if (written.has(name) || def.persist || def.source || def.call || def.live || def.feed) continue;
    if (typeof def.initial === 'string' || typeof def.initial === 'number') frozen.set(name, def.initial);
  }
  return frozen;
}

/** Records the frozen states of `doc` for this compile. */
export function freeze(ctx: CompileCtx, doc: Doc): void {
  values.set(ctx, frozenStates(doc));
}

/** The value a frozen state always holds, or undefined when it can change (or is no state of this page). */
export function frozenValue(ctx: CompileCtx, name: string): string | number | undefined {
  return values.get(ctx)?.get(name);
}
