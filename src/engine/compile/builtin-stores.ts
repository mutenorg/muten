// builtin-stores: the stores every app has without writing them, read and changed like its own (a store or a state of
// the same name in the app always wins):
//   device.online · device.width · device.now · device.scrollDir      the browser (runtime-device.ts)
//   lang.current · lang.list · lang.use("en")                        the language, once the app has src/lang (runtime-lang.ts)
//   url.s · url.path · url.set({ s: "pagos" })                       the address bar, Back included (runtime-url.ts)
import { DEVICE_STORE, LANG_STORE, LANG_USE, URL_STORE, StOp } from '#engine/shared/vocab.js';
import type { CompileCtx, Expr, Stmt } from '#engine/shared/types.js';

const free = (ctx: CompileCtx, name: string): boolean => !ctx.stores[name] && !ctx.stateKeys.has(name);

// `<store>.<member>` → its JS, for the stores the app has right now
const READS: ReadonlyMap<string, { has: (ctx: CompileCtx) => boolean; read: (member: string) => string }> = new Map([
  [DEVICE_STORE, { has: () => true, read: (member: string) => `__device(${JSON.stringify(member)}).get()` }],
  [LANG_STORE, { has: (ctx: CompileCtx) => !!ctx.translations, read: (member: string) => (member === 'list' ? '__langList()' : '__lang().get()') }],
  [URL_STORE, { has: () => true, read: (member: string) => `__urlRead(${JSON.stringify(member)})` }],
]);

/** `device.online`, `lang.current`, `url.s` as JS, or null when the name is not a builtin store here. */
export function builtinStoreRead(ctx: CompileCtx, head: string, rest: string[]): string | null {
  const store = READS.get(head);
  return store && rest.length && store.has(ctx) && free(ctx, head) ? store.read(rest.join('.')) : null;
}

/** `lang.use("en")`, `url.set({ s: "pagos" })` as JS, or null when the statement is not one of them. */
export function builtinStoreStatement(ctx: CompileCtx, st: Stmt, value: (expr: Expr) => string): string | null {
  if (st.op === StOp.Call && st.target === LANG_STORE && st.method === LANG_USE && ctx.translations && free(ctx, LANG_STORE)) return `__langUse(${st.args.map(value).join(', ')});`;
  if (st.op === StOp.Set && st.target === URL_STORE && free(ctx, URL_STORE)) return `__urlSet(${value(st.arg)});`;
  return null;
}
